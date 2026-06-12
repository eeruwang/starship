/**
 * StarShip Cloudflare Worker
 *
 * 역할:
 * 1. 정적 파일 서빙 (wrangler assets 바인딩이 자동 처리)
 * 2. /proxy 경로로 들어오는 요청을 Fediverse 인스턴스에 프록시
 * 3. /api/auth/* 회원가입/로그인/세션 관리
 * 4. /api/sync/* 계정·설정 클라우드 저장/불러오기
 * 5. /api/stream WebSocket 스트림 릴레이 (Durable Object)
 */

// Re-export Durable Object class for wrangler binding
export { StreamRelay } from './stream-relay.js';

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const CACHE_TTL_IMAGE = 7 * 24 * 60 * 60; // 7 days
const CACHE_TTL_OG = 24 * 60 * 60; // 24 hours
const CACHE_TTL_THEME = 7 * 24 * 60 * 60; // 7 days
const CACHE_MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
let _tablesInitialized = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight for all /api/ routes
    if (request.method === 'OPTIONS' && (url.pathname.startsWith('/api/') || url.pathname === '/proxy')) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Image cache proxy
    if (url.pathname === '/cache/image' && request.method === 'GET') {
      return handleImageCache(url, env);
    }

    // Proxy
    if (url.pathname === '/proxy') {
      return handleProxy(request, url);
    }

    // OG metadata fetch (no DB needed)
    if (url.pathname === '/api/og' && request.method === 'GET') {
      return handleOgFetch(url, env);
    }

    // Instance theme-color fetch (no DB needed)
    if (url.pathname === '/api/instance-theme' && request.method === 'GET') {
      return handleInstanceTheme(url, env);
    }

    // WebSocket stream relay (Durable Object)
    if (url.pathname === '/api/stream') {
      return handleStreamUpgrade(request, env);
    }

    // Auth & sync API
    if (url.pathname.startsWith('/api/')) {
      if (!_tablesInitialized) {
        await ensureTables(env.FEDI_ACCOUNTS);
        _tablesInitialized = true;
      }
      return handleApi(request, url, env);
    }

    // Static files — wrap with security headers. CSP is REPORT-ONLY because
    // the current UI uses inline `onerror=` attributes on dozens of <img>
    // elements (avatar/media fallback) which a strict script-src would block.
    // Report-only lets us see violations in dev console without breaking the
    // app; once those inline handlers are migrated to delegated listeners we
    // can flip this to enforcing mode. X-Content-Type-Options and
    // Referrer-Policy are safe to enforce immediately.
    const assetRes = await env.ASSETS.fetch(request);
    const ct = assetRes.headers.get('Content-Type') || '';
    if (ct.includes('text/html')) {
      const headers = new Headers(assetRes.headers);
      headers.set('Content-Security-Policy-Report-Only', [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src * data: blob:",
        "media-src *",
        "connect-src *",
        "font-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '));
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Frame-Options', 'DENY');
      return new Response(assetRes.body, { status: assetRes.status, headers });
    }
    return assetRes;
  },
};

// ===== D1 Schema =====

async function ensureTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_data (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
  ]);
  // Migrate: add role column if missing
  try { await db.prepare("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'").run(); } catch {}
  // Auto-promote first user to admin
  const first = await db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').first();
  if (first) {
    await db.prepare("UPDATE users SET role = 'admin' WHERE id = ? AND role != 'admin'").bind(first.id).run();
  }
}

