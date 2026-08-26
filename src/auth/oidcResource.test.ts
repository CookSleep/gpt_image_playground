import { afterEach, describe, expect, it, vi } from 'vitest'
import { OIDC_ACCESS_TOKEN_KEY, OIDC_ISSUER_KEY, OIDC_TOKEN_EXPIRY_KEY } from './api'
import { estimateModelPricing, extractBalance, fetchApiKeys, fetchBalance, fetchModels, invalidateApiKeysCache } from './oidcResource'

afterEach(() => {
  invalidateApiKeysCache()
  vi.unstubAllGlobals()
})

describe('fetchApiKeys', () => {
  it('parses platform independently from the display group name', async () => {
    const storage = new Map<string, string>([
      [OIDC_ISSUER_KEY, 'https://issuer.example.com/'],
      [OIDC_ACCESS_TOKEN_KEY, 'oidc-token'],
      [OIDC_TOKEN_EXPIRY_KEY, String(Date.now() + 3600_000)],
    ])
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    })
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      items: [{
        api_key: 'composite-key',
        name: '生产 Key',
        group: { name: '图像生成组', platform: 'composite' },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchApiKeys()

    expect(result.items).toEqual([{
      key: 'composite-key',
      name: '生产 Key',
      groupName: '图像生成组',
      platform: 'composite',
    }])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/api-keys?scope=image')
    expect(new Headers(init?.headers).get('X-OIDC-Access-Token')).toBe('oidc-token')
  })

  it('生图和 Agent 使用独立 scope 与缓存', async () => {
    const storage = new Map<string, string>([
      [OIDC_ACCESS_TOKEN_KEY, 'oidc-token'],
      [OIDC_TOKEN_EXPIRY_KEY, String(Date.now() + 3600_000)],
    ])
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    })
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([fetchApiKeys('image'), fetchApiKeys('agent')])

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/api-keys?scope=image',
      '/api/v1/api-keys?scope=agent',
    ])
  })
})

describe('fetchBalance', () => {
  it('通过后台复用并发 Inner API 余额请求且不传 OIDC token 或 API Key', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    })
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ available: true, balance: '12.0000' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const [first, second] = await Promise.all([fetchBalance(), fetchBalance()])

    expect(first.balance).toBe('12.0000')
    expect(second.balance).toBe('12.0000')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/balance')
    expect(new Headers(init?.headers).get('X-OIDC-Access-Token')).toBeNull()
    expect(new Headers(init?.headers).get('X-Upstream-API-Key')).toBeNull()
  })

  it('格式化 Inner API 的十进制余额', () => {
    expect(extractBalance({ available: true, balance: '9.7500' })).toBe('9.75')
    expect(extractBalance({ available: false })).toBe('')
  })

  it('calls model price estimate endpoint with selected api key', async () => {
    const storage = new Map<string, string>([[OIDC_ISSUER_KEY, 'https://issuer.example.com/']])
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      endpoint: 'fal-ai/flux/dev',
      estimated_price: 0.3,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await estimateModelPricing('api-key-a', 'fal-ai/flux/dev', {
      image_size: '1024x1024',
      num_images: 2,
      quality: 'high',
    })

    expect(result.estimated_price).toBe(0.3)
    expect(fetchMock).toHaveBeenCalledWith('https://issuer.example.com/api/v1/model/fal-ai/flux/dev/estimate_pricing', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer api-key-a' }),
      body: JSON.stringify({ image_size: '1024x1024', num_images: 2, quality: 'high' }),
    }))
  })
})

describe('fetchModels', () => {
  it('通过后台传递 API Key 和生图场景', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    })
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchModels('api-key-a', { scope: 'image' })

    expect(result.data.map((model) => model.id)).toEqual(['gpt-image-2'])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/models?scope=image')
    expect(new Headers(init?.headers).get('X-Upstream-API-Key')).toBe('api-key-a')
  })

  it('向后台传递 Agent 场景', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    })
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ id: 'gpt-5.2' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchModels('api-key-a', { scope: 'agent' })

    expect(result.data.map((model) => model.id)).toEqual(['gpt-5.2'])
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/models?scope=agent')
  })
})
