import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type ApiProfile } from '../types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, getActiveApiProfile, normalizeSettings } from './apiProfiles'
import { callImageApi } from './api'
import { appendModerationDetails } from './imageApiShared'
import { DEFAULT_SVG_MODEL, isGptImage25PlusModel, isGptImage26PlusModel } from './imageModels'
import { getParamDisabledReasons, normalizeParamsForSettings, supportsTransparentOutput } from './paramCompatibility'

function createSettings(patch: Partial<ApiProfile>) {
  const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: false, ...patch })
  return normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
}

function mockImageResponse() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    data: [{ b64_json: 'aW1hZ2U=' }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
}

function getJsonBodies(fetchMock: ReturnType<typeof mockImageResponse>) {
  return fetchMock.mock.calls
    .map(([, init]) => (init as RequestInit | undefined)?.body)
    .filter((body): body is string => typeof body === 'string')
    .map((body) => JSON.parse(body))
}

function getFormBody(fetchMock: ReturnType<typeof mockImageResponse>) {
  const [, init] = fetchMock.mock.calls.find(([, request]) => (request as RequestInit | undefined)?.body instanceof FormData)!
  return (init as RequestInit).body as FormData
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GPT Image model versions', () => {
  it('detects 2.5 and later models for xhigh quality and markup', () => {
    expect(isGptImage25PlusModel('gpt-image-2.5-flare')).toBe(true)
    expect(isGptImage25PlusModel('gpt-image-2.6-sunburst')).toBe(true)
    expect(isGptImage25PlusModel('openai/gpt-image-2.5/sunburst')).toBe(true)
    expect(isGptImage25PlusModel('gpt-image-3')).toBe(true)
    expect(isGptImage25PlusModel('gpt-image-2')).toBe(false)
    expect(isGptImage25PlusModel('gpt-image-1.5')).toBe(false)
    expect(isGptImage25PlusModel('dall-e-3')).toBe(false)
  })

  it('detects 2.6 and later models for complexity, SVG and GIF', () => {
    expect(isGptImage26PlusModel('gpt-image-2.6-flare')).toBe(true)
    expect(isGptImage26PlusModel('GPT-Image-2.6-Sunburst')).toBe(true)
    expect(isGptImage26PlusModel('gpt-image-2.5-sunburst-2026-09-08')).toBe(false)
  })
})

describe('GPT Image 2.6 parameter compatibility', () => {
  const params = { ...DEFAULT_PARAMS, quality: 'max' as const, complexity: 'low' as const, output_format: 'svg' as const }

  it('keeps complexity, SVG and max quality on GPT Image 2.6', () => {
    const next = normalizeParamsForSettings(params, createSettings({ model: 'gpt-image-2.6-flare' }))
    expect(next).toMatchObject({ quality: 'max', complexity: 'low', output_format: 'svg' })
  })

  it('keeps max quality but drops 2.6-only params on GPT Image 2.5', () => {
    const next = normalizeParamsForSettings(params, createSettings({ model: 'gpt-image-2.5-flare' }))
    expect(next).toMatchObject({ quality: 'max', complexity: 'auto', output_format: 'png' })
  })

  it('uses the Responses image tool model for 2.6 params', () => {
    const settings = createSettings({ apiMode: 'responses', model: 'gpt-5.5', imageGenerationModel: 'gpt-image-2.6-flare' })
    expect(normalizeParamsForSettings(params, settings)).toMatchObject({ complexity: 'low', output_format: 'svg' })
  })

  it('falls back to bitmap output in Agent mode', () => {
    const next = normalizeParamsForSettings(params, createSettings({ model: 'gpt-image-2.6-flare' }), { agent: true })
    expect(next).toMatchObject({ complexity: 'low', output_format: 'png' })
  })

  it('keeps 2.6 params on fal.ai and limits SVG output to one image', () => {
    const fal = createDefaultFalProfile({ apiKey: 'fal-key', model: 'openai/gpt-image-2.6/sunburst' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [fal], activeProfileId: fal.id })
    expect(normalizeParamsForSettings({ ...params, n: 3 }, settings)).toMatchObject({ quality: 'high', complexity: 'low', output_format: 'svg', n: 1 })
    expect(normalizeParamsForSettings({ ...params, output_format: 'gif' }, settings).output_format).toBe('gif')

    const fal25 = createDefaultFalProfile({ apiKey: 'fal-key', model: 'openai/gpt-image-2.5/sunburst' })
    const settings25 = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [fal25], activeProfileId: fal25.id })
    expect(normalizeParamsForSettings(params, settings25)).toMatchObject({ quality: 'max', complexity: 'auto', output_format: 'png' })
  })

  it('keeps 2.6 params in Codex CLI mode', () => {
    const next = normalizeParamsForSettings(params, createSettings({ model: 'gpt-image-2.6-flare', codexCli: true }))
    expect(next).toMatchObject({ quality: 'auto', complexity: 'low', output_format: 'svg' })
  })

  it('uses default image capabilities when the Responses image model is omitted', () => {
    const profile = getActiveApiProfile(createSettings({ apiMode: 'responses', model: 'gpt-image-2.6-sunburst', imageGenerationModel: '' }))
    expect(getParamDisabledReasons(profile)).toMatchObject({
      complexity: undefined,
      gif: undefined,
      svg: undefined,
    })
  })
})

