/* Service Worker — 페이지 이미지 영구 캐시 */
const CACHE = 'pages-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  if (!e.request.url.includes('/static/pages/page_')) return;
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        if (cached) return cached;                          // 캐시 히트 → 즉시
        return fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());   // 캐시 저장
          return res;
        });
      })
    )
  );
});