// ===== Auth Helpers =====

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function getSessionUser(request, db) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/starship_session=([a-f0-9]{64})/);
  if (!match) return null;
  const token = match[1];
  const row = await db.prepare(
    `SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).bind(token).first();
  return row || null;
}

// ===== API Router =====

async function handleApi(request, url, env) {
  const db = env.FEDI_ACCOUNTS;
  const path = url.pathname;

  if (path === '/api/auth/register' && request.method === 'POST') {
    return handleRegister(request, db, env);
  }
  if (path === '/api/auth/login' && request.method === 'POST') {
    return handleLogin(request, db);
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    return handleLogout(request, db);
  }
  if (path === '/api/auth/me' && request.method === 'GET') {
    return handleMe(request, db);
  }
  if (path === '/api/sync/save' && request.method === 'POST') {
    return handleSyncSave(request, db);
  }
  if (path === '/api/sync/load' && request.method === 'GET') {
    return handleSyncLoad(request, db);
  }
  // Admin endpoints
  if (path === '/api/admin/settings' && request.method === 'GET') {
    return handleAdminGetSettings(request, db);
  }
  if (path === '/api/admin/settings' && request.method === 'POST') {
    return handleAdminSaveSettings(request, db);
  }
  if (path === '/api/admin/invite-codes' && request.method === 'GET') {
    return handleGetInviteCodes(request, db);
  }
  if (path === '/api/admin/invite-codes' && request.method === 'POST') {
    return handleCreateInviteCodes(request, db);
  }
  if (path.startsWith('/api/admin/invite-codes/') && request.method === 'DELETE') {
    const code = decodeURIComponent(path.split('/').pop());
    return handleDeleteInviteCode(request, db, code);
  }
  // Public: get registration status & turnstile site key
  if (path === '/api/site-info' && request.method === 'GET') {
    return handleSiteInfo(db, env);
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

// ===== Auth Endpoints =====

async function handleRegister(request, db, env) {
  const body = await parseJsonBody(request);
  if (!body) return jsonResponse({ error: '잘못된 요청입니다' }, 400);
  const { username, password, turnstileToken, inviteCode } = body;

  // Check registration mode
  const regMode = await getRegistrationMode(db);
  if (regMode === 'closed') {
    return jsonResponse({ error: '현재 회원가입이 비활성화되어 있습니다' }, 403);
  }
  if (regMode === 'invite') {
    if (!inviteCode) {
      return jsonResponse({ error: '초대코드를 입력해주세요' }, 400);
    }
    const code = await db.prepare('SELECT * FROM invite_codes WHERE code = ?').bind(inviteCode.trim()).first();
    if (!code || code.used_count >= code.max_uses) {
      return jsonResponse({ error: '유효하지 않거나 이미 사용된 초대코드입니다' }, 403);
    }
  }

  if (!username || !password) {
    return jsonResponse({ error: '아이디와 비밀번호를 입력해주세요' }, 400);
  }
  if (username.length < 2 || username.length > 30) {
    return jsonResponse({ error: '아이디는 2~30자로 입력해주세요' }, 400);
  }
  if (!/^[a-zA-Z0-9_\-]+$/.test(username)) {
    return jsonResponse({ error: '아이디는 영문, 숫자, 밑줄(_), 하이픈(-)만 사용할 수 있습니다' }, 400);
  }
  if (password.length < 6) {
    return jsonResponse({ error: '비밀번호는 6자 이상이어야 합니다' }, 400);
  }

  // Verify Turnstile
  const turnstileSecret = env.TURNSTILE_SECRET;
  if (turnstileSecret) {
    if (!turnstileToken) {
      return jsonResponse({ error: '인간 확인을 완료해주세요' }, 400);
    }
    try {
      const verifyRes = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: turnstileSecret, response: turnstileToken }),
      });
      if (!verifyRes.ok) {
        return jsonResponse({ error: '인간 확인 서버 오류. 다시 시도해주세요' }, 502);
      }
      const verifyData = await verifyRes.json();
      if (!verifyData.success) {
        return jsonResponse({ error: '인간 확인에 실패했습니다. 다시 시도해주세요' }, 403);
      }
    } catch {
      return jsonResponse({ error: '인간 확인 서버에 연결할 수 없습니다. 다시 시도해주세요' }, 502);
    }
  }

  const existing = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) {
    return jsonResponse({ error: '이미 사용 중인 아이디입니다' }, 409);
  }

  // Atomically claim invite slot right before user creation (after all validation passes)
  if (regMode === 'invite' && inviteCode) {
    const claimed = await db.prepare(
      'UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses RETURNING id'
    ).bind(inviteCode.trim()).first();
    if (!claimed) {
      return jsonResponse({ error: '초대코드가 이미 모두 사용되었습니다' }, 403);
    }
  }

  const salt = generateToken();
  const passwordHash = await hashPassword(password, salt);
  const result = await db.prepare(
    'INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)'
  ).bind(username, passwordHash, salt).run();

  const userId = result.meta.last_row_id;
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL * 1000).toISOString();
  await db.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, userId, expiresAt).run();

  // Fetch actual role (first user is auto-promoted to admin by ensureTables)
  const newUser = await db.prepare('SELECT role FROM users WHERE id = ?').bind(userId).first();
  return jsonResponse({ ok: true, username, role: newUser?.role || 'user' }, 201, sessionCookie(token));
}

async function handleLogin(request, db) {
  const body = await parseJsonBody(request);
  if (!body) return jsonResponse({ error: '잘못된 요청입니다' }, 400);
  const { username, password } = body;
  if (!username || !password) {
    return jsonResponse({ error: '아이디와 비밀번호를 입력해주세요' }, 400);
  }

  const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!user) {
    return jsonResponse({ error: '아이디 또는 비밀번호가 올바르지 않습니다' }, 401);
  }

  const hash = await hashPassword(password, user.salt);
  if (hash !== user.password_hash) {
    return jsonResponse({ error: '아이디 또는 비밀번호가 올바르지 않습니다' }, 401);
  }

  // Clean up expired sessions (all users, probabilistic to avoid every-login overhead)
  if (Math.random() < 0.1) {
    await db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL * 1000).toISOString();
  await db.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, user.id, expiresAt).run();

  return jsonResponse({ ok: true, username: user.username, role: user.role }, 200, sessionCookie(token));
}

async function handleLogout(request, db) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/starship_session=([a-f0-9]{64})/);
  if (match) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(match[1]).run();
  }
  return jsonResponse({ ok: true }, 200, 'starship_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
}

async function handleMe(request, db) {
  const user = await getSessionUser(request, db);
  if (!user) {
    return jsonResponse({ loggedIn: false }, 200);
  }
  return jsonResponse({ loggedIn: true, username: user.username, role: user.role });
}

// ===== Sync Endpoints =====

async function handleSyncSave(request, db) {
  const user = await getSessionUser(request, db);
  if (!user) return jsonResponse({ error: '로그인이 필요합니다' }, 401);

  // Enforce request body size limit (512KB)
  const contentLength = parseInt(request.headers.get('Content-Length') || '0');
  if (contentLength > 512 * 1024) {
    return jsonResponse({ error: '데이터가 너무 큽니다 (최대 512KB)' }, 413);
  }

  const body = await parseJsonBody(request);
  if (!body) return jsonResponse({ error: '잘못된 요청입니다' }, 400);

  // Validate data size after parsing
  const bodyStr = JSON.stringify(body);
  if (bodyStr.length > 512 * 1024) {
    return jsonResponse({ error: '데이터가 너무 큽니다 (최대 512KB)' }, 413);
  }

  // body: { accounts, settings, columnState }
  const stmts = [];
  for (const key of ['accounts', 'settings', 'columnState']) {
    if (body[key] !== undefined) {
      stmts.push(
        db.prepare(
          `INSERT OR REPLACE INTO user_data (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))`
        ).bind(user.id, key, JSON.stringify(body[key]))
      );
    }
  }
  if (stmts.length > 0) await db.batch(stmts);
  return jsonResponse({ ok: true });
}

async function handleSyncLoad(request, db) {
  const user = await getSessionUser(request, db);
  if (!user) return jsonResponse({ error: '로그인이 필요합니다' }, 401);

  const rows = await db.prepare('SELECT key, value FROM user_data WHERE user_id = ?').bind(user.id).all();
  const data = {};
  for (const row of rows.results) {
    try { data[row.key] = JSON.parse(row.value); } catch { data[row.key] = row.value; }
  }
  return jsonResponse(data);
}

// ===== WebSocket Stream Relay =====

async function handleStreamUpgrade(request, env) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  // Authenticate via session cookie
  const db = env.FEDI_ACCOUNTS;
  if (!_tablesInitialized) {
    await ensureTables(db);
    _tablesInitialized = true;
  }

  const user = await getSessionUser(request, db);
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Route to per-user Durable Object
  const doId = env.STREAM_RELAY.idFromName(`user:${user.id}`);
  const stub = env.STREAM_RELAY.get(doId);
  return stub.fetch(request);
}

// ===== Admin Endpoints =====

async function handleAdminGetSettings(request, db) {
  const user = await getSessionUser(request, db);
  if (!user || user.role !== 'admin') return jsonResponse({ error: '권한이 없습니다' }, 403);

  const rows = await db.prepare('SELECT key, value FROM site_settings').all();
  const settings = {};
  for (const row of rows.results) settings[row.key] = row.value;
  return jsonResponse(settings);
}

async function handleAdminSaveSettings(request, db) {
  const user = await getSessionUser(request, db);
  if (!user || user.role !== 'admin') return jsonResponse({ error: '권한이 없습니다' }, 403);

  const body = await parseJsonBody(request);
  if (!body) return jsonResponse({ error: '잘못된 요청입니다' }, 400);
  const stmts = [];
  for (const [key, value] of Object.entries(body)) {
    stmts.push(
      db.prepare('INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)').bind(key, String(value))
    );
  }
  if (stmts.length > 0) await db.batch(stmts);
  return jsonResponse({ ok: true });
}

async function handleSiteInfo(db, env) {
  const regMode = await getRegistrationMode(db);
  return jsonResponse({
    registrationMode: regMode,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
  });
}

// Helper: get registration mode with backward compat
async function getRegistrationMode(db) {
  const modeSetting = await db.prepare("SELECT value FROM site_settings WHERE key = 'registration_mode'").first();
  if (modeSetting) return modeSetting.value; // 'open', 'invite', 'closed'
  // Backward compat: check old registration_open key
  const oldSetting = await db.prepare("SELECT value FROM site_settings WHERE key = 'registration_open'").first();
  if (oldSetting) return oldSetting.value === 'true' ? 'open' : 'closed';
  return 'open'; // default
}

// ===== Invite Code Endpoints =====

async function handleGetInviteCodes(request, db) {
  const user = await getSessionUser(request, db);
  if (!user || user.role !== 'admin') return jsonResponse({ error: '권한이 없습니다' }, 403);

  const rows = await db.prepare('SELECT code, max_uses, used_count, created_at FROM invite_codes ORDER BY created_at DESC').all();
  return jsonResponse(rows.results);
}

async function handleCreateInviteCodes(request, db) {
  const user = await getSessionUser(request, db);
  if (!user || user.role !== 'admin') return jsonResponse({ error: '권한이 없습니다' }, 403);

  const inviteBody = await parseJsonBody(request);
  if (!inviteBody) return jsonResponse({ error: '잘못된 요청입니다' }, 400);
  const { count = 1, maxUses = 1 } = inviteBody;
  const num = Math.min(Math.max(1, parseInt(count) || 1), 50);
  const uses = Math.max(1, parseInt(maxUses) || 1);

  const codes = [];
  const stmts = [];
  for (let i = 0; i < num; i++) {
    const code = generateInviteCode();
    codes.push(code);
    stmts.push(
      db.prepare('INSERT INTO invite_codes (code, max_uses, created_by) VALUES (?, ?, ?)').bind(code, uses, user.id)
    );
  }
  await db.batch(stmts);
  return jsonResponse({ codes });
}

async function handleDeleteInviteCode(request, db, code) {
  const user = await getSessionUser(request, db);
  if (!user || user.role !== 'admin') return jsonResponse({ error: '권한이 없습니다' }, 403);

  await db.prepare('DELETE FROM invite_codes WHERE code = ?').bind(code).run();
  return jsonResponse({ ok: true });
}

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

// ===== Helpers =====

function sessionCookie(token) {
  return `starship_session=${token}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=Lax`;
}

function jsonResponse(data, status = 200, setCookie = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...corsHeaders(),
  };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  return new Response(JSON.stringify(data), { status, headers });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

// ===== Security Helpers =====

function isPrivateHost(hostname) {
  // Block localhost and loopback
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === '[::1]' || lower === '0.0.0.0') return true;
  // Block .local domains
  if (lower.endsWith('.local') || lower.endsWith('.internal')) return true;
  // Block private IPv4 ranges
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [, a, b] = [null, parseInt(ipv4[1]), parseInt(ipv4[2])];
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local)
    if (a === 0) return true;                            // 0.0.0.0/8
    if (a === 127) return true;                          // 127.0.0.0/8
  }
  // Block IPv6 private ranges
  if (hostname.startsWith('[')) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    if (ipv6 === '::1' || ipv6 === '::' || ipv6.startsWith('fe80:') || ipv6.startsWith('fc') || ipv6.startsWith('fd')) return true;
  }
  return false;
}

// ===== R2 Cache Helpers =====

async function cacheKey(prefix, url) {
  const data = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}/${hex}`;
}

