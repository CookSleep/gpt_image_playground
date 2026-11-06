import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type ApiProfile, type CustomProviderDefinition } from '../types'
import { callImageApi } from './api'
import { createDefaultOpenAIProfile, createSettingsForApiProfile, DEFAULT_SETTINGS, getActiveApiProfile, importCustomProviderSettingsFromJson, normalizeSettings, resolveApiProfileModel, switchApiProfileProvider } from './apiProfiles'
import { getCustomQueuedImageResult } from './openaiCompatibleImageApi'
import { OPENAI_IMAGE_TASK_PROVIDER } from './imageProviderMappings'
import { getImageModelFamily } from './imageModels'
import { getImageModelOptions } from './imageModelParams'
import { customProviderSupportsNativeTransparentBackground } from './customProviderCapabilities'
import { normalizeParamsForSettings } from './paramCompatibility'
import { prepareSettingsForCommit } from './settingsActions'

const EXAMPLE_PROVIDER: CustomProviderDefinition = {
  id: 'custom-example',
  name: 'Example',
  submit: {
    path: 'generateTask/{model}',
    body: { request_type: 'async', input: { mode: '$mode', prompt: '$prompt', aspect_ratio: '$params.aspect_ratio', resolution: '$resolution.lower', image_urls: '$inputImages.urls' } },
    taskIdPath: 'data.taskId',
  },
  poll: {
    path: 'statusTask/{model}', query: { taskId: '{task_id}' }, intervalSeconds: 5,
    statusPath: 'data.state', successValues: ['success'], failureValues: ['failed'], errorPath: 'data.failMsg',
    result: { imageUrlPaths: ['data.resultJson.resultUrls.*'] },
  },
  modelOverrides: [{
    models: ['grok-*'],
    submit: {
      path: 'generateTask/{model}',
      body: { request_type: 'async', input: { mode: '$mode', prompt: '$prompt', aspect_ratio: '$params.aspect_ratio', image_urls: '$inputImages.urls' } },
      taskIdPath: 'data.taskId',
    },
  }],
}

const EXAMPLE_CONFIG = {
  customProviders: [EXAMPLE_PROVIDER],
  profiles: [createDefaultOpenAIProfile({ provider: 'custom-example', baseUrl: 'https://api.example.com/api/v1', model: 'gemini-example-image, grok-imagine-image-2.0' })],
}

const PNG = 'data:image/png;base64,aW1hZ2U='

