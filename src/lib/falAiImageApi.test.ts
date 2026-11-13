import { fal } from '@fal-ai/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, DEFAULT_FAL_BASE_URL, DEFAULT_SETTINGS } from './apiProfiles'
import { callFalAiImageApi, getFalQueuedImageResult } from './falAiImageApi'
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
  it('Grok 2.0 接受 5 张参考图，6 张在请求前被拒绝', async () => {
    falMock.subscribe.mockResolvedValue({ requestId: 'req-1', data: { images: [{ b64_json: 'aW1hZ2U=' }] } })
    const profile = createDefaultFalProfile({ model: 'xai/grok-imagine-image/v2.0' })
    const opts = { settings: DEFAULT_SETTINGS, prompt: '测试', params: DEFAULT_PARAMS, inputImageDataUrls: Array(5).fill('data:image/png;base64,aW1hZ2U=') }
    await callFalAiImageApi(opts, profile)
    expect(falMock.subscribe.mock.calls[0][1].input.image_urls).toHaveLength(5)
    falMock.subscribe.mockClear()
    await expect(callFalAiImageApi({ ...opts, inputImageDataUrls: [...opts.inputImageDataUrls, opts.inputImageDataUrls[0]] }, profile)).rejects.toThrow('最多支持 5 张')
    expect(falMock.subscribe).not.toHaveBeenCalled()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it.each([false, true])('preserves and sanitizes search sources, queue recovery=%s', async (recovery) => {
    const payload = { requestId: 'req-1', data: {
      images: [{ b64_json: 'aW1hZ2U=' }],
      grounding_metadata: [null, {}, {
        searchEntryPoint: { renderedContent: '<div>Google Search</div>' },
        groundingChunks: [{ web: { uri: 'https://example.com/page', title: 'Page' } }],
      }, {
        search_entry_point: { rendered_content: '<div>Image Search</div>' },
        grounding_chunks: [
          { image: { source_uri: 'https://example.com/photo', image_uri: 'https://example.com/photo.png', title: 'Photo' } },
          { web: { uri: 'javascript:alert(1)' } },
        ],
      }],
    } }
    falMock.subscribe.mockResolvedValue(payload)
    vi.mocked(fal.queue.result).mockResolvedValue(payload)
    const profile = createDefaultFalProfile({ model: 'fal-ai/nano-banana-2' })
    const result = recovery
      ? await getFalQueuedImageResult(profile, profile.model, 'req-1', DEFAULT_PARAMS)
      : await callFalAiImageApi({ settings: DEFAULT_SETTINGS, prompt: 'prompt', params: DEFAULT_PARAMS, inputImageDataUrls: [] }, profile)
    expect(result.searchGrounding).toEqual([
      { renderedContent: '<div>Google Search</div>', sources: [{ uri: 'https://example.com/page', title: 'Page' }] },
      { renderedContent: '<div>Image Search</div>', sources: [{ uri: 'https://example.com/photo', imageUri: 'https://example.com/photo.png', title: 'Photo' }] },
    ])
  })

  it.each([
    ['google/nano-banana-2.1/edit', 'google/nano-banana-2.1', false],
    ['fal-ai/nano-banana-2', 'fal-ai/nano-banana-2/edit', true],
    ['fal-ai/nano-banana-pro/edit', 'fal-ai/nano-banana-pro', false],
    ['fal-ai/nano-banana/edit', 'fal-ai/nano-banana', false],
    ['xai/grok-imagine-image/edit', 'xai/grok-imagine-image', false],
    ['xai/grok-imagine-image/quality/edit', 'xai/grok-imagine-image/quality', false],
    ['xai/grok-imagine-image/v2.0/text-to-image', 'xai/grok-imagine-image/v2.0/edit', true],
    ['bytedance/seedream/v5.5', 'bytedance/seedream/v5.5/text-to-image', false],
    ['bytedance/seedream/v5.5/text-to-image', 'bytedance/seedream/v5.5/edit', true],
  ])('routes %s to %s', async (model, endpoint, edit) => {
    falMock.subscribe.mockResolvedValue({ requestId: 'req-1', data: { images: [{ b64_json: 'aW1hZ2U=' }] } })
    const images = edit ? ['data:image/png;base64,aW1hZ2U='] : []
    await callFalAiImageApi({ settings: DEFAULT_SETTINGS, prompt: 'prompt', params: DEFAULT_PARAMS, inputImageDataUrls: images }, createDefaultFalProfile({ model }))
    expect(falMock.subscribe.mock.calls[0][0]).toBe(endpoint)
    const input = falMock.subscribe.mock.calls[0][1].input
    expect(input.image_urls).toEqual(edit ? images : undefined)
    expect(input).not.toHaveProperty('reasoning_effort')
    expect(input).not.toHaveProperty('mask_url')
  })

  it.each([
    ['google/nano-banana-2.1', '4K', 'medium', { resolution: '4K', thinking_level: 'medium', enable_web_search: true }],
    ['fal-ai/nano-banana-2/edit', '512', 'high', { resolution: '0.5K', thinking_level: 'high', enable_web_search: true, enable_image_search: true }],
    ['fal-ai/nano-banana/edit', '4K', 'high', {}],
  ] as const)('maps Gemini parameters for %s', async (model, resolution, thinking_level, extra) => {
    falMock.subscribe.mockResolvedValue({ requestId: 'req-1', data: { images: [{ b64_json: 'aW1hZ2U=' }] } })
    await callFalAiImageApi({ settings: DEFAULT_SETTINGS, prompt: 'prompt', params: { ...DEFAULT_PARAMS, resolution, thinking_level, aspect_ratio: '16:9', n: 3, google_search: true, image_search: true, complexity: 'high' }, inputImageDataUrls: [] }, createDefaultFalProfile({ model }))
    expect(falMock.subscribe.mock.calls[0][1].input).toEqual({ prompt: 'prompt', num_images: 3, output_format: 'png', aspect_ratio: '16:9', ...extra })
  })

  it('maps Grok resolution and quality without GPT Image parameters', async () => {
    falMock.subscribe.mockResolvedValue({ requestId: 'req-1', data: { images: [{ b64_json: 'aW1hZ2U=' }] } })
    await callFalAiImageApi({ settings: DEFAULT_SETTINGS, prompt: 'prompt', params: { ...DEFAULT_PARAMS, resolution: '1.5K', aspect_ratio: '5:2', quality: 'low', complexity: 'high' }, inputImageDataUrls: [] }, createDefaultFalProfile({ model: 'xai/grok-imagine-image/v2.0/text-to-image' }))
    expect(falMock.subscribe.mock.calls[0][1].input).toEqual({ prompt: 'prompt', num_images: 1, output_format: 'png', aspect_ratio: '5:2', resolution: '1.5k', quality: 'low' })
  })

  it.each([
    ['auto', '1.5K', 'auto_1.5K'],
    ['custom', undefined, { width: 2048, height: 1024 }],
  ])('maps Seedream size %s and native transparent output', async (aspect_ratio, resolution, image_size) => {
    falMock.subscribe.mockResolvedValue({ requestId: 'req-1', data: { images: [{ b64_json: 'aW1hZ2U=' }] } })
    await callFalAiImageApi({ settings: DEFAULT_SETTINGS, prompt: 'prompt', params: { ...DEFAULT_PARAMS, aspect_ratio, resolution, size: '2048x1024', n: 4, watermark: true }, inputImageDataUrls: [], nativeTransparentBackground: true }, createDefaultFalProfile({ model: 'bytedance/seedream/v5.5/text-to-image' }))
    expect(falMock.subscribe.mock.calls[0][1].input).toEqual({ prompt: 'prompt', num_images: 4, output_format: 'png', image_size, watermark: true, background: 'transparent' })
  })

  it('rejects too many Grok references before submitting', async () => {
    await expect(callFalAiImageApi({ settings: DEFAULT_SETTINGS, prompt: 'prompt', params: DEFAULT_PARAMS, inputImageDataUrls: Array(4).fill('data:image/png;base64,aW1hZ2U=') }, createDefaultFalProfile({ model: 'xai/grok-imagine-image' }))).rejects.toThrow('最多支持 3 张参考图')
    expect(falMock.subscribe).not.toHaveBeenCalled()
  })

  it('rejects too many Seedream references before submitting', async () => {
    await expect(callFalAiImageApi({ settings: DEFAULT_SETTINGS, prompt: 'prompt', params: DEFAULT_PARAMS, inputImageDataUrls: Array(11).fill('data:image/png;base64,aW1hZ2U=') }, createDefaultFalProfile({ model: 'bytedance/seedream/v5.5/edit' }))).rejects.toThrow('最多支持 10 张参考图')
    expect(falMock.subscribe).not.toHaveBeenCalled()
  })

  it.each(['google/nano-banana-2.1', 'xai/grok-imagine-image', 'bytedance/seedream/v5.5/edit'])('rejects unsupported masks for %s', async (model) => {
    await expect(callFalAiImageApi({ settings: DEFAULT_SETTINGS, prompt: 'prompt', params: DEFAULT_PARAMS, inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='], maskDataUrl: 'data:image/png;base64,aW1hZ2U=' }, createDefaultFalProfile({ model }))).rejects.toThrow('不支持遮罩编辑')
    expect(falMock.subscribe).not.toHaveBeenCalled()
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
    }, createDefaultFalProfile({ apiKey: 'fal-key', model: 'openai/gpt-image-2' }))

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

  it.each([
    { name: 'explicit model', svgModel: 'gpt-6-luna' },
    { name: 'default model', svgModel: undefined },
  ])('uses the SVG $name without SVG reasoning settings', async ({ svgModel }) => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ url: 'data:image/svg+xml;base64,PHN2Zy8+' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'svg', n: 4, complexity: 'low' },
      nativeTransparentBackground: true,
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ model: 'openai/gpt-image-2.6/sunburst', apiKey: 'fal-key', svgModel, svgReasoningEffort: 'high' }))

    const input = falMock.subscribe.mock.calls[0][1].input
    expect(input).toMatchObject({ output_format: 'svg', num_images: 1, reasoning_effort: 'low', background: 'transparent' })
    if (svgModel) expect(input.svg_model).toBe(svgModel)
    else expect(input).not.toHaveProperty('svg_model')
    expect(input).not.toHaveProperty('provider_options')
    expect(input).not.toHaveProperty('svg')
    expect(input).not.toHaveProperty('svg_reasoning_effort')
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
