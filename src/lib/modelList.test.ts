import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchProviderModelIds, parseModelIds, pickImageModelIds } from './modelList'
import { FetchConnectError } from './platform'

describe('parseModelIds', () => {
  it('reads OpenAI style data arrays and drops empty ids', () => {
    const payload = { object: 'list', data: [{ id: 'gpt-5' }, { id: ' gpt-4.1 ' }, { id: '' }, null] }

    expect(parseModelIds(payload)).toEqual(['gpt-5', 'gpt-4.1'])
  })

  it('accepts models arrays, plain string arrays and bare arrays', () => {
    expect(parseModelIds({ models: [{ model: 'qwen-max' }, { name: 'deepseek-chat' }] })).toEqual(['qwen-max', 'deepseek-chat'])
    expect(parseModelIds(['a', 'b', 'a'])).toEqual(['a', 'b'])
  })

  it('returns an empty list for unexpected payloads', () => {
    expect(parseModelIds(null)).toEqual([])
    expect(parseModelIds({ error: 'nope' })).toEqual([])
    expect(parseModelIds('gpt-5')).toEqual([])
  })
})

describe('pickImageModelIds', () => {
  it('keeps only image models when the provider mixes text and image models', () => {
    expect(pickImageModelIds(['gpt-5', 'gpt-image-2', 'o3', 'gpt-image-2.5-sunburst']))
      .toEqual(['gpt-image-2', 'gpt-image-2.5-sunburst'])
  })

  it('falls back to the full list when no name mentions image', () => {
    expect(pickImageModelIds(['nano-banana', 'seedream-4'])).toEqual(['nano-banana', 'seedream-4'])
  })
})

describe('fetchProviderModelIds', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('requests /v1/models with a bearer token and parses the response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gpt-5' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchProviderModelIds({ baseUrl: 'https://api.example.com', apiKey: 'sk-1' })).resolves.toEqual(['gpt-5'])

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/models')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-1')
  })

  it('surfaces the provider error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 })))

    await expect(fetchProviderModelIds({ baseUrl: 'https://api.example.com/v1', apiKey: '' })).rejects.toThrow('invalid key')
  })

  it('turns a network failure into a readable hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))

    await expect(fetchProviderModelIds({ baseUrl: 'https://api.example.com', apiKey: 'sk-1' })).rejects.toThrow('无法连接该接口')
  })

  it('uses the configured API proxy without an empty authorization header', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(['gpt-image-2'])))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchProviderModelIds({ baseUrl: '', apiKey: ' ', apiProxy: true })).resolves.toEqual(['gpt-image-2'])
    expect(fetchMock).toHaveBeenCalledWith('/api-proxy/models', expect.objectContaining({ headers: {} }))
  })

  it('keeps a trailing-slash custom API path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([])))
    vi.stubGlobal('fetch', fetchMock)

    await fetchProviderModelIds({ baseUrl: 'https://api.example.com/custom/', apiKey: '' })
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/custom/models', expect.any(Object))
  })

  it('explains invalid JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Not a model list</html>')))

    await expect(fetchProviderModelIds({ baseUrl: 'https://api.example.com', apiKey: '' })).rejects.toThrow('不是有效的 JSON')
  })

  it('preserves the desktop connection error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new FetchConnectError('无法解析主机名') }))

    await expect(fetchProviderModelIds({ baseUrl: 'https://api.example.com', apiKey: '' })).rejects.toThrow('无法解析主机名')
  })

  it('aborts a timed-out request and clears the timer', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })))
    const request = fetchProviderModelIds({ baseUrl: 'https://api.example.com', apiKey: '' })
    const assertion = expect(request).rejects.toThrow('拉取模型超时')

    await vi.advanceTimersByTimeAsync(20000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps cancellation distinct from a timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })))
    const controller = new AbortController()
    const request = fetchProviderModelIds({ baseUrl: 'https://api.example.com', apiKey: '', signal: controller.signal })
    const assertion = expect(request).rejects.toMatchObject({ name: 'AbortError' })

    controller.abort()
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
})