function settings(profile: Partial<ApiProfile>, customProviders: CustomProviderDefinition[] = []) {
  const item = createDefaultOpenAIProfile({ baseUrl: 'https://example.com/v1', apiKey: 'test-key', ...profile })
  return normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [item], activeProfileId: item.id, customProviders })
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('图像模型配置和参数', () => {
  it('临时复用其他配置中的模型时，按实际模型保留比例和分辨率', () => {
    const original = createDefaultOpenAIProfile({ id: 'original', model: 'gpt-image-2.6' })
    const mixed = createDefaultOpenAIProfile({ id: 'mixed', model: 'gpt-image-2.6, gemini-example-image', selectedModel: 'gpt-image-2.6', codexCli: true })
    const config = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [original, mixed], activeProfileId: original.id })
    const reused = resolveApiProfileModel(mixed, 'gemini-example-image')
    const effective = createSettingsForApiProfile(config, reused)
    expect(getActiveApiProfile(effective)).toMatchObject({ id: 'mixed', model: 'gemini-example-image', codexCli: false })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, aspect_ratio: '16:9', resolution: '4K' }, effective)).toMatchObject({ aspect_ratio: '16:9', resolution: '4K' })
    expect(config.activeProfileId).toBe('original')
    expect(config.profiles[1]).toMatchObject({ selectedModel: 'gpt-image-2.6', codexCli: true })
  })

  it.each([false, true])('混合模型的透明背景能力互不影响，GPT 映射位于覆盖项：%s', (override) => {
    const withBackground = { path: 'images/generations', body: { background: '$params.background' } }
    const withoutBackground = { path: 'images/generations', body: { prompt: '$prompt' } }
    const provider: CustomProviderDefinition = {
      id: 'custom-example', name: 'Example',
      submit: override ? withoutBackground : withBackground,
      modelOverrides: [{ models: override ? ['gpt-*'] : ['gemini-*', 'example-*'], submit: override ? withBackground : withoutBackground }],
    }
    const config = settings({ provider: provider.id, model: 'gpt-image-2.6, gemini-example-image, example-image', selectedModel: 'gemini-example-image', transparentBackgroundMethod: 'api' }, [provider])
    expect(customProviderSupportsNativeTransparentBackground(provider)).toBe(true)
    expect(customProviderSupportsNativeTransparentBackground(provider, 'gpt-image-2.6')).toBe(true)
    expect(customProviderSupportsNativeTransparentBackground(provider, 'example-image')).toBe(false)
    const restored = normalizeSettings(JSON.parse(JSON.stringify(config)))
    expect(restored.profiles[0].transparentBackgroundMethod).toBe('api')
    expect(getActiveApiProfile(restored).transparentBackgroundMethod).toBe('local')
    expect(resolveApiProfileModel(restored.profiles[0], undefined, provider).transparentBackgroundMethod).toBe('local')
    for (const [model, method] of [['gpt-image-2.6', 'api'], ['example-image', 'local']]) {
      const selected = normalizeSettings({ ...restored, profiles: [{ ...restored.profiles[0], selectedModel: model }] })
      expect(getActiveApiProfile(selected).transparentBackgroundMethod).toBe(method)
      expect(selected.profiles[0].transparentBackgroundMethod).toBe('api')
    }
  })

  it('Flash Lite 只提供 1K 和常规比例，Flash 保留 512 与扩展比例', () => {
    const lite = createDefaultOpenAIProfile({ provider: 'google', model: 'gemini-3.1-flash-lite-image' })
    const options = getImageModelOptions(lite)
    expect(options.resolutions).toEqual(['1K'])
    for (const ratio of ['1:4', '4:1', '1:8', '8:1']) expect(options.ratios).not.toContain(ratio)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, aspect_ratio: '1:8', resolution: '512' }, settings(lite))).toMatchObject({ aspect_ratio: 'auto', resolution: '1K' })
    const flash = getImageModelOptions({ ...lite, model: 'gemini-3.1-flash-image' })
    expect(flash.resolutions).toContain('512')
    expect(flash.ratios).toContain('1:8')
  })

  it.each(['google/gemini-3.1-flash-image-2K', 'gemini-nano-banana-example', 'nano-banana-2-1'])('识别 Gemini 模型 %s', (model) => {
    expect(getImageModelFamily(createDefaultOpenAIProfile({ model }))).toBe('gemini')
  })

  it.each(['grok-imagine-image-2.0', 'xai/grok-2-image', 'grok-imagine-1.5-example', 'grok-imagine-image'])('识别 Grok 模型 %s', (model) => {
    expect(getImageModelFamily(createDefaultOpenAIProfile({ model }))).toBe('grok')
  })

  it('不把文本和视频模型识别成图片模型', () => {
    for (const model of ['gemini-3-pro', 'grok-4', 'grok-imagine-video', 'gpt-image-2.6']) {
      expect(getImageModelFamily(createDefaultOpenAIProfile({ model }))).toBeNull()
    }
  })

  it('混合模型配置按选中的 ID 切换，恢复后保留选择', () => {
    const config = settings({ model: 'gpt-image-2.6, gemini-3.1-flash-image, grok-imagine-image-2.0', selectedModel: 'gemini-3.1-flash-image' })
    const restored = normalizeSettings(JSON.parse(JSON.stringify(config)))
    expect(getImageModelFamily(getActiveApiProfile(restored))).toBe('gemini')
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 4, quality: 'max', output_format: 'gif', aspect_ratio: '16:9', resolution: '4K' }, restored)
    expect(params).toMatchObject({ n: 4, quality: 'auto', output_format: 'png', aspect_ratio: '16:9', resolution: '4K' })
    const grok = settings({ model: 'grok-imagine-image-2.0' })
    expect(normalizeParamsForSettings(params, grok)).toMatchObject({ resolution: '1K', quality: 'auto' })
    const gpt = settings({ model: 'gpt-image-2.6' })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'max', n: 4 }, gpt)).toMatchObject({ quality: 'max', n: 4 })
  })

  it.each(['google', 'xai'])('官方服务商 %s 可以切换、导出和恢复', (provider) => {
    const profile = switchApiProfileProvider(createDefaultOpenAIProfile(), provider)
    const config = prepareSettingsForCommit(settings(profile))
    const restored = importCustomProviderSettingsFromJson(JSON.stringify({ profiles: config.profiles, customProviders: [] }))
    expect(restored.profiles[0]).toMatchObject({ provider, model: profile.model, baseUrl: profile.baseUrl, transparentBackgroundMethod: 'local', apiMode: 'images' })
  })

  it.each([
    ['https://example.com/v1beta', 'https://example.com/v1beta'],
    ['https://example.com/v1beta/models', 'https://example.com/v1beta'],
    ['https://example.com/proxy', 'https://example.com/proxy/v1beta'],
    ['https://example.com/proxy/', 'https://example.com/proxy/'],
  ])('Google 地址按 v1beta 补齐前缀：%s', (baseUrl, expected) => {
    const config = prepareSettingsForCommit(settings({ provider: 'google', baseUrl, model: 'gemini-3.1-flash-image' }))
    expect(config.baseUrl).toBe(expected)
  })

  it.each(['gemini-example-image', 'grok-imagine-image-2.0'])('混合模型配置中的 %s 忽略 Codex CLI 开关，切回 GPT 时保留', (model) => {
    const config = settings({ model: `gpt-image-2.6, ${model}`, selectedModel: model, codexCli: true })
    expect(getActiveApiProfile(config).codexCli).toBe(false)
    expect(config.profiles[0].codexCli).toBe(true)
    const restored = normalizeSettings({ ...config, profiles: [{ ...config.profiles[0], selectedModel: 'gpt-image-2.6' }] })
    expect(getActiveApiProfile(restored).codexCli).toBe(true)
  })

  it.each(['openai', 'custom-example'])('%s 中的 Gemini、Grok 不受 Codex CLI 开关影响', async (provider) => {
    const customProvider: CustomProviderDefinition = {
      id: 'custom-example', name: 'Example',
      submit: { path: 'images/generations', body: { prompt: '$prompt', size: '$params.size', resolution: '$params.resolution', quality: '$params.quality', n: '$params.n' } },
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ data: [{ b64_json: 'aW1hZ2U=' }] }))
    for (const model of ['gemini-example-image', 'grok-imagine-image-2.0']) {
      for (const codexCli of [false, true]) {
        await callImageApi({ settings: settings({ provider, model, codexCli }, [customProvider]), prompt: '猫', params: { ...DEFAULT_PARAMS, n: 3, size: '1536x1024', aspect_ratio: '3:2', resolution: '2K', quality: 'medium' }, inputImageDataUrls: [] })
      }
    }
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[2]).toEqual(bodies[3])
    expect(bodies[1]).toMatchObject({ prompt: '猫', resolution: '2K', n: 3 })
    expect(bodies[3]).toMatchObject({ prompt: '猫', quality: 'medium', n: 3 })
  })
})

