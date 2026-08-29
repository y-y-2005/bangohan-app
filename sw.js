// 修正版 Service Worker
// 旧版は cache-first だったため、app.js を直しても端末に古いコードが配信され続けた。
const CACHE_NAME = 'bangohan-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 同期API等の外部リクエストには一切介入しない
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  // network-first: 最新のコードを優先し、通信不可のときだけキャッシュを使う
  event.respondWith(
    fetch(event.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