async function r2Get(bucket, key, ttlSeconds) {
  if (!bucket) return null;
  const obj = await bucket.get(key);
  if (!obj) return null;
  const cached = obj.customMetadata?.cachedAt;
  if (cached && (Date.now() - parseInt(cached)) > ttlSeconds * 1000) {
    // Expired — delete in background, return null
    bucket.delete(key).catch(() => {});
    return null;
  }
  return obj;
}

async function r2PutJson(bucket, key, data) {
  if (!bucket) return;
  await bucket.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { cachedAt: String(Date.now()) },
  });
}

// ===== Image Cache Proxy =====

async function handleImageCache(url, env) {
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing "url" parameter' }, 400);
  }

  let parsed;
  try { parsed = new URL(targetUrl); } catch {
    return jsonResponse({ error: 'Invalid URL' }, 400);
  }
  if (parsed.protocol !== 'https:') {
    return jsonResponse({ error: 'Only HTTPS URLs allowed' }, 400);
  }
  if (isPrivateHost(parsed.hostname)) {
    return jsonResponse({ error: 'Requests to private/internal addresses are not allowed' }, 403);
  }

  const bucket = env.STARSHIP_CACHE;
  const key = await cacheKey('img', targetUrl);

  // When the proxy can't deliver bytes (origin blocks our UA, returns a CF
  // challenge page, our datacenter IP is blocklisted, etc.), redirect the
  // browser to the original URL so it can fetch directly. This is what the
  // profile modal already does, and it works for Hollo's remote-pass-through
  // avatar URLs that fail through the worker.
  const directRedirect = () => new Response(null, {
    status: 302,
    headers: {
      'Location': targetUrl,
      'Cache-Control': 'no-store',
      ...corsHeaders(),
    },
  });

  // Check R2 cache — but only trust it if the body is non-empty. Earlier bugs
  // could have stored zero-byte responses that would now serve corrupt data.
  const cached = await r2Get(bucket, key, CACHE_TTL_IMAGE);
  if (cached && cached.size > 0) {
    const headers = {
      'Content-Type': cached.httpMetadata?.contentType || 'image/png',
      'Cache-Control': `public, max-age=${CACHE_TTL_IMAGE}`,
      'X-Cache': 'HIT',
      ...corsHeaders(),
    };
    return new Response(cached.body, { status: 200, headers });
  }

  // Fetch from origin
  try {
    const res = await fetch(targetUrl, {
      headers: {
        // Browser-like UA: many fediverse instances behind Cloudflare reject
        // unknown bot UAs with a JS challenge that the worker can't solve.
        'User-Agent': 'Mozilla/5.0 (compatible; StarShip/1.0; +https://starship.eeruwang.workers.dev)',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });

    if (!res.ok) {
      return directRedirect();
    }

    const contentType = res.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      // Likely an HTML challenge page — let the browser retry directly
      return directRedirect();
    }

    const contentLength = parseInt(res.headers.get('Content-Length') || '0');
    if (contentLength > CACHE_MAX_IMAGE_SIZE) {
      return directRedirect();
    }

    const imageData = await res.arrayBuffer();
    if (imageData.byteLength === 0) {
      return directRedirect();
    }
    if (imageData.byteLength > CACHE_MAX_IMAGE_SIZE) {
      return directRedirect();
    }

    // Store in R2 (non-blocking)
    if (bucket) {
      const putPromise = bucket.put(key, imageData, {
        httpMetadata: { contentType },
        customMetadata: { cachedAt: String(Date.now()), originalUrl: targetUrl },
      });
      // Use waitUntil if available, otherwise await
      putPromise.catch(() => {});
    }

    const headers = {
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${CACHE_TTL_IMAGE}`,
      'X-Cache': 'MISS',
      ...corsHeaders(),
    };
    return new Response(imageData, { status: 200, headers });
  } catch (err) {
    return directRedirect();
  }
}

// ===== OG Metadata =====

async function handleOgFetch(url, env) {
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing "url" parameter' }, 400);
  }

  let parsed;
  try { parsed = new URL(targetUrl); } catch {
    return jsonResponse({ error: 'Invalid URL' }, 400);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return jsonResponse({ error: 'Only HTTP(S) URLs allowed' }, 400);
  }
  if (isPrivateHost(parsed.hostname)) {
    return jsonResponse({ error: 'Requests to private/internal addresses are not allowed' }, 403);
  }

  // Check R2 cache
  const bucket = env.STARSHIP_CACHE;
  const key = await cacheKey('og', targetUrl);
  const cached = await r2Get(bucket, key, CACHE_TTL_OG);
  if (cached) {
    const data = await cached.json();
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400',
      'X-Cache': 'HIT',
      ...corsHeaders(),
    };
    return new Response(JSON.stringify(data), { status: 200, headers });
  }

  try {
    const hostname = parsed.hostname.replace(/^(?:www\.|m\.|mobile\.)/, '');

    // YouTube: direct thumbnail + oEmbed title (never fall through to generic fetch)
    if (hostname === 'youtube.com' || hostname === 'youtu.be') {
      const og = await fetchYoutubeOg(targetUrl);
      const result = og || { title: null, description: null, image: null, siteName: 'YouTube' };
      r2PutJson(bucket, key, result).catch(() => {});
      return ogResponse(result);
    }

    // X/Twitter: use oEmbed + crawl-friendly fetch
    if (hostname === 'twitter.com' || hostname === 'x.com') {
      const og = await fetchTwitterOg(targetUrl);
      if (og && (og.title || og.description)) {
        r2PutJson(bucket, key, og).catch(() => {});
        return ogResponse(og);
      }
    }

    // Generic: fetch HTML with bot UA (sites serve proper OG to crawlers)
    const response = await fetchAndParseOg(targetUrl);
    // Cache successful OG responses
    if (response.status === 200) {
      const cloned = response.clone();
      cloned.json().then(data => r2PutJson(bucket, key, data)).catch(() => {});
    }
    return response;
  } catch (err) {
    return jsonResponse({ error: `Fetch error: ${err.message}` }, 502);
  }
}

async function handleInstanceTheme(url, env) {
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing "url" parameter' }, 400);
  }

  let parsed;
  try { parsed = new URL(targetUrl); } catch {
    return jsonResponse({ error: 'Invalid URL' }, 400);
  }
  if (parsed.protocol !== 'https:') {
    return jsonResponse({ error: 'Only HTTPS URLs allowed' }, 400);
  }
  if (isPrivateHost(parsed.hostname)) {
    return jsonResponse({ error: 'Requests to private/internal addresses are not allowed' }, 403);
  }

  // Check R2 cache
  const bucket = env.STARSHIP_CACHE;
  const key = await cacheKey('theme', targetUrl);
  const cached = await r2Get(bucket, key, CACHE_TTL_THEME);
  if (cached) {
    const data = await cached.json();
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400',
      'X-Cache': 'HIT',
      ...corsHeaders(),
    };
    return new Response(JSON.stringify(data), { status: 200, headers });
  }

  try {
    const res = await fetch(targetUrl, {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'StarShip/1.0',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      return jsonResponse({ color: null });
    }
    const html = await readPartial(res, 32768);
    // Try CSS --color-accent variable first (Mastodon 4.x accent color)
    let color = null;
    const cssMatch = html.match(/--color-accent:\s*([^;}]+)/);
    if (cssMatch) {
      color = cssMatch[1].trim();
    }
    // Normalize rgb() to hex
    if (color) {
      const rgbMatch = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
      if (rgbMatch) {
        const toHex = v => parseInt(v).toString(16).padStart(2, '0');
        color = `#${toHex(rgbMatch[1])}${toHex(rgbMatch[2])}${toHex(rgbMatch[3])}`;
      }
    }
    // Fall back to theme-color meta tag
    if (!color) {
      color = extractMeta(html, 'theme-color', true, true);
    }
    const result = { color: color || null };
    // Cache the result
    r2PutJson(bucket, key, result).catch(() => {});
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400',
      'X-Cache': 'MISS',
      ...corsHeaders(),
    };
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch {
    return jsonResponse({ color: null });
  }
}