describe('Google 单次生成', () => {
  it('发送单轮图文、比例和分辨率，使用实际 MIME 并排除思考图片', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ candidates: [{ content: { parts: [
      { thought: true, inlineData: { mimeType: 'image/png', data: 'draft' } },
      { text: '完成' },
      { inlineData: { mimeType: 'image/jpeg', data: 'aW1hZ2U=' } },
    ] } }] }))
    const result = await callImageApi({
      settings: settings({ provider: 'google', model: 'gemini-3.1-flash-image', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
      prompt: '修改背景', params: { ...DEFAULT_PARAMS, aspect_ratio: '16:9', resolution: '2K' }, inputImageDataUrls: [PNG],
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', 'x-goog-api-key': 'test-key' })
    expect(JSON.parse(String(init?.body))).toEqual({
      contents: [{ role: 'user', parts: [{ text: '生成图像：\n修改背景' }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' } },
    })
    expect(result.images).toEqual(['data:image/jpeg;base64,aW1hZ2U='])
  })

  it('Gemini 2.5 不发送 imageSize，自动比例不传 aspectRatio', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'aW1hZ2U=' } }] } }] }))
    const result = await callImageApi({ settings: settings({ provider: 'google', model: 'gemini-2.5-flash-image' }), prompt: '猫', params: { ...DEFAULT_PARAMS, resolution: '1K' }, inputImageDataUrls: [] })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).generationConfig.imageConfig).toEqual({})
    expect(result.actualParamsList?.[0]).not.toHaveProperty('resolution')
  })

  it('没有图片时保留拦截原因和原始响应', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ promptFeedback: { blockReason: 'SAFETY' } }))
    await expect(callImageApi({ settings: settings({ provider: 'google' }), prompt: '猫', params: DEFAULT_PARAMS, inputImageDataUrls: [] })).rejects.toMatchObject({ message: '接口未返回图片：SAFETY', rawResponsePayload: expect.stringContaining('SAFETY') })
  })

  it('多张拆分独立请求，保留全部返回图片和部分失败信息', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ candidates: [{ content: { parts: [
        { inlineData: { mimeType: 'image/png', data: 'first' } },
        { inlineData: { mimeType: 'image/png', data: 'second' } },
      ] } }] }))
      .mockResolvedValueOnce(json({ error: { message: 'example failure' } }, 400))
      .mockResolvedValueOnce(json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'third' } }] } }] }))
    const result = await callImageApi({ settings: settings({ provider: 'google', model: 'gemini-example-image' }), prompt: '猫', params: { ...DEFAULT_PARAMS, n: 3 }, inputImageDataUrls: [] })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String(init?.body))
      expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '生成图像：\n猫' }] }])
      expect(body).not.toHaveProperty('n')
      expect(body.generationConfig).not.toHaveProperty('candidateCount')
    }
    expect(result.images).toEqual(['first', 'second', 'third'].map((data) => `data:image/png;base64,${data}`))
    expect(result.actualParamsList).toHaveLength(3)
    expect(result.failedRequests).toEqual([{ requestIndex: 1, error: 'example failure' }])
  })
})

