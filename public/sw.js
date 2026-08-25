const CACHE_NAME = 'gpt-image-playground-v0.6.10-auth-cache-fix'
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './logo.png']
const APP_SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.registration.scope).href))
const ASSETS_PATH = new URL('./assets/', self.registration.scope).pathname
const AUTH_PATH = new URL('./auth/', self.registration.scope).pathname
const COMPOSITE_MODEL_PATH = new URL('./api/v1/model/', self.registration.scope).pathname

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

  // OIDC 的跨域重定向链必须由浏览器原生导航处理。
  if (url.pathname.startsWith(AUTH_PATH)) return

  // 项目页的 Composite 状态轮询必须始终直接访问网络。
  if (url.pathname.startsWith(COMPOSITE_MODEL_PATH) && url.pathname.endsWith('/status')) return

  if (request.mode === 'navigate') {
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

  // 只缓存明确的静态资源，避免按 URL 缓存带用户身份的 API 响应。
  if (!APP_SHELL_URLS.has(request.url) && !url.pathname.startsWith(ASSETS_PATH)) return

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