// YouTube: extract video ID for thumbnail, oEmbed for title (optional)
async function fetchYoutubeOg(url) {
  // Always extract video ID for a reliable thumbnail (no API needed)
  const vidMatch = url.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w\-]+)/);
  const videoId = vidMatch ? vidMatch[1] : null;
  const image = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;

  // Try oEmbed for title/description (may fail from Workers)
  let title = null;
  let description = null;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json();
      title = data.title || null;
      description = data.author_name || null;
    }
  } catch { /* oEmbed unavailable, continue with thumbnail only */ }

  // Return if we have at least an image or title
  if (title || image) {
    return { title, description, image, siteName: 'YouTube' };
  }
  return null;
}

// X/Twitter: oEmbed for text + attempt HTML fetch for image
async function fetchTwitterOg(url) {
  try {
    // Step 1: oEmbed for title/description
    let title = null, description = null, image = null;
    try {
      const oRes = await fetch(
        `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&format=json`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
      );
      if (oRes.ok) {
        const data = await oRes.json();
        const handle = data.author_url ? data.author_url.split('/').pop() : '';
        title = data.author_name ? `${data.author_name}${handle ? ' (@' + handle + ')' : ''}` : null;
        if (data.html) {
          const textMatch = data.html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
          if (textMatch) {
            description = textMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          }
        }
      }
    } catch { /* continue without oembed */ }

    // Step 2: try HTML fetch for og:image (X serves OG to known crawlers)
    try {
      const htmlRes = await fetch(url, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(5000),
      });
      if (htmlRes.ok) {
        const html = await readPartial(htmlRes, 65536);
        image = extractMeta(html, 'og:image') || extractMeta(html, 'twitter:image', true) || null;
        if (!title) title = extractMeta(html, 'og:title');
        if (!description) description = extractMeta(html, 'og:description');
      }
    } catch { /* use oembed data only */ }

    if (!title && !description) return null;
    return { title, description, image, siteName: 'X' };
  } catch { return null; }
}

