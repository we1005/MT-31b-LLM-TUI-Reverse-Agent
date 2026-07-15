// rev-agent showcase Service Worker — 离线可用(首次访问后)
// 策略: 导航=network-first(离线回退缓存/首页), 静态资源=stale-while-revalidate
const CACHE = 'rev-agent-v1'
const SHELL = [
  './', './index.html', './docs.html', './wiki.html', './tutorial.html',
  './manifest.webmanifest', './favicon.svg',
  './icons/icon-192.png', './icons/icon-512.png',
]
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})
self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return // 跨域(字体CDN等)交给浏览器
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r })
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html'))),
    )
    return
  }
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((r) => {
        if (r && r.status === 200) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)) }
        return r
      }).catch(() => cached)
      return cached || net
    }),
  )
})
