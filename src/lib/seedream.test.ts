import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type CustomProviderDefinition } from '../types'
import { callImageApi } from './api'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, getActiveApiProfile, normalizeSettings, switchApiProfileProvider } from './apiProfiles'
import { getImageModelFamily } from './imageModels'
import { getImageModelOptions, getSeedreamSize } from './imageModelParams'
import { normalizeParamsForSettings } from './paramCompatibility'
import { prepareSettingsForCommit } from './settingsActions'
import { normalizeSeedreamImageSize, getSeedreamRatioSize } from './size'

afterEach(() => vi.restoreAllMocks())

describe('Seedream 5.5', () => {
  it.each(['bytedance', 'openai', 'custom-json'])('sends all background modes through %s', async (provider) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })))
    const profile = createDefaultOpenAIProfile({ provider, model: 'doubao-seedream-5-5-261028', baseUrl: 'https://example.com/v1/', apiKey: 'test-key' })
    const settings = normalizeSettings({ profiles: [profile], activeProfileId: profile.id, customProviders: [{ id: 'custom-json', name: '测试', submit: { path: 'images/generations', body: { watermark: '$params.watermark', background: '$params.background', output_format: '$params.output_format' } } }] })
    for (const background of ['auto', 'transparent', 'opaque'] as const) {
      const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, output_format: 'jpeg', background, watermark: false }, settings)
      expect(params.transparent_output).toBe(background === 'transparent')
      await callImageApi({ settings, prompt: '测试', params, inputImageDataUrls: [], nativeTransparentBackground: params.transparent_output })
      const body = JSON.parse(String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1]?.body))
      expect(body.watermark).toBe(false)
      expect(body.background).toBe(background)
      expect(body.output_format).toBe(background === 'transparent' ? 'png' : 'jpeg')
    }
  })

  it('requests an opaque image for local background removal', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })))
    const profile = createDefaultOpenAIProfile({ provider: 'bytedance', model: 'doubao-seedream-5-5-261028', baseUrl: 'https://example.com/v3/', apiKey: 'test-key', transparentBackgroundMethod: 'local' })
    const settings = normalizeSettings({ profiles: [profile], activeProfileId: profile.id })
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, background: 'transparent' }, settings)
    await callImageApi({ settings, prompt: '测试', params, inputImageDataUrls: [], nativeTransparentBackground: false })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).background).toBe('opaque')
    expect(params).toMatchObject({ background: 'transparent', transparent_output: true })
  })

  it.each(['1281x721', '8192x512', '512x8192', '2100x2100'])('preserves valid custom dimensions %s', (size) => {
    expect(normalizeSeedreamImageSize(size)).toBe(size)
    const profile = switchApiProfileProvider(createDefaultOpenAIProfile(), 'bytedance')
    const settings = normalizeSettings({ profiles: [profile], activeProfileId: profile.id })
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, size, aspect_ratio: 'custom', resolution: '4K' }, settings)
    expect(params).toMatchObject({ size, aspect_ratio: 'custom', resolution: undefined })
    expect(getSeedreamSize(profile, params)).toBe(size)
  })

  it.each(['1x1', '1x100000', '100000x1', '10000x10000', '100x100', '999999999999x999999999999'])('normalizes out-of-range custom dimensions %s', (size) => {
    const [w, h] = normalizeSeedreamImageSize(size).split('x').map(Number)
    expect(w * h).toBeGreaterThanOrEqual(921600)
    expect(w * h).toBeLessThanOrEqual(4624220)
    expect(w / h).toBeGreaterThanOrEqual(1 / 16)
    expect(w / h).toBeLessThanOrEqual(16)
  })

  it.each(['auto', '0x1000', '-1x1000', 'NaNx10', '1.5x1024', '1e20x1'])('rejects invalid custom dimensions %s', (size) => {
    expect(normalizeSeedreamImageSize(size)).toBe('')
  })

  it.each(['bytedance', 'openai', 'custom-json'])('sends exact custom dimensions through %s', async (provider) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })))
    const profile = createDefaultOpenAIProfile({ provider, model: 'doubao-seedream-5-5-261028', baseUrl: 'https://example.com/v1/', apiKey: 'test-key' })
    const settings = normalizeSettings({ profiles: [profile], activeProfileId: profile.id, customProviders: [{ id: 'custom-json', name: '测试', submit: { path: 'images/generations', body: { size: '$params.size', aspect_ratio: '$params.aspect_ratio', resolution: '$params.resolution' } } }] })
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '8192x512', aspect_ratio: 'custom' }, settings)
    await callImageApi({ settings, prompt: '测试', params, inputImageDataUrls: [] })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.size).toBe('8192x512')
    expect(body).not.toHaveProperty('aspect_ratio')
    expect(body).not.toHaveProperty('resolution')
  })

  it.each(['doubao-seedream-5-5-261028', 'seedream-5.5', 'bytedance/seedream-5.5', 'seedream-5-5', 'seedream-v5.5', 'seedream_v5_5', 'seedreamv5.5', 'seedream5.5', ' Seedream 5.5 ', 'bytedance/seedream-v5.5', 'doubao-seedream-v5.5-261028'])('recognizes %s through compatible and custom providers', (model) => {
    for (const provider of ['openai', 'custom-json']) {
      expect(getImageModelFamily({ provider, apiMode: 'images', model })).toBe('seedream')
    }
    expect(getImageModelFamily({ provider: 'openai', apiMode: 'responses', model })).toBeNull()
  })

  it.each(['seedream-v5.50', 'seedream-v5.0', 'seedream-v4.5', 'seedream-v15.5', 'seedream-v5.5foo', 'notseedream-v5.5'])('does not recognize %s as Seedream 5.5', (model) => {
    for (const provider of ['openai', 'custom-json']) {
      expect(getImageModelFamily({ provider, apiMode: 'images', model })).toBeNull()
    }
  })

  it('preserves the native provider, API path and transparency after saving', () => {
    const profile = switchApiProfileProvider(createDefaultOpenAIProfile(), 'bytedance')
    const settings = prepareSettingsForCommit(normalizeSettings({ profiles: [{ ...profile, baseUrl: profile.baseUrl.replace(/\/$/, '') }], activeProfileId: profile.id }))
    expect(getActiveApiProfile(settings)).toMatchObject({ provider: 'bytedance', model: 'doubao-seedream-5-5-261028', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', transparentBackgroundMethod: 'api', codexCli: false, streamImages: false })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 6, resolution: '4K', output_format: 'webp', google_search: true }, settings)).toMatchObject({ n: 1, resolution: '2K', size: '2K', output_format: 'png', google_search: undefined })
  })

  it('keeps all resolution and ratio combinations within the documented pixel limits', () => {
    const profile = switchApiProfileProvider(createDefaultOpenAIProfile(), 'bytedance')
    const options = getImageModelOptions(profile)
    for (const resolution of options.resolutions) {
      for (const aspect_ratio of options.ratios) {
        const size = getSeedreamSize(profile, { ...DEFAULT_PARAMS, resolution, aspect_ratio })
        if (aspect_ratio === 'auto') {
          expect(size).toBe(resolution)
          continue
        }
        const [w, h] = size.split('x').map(Number)
        expect(w * h).toBeGreaterThanOrEqual(921600)
        expect(w * h).toBeLessThanOrEqual(4624220)
        expect(w / h).toBeGreaterThanOrEqual(1 / 16)
        expect(w / h).toBeLessThanOrEqual(16)
      }
    }
  })

  it.each(['32:1', '1:32', '100:1'])('normalizes out-of-range custom ratios %s', (ratio) => {
    const [w, h] = getSeedreamRatioSize('2K', ratio).split('x').map(Number)
    expect(w / h).toBeGreaterThanOrEqual(1 / 16)
    expect(w / h).toBeLessThanOrEqual(16)
    expect(w * h).toBeGreaterThanOrEqual(921600)
    expect(w * h).toBeLessThanOrEqual(4624220)
  })

  it.each(['16:9', '16x9', '16X9', '16×9', ' 16 : 9 '])('accepts ratio separators used by the size dialog: %s', (ratio) => {
    expect(getSeedreamRatioSize('2K', ratio)).toBe('2730x1536')
  })

  it.each(['bytedance', 'openai'])('sends only supported fields with %s for generation and reference editing', async (provider) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })))
    const profile = createDefaultOpenAIProfile({ provider, apiKey: 'test-key', baseUrl: provider === 'bytedance' ? 'https://ark.cn-beijing.volces.com/api/v3' : 'https://example.com/v1', model: 'doubao-seedream-5-5-261028', responseFormatB64Json: true })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
    for (const inputImageDataUrls of [[], ['data:image/png;base64,aW1hZ2U=']]) {
      await callImageApi({ settings, prompt: '贴纸', params: { ...DEFAULT_PARAMS, n: 4, quality: 'high', moderation: 'low', output_compression: 70, output_format: 'jpeg', background: 'transparent' }, inputImageDataUrls, nativeTransparentBackground: true })
      const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
      expect(url).toBe(`${profile.baseUrl}/images/generations`)
      expect(JSON.parse(String(init?.body))).toEqual({ model: profile.model, prompt: '贴纸', size: '2K', output_format: 'png', background: 'transparent', watermark: false, response_format: 'b64_json', ...(inputImageDataUrls.length ? { image: inputImageDataUrls } : {}) })
    }
  })

  it('honors model overrides and omits unsupported parameter mappings for custom providers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })))
    const mapping = {
      path: 'seedream/generate',
      contentType: 'json' as const,
      body: { model: '$profile.model', prompt: '$prompt', size: '$params.size', output_format: '$params.output_format', background: '$params.background', image: '$inputImages.dataUrls', quality: '$params.quality', n: '$params.n', moderation: '$params.moderation', compression: '$params.output_compression', thinking: '$params.thinking_level', search: '$params.google_search' },
      result: { b64JsonPaths: ['data.*.b64_json'] },
    }
    const customProvider: CustomProviderDefinition = { id: 'custom-json', name: '测试', submit: { path: 'other' }, modelOverrides: [{ models: ['*seedream*'], submit: mapping, editSubmit: mapping }] }
    const profile = createDefaultOpenAIProfile({ provider: customProvider.id, model: 'bytedance/seedream-5.5', baseUrl: 'https://example.com/v1', apiKey: 'test-key' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, customProviders: [customProvider], profiles: [profile], activeProfileId: profile.id })
    expect(getActiveApiProfile(settings).transparentBackgroundMethod).toBe('api')
    await callImageApi({ settings, prompt: '测试', params: { ...DEFAULT_PARAMS, resolution: '1.5K', aspect_ratio: '1:1', n: 4, google_search: true, background: 'transparent' }, inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='], nativeTransparentBackground: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.com/v1/seedream/generate')
    expect(JSON.parse(String(init?.body))).toEqual({ model: profile.model, prompt: '测试', size: '1536x1536', output_format: 'png', background: 'transparent', image: ['data:image/png;base64,aW1hZ2U='] })
  })

  it('rejects excess reference images before sending a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const profile = switchApiProfileProvider(createDefaultOpenAIProfile(), 'bytedance')
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
    await expect(callImageApi({ settings, prompt: '测试', params: DEFAULT_PARAMS, inputImageDataUrls: Array(11).fill('data:image/png;base64,aW1hZ2U=') })).rejects.toThrow('最多接受 10 张参考图')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
