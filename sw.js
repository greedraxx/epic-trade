// 앱 셸만 캐시한다(네트워크 우선, 실패 시 캐시). 시세 데이터(Bybit)는 건드리지 않는다.
const CACHE = 'epic-trade-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/bybit/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request))
  );
});
