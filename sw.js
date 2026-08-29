// bangohan-app / sw.js
//
// 旧版(v1, v2)は cache-first だったため、app.js を更新しても端末に
// 古いコードが配信され続けた。この版は「一切キャッシュしない」。
//
// - fetch ハンドラを持たないので、すべての通信が素通りする
// - activate 時に過去のキャッシュを全削除する
// - skipWaiting + clients.claim で即時に旧版を置き換える
//
// PWA としてのホーム画面追加は manifest.json 側で成立するため、
// この Service Worker のままでも「アプリとして追加」は引き続き可能。
// オフライン対応は、同期が安定してから改めて入れること。

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// fetch ハンドラは意図的に登録しない。
// これにより、すべてのリクエストがネットワークへ直接届く。
