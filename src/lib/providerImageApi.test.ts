import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { callImageApi } from './api'
import { createDefaultAgnesProfile, createDefaultGrokProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Grok gateway retries', () => {
  it.each([502, 503, 504, 520, 521, 522, 523, 524])('retries HTTP %s once with the same request', async (status) => {
    vi.useFakeTimers()
    const profile = createDefaultGrokProfile({ apiKey: 'grok-key' })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })))
    const request = callImageApi({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }),
      prompt: 'A circle', params: DEFAULT_PARAMS, inputImageDataUrls: [],
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect((await request).images).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0])
  })

  it('stops after the second gateway error', async () => {
    vi.useFakeTimers()
    const profile = createDefaultGrokProfile({ apiKey: 'grok-key' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('Bad gateway', { status: 502 }))
    const request = expect(callImageApi({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }),
      prompt: 'A circle', params: DEFAULT_PARAMS, inputImageDataUrls: [],
    })).rejects.toThrow('Bad gateway')
    await vi.advanceTimersByTimeAsync(1000)
    await request
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401, 403, 429])('does not retry HTTP %s', async (status) => {
    const profile = createDefaultGrokProfile({ apiKey: 'grok-key' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Rejected', { status }))
    await expect(callImageApi({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }),
      prompt: 'A circle', params: DEFAULT_PARAMS, inputImageDataUrls: [],
    })).rejects.toThrow('Rejected')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry gateway errors from other providers', async () => {
    const profile = createDefaultOpenAIProfile({ apiKey: 'openai-key' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Bad gateway', { status: 502 }))
    await expect(callImageApi({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }),
      prompt: 'A circle', params: DEFAULT_PARAMS, inputImageDataUrls: [],
    })).rejects.toThrow('Bad gateway')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('Agnes image requests', () => {
  it.each([0, 1, 2])('sends %s reference images using the documented endpoint and fields', async (count) => {
    const profile = createDefaultAgnesProfile({ apiKey: 'agnes-key' })
    const images = Array.from({ length: count }, () => 'data:image/png;base64,aW1hZ2U=')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })))
    const result = await callImageApi({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }),
      prompt: 'A circle', params: { ...DEFAULT_PARAMS, size: '2624x1472', quality: 'high' }, inputImageDataUrls: images,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/images\/generations$/)
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer agnes-key', 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'agnes-image-2.5-flash', prompt: 'A circle', size: '2K', ratio: '16:9',
      ...(count ? { extra_body: { image: images, response_format: 'b64_json' } } : { return_base64: true }),
    })
    expect(result.images).toHaveLength(1)
  })

  it('requests multiple Agnes outputs separately and keeps partial successes', async () => {
    const profile = createDefaultAgnesProfile({ apiKey: 'agnes-key' })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })))
      .mockResolvedValueOnce(new Response('Rejected', { status: 400 }))
    const result = await callImageApi({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }),
      prompt: 'A circle', params: { ...DEFAULT_PARAMS, n: 2 }, inputImageDataUrls: [],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.images).toHaveLength(1)
    expect(result.failedRequests).toEqual([{ requestIndex: 1, error: 'Rejected' }])
  })
})
