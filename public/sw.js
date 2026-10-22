// This worker never caches business data, account pages, API responses or mutations.
const CACHE_PREFIX = 'dinfon-public-offline-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const OFFLINE_PATH = '/offline.html';

async function prepareOfflinePage() {
  try {
    const response = await fetch(new Request(new URL(OFFLINE_PATH, self.location.origin), {
      cache: 'reload', credentials: 'omit', redirect: 'error',
    }));
    // A hosting login/error page must never be stored as an offline response.
    if (!response.ok || !response.headers.get('Content-Type')?.includes('text/html')) return;
    if (!(await response.clone().text()).includes('data-dinfon-offline="v1"')) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(OFFLINE_PATH, response);
  } catch {
    // Installation can still finish; fallbackResponse also works without a cache entry.
  }
}

function fallbackResponse() {
  return new Response('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接后继续 · 鼎峰协同</title><body><h1>连接网络后继续</h1><p>暂时无法连接鼎峰协同。请检查网络，然后重试。</p><a href="/">重新连接</a></body></html>', {
    status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(prepareOfflinePage().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // API/auth paths, static files, cross-origin traffic and writes are not intercepted.
  if (request.method !== 'GET' || request.mode !== 'navigate' || url.origin !== self.location.origin || url.pathname !== '/') return;
  event.respondWith(fetch(request).catch(async () => {
    try {
      const offline = await (await caches.open(CACHE_NAME)).match(OFFLINE_PATH);
      return offline || fallbackResponse();
    } catch {
      return fallbackResponse();
    }
  }));
});