describe('GPT Image 2.6 requests', () => {
  it('sends complexity and the SVG authoring model without streaming', async () => {
    const fetchMock = mockImageResponse()
    const result = await callImageApi({
      settings: createSettings({ model: 'gpt-image-2.6-flare', streamImages: true, svgModel: 'gpt-6-luna' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, complexity: 'medium', output_format: 'svg', n: 2 },
      inputImageDataUrls: [],
    })

    const bodies = getJsonBodies(fetchMock)
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(body).toMatchObject({ complexity: 'medium', output_format: 'svg', svg: { model: 'gpt-6-luna' } })
      expect(body).not.toHaveProperty('stream')
      expect(body).not.toHaveProperty('partial_images')
      expect(body).not.toHaveProperty('n')
    }
    expect(result.images[0]).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('uses the default SVG authoring model', async () => {
    const fetchMock = mockImageResponse()
    await callImageApi({
      settings: createSettings({ model: 'gpt-image-2.6-sunburst' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'svg' },
      inputImageDataUrls: [],
    })

    expect(getJsonBodies(fetchMock)[0].svg).toEqual({ model: DEFAULT_SVG_MODEL })
  })

  it('sends GIF frame settings and omits complexity when it is auto', async () => {
    const fetchMock = mockImageResponse()
    const result = await callImageApi({
      settings: createSettings({ model: 'gpt-image-2.6-flare' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'gif', frame_count: 4, frame_duration_ms: 120 },
      inputImageDataUrls: [],
    })

    const body = getJsonBodies(fetchMock)[0]
    expect(body).toMatchObject({ output_format: 'gif', frame_count: 4, frame_duration_ms: 120 })
    expect(body).not.toHaveProperty('complexity')
    expect(body).not.toHaveProperty('svg')
    expect(result.images[0]).toMatch(/^data:image\/gif;base64,/)
  })

  it('does not send GIF frame settings for other formats', async () => {
    const fetchMock = mockImageResponse()
    await callImageApi({
      settings: createSettings({ model: 'gpt-image-2.6-flare' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, frame_count: 4, frame_duration_ms: 120 },
      inputImageDataUrls: [],
    })

    const body = getJsonBodies(fetchMock)[0]
    expect(body).not.toHaveProperty('frame_count')
    expect(body).not.toHaveProperty('frame_duration_ms')
  })

  it('sends complexity and the markup layer to the Images edit API', async () => {
    const fetchMock = mockImageResponse()
    await callImageApi({
      settings: createSettings({ model: 'gpt-image-2.6-sunburst' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, complexity: 'low' },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
      markupDataUrl: 'data:image/png;base64,bWFya3Vw',
    })

    const body = getFormBody(fetchMock)
    expect(body.get('markup')).toBeInstanceOf(Blob)
    expect(body.has('mask')).toBe(false)
    expect(body.get('complexity')).toBe('low')
  })

  it('keeps the original image and separate markup when switching 2.6, 2.5 and back', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = mockImageResponse()
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).startsWith('data:')) return originalFetch(input, init)
      return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const inputImageDataUrls = ['data:image/png;base64,aW1hZ2U=']
    for (const model of ['gpt-image-2.6-sunburst', 'gpt-image-2.5', 'gpt-image-2.6-sunburst']) {
      fetchMock.mockClear()
      await callImageApi({
        settings: createSettings({ model }),
        prompt: 'prompt',
        params: DEFAULT_PARAMS,
        inputImageDataUrls,
        markupDataUrl: 'data:image/png;base64,bWFya3Vw',
      })
      const body = getFormBody(fetchMock)
      expect(await (body.get('markup') as Blob).text()).toBe('markup')
      expect(inputImageDataUrls).toEqual(['data:image/png;base64,aW1hZ2U='])
    }
  })

  it('sends GIF frame settings to the Images edit API', async () => {
    const fetchMock = mockImageResponse()
    await callImageApi({
      settings: createSettings({ model: 'gpt-image-2.6-sunburst' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'gif', frame_count: 4, frame_duration_ms: 120 },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    })

    const body = getFormBody(fetchMock)
    expect(body.get('output_format')).toBe('gif')
    expect(body.get('frame_count')).toBe('4')
    expect(body.get('frame_duration_ms')).toBe('120')
    expect(body.has('complexity')).toBe(false)
  })

  it('sends 2.6 params to the Responses image tool', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'image_generation_call', result: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: createSettings({ apiMode: 'responses', model: 'gpt-5.5', imageGenerationModel: 'gpt-image-2.6-flare', streamImages: true }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, complexity: 'high', output_format: 'gif', frame_count: 3 },
      inputImageDataUrls: [],
    })

    const body = getJsonBodies(fetchMock)[0]
    expect(body.stream).toBe(true)
    expect(body.tools[0]).toMatchObject({ complexity: 'high', output_format: 'gif', frame_count: 3 })
    expect(body.tools[0]).not.toHaveProperty('partial_images')
  })
})

describe('GPT Image 2.6 custom providers', () => {
  const createCustomSettings = (model: string) => normalizeSettings({
    ...DEFAULT_SETTINGS,
    customProviders: [{
      id: 'custom-26',
      name: 'Custom 2.6',
      template: 'http-image',
      submit: {
        path: 'images/generations',
        method: 'POST',
        contentType: 'json',
        body: {
          model: '$profile.model',
          prompt: '$prompt',
          n: '$params.n',
          output_format: '$params.output_format',
          complexity: '$params.complexity',
          frame_count: '$params.frame_count',
          frame_duration_ms: '$params.frame_duration_ms',
          svg: '$params.svg',
        },
        result: { b64JsonPaths: ['data.*.b64_json'] },
      },
    }],
    profiles: [{ ...DEFAULT_SETTINGS.profiles[0], id: 'custom-profile', provider: 'custom-26', baseUrl: 'https://api.example.com/v1', apiKey: 'key', model, svgModel: 'gpt-6-luna' }],
    activeProfileId: 'custom-profile',
  })

  it('keeps 2.6 params only for 2.6 models', () => {
    const params = { ...DEFAULT_PARAMS, complexity: 'low' as const, output_format: 'gif' as const }
    expect(normalizeParamsForSettings(params, createCustomSettings('gpt-image-2.6-flare'))).toMatchObject({ complexity: 'low', output_format: 'gif' })
    expect(normalizeParamsForSettings(params, createCustomSettings('gpt-image-2.5-flare'))).toMatchObject({ complexity: 'auto', output_format: 'png' })
  })

  it('allows transparent SVG and GIF only when the template maps the native background', () => {
    const settings = createCustomSettings('gpt-image-2.6-flare')
    const profile = settings.profiles[0]
    expect(supportsTransparentOutput(settings, profile, 'png')).toBe(true)
    expect(supportsTransparentOutput(settings, profile, 'jpeg')).toBe(false)
    expect(supportsTransparentOutput(settings, profile, 'gif')).toBe(false)
    expect(supportsTransparentOutput(createSettings({ model: 'gpt-image-2.6-flare' }), createDefaultOpenAIProfile(), 'svg')).toBe(true)
  })

  it('fills the template and omits fields that do not apply', async () => {
    const fetchMock = mockImageResponse()
    await callImageApi({
      settings: createCustomSettings('gpt-image-2.6-flare'),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'gif', frame_count: 4 },
      inputImageDataUrls: [],
    })

    const body = getJsonBodies(fetchMock)[0]
    expect(body).toMatchObject({ output_format: 'gif', frame_count: 4, frame_duration_ms: 200 })
    expect(body).not.toHaveProperty('complexity')
    expect(body).not.toHaveProperty('svg')
  })

  it('sends the SVG authoring model and splits SVG output into single requests', async () => {
    const fetchMock = mockImageResponse()
    await callImageApi({
      settings: createCustomSettings('gpt-image-2.6-flare'),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, complexity: 'high', output_format: 'svg', n: 2 },
      inputImageDataUrls: [],
    })

    const bodies = getJsonBodies(fetchMock)
    expect(bodies).toHaveLength(2)
    for (const body of bodies) expect(body).toMatchObject({ n: 1, complexity: 'high', svg: { model: 'gpt-6-luna' } })
  })
})