// Generic HTML fetch + OG parse
async function fetchAndParseOg(targetUrl) {
  const res = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    return jsonResponse({ error: `Fetch failed: ${res.status}` }, 502);
  }

  const html = await readPartial(res, 65536);
  const og = {};

  og.title = extractMeta(html, 'og:title')
    || extractMeta(html, 'twitter:title', true)
    || null;
  og.description = extractMeta(html, 'og:description')
    || extractMeta(html, 'twitter:description', true)
    || null;
  og.image = extractMeta(html, 'og:image')
    || extractMeta(html, 'twitter:image', true)
    || extractMeta(html, 'twitter:image:src', true)
    || null;
  og.siteName = extractMeta(html, 'og:site_name')
    || null;

  // <title> fallback
  if (!og.title) {
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    og.title = titleTag ? decodeHtmlEntities(titleTag[1].trim()) : null;
  }
  // meta description fallback
  if (!og.description) {
    og.description = extractMeta(html, 'description', true, true);
  }

  return ogResponse(og);
}

// Read first N bytes from response
async function readPartial(res, maxBytes) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

// Extract meta tag content by property or name
function extractMeta(html, property, tryName = false, nameOnly = false) {
  const attrs = [];
  if (!nameOnly) attrs.push('property');
  if (tryName || nameOnly) attrs.push('name');

  for (const attr of attrs) {
    // pattern: attr="property" ... content="value"
    const p1 = new RegExp(`<meta[^>]*${attr}=["']${escapeRegex(property)}["'][^>]*content="([^"]*?)"`, 'i');
    const m1 = html.match(p1);
    if (m1) return decodeHtmlEntities(m1[1]);

    const p1s = new RegExp(`<meta[^>]*${attr}=["']${escapeRegex(property)}["'][^>]*content='([^']*?)'`, 'i');
    const m1s = html.match(p1s);
    if (m1s) return decodeHtmlEntities(m1s[1]);

    // pattern: content="value" ... attr="property"
    const p2 = new RegExp(`<meta[^>]*content="([^"]*?)"[^>]*${attr}=["']${escapeRegex(property)}["']`, 'i');
    const m2 = html.match(p2);
    if (m2) return decodeHtmlEntities(m2[1]);

    const p2s = new RegExp(`<meta[^>]*content='([^']*?)'[^>]*${attr}=["']${escapeRegex(property)}["']`, 'i');
    const m2s = html.match(p2s);
    if (m2s) return decodeHtmlEntities(m2s[1]);
  }
  return null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ogResponse(og) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=86400',
    ...corsHeaders(),
  };
  return new Response(JSON.stringify(og), { status: 200, headers });
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (m, c) => String.fromCharCode(parseInt(c)));
}

