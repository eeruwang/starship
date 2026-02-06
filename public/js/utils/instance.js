/**
 * Instance URL / platform helpers.
 */

const useProxy = typeof window !== 'undefined' && window.location.hostname !== 'localhost';

export function buildFetchUrl(targetUrl) {
  return useProxy ? `/proxy?url=${encodeURIComponent(targetUrl)}` : targetUrl;
}

export function normalizeInstanceUrl(rawUrl) {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    throw new Error('인스턴스 URL을 입력하세요.');
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);

  if (!url.hostname) {
    throw new Error('올바른 인스턴스 URL 형식이 아닙니다.');
  }

  url.pathname = '';
  url.search = '';
  url.hash = '';

  return url.toString().replace(/\/+$/, '');
}

async function fetchJson(url, options = {}) {
  const res = await fetch(buildFetchUrl(url), options);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export async function detectPlatform(instanceUrl) {
  const normalized = normalizeInstanceUrl(instanceUrl);

  const nodeInfoRoot = await fetchJson(`${normalized}/.well-known/nodeinfo`);
  const links = nodeInfoRoot?.links || [];
  for (const link of links) {
    if (!link.href) continue;
    const nodeInfo = await fetchJson(link.href);
    const name = (nodeInfo?.software?.name || '').toLowerCase();
    if (name.includes('mastodon')) return 'mastodon';
    if (name.includes('iceshrimp')) return 'iceshrimp';
    if (name.includes('cherrypick')) return 'cherrypick';
    if (name.includes('misskey')) return 'misskey';
  }

  const mastodonInfo = await fetchJson(`${normalized}/api/v1/instance`);
  if (mastodonInfo) return 'mastodon';

  const misskeyMeta = await fetchJson(`${normalized}/api/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (misskeyMeta) {
    const name = (misskeyMeta.softwareName || misskeyMeta.name || '').toLowerCase();
    if (name.includes('iceshrimp')) return 'iceshrimp';
    if (name.includes('cherrypick')) return 'cherrypick';
    return 'misskey';
  }

  throw new Error('플랫폼을 자동으로 감지하지 못했습니다. 메뉴에서 직접 선택해 주세요.');
}

