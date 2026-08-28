import { client } from './opentk_media_sdk'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, DEFAULT_FAL_BASE_URL, DEFAULT_SETTINGS } from './apiProfiles'
import { callFalAiImageApi, getFalQueuedImageResult } from './falAiImageApi'

vi.mock('./opentk_media_sdk', () => ({
  client: {
    config: vi.fn(),
    subscribe: vi.fn(),
    queue: {
      subscribeToStatus: vi.fn(),
      result: vi.fn(),
    },
  },
}))

const falMock = client as unknown as {
  config: Mock
  subscribe: Mock
  queue: {
    subscribeToStatus: Mock
    result: Mock
  }
}

describe('callFalAiImageApi', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses the default fal endpoint without proxyUrl', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      requestId: 'frontend-request-fal',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ apiKey: 'fal-key', baseUrl: DEFAULT_FAL_BASE_URL }))

    expect(falMock.config).toHaveBeenCalledWith({
      credentials: 'fal-key',
      suppressLocalCredentialsWarning: true,
    })
    expect(falMock.subscribe).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: { 'X-Request-ID': 'frontend-request-fal' },
    }))
  })

  it('passes custom fal API URL to the SDK proxyUrl option', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({
      apiKey: 'fal-key',
      baseUrl: 'https://fal-proxy.example.com/api/fal/',
    }))

    expect(falMock.config).toHaveBeenCalledWith({
      credentials: 'fal-key',
      suppressLocalCredentialsWarning: true,
      proxyUrl: 'https://fal-proxy.example.com/api/fal',
    })
  })

  it('reuses the request id for status and result requests', async () => {
    falMock.queue.subscribeToStatus.mockResolvedValue({ status: 'COMPLETED' })
    falMock.queue.result.mockResolvedValue({
      requestId: 'task-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await getFalQueuedImageResult(
      createDefaultFalProfile({ apiKey: 'fal-key' }),
      'openai/gpt-image-2',
      'task-1',
      { ...DEFAULT_PARAMS },
      'frontend-request-fal',
    )

    const expected = expect.objectContaining({
      requestId: 'task-1',
      headers: { 'X-Request-ID': 'frontend-request-fal' },
    })
    expect(falMock.queue.subscribeToStatus).toHaveBeenCalledWith('openai/gpt-image-2', expected)
    expect(falMock.queue.result).toHaveBeenCalledWith('openai/gpt-image-2', expected)
  })
})
