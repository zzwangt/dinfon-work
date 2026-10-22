import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const publicUrl = new URL('../public/', import.meta.url);
const workerSource = await readFile(new URL('sw.js', publicUrl), 'utf8');
const clientSource = await readFile(new URL('client/pwa.js', publicUrl), 'utf8');
const offlineHtml = await readFile(new URL('offline.html', publicUrl), 'utf8');
const CACHE = 'dinfon-public-offline-v1';

function workerHarness(fetcher = async () => new Response(offlineHtml, { headers: { 'Content-Type': 'text/html' } })) {
  const listeners = new Map();
  const stores = new Map();
  const fetchCalls = [];
  const deleted = [];
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const cache = stores.get(name);
      return {
        async put(path, response) { cache.set(path, response.clone()); },
        async match(path) { return cache.get(path)?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deleted.push(name); return stores.delete(name); },
  };
  const state = { claims: 0, skips: 0 };
  const context = vm.createContext({
    URL, Request, Response, caches,
    fetch: async (request) => { fetchCalls.push(request); return fetcher(request); },
    self: {
      location: { origin: 'https://work.example.test' },
      addEventListener: (name, listener) => listeners.set(name, listener),
      skipWaiting: async () => { state.skips++; },
      clients: { claim: async () => { state.claims++; } },
    },
  });
  vm.runInContext(workerSource, context);
  return {
    stores, fetchCalls, deleted, state,
    async lifecycle(name) {
      let work;
      listeners.get(name)({ waitUntil: (promise) => { work = promise; } });
      await work;
    },
    async request(path = '/', { method = 'GET', mode = 'navigate', origin = 'https://work.example.test' } = {}) {
      let response;
      let intercepted = false;
      const request = { url: new URL(path, origin).href, method, mode };
      listeners.get('fetch')({ request, respondWith: (promise) => { intercepted = true; response = promise; } });
      return { intercepted, response: await response };
    },
  };
}

function clientHarness({ standalone = false, secure = true } = {}) {
  const events = new Map();
  const documentEvents = new Map();
  const registrations = [];
  const media = { matches: standalone, addEventListener() {} };
  const context = vm.createContext({
    window: {
      isSecureContext: secure,
      matchMedia: () => media,
      addEventListener: (name, callback) => events.set(name, callback),
    },
    navigator: { serviceWorker: { register: async (...args) => { registrations.push(args); } } },
    document: {
      querySelectorAll: () => [],
      addEventListener: (name, callback) => documentEvents.set(name, callback),
    },
  });
  vm.runInContext(clientSource.replace(/^export /gm, ''), context);
  return { context, events, documentEvents, registrations, media };
}

test('PWA manifest stays on the deployment origin with correctly sized local icons', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', publicUrl), 'utf8'));
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.name, '鼎峰协同');
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
  for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
    assert.match(icon.src, /^\/icons\/[a-z0-9-]+\.png$/);
    const png = await readFile(new URL(icon.src.slice(1), publicUrl));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
  const index = await readFile(new URL('client/index.html', publicUrl), 'utf8');
  assert.match(index, /rel="manifest" href="\/manifest.webmanifest"/);
  assert.match(index, /apple-touch-icon/);
  assert.match(index, /viewport-fit=cover/);
  assert.match(index, /interactive-widget=resizes-content/);
  assert.doesNotMatch(index, /user-scalable=no|maximum-scale=1/);
});

test('service worker installation caches only the marked generic offline page, with no credentials', async () => {
  const worker = workerHarness();
  await worker.lifecycle('install');
  assert.deepEqual([...worker.stores.keys()], [CACHE]);
  assert.deepEqual([...worker.stores.get(CACHE).keys()], ['/offline.html']);
  assert.equal(worker.fetchCalls.length, 1);
  assert.equal(worker.fetchCalls[0].credentials, 'omit');
  assert.equal(worker.fetchCalls[0].redirect, 'error');
  assert.equal(worker.fetchCalls[0].cache, 'reload');
  assert.equal(worker.state.skips, 1);
});

