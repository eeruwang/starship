/**
 * StarShip Cloudflare Worker
 *
 * 역할:
 * 1. 정적 파일 서빙 (wrangler assets 바인딩이 자동 처리)
 * 2. /proxy/* 경로로 들어오는 요청을 Fediverse 인스턴스에 프록시
 *    → 브라우저 CORS 제한을 우회합니다.
 *
 * 프록시 사용법:
 *   GET  /proxy?url=https://mastodon.social/api/v1/timelines/home&token=xxx
 *   POST /proxy?url=https://misskey.io/api/notes/timeline  (body 그대로 전달)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API 프록시 요청 처리
    if (url.pathname === '/proxy') {
      return handleProxy(request, url);
    }

    // 그 외: 정적 파일은 assets 바인딩이 자동 처리
    // (wrangler.toml의 [assets] 설정에 의해)
    return env.ASSETS.fetch(request);
  },
};

async function handleProxy(request, url) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing "url" query parameter' }, 400);
  }

  // URL 유효성 검사
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return jsonResponse({ error: 'Invalid target URL' }, 400);
  }

  // HTTPS만 허용
  if (parsed.protocol !== 'https:') {
    return jsonResponse({ error: 'Only HTTPS targets are allowed' }, 400);
  }

  // 허용 API 경로 패턴 검증 (보안)
  if (!isAllowedApiPath(parsed.pathname)) {
    return jsonResponse({ error: 'Blocked: path not in allowlist' }, 403);
  }

  try {
    // 원본 요청의 헤더 추출 (Authorization 등)
    const proxyHeaders = new Headers();
    proxyHeaders.set('User-Agent', 'StarShip/1.0');
    proxyHeaders.set('Accept', 'application/json');

    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      proxyHeaders.set('Authorization', authHeader);
    }

    const contentType = request.headers.get('Content-Type');
    if (contentType) {
      proxyHeaders.set('Content-Type', contentType);
    }

    // 요청 본문 (POST 등)
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // For multipart form data (file uploads), pass the body as-is
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

    // 응답을 클라이언트에 전달 + CORS 헤더 추가
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

/**
 * Fediverse API 경로만 허용 (보안을 위해)
 */
function isAllowedApiPath(pathname) {
  const allowed = [
    // Mastodon API
    /^\/api\/v[12]\//,
    /^\/oauth\//,
    // Misskey / Iceshrimp / CherryPick API
    /^\/api\//,
  ];
  return allowed.some((re) => re.test(pathname));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}
