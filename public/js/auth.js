/**
 * OAuth / MiAuth 인증 모듈
 *
 * Mastodon: OAuth 2.0 (앱 등록 → authorize → code 교환)
 * Misskey / Iceshrimp / CherryPick: MiAuth (세션 → 인증 → 토큰 확인)
 */

const CALLBACK_URL = `${window.location.origin}/callback.html`;
const APP_NAME = 'StarShip';
const APP_WEBSITE = window.location.origin;
const PENDING_AUTH_KEY = 'starship_pending_auth';

// Worker 프록시 사용 여부
const useProxy = window.location.hostname !== 'localhost';

function buildFetchUrl(targetUrl) {
  return useProxy ? `/proxy?url=${encodeURIComponent(targetUrl)}` : targetUrl;
}

// ===== Mastodon OAuth 2.0 =====

// 어드민 스코프 표기가 서버 버전마다 다르므로 여러 형태를 순서대로 시도한다.
// 폴백 없이 admin 을 반드시 포함하도록 — non-admin 만으로 등록되면 어드민 이모지
// 가져오기 기능이 아예 불가능해지기 때문.
const MASTODON_SCOPE_ATTEMPTS = [
  // Mastodon 4.3+ 세분화 스코프
  'read write follow push admin:read:custom_emojis admin:write:custom_emojis',
  // Mastodon 4.0~4.2 폭넓은 어드민 스코프
  'read write follow push admin:read admin:write',
  // 최광의 admin (일부 fork)
  'read write follow push admin',
];

export async function startMastodonOAuth(instanceUrl, popup) {
  instanceUrl = instanceUrl.replace(/\/+$/, '');

  // 1. 앱 등록 — 어드민 스코프 조합을 순서대로 시도. 모두 실패면 명확히 throw.
  let app = null;
  let usedScope = null;
  const failures = [];
  for (const scope of MASTODON_SCOPE_ATTEMPTS) {
    const res = await fetch(buildFetchUrl(`${instanceUrl}/api/v1/apps`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: APP_NAME,
        redirect_uris: CALLBACK_URL,
        scopes: scope,
        website: APP_WEBSITE,
      }),
    });
    if (res.ok) {
      app = await res.json();
      usedScope = scope;
      break;
    }
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (_) {}
    failures.push(`[${res.status}] ${scope} — ${detail}`);
    // 400/422 (invalid scope) 이면 다음 후보. 그 외 (네트워크·5xx) 는 즉시 중단.
    if (res.status !== 422 && res.status !== 400) {
      throw new Error(`앱 등록 실패 (${res.status})\n${detail}`);
    }
  }
  if (!app) {
    throw new Error(
      '앱 등록 실패: 이 Mastodon 서버가 admin 스코프를 지원하지 않습니다.\n'
      + '서버 버전을 확인하거나(4.0+ 권장) 관리자에게 문의하세요.\n\n'
      + failures.join('\n')
    );
  }

  // 2. 인증 정보 임시 저장 (실제 쓴 scope 도 함께 저장 — authorize 랑 맞춰야 함)
  savePendingAuth({
    platform: 'mastodon',
    instanceUrl,
    clientId: app.client_id,
    clientSecret: app.client_secret,
    scope: usedScope,
  });

  // 3. 인증 페이지로 이동
  const authUrl = `${instanceUrl}/oauth/authorize?` + new URLSearchParams({
    client_id: app.client_id,
    redirect_uri: CALLBACK_URL,
    response_type: 'code',
    scope: usedScope,
  }).toString();

  if (popup) {
    popup.location.href = authUrl;
  } else {
    window.location.href = authUrl;
  }
  return popup;
}

export async function completeMastodonOAuth(code, pending) {
  // code → access_token 교환 (OAuth 2.0 spec: application/x-www-form-urlencoded)
  const tokenRes = await fetch(buildFetchUrl(`${pending.instanceUrl}/oauth/token`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: pending.clientId,
      client_secret: pending.clientSecret,
      redirect_uri: CALLBACK_URL,
      code,
    }).toString(),
  });

  if (!tokenRes.ok) {
    throw new Error(`토큰 교환 실패 (${tokenRes.status})`);
  }

  const token = await tokenRes.json();
  return {
    platform: 'mastodon',
    instanceUrl: pending.instanceUrl,
    accessToken: token.access_token,
  };
}

// ===== Misskey MiAuth (Misskey / Iceshrimp / CherryPick) =====

