import { readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'

describe('service worker fetch 缓存范围', () => {
  it('只拦截静态资源，不拦截认证和其他动态请求', () => {
    const listeners = new Map()
    const worker = {
      registration: { scope: 'https://img.opentk.ai/' },
      location: { origin: 'https://img.opentk.ai' },
      clients: { claim: vi.fn() },
      skipWaiting: vi.fn(),
      addEventListener: vi.fn((type, listener) => {
        listeners.set(type, listener)
      }),
    }
    const cacheStorage = {
      match: vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
      open: vi.fn(),
      keys: vi.fn(),
      delete: vi.fn(),
    }

    const source = readFileSync('public/sw.js', 'utf8')
    new Function('self', 'caches', source)(worker, cacheStorage)
    const handleFetch = listeners.get('fetch')

    const authRespondWith = vi.fn()
    handleFetch({ request: new Request('https://img.opentk.ai/auth/user'), respondWith: authRespondWith })
    expect(authRespondWith).not.toHaveBeenCalled()

    const loginRespondWith = vi.fn()
    handleFetch({
      request: { method: 'GET', url: 'https://img.opentk.ai/auth/login/opentk', mode: 'navigate' },
      respondWith: loginRespondWith,
    })
    expect(loginRespondWith).not.toHaveBeenCalled()

    const apiRespondWith = vi.fn()
    handleFetch({ request: new Request('https://img.opentk.ai/api/v1/jobs'), respondWith: apiRespondWith })
    expect(apiRespondWith).not.toHaveBeenCalled()

    const apiKeysRespondWith = vi.fn()
    handleFetch({ request: new Request('https://img.opentk.ai/api/v1/api-keys'), respondWith: apiKeysRespondWith })
    expect(apiKeysRespondWith).not.toHaveBeenCalled()

    const modelsRespondWith = vi.fn()
    handleFetch({ request: new Request('https://img.opentk.ai/api/v1/models?scope=agent'), respondWith: modelsRespondWith })
    expect(modelsRespondWith).not.toHaveBeenCalled()

    const balanceRespondWith = vi.fn()
    handleFetch({ request: new Request('https://img.opentk.ai/api/v1/balance'), respondWith: balanceRespondWith })
    expect(balanceRespondWith).not.toHaveBeenCalled()

    const projectRespondWith = vi.fn()
    handleFetch({ request: new Request('https://img.opentk.ai/api/v1/projects'), respondWith: projectRespondWith })
    expect(projectRespondWith).not.toHaveBeenCalled()

    const assetRespondWith = vi.fn()
    handleFetch({ request: new Request('https://img.opentk.ai/assets/index-abc.js'), respondWith: assetRespondWith })
    expect(assetRespondWith).toHaveBeenCalledOnce()
  })
})