// ===== Proxy =====

async function handleProxy(request, url) {
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing "url" query parameter' }, 400);
  }

  let parsed;
  try { parsed = new URL(targetUrl); } catch {
    return jsonResponse({ error: 'Invalid target URL' }, 400);
  }
  if (parsed.protocol !== 'https:') {
    return jsonResponse({ error: 'Only HTTPS targets are allowed' }, 400);
  }
  if (isPrivateHost(parsed.hostname)) {
    return jsonResponse({ error: 'Requests to private/internal addresses are not allowed' }, 403);
  }
  // Prevent self-proxy loops
  const selfHost = new URL(request.url).hostname;
  if (parsed.hostname === selfHost) {
    return jsonResponse({ error: 'Cannot proxy to self' }, 400);
  }
  if (!isAllowedApiPath(parsed.pathname)) {
    return jsonResponse({ error: 'Blocked: path not in allowlist' }, 403);
  }

  try {
    const proxyHeaders = new Headers();
    // Browser-like UA: avoids Cloudflare bot challenges on protected fediverse
    // instances (Hollo, Mastodon-compat behind CF). Matches the /cache/image
    // proxy's UA so all fediverse-bound subrequests look consistent.
    proxyHeaders.set('User-Agent', 'Mozilla/5.0 (compatible; StarShip/1.0; +https://starship.eeruwang.workers.dev)');
    proxyHeaders.set('Accept', 'application/json');

    const authHeader = request.headers.get('Authorization');
    if (authHeader) proxyHeaders.set('Authorization', authHeader);

    const contentType = request.headers.get('Content-Type');
    if (contentType) proxyHeaders.set('Content-Type', contentType);

    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (contentType && contentType.includes('multipart/form-data')) {
        body = await request.arrayBuffer();
      } else {
        body = await request.text();
      }
    }

    // Bound the upstream wait. Without this a hanging fediverse instance ties
    // up the worker request until Cloudflare's hard subrequest limit (~30s),
    // burning request budget and slowing concurrent users of the same worker.
    const proxyRes = await fetch(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      body,
      signal: AbortSignal.timeout(15000),
    });

    const responseHeaders = new Headers(proxyRes.headers);
    for (const [key, value] of Object.entries(corsHeaders())) {
      responseHeaders.set(key, value);
    }

    return new Response(proxyRes.body, {
      status: proxyRes.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return jsonResponse({ error: `Proxy error: ${err.message}` }, 502);
  }
}

function isAllowedApiPath(pathname) {
  const allowed = [
    /^\/api\/v[12]\//,       // Mastodon API
    /^\/oauth\//,             // Mastodon OAuth
    /^\/api\//,               // Misskey API (broad, covers all /api/* endpoints)
    /^\/.well-known\//,       // WebFinger, NodeInfo (platform detection)
    /^\/nodeinfo\//,          // NodeInfo (platform detection)
  ];
  return allowed.some((re) => re.test(pathname));
}