test('service worker refuses to cache a login or hosting error response', async () => {
  for (const response of [
    new Response('<html>Login with a private email</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response(offlineHtml, { status: 403, headers: { 'Content-Type': 'text/html' } }),
    new Response('{"private":true}', { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const worker = workerHarness(async () => response);
    await worker.lifecycle('install');
    assert.equal(worker.stores.size, 0);
  }
});

test('service worker bypasses API, auth, static requests, other origins and mutations', async () => {
  const worker = workerHarness(async () => { throw new Error('must not be fetched by worker'); });
  for (const [path, options] of [
    ['/api/session', {}], ['/api/state', {}], ['/api/auth/login', { method: 'POST' }],
    ['/api/actions', { method: 'POST' }], ['/signin', {}], ['/signout', {}],
    ['/auth/callback', {}], ['/client/app.js', { mode: 'cors' }],
    ['/', { method: 'POST' }], ['/', { mode: 'cors' }], ['/', { origin: 'https://elsewhere.test' }],
  ]) {
    assert.equal((await worker.request(path, options)).intercepted, false, `${path} must bypass the worker`);
  }
  assert.equal(worker.fetchCalls.length, 0);
  assert.equal(worker.stores.size, 0);
});

test('successful app navigation and authentication failures are returned without caching', async () => {
  for (const status of [200, 401, 403, 500]) {
    const worker = workerHarness(async () => new Response('account-specific content', { status }));
    const result = await worker.request('/?private-query=value');
    assert.equal(result.intercepted, true);
    assert.equal(result.response.status, status);
    assert.equal(await result.response.text(), 'account-specific content');
    assert.equal(worker.stores.size, 0);
  }
});

test('failed root navigation returns only the generic offline page, never a prior account page', async () => {
  let online = true;
  const worker = workerHarness(async (request) => {
    if (!online) throw new TypeError('offline');
    return new Response(request.url.endsWith('/offline.html') ? offlineHtml : 'private project data', { headers: { 'Content-Type': 'text/html' } });
  });
  await worker.lifecycle('install');
  await worker.request('/');
  online = false;
  const result = await worker.request('/');
  const text = await result.response.text();
  assert.match(text, /连接网络后继续/);
  assert.doesNotMatch(text, /private project data/);
  assert.deepEqual([...worker.stores.get(CACHE).keys()], ['/offline.html']);
});

test('offline startup has a no-store fallback even when the offline cache was never populated', async () => {
  const worker = workerHarness(async () => { throw new TypeError('offline'); });
  await worker.lifecycle('install');
  const result = await worker.request('/');
  assert.equal(result.response.status, 503);
  assert.equal(result.response.headers.get('Cache-Control'), 'no-store');
  assert.match(await result.response.text(), /连接网络后继续/);
});

test('worker upgrade removes only obsolete caches belonging to this offline fallback', async () => {
  const worker = workerHarness();
  worker.stores.set('unrelated-application', new Map());
  worker.stores.set('dinfon-public-offline-v0', new Map());
  worker.stores.set(CACHE, new Map());
  await worker.lifecycle('activate');
  assert.deepEqual(worker.deleted, ['dinfon-public-offline-v0']);
  assert.equal(worker.stores.has('unrelated-application'), true);
  assert.equal(worker.state.claims, 1);
});

test('install card offers manual browser steps without inventing installation support', () => {
  const client = clientHarness();
  const html = client.context.renderInstallCard();
  assert.match(html, /iPhone \/ iPad/);
  assert.match(html, /Android/);
  assert.match(html, /data-action="pwa-install" hidden/);
  assert.match(html, /data-pwa-installed hidden/);
  assert.match(html, /使用时需要联网/);
  assert.doesNotMatch(clientSource, /userAgent/);
});

test('PWA initialization is idempotent and service worker registration requires secure context', () => {
  const client = clientHarness();
  client.context.initPWA();
  client.context.initPWA();
  assert.equal(client.registrations.length, 1);
  assert.equal(client.registrations[0][0], '/sw.js');
  assert.equal(client.registrations[0][1].scope, '/');
  assert.equal(client.registrations[0][1].updateViaCache, 'none');
  const insecure = clientHarness({ secure: false });
  insecure.context.initPWA();
  assert.equal(insecure.registrations.length, 0);
});

test('accepting a prompt is pending until the browser confirms appinstalled', async () => {
  const client = clientHarness();
  client.context.initPWA();
  let prompts = 0;
  let prevented = false;
  client.events.get('beforeinstallprompt')({
    preventDefault() { prevented = true; },
    async prompt() { prompts++; },
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  });
  assert.equal(prevented, true);
  assert.doesNotMatch(client.context.renderInstallCard(), /data-action="pwa-install" hidden/);
  await client.context.requestInstall();
  assert.equal(prompts, 1);
  assert.match(client.context.renderInstallCard(), /已确认安装请求/);
  assert.match(client.context.renderInstallCard(), /data-pwa-installed hidden/);
  client.events.get('appinstalled')();
  assert.doesNotMatch(client.context.renderInstallCard(), /data-pwa-installed hidden/);
});

test('dismissed prompts remain uninstalled and cannot be replayed', async () => {
  const client = clientHarness();
  client.context.initPWA();
  let prompts = 0;
  client.events.get('beforeinstallprompt')({
    preventDefault() {},
    async prompt() { prompts++; },
    userChoice: Promise.resolve({ outcome: 'dismissed' }),
  });
  await client.context.requestInstall();
  await client.context.requestInstall();
  assert.equal(prompts, 1);
  assert.match(client.context.renderInstallCard(), /已取消安装/);
  assert.match(client.context.renderInstallCard(), /data-pwa-installed hidden/);
});
