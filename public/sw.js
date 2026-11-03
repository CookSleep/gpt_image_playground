const CACHE_NAME = 'gpt-image-playground-v0.8.4'
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './pwa-icon.svg', './pwa-maskable-icon.svg', './color-mode.js']
const APP_SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.registration.scope).href))
const ASSETS_PATH = new URL('./assets/', self.registration.scope).pathname

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // 只缓存顶层页面；公告卡片中的 iframe 也是导航请求，不能写进 index.html 的缓存
  if (request.mode === 'navigate' && request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy))
          return response
        })
        .catch(() => caches.match('./index.html')),
    )
    return
  }

  if (!APP_SHELL_URLS.has(url.href) && !url.pathname.startsWith(ASSETS_PATH)) return

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached

      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})
