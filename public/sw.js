// Service worker: застосунок відкривається без інтернету + приймає push-сповіщення.
// Після зміни списку файлів збільш VERSION.
const VERSION = 'v26';
const CACHE = 'habits-' + VERSION;
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/css/intro.css',
  '/js/app.js',
  '/js/db.js',
  '/js/sync.js',
  '/js/notify.js',
  '/js/sleepcore.js',
  '/js/intro.js',
  '/js/motion.js',
  '/js/vendor/anime.es.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/badge-96.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('habits-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Stale-while-revalidate: миттєво віддаємо з кешу (працює офлайн),
// а у фоні тягнемо свіжу версію — вона з'явиться при наступному відкритті.
async function swr(request, cacheKey) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(cacheKey || request, { ignoreSearch: true });
  const network = fetch(request).then((res) => {
    if (res && res.ok) cache.put(cacheKey || request, res.clone());
    return res;
  }).catch(() => null);
  if (cached) return cached;
  const res = await network;
  return res || new Response('Офлайн', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // дані — тільки через мережу, офлайн їх тримає IndexedDB
  if (req.mode === 'navigate') {
    event.respondWith(swr(req, '/index.html'));
    return;
  }
  event.respondWith(swr(req));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Звички';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Не забудь відмітити звички на сьогодні.',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: data.tag || 'daily-reminder',
    renotify: true,
    data: { url: data.url || '/?tab=today' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        const tab = new URL(target, self.location.origin).searchParams.get('tab') || 'today';
        c.postMessage({ type: 'open-tab', tab });
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
