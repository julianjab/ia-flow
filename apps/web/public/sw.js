// Service worker de la PWA: lo que pide Chrome para «Instalar app», y que abra sin red con la última versión que
// cargó. Red primero; la caché sólo si no hay conexión. La API (y su stream SSE) nunca pasa por acá.
const CACHE = 'ia-flow-v1'

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['/']))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (
    e.request.method !== 'GET' ||
    url.origin !== location.origin ||
    url.pathname.startsWith('/api/')
  )
    return
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) {
          const copy = r.clone()
          caches.open(CACHE).then((c) => c.put(e.request, copy))
        }
        return r
      })
      // una ruta del router (/runner, /tasks/…) sin red cae al index, que la resuelve
      .catch(() => caches.match(e.request).then((r) => r ?? caches.match('/'))),
  )
})