describe('moderation details', () => {
  it('appends the blocking stage and categories', () => {
    expect(appendModerationDetails('blocked', { moderation_stage: 'output', categories: ['violence', 'sexual'] }))
      .toBe('blocked\n拦截来源：生成结果；类别：violence、sexual')
  })

  it('keeps the message when details are missing or unknown', () => {
    expect(appendModerationDetails('blocked', undefined)).toBe('blocked')
    expect(appendModerationDetails('blocked', { moderation_stage: 'unknown', categories: [] })).toBe('blocked')
  })
})

describe('SVG editing and GIF masks', () => {
  it('sends SVG author reasoning in multipart edits', async () => {
    const fetchMock = mockImageResponse()
    await callImageApi({
      settings: createSettings({ model: 'gpt-image-2.6-flare', svgReasoningEffort: 'high' }),
      prompt: 'vector', params: { ...DEFAULT_PARAMS, output_format: 'svg' },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    })
    const body = getFormBody(fetchMock)
    expect(body.get('svg[model]')).toBe(DEFAULT_SVG_MODEL)
    expect(body.get('svg[reasoning][effort]')).toBe('high')
    expect(body.has('svg')).toBe(false)
  })

  it('sends SVG author reasoning in generation requests', async () => {
    const fetchMock = mockImageResponse()
    await callImageApi({
      settings: createSettings({ model: 'gpt-image-2.6-flare', svgReasoningEffort: 'high' }),
      prompt: 'vector', params: { ...DEFAULT_PARAMS, output_format: 'svg' }, inputImageDataUrls: [],
    })
    expect(getJsonBodies(fetchMock)[0].svg).toEqual({ model: DEFAULT_SVG_MODEL, reasoning: { effort: 'high' } })
  })

  it('rejects GIF masks before sending a request', async () => {
    const fetchMock = mockImageResponse()
    await expect(callImageApi({
      settings: createSettings({ model: 'gpt-image-2.6-flare' }),
      prompt: 'animate', params: { ...DEFAULT_PARAMS, output_format: 'gif' },
      inputImageDataUrls: [], maskDataUrl: 'data:image/png;base64,aW1hZ2U=',
    })).rejects.toThrow('GIF 不支持遮罩')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Responses SVG defaults and GIF lifecycle streaming', () => {
  it.each([
    [{}, undefined],
    [{ svgReasoningEffort: 'high' }, { reasoning: { effort: 'high' } }],
    [{ svgModel: 'gpt-6-luna', svgReasoningEffort: 'low' }, { model: 'gpt-6-luna', reasoning: { effort: 'low' } }],
  ])('preserves optional SVG author settings: %j', async (patch, expected) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'image_generation_call', result: 'aW1hZ2U=' }],
    }), { headers: { 'Content-Type': 'application/json' } }))
    await callImageApi({
      settings: createSettings({ apiMode: 'responses', model: 'gpt-6.1-sol', imageGenerationModel: 'gpt-image-2.6-flare', ...patch } as Partial<ApiProfile>),
      prompt: 'vector', params: { ...DEFAULT_PARAMS, output_format: 'svg' }, inputImageDataUrls: [],
    })
    expect(getJsonBodies(fetchMock)[0].tools[0].svg).toEqual(expected)
  })

  it('reads the final GIF from lifecycle events without requesting partial images', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: ' + JSON.stringify({ type: 'response.created', response: { output: [] } }) + '\n\n' +
      'data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'image_generation_call', result: 'aW1hZ2U=' }] } }) + '\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const result = await callImageApi({
      settings: createSettings({ apiMode: 'responses', model: 'gpt-6.1-sol', imageGenerationModel: 'gpt-image-2.6-flare', streamImages: true, streamPartialImages: 3 }),
      prompt: 'animate', params: { ...DEFAULT_PARAMS, output_format: 'gif' }, inputImageDataUrls: [],
    })
    const body = getJsonBodies(fetchMock)[0]
    expect(body.stream).toBe(true)
    expect(body.tools[0]).not.toHaveProperty('partial_images')
    expect(result.images).toEqual(['data:image/gif;base64,aW1hZ2U='])
  })
})
