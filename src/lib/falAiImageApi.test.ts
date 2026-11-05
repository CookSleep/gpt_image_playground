import { fal } from '@fal-ai/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, DEFAULT_FAL_BASE_URL, DEFAULT_SETTINGS } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'
import { apiFetch } from './platform'

vi.mock('@fal-ai/client', () => ({
  fal: {
    config: vi.fn(),
    subscribe: vi.fn(),
    queue: {
      subscribeToStatus: vi.fn(),
      result: vi.fn(),
    },
  },
}))

const falMock = fal as unknown as {
  config: Mock
  subscribe: Mock
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
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ apiKey: 'fal-key', baseUrl: DEFAULT_FAL_BASE_URL }))

    expect(falMock.config).toHaveBeenCalledWith({
      credentials: 'fal-key',
      suppressLocalCredentialsWarning: true,
      fetch: apiFetch,
    })
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
      fetch: apiFetch,
      proxyUrl: 'https://fal-proxy.example.com/api/fal',
    })
  })

  it('uses the GPT Image 2.5 text-to-image endpoint and preserves max quality', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, quality: 'max' },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ model: 'openai/gpt-image-2.5/sunburst', apiKey: 'fal-key' }))

    expect(falMock.subscribe).toHaveBeenCalledWith('openai/gpt-image-2.5/sunburst/text-to-image', expect.objectContaining({
      input: expect.objectContaining({ quality: 'max' }),
    }))
  })

  it('uses the GPT Image 2.5 edit endpoint', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    }, createDefaultFalProfile({ model: 'openai/gpt-image-2.5/flare', apiKey: 'fal-key' }))

    expect(falMock.subscribe).toHaveBeenCalledWith('openai/gpt-image-2.5/flare/edit', expect.anything())
  })

  it('requests a native transparent background', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'webp', transparent_output: true },
      nativeTransparentBackground: true,
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ apiKey: 'fal-key' }))

    expect(falMock.subscribe).toHaveBeenCalledWith('openai/gpt-image-2', expect.objectContaining({
      input: expect.objectContaining({ background: 'transparent' }),
    }))
  })

  it('maps GPT Image 2.6 complexity and GIF settings and caps quality at high', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ url: 'data:image/gif;base64,aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, quality: 'max', complexity: 'low', output_format: 'gif', frame_count: 4, frame_duration_ms: 120 },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ model: 'openai/gpt-image-2.6/flare', apiKey: 'fal-key' }))

    const input = falMock.subscribe.mock.calls[0][1].input
    expect(falMock.subscribe.mock.calls[0][0]).toBe('openai/gpt-image-2.6/flare/text-to-image')
    expect(input).toMatchObject({ quality: 'high', reasoning_effort: 'low', output_format: 'gif', frame_count: 4, frame_duration_ms: 120 })
    expect(input).not.toHaveProperty('provider_options')
  })

  // fal.ai 的 SVG 暂不开放，恢复 falAiImageApi 中的 provider_options 后改回 it
  it.skip('passes the SVG authoring model through provider_options', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ url: 'data:image/svg+xml;base64,PHN2Zy8+' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'svg' },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ model: 'openai/gpt-image-2.6/sunburst', apiKey: 'fal-key', svgModel: 'gpt-6-luna' }))

    const input = falMock.subscribe.mock.calls[0][1].input
    expect(input).toMatchObject({ output_format: 'svg', provider_options: { svg: { model: 'gpt-6-luna' } } })
    expect(input).not.toHaveProperty('reasoning_effort')
    expect(input).not.toHaveProperty('frame_count')
  })

  it('sends the markup layer to the GPT Image 2.6 edit endpoint', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
      markupDataUrl: 'data:image/png;base64,bWFya3Vw',
    }, createDefaultFalProfile({ model: 'openai/gpt-image-2.6/sunburst', apiKey: 'fal-key' }))

    expect(falMock.subscribe).toHaveBeenCalledWith('openai/gpt-image-2.6/sunburst/edit', expect.objectContaining({
      input: expect.objectContaining({ markup_image_url: 'data:image/png;base64,bWFya3Vw' }),
    }))
  })
})
