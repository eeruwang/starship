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

const MASTODON_SCOPES = 'read write follow push';

export async function startMastodonOAuth(instanceUrl, popup) {
  instanceUrl = instanceUrl.replace(/\/+$/, '');

  // 1. 앱 등록
  const appRes = await fetch(buildFetchUrl(`${instanceUrl}/api/v1/apps`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: APP_NAME,
      redirect_uris: CALLBACK_URL,
      scopes: MASTODON_SCOPES,
      website: APP_WEBSITE,
    }),
  });

  if (!appRes.ok) {
    throw new Error(`앱 등록 실패 (${appRes.status})`);
  }

  const app = await appRes.json();

  // 2. 인증 정보 임시 저장
  savePendingAuth({
    platform: 'mastodon',
    instanceUrl,
    clientId: app.client_id,
    clientSecret: app.client_secret,
  });

  // 3. 인증 페이지로 이동
  const authUrl = `${instanceUrl}/oauth/authorize?` + new URLSearchParams({
    client_id: app.client_id,
    redirect_uri: CALLBACK_URL,
    response_type: 'code',
    scope: MASTODON_SCOPES,
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
  'write:account',
  'write:drive',
  'write:favorites',
  'write:following',
  'write:notes',
  'write:reactions',
  'write:votes',
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

  const popup = window.open(
    url,
    'starship_auth',
    `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
  );

  if (!popup) {
    // 팝업 차단 시 현재 탭에서 리다이렉트
    window.location.href = url;
    return null;
  }

  return popup;
}

export function savePendingAuth(data) {
  localStorage.setItem(PENDING_AUTH_KEY, JSON.stringify(data));
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