const MISSKEY_PERMISSIONS = [
  'read:account',
  'read:blocks',
  'read:drive',
  'read:favorites',
  'read:following',
  'read:mutes',
  'read:notifications',
  'read:reactions',
  'read:pages',
  'write:account',
  'write:pages',
  'write:drive',
  'write:favorites',
  'write:following',
  'write:notes',
  'write:reactions',
  'write:votes',
  // 어드민 이모지 관리 (관리자 계정에서만 실제 권한 부여됨. 일반 사용자는 무시)
  'read:admin:emoji',
  'write:admin:emoji',
].join(',');

export async function startMiAuth(instanceUrl, platform, popup) {
  instanceUrl = instanceUrl.replace(/\/+$/, '');

  const sessionId = crypto.randomUUID();

  savePendingAuth({
    platform,
    instanceUrl,
    sessionId,
  });

  const authUrl = `${instanceUrl}/miauth/${sessionId}?` + new URLSearchParams({
    name: APP_NAME,
    callback: CALLBACK_URL,
    permission: MISSKEY_PERMISSIONS,
  }).toString();

  if (popup) {
    popup.location.href = authUrl;
  } else {
    window.location.href = authUrl;
  }
  return popup;
}

export async function completeMiAuth(sessionId, pending) {
  const checkRes = await fetch(buildFetchUrl(`${pending.instanceUrl}/api/miauth/${sessionId}/check`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  if (!checkRes.ok) {
    throw new Error(`MiAuth 확인 실패 (${checkRes.status})`);
  }

  const result = await checkRes.json();

  if (!result.token) {
    throw new Error('인증이 완료되지 않았습니다. 다시 시도해주세요.');
  }

  return {
    platform: pending.platform,
    instanceUrl: pending.instanceUrl,
    accessToken: result.token,
  };
}

// ===== 공통 유틸 =====

export function openAuthPopup(url) {
  const width = 600;
  const height = 700;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;

  // Use a unique target name per call so two concurrent OAuth attempts (e.g.
  // user clicks "로그인으로 연결" again while the first popup is open) don't
  // collide and replace each other's URL.
  const targetName = `starship_auth_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const popup = window.open(
    url,
    targetName,
    `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,noopener=no`
  );

  if (!popup) {
    // 팝업 차단 시 현재 탭에서 리다이렉트
    window.location.href = url;
    return null;
  }

  return popup;
}

export function savePendingAuth(data) {
  try { localStorage.setItem(PENDING_AUTH_KEY, JSON.stringify(data)); } catch {}
}

export function loadPendingAuth() {
  try {
    const data = localStorage.getItem(PENDING_AUTH_KEY);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

export function clearPendingAuth() {
  localStorage.removeItem(PENDING_AUTH_KEY);
}

/**
 * 메인 페이지에서 호출: postMessage + localStorage 폴링 병행
 * (COOP 헤더나 팝업 차단으로 window.opener가 끊길 수 있으므로 이중 채널 사용)
 */
export function waitForAuthCallback() {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      settled = true;
      window.removeEventListener('message', handleMessage);
      clearInterval(pollTimer);
    };

    // Channel 1: postMessage
    const handleMessage = (event) => {
      if (settled) return;
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'starship_auth_complete') {
        cleanup();
        localStorage.removeItem('starship_auth_result');
        resolve(event.data.result);
      } else if (event.data?.type === 'starship_auth_error') {
        cleanup();
        localStorage.removeItem('starship_auth_error');
        reject(new Error(event.data.error));
      }
    };
    window.addEventListener('message', handleMessage);

    // Channel 2: localStorage polling (fallback)
    const pollTimer = setInterval(() => {
      if (settled) return;
      const result = localStorage.getItem('starship_auth_result');
      if (result) {
        localStorage.removeItem('starship_auth_result');
        cleanup();
        try {
          resolve(JSON.parse(result));
        } catch {
          reject(new Error('인증 결과를 파싱할 수 없습니다.'));
        }
        return;
      }
      const error = localStorage.getItem('starship_auth_error');
      if (error) {
        localStorage.removeItem('starship_auth_error');
        cleanup();
        reject(new Error(error));
      }
    }, 500);

    // 5분 타임아웃
    setTimeout(() => {
      if (!settled) {
        cleanup();
        reject(new Error('인증 시간이 초과되었습니다.'));
      }
    }, 300000);
  });
}
