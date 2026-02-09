/**
 * StarShip Cloudflare Worker
 *
 * 역할:
 * 1. 정적 파일 서빙 (wrangler assets 바인딩이 자동 처리)
 * 2. /proxy 경로로 들어오는 요청을 Fediverse 인스턴스에 프록시
 * 3. /api/auth/* 회원가입/로그인/세션 관리
 * 4. /api/sync/* 계정·설정 클라우드 저장/불러오기
 */

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight for all /api/ routes
    if (request.method === 'OPTIONS' && (url.pathname.startsWith('/api/') || url.pathname === '/proxy')) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Proxy
    if (url.pathname === '/proxy') {
      return handleProxy(request, url);
    }

    // Auth & sync API
    if (url.pathname.startsWith('/api/')) {
      await ensureTables(env.FEDI_ACCOUNTS);
      return handleApi(request, url, env);
    }

    // Static files
    return env.ASSETS.fetch(request);
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

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function getSessionUser(request, db) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/starship_session=([a-f0-9]+)/);
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
  const { username, password, turnstileToken, inviteCode } = await request.json();

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
  if (password.length < 6) {
    return jsonResponse({ error: '비밀번호는 6자 이상이어야 합니다' }, 400);
  }

  // Verify Turnstile
  const turnstileSecret = env.TURNSTILE_SECRET;
  if (turnstileSecret) {
    if (!turnstileToken) {
      return jsonResponse({ error: '인간 확인을 완료해주세요' }, 400);
    }
    const verifyRes = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: turnstileSecret, response: turnstileToken }),
    });
    const verifyData = await verifyRes.json();
    if (!verifyData.success) {
      return jsonResponse({ error: '인간 확인에 실패했습니다. 다시 시도해주세요' }, 403);
    }
  }

  const existing = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) {
    return jsonResponse({ error: '이미 사용 중인 아이디입니다' }, 409);
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

  // Increment invite code usage
  if (regMode === 'invite' && inviteCode) {
    await db.prepare('UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?').bind(inviteCode.trim()).run();
  }

  // Fetch actual role (first user is auto-promoted to admin by ensureTables)
  const newUser = await db.prepare('SELECT role FROM users WHERE id = ?').bind(userId).first();
  return jsonResponse({ ok: true, username, role: newUser?.role || 'user' }, 201, sessionCookie(token));
}

async function handleLogin(request, db) {
  const { username, password } = await request.json();
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

  // Clean up old sessions
  await db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < datetime('now')").bind(user.id).run();

  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL * 1000).toISOString();
  await db.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, user.id, expiresAt).run();

  return jsonResponse({ ok: true, username: user.username, role: user.role }, 200, sessionCookie(token));
}

async function handleLogout(request, db) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/starship_session=([a-f0-9]+)/);
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

  const body = await request.json();
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

  const body = await request.json();
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

  const { count = 1, maxUses = 1 } = await request.json();
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
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
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
  if (!isAllowedApiPath(parsed.pathname)) {
    return jsonResponse({ error: 'Blocked: path not in allowlist' }, 403);
  }

  try {
    const proxyHeaders = new Headers();
    proxyHeaders.set('User-Agent', 'StarShip/1.0');
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

    const proxyRes = await fetch(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      body,
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
    /^\/api\/v[12]\//,
    /^\/oauth\//,
    /^\/api\//,
  ];
  return allowed.some((re) => re.test(pathname));
}
