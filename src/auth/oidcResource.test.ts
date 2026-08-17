import { afterEach, describe, expect, it, vi } from 'vitest'
import { OIDC_ISSUER_KEY } from './api'
import { estimateModelPricing, fetchUsage } from './oidcResource'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchUsage', () => {
  it('复用同 apiKey 的并发 usage 请求', async () => {
    const storage = new Map<string, string>([[OIDC_ISSUER_KEY, 'https://issuer.example.com/']])
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ total_balance: 12 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const [first, second] = await Promise.all([fetchUsage('api-key-a'), fetchUsage('api-key-a')])

    expect(first.total_balance).toBe(12)
    expect(second.total_balance).toBe(12)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://issuer.example.com/v1/usage', expect.any(Object))
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