describe('OpenAI Images 模型适配', () => {
  it('Grok 数字别名使用 size 和链接参考图，在 generations 中提交', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [{ task_id: 'example-task' }] }))
      .mockResolvedValueOnce(json({ data: { status: 'completed', result: { images: [{ url: [PNG] }] } } }))
    const config = settings({ model: 'grok-imagine-1.5-ext' })
    const profile = getActiveApiProfile(config)
    expect(getImageModelOptions(profile).resolutions).toEqual([])
    expect(getImageModelOptions(profile).ratios).not.toContain('21:9')
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 2, aspect_ratio: '16:9', resolution: '2K', quality: 'medium' }, config)
    expect(params.resolution).toBeUndefined()
    await callImageApi({ settings: config, prompt: '猫', params, inputImageDataUrls: [PNG], inputImageUrls: ['https://images.example.com/input.png'] })
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/v1/images/generations')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ model: 'grok-imagine-1.5-ext', prompt: '猫', n: 2, size: '16:9', image_urls: ['https://images.example.com/input.png'] })
    expect(fetchMock.mock.calls[1][0]).toBe('https://example.com/v1/tasks/example-task')
  })

  it('Grok 数字别名拒绝本地参考图，避免提交无效的 Base64 请求', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(callImageApi({ settings: settings({ model: 'grok-imagine-1.5-ext' }), prompt: '猫', params: DEFAULT_PARAMS, inputImageDataUrls: [PNG], inputImageUrls: [null] })).rejects.toThrow('只接受链接参考图')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Gemini 替换 GPT 参数，并在 generations 中传递参考图', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [{ b64_json: 'aW1hZ2U=' }] }))
    await callImageApi({ settings: settings({ model: 'gemini-nano-banana-example', streamImages: true }), prompt: '猫', params: { ...DEFAULT_PARAMS, n: 3, quality: 'max', aspect_ratio: '3:2', resolution: '4K' }, inputImageDataUrls: [PNG] })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/v1/images/generations')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ model: 'gemini-nano-banana-example', prompt: '猫', n: 3, size: '3:2', resolution: '4K', image_urls: [PNG] })
  })

  it.each(['openai', 'xai'])('Grok 在 %s 入口使用 JSON 编辑及原生参数', async (provider) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [{ b64_json: '/9j/aW1hZ2U=' }, { b64_json: '/9j/second' }] }))
    const result = await callImageApi({ settings: settings({ provider, model: 'grok-imagine-image-2.0', responseFormatB64Json: true }), prompt: '合并', params: { ...DEFAULT_PARAMS, n: 2, aspect_ratio: '16:9', resolution: '2K', quality: 'medium' }, inputImageDataUrls: [PNG, PNG] })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/v1/images/edits')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ model: 'grok-imagine-image-2.0', prompt: '合并', n: 2, aspect_ratio: '16:9', resolution: '2k', quality: 'medium', images: [{ type: 'image_url', url: PNG }, { type: 'image_url', url: PNG }], response_format: 'b64_json' })
    expect(result.images).toHaveLength(2)
    expect(result.images[0]).toMatch(/^data:image\/jpeg/)
  })

  it('旧 Grok 模型不发送 quality，单张参考图使用 image 字段', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [{ b64_json: 'aW1hZ2U=' }] }))
    await callImageApi({ settings: settings({ model: 'grok-imagine-image' }), prompt: '猫', params: { ...DEFAULT_PARAMS, quality: 'high' }, inputImageDataUrls: [PNG] })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).not.toHaveProperty('quality')
    expect(body.image).toEqual({ type: 'image_url', url: PNG })
  })

  it.each(['google', 'xai', 'openai'])('%s 拒绝不支持的遮罩编辑', async (provider) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(callImageApi({ settings: settings({ provider, model: 'gemini-3.1-flash-image' }), prompt: '猫', params: DEFAULT_PARAMS, inputImageDataUrls: [PNG], maskDataUrl: PNG })).rejects.toThrow('不支持遮罩编辑')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('异步任务和自定义多模型映射', () => {
  it('多张异步生成保留 n，并取回同一任务的全部图片', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [{ task_id: 'example-task' }] }))
      .mockResolvedValueOnce(json({ data: { status: 'completed', result: { images: [{ url: [PNG, 'data:image/png;base64,second'] }] } } }))
    const result = await callImageApi({ settings: settings({ model: 'gemini-example-image', streamImages: true }), prompt: '猫', params: { ...DEFAULT_PARAMS, n: 2 }, inputImageDataUrls: [] })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).n).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.images).toEqual([PNG, 'data:image/png;base64,second'])
  })

  it('兼容接口的提交、轮询和恢复使用相同代理', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [{ task_id: 'example-task' }] }))
      .mockImplementation(async () => json({ data: { status: 'completed', result: { images: [{ url: PNG }] } } }))
    const config = settings({ model: 'gemini-example-image', apiProxy: true })
    await callImageApi({ settings: config, prompt: '猫', params: DEFAULT_PARAMS, inputImageDataUrls: [] })
    await getCustomQueuedImageResult(getActiveApiProfile(config), OPENAI_IMAGE_TASK_PROVIDER, 'example-task', DEFAULT_PARAMS)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api-proxy/images/generations', '/api-proxy/tasks/example-task', '/api-proxy/tasks/example-task'])
  })

  it('xAI 官方入口不使用锁定的 OpenAI 代理', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    vi.stubEnv('VITE_API_PROXY_LOCKED', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [{ b64_json: 'aW1hZ2U=' }] }))
    await callImageApi({ settings: settings({ provider: 'xai', model: 'grok-imagine-image-2.0' }), prompt: '猫', params: DEFAULT_PARAMS, inputImageDataUrls: [] })
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/v1/images/generations')
  })

  it('接受任务对象形式的 ID 和字符串结果链接', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: { object: 'generation.task', id: 'example-task', status: 'pending' } }, 202))
      .mockResolvedValueOnce(json({ data: { status: 'completed', result: { images: [{ url: PNG }] } } }))
    await callImageApi({ settings: settings({ model: 'grok-imagine-image-2.0' }), prompt: '猫', params: DEFAULT_PARAMS, inputImageDataUrls: [] })
    expect(fetchMock.mock.calls[1][0]).toBe('https://example.com/v1/tasks/example-task')
  })

  it('轮询遇到临时错误和处理中状态时继续查询，不重复提交', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [{ task_id: 'example-task' }] }))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ data: { status: 'processing' } }))
      .mockResolvedValueOnce(json({ data: { status: 'completed', result: { images: [{ url: [PNG] }] } } }))
    const result = callImageApi({ settings: settings({ model: 'gemini-example-image', timeout: 1 }), prompt: '猫', params: DEFAULT_PARAMS, inputImageDataUrls: [] })
    await vi.advanceTimersByTimeAsync(9000)
    expect((await result).images).toEqual([PNG])
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('自定义服务商为 Gemini 传入比例和分辨率，为 Grok 使用另一套映射', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: { taskId: 'example-task' } }))
      .mockResolvedValueOnce(json({ data: { state: 'success', resultJson: JSON.stringify({ resultUrls: [PNG] }) } }))
    await callImageApi({ settings: settings(EXAMPLE_CONFIG.profiles[0], EXAMPLE_CONFIG.customProviders), prompt: '猫', params: { ...DEFAULT_PARAMS, aspect_ratio: '3:2', resolution: '4K' }, inputImageDataUrls: [PNG], inputImageUrls: ['https://images.example.com/input.png'] })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ request_type: 'async', input: { mode: 'image-to-image', prompt: '猫', aspect_ratio: '3:2', resolution: '4k', image_urls: ['https://images.example.com/input.png'] } })
  })

  it('兼容接口提交后轮询，不重复生成；可恢复同一个任务', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [{ task_id: 'task/1', status: 'submitted' }] }))
      .mockResolvedValueOnce(json({ data: { status: 'completed', result: { images: [{ url: [PNG] }] } } }))
    const enqueued = vi.fn()
    const config = settings({ model: 'gemini-nano-banana-example' })
    const result = await callImageApi({ settings: config, prompt: '猫', params: DEFAULT_PARAMS, inputImageDataUrls: [], onCustomTaskEnqueued: enqueued })
    expect(enqueued).toHaveBeenCalledWith({ taskId: 'task/1' })
    expect(fetchMock.mock.calls[1][0]).toBe('https://example.com/v1/tasks/task%2F1')
    expect(result.images).toEqual([PNG])
    fetchMock.mockClear().mockResolvedValue(json({ data: { status: 'completed', result: { images: [{ url: [PNG] }] } } }))
    await getCustomQueuedImageResult(getActiveApiProfile(config), OPENAI_IMAGE_TASK_PROVIDER, 'task/1', DEFAULT_PARAMS)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET')
  })

  it('自定义服务商按模型替换路径，解析 JSON 字符串结果，并保留导入后的映射', async () => {
    const imported = importCustomProviderSettingsFromJson(JSON.stringify(EXAMPLE_CONFIG))
    const provider = imported.customProviders[0]
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: { taskId: 'task&1' } }))
      .mockResolvedValueOnce(json({ data: { state: 'success', resultJson: JSON.stringify({ resultUrls: [PNG] }) } }))
    const result = await callImageApi({ settings: settings({ ...imported.profiles[0], selectedModel: 'grok-imagine-image-2.0' }, [provider]), prompt: '猫', params: DEFAULT_PARAMS, inputImageDataUrls: [] })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/api/v1/generateTask/grok-imagine-image-2.0')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ request_type: 'async', input: { mode: 'text-to-image', prompt: '猫', aspect_ratio: 'auto' } })
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/api/v1/statusTask/grok-imagine-image-2.0?taskId=task%261')
    expect(result.images).toEqual([PNG])
  })

  it('仅接受链接的自定义服务商不静默丢弃本地参考图', async () => {
    const preset = EXAMPLE_CONFIG
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(callImageApi({ settings: settings(preset.profiles[0], preset.customProviders), prompt: '猫', params: DEFAULT_PARAMS, inputImageDataUrls: [PNG], inputImageUrls: [null] })).rejects.toThrow('只接受链接参考图')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('异步失败保留服务商原因', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [{ task_id: 'failed-task' }] }))
      .mockResolvedValueOnce(json({ data: { status: 'failed', error: { message: '额度不足' } } }))
    await expect(callImageApi({ settings: settings({ model: 'gemini-nano-banana-example' }), prompt: '猫', params: DEFAULT_PARAMS, inputImageDataUrls: [] })).rejects.toThrow('额度不足')
  })
})
