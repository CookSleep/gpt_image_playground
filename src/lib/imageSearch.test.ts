import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type CustomProviderDefinition } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { callImageApi } from './api'
import { getImageSearchSupport, getImageThinkingSupport, parseImageSearchGrounding } from './imageSearch'
import { normalizeParamsForSettings } from './paramCompatibility'

afterEach(() => vi.restoreAllMocks())

const provider: CustomProviderDefinition = {
  id: 'custom-example', name: 'Example',
  submit: { path: 'images/generations', body: { prompt: '$prompt', search: '$params.google_search', image_search: '$params.image_search' }, result: { b64JsonPaths: ['data.*.b64_json'] } },
  modelOverrides: [{ models: ['gemini-lite-*'], submit: { path: 'images/generations', body: { prompt: '$prompt' } } }],
}

describe('图像搜索', () => {
  it.each([
    ['gemini-3.1-flash-image', ['minimal', 'high']],
    ['gemini-3.1-flash-lite-image', ['minimal', 'high']],
    ['gemini-nano-banana-2.1', ['minimal', 'medium', 'high']],
    ['gemini-3-pro-image', []],
    ['gemini-2.5-flash-image', []],
  ])('按图像模型提供思考等级：%s', (model, levels) => {
    expect(getImageThinkingSupport(createDefaultOpenAIProfile({ provider: 'google', model })).levels).toEqual(levels)
  })

  it.each(['auto', 'minimal', 'low', 'medium', 'high'] as const)('发送受支持的思考等级：%s', async (thinking_level) => {
    const profile = createDefaultOpenAIProfile({ provider: 'google', model: 'gemini-3.1-flash-image', apiKey: 'example-key', baseUrl: 'https://example.com/v1beta/' })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] } }] })))
    await callImageApi({ settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }), prompt: 'example', params: { ...DEFAULT_PARAMS, thinking_level }, inputImageDataUrls: [] })
    const body = JSON.parse(fetch.mock.calls[0][1]?.body as string)
    expect(body.generationConfig.thinkingConfig).toEqual(['minimal', 'high'].includes(thinking_level) ? { thinkingLevel: thinking_level.toUpperCase() } : undefined)
  })
  it.each([
    ['gemini-3-pro-image', true, false],
    ['gemini-3.1-flash-image', true, true],
    ['gemini-3.1-flash-image-preview', true, true],
    ['gemini-nano-banana-2.1', true, true],
    ['gemini-3.1-flash-lite-image', false, false],
    ['gemini-2.5-flash-image', false, false],
  ])('按模型判断搜索能力：%s', (model, web, image) => {
    const support = getImageSearchSupport(createDefaultOpenAIProfile({ provider: 'google', model }))
    expect(!support.googleSearch).toBe(web)
    expect(!support.imageSearch).toBe(image)
  })

  it('兼容接口没有统一搜索字段，自定义接口按模型映射判断', () => {
    const profile = createDefaultOpenAIProfile({ model: 'gemini-3.1-flash-image' })
    expect(getImageSearchSupport(profile).googleSearch).toContain('映射')
    expect(getImageSearchSupport({ ...profile, provider: provider.id }, provider)).toEqual({ googleSearch: undefined, imageSearch: undefined })
    expect(getImageSearchSupport({ ...profile, provider: provider.id, model: 'gemini-lite-image' }, provider).imageSearch).toContain('未映射')
  })

  it.each([
    ['gemini-3.1-flash-image', true, false, { searchTypes: { webSearch: {} } }],
    ['gemini-3.1-flash-image', false, true, { searchTypes: { imageSearch: {} } }],
    ['gemini-3.1-flash-image', true, true, { searchTypes: { webSearch: {}, imageSearch: {} } }],
    ['gemini-3-pro-image', true, true, {}],
    ['gemini-3.1-flash-lite-image', true, true, undefined],
    ['gemini-3.1-flash-image', false, false, undefined],
  ])('Google 请求独立控制搜索类型：%s，%s，%s', async (model, google_search, image_search, search) => {
    const profile = createDefaultOpenAIProfile({ provider: 'google', model, apiKey: 'example-key', baseUrl: 'https://example.com/v1beta/' })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] } }] })))
    await callImageApi({ settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }), prompt: 'example', params: { ...DEFAULT_PARAMS, google_search, image_search }, inputImageDataUrls: [] })
    const body = JSON.parse(fetch.mock.calls[0][1]?.body as string)
    expect(body.tools).toEqual(search === undefined ? undefined : [{ googleSearch: search }])
  })

  it('多图请求保留每次响应的搜索来源与搜索建议', async () => {
    const profile = createDefaultOpenAIProfile({ provider: 'google', model: 'gemini-3.1-flash-image', apiKey: 'example-key', baseUrl: 'https://example.com/v1beta/' })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ candidates: [{
      content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] },
      groundingMetadata: { searchEntryPoint: { renderedContent: '<div>Google Search</div>' }, groundingChunks: [{ image: { sourceUri: 'https://example.com/source', imageUri: 'https://example.com/image.png', title: 'Example source' } }] },
    }] })))
    const result = await callImageApi({ settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }), prompt: 'example', params: { ...DEFAULT_PARAMS, n: 2, google_search: true, image_search: true }, inputImageDataUrls: [] })
    expect(result.images).toHaveLength(2)
    expect(result.searchGrounding).toHaveLength(2)
    expect(result.searchGrounding?.[0]).toEqual({ renderedContent: '<div>Google Search</div>', sources: [{ uri: 'https://example.com/source', title: 'Example source' }] })
  })

  it('清洗搜索来源，忽略非网页链接并去重', () => {
    expect(parseImageSearchGrounding({ groundingChunks: [null, { web: { uri: 'javascript:alert(1)' } }, { web: { uri: 'https://example.com', title: 'Example' } }, { image: { sourceUri: 'https://example.com', title: 'Example' } }] })).toEqual({ sources: [{ uri: 'https://example.com', title: 'Example' }] })
    expect(parseImageSearchGrounding(null)).toBeUndefined()
  })

  it('切换到不支持的模型时清除搜索参数', () => {
    const profile = createDefaultOpenAIProfile({ provider: 'google', model: 'gemini-3.1-flash-lite-image' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, google_search: true, image_search: true }, settings)).toMatchObject({ google_search: undefined, image_search: undefined })
  })

  it('自定义服务商发送映射后的布尔搜索参数', async () => {
    const profile = createDefaultOpenAIProfile({ provider: provider.id, model: 'gemini-3.1-flash-image', apiKey: 'example-key', baseUrl: 'https://example.com/v1' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id, customProviders: [provider] })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })))
    await callImageApi({ settings, prompt: 'example', params: normalizeParamsForSettings({ ...DEFAULT_PARAMS, google_search: true, image_search: false }, settings), inputImageDataUrls: [] })
    const body = JSON.parse(fetch.mock.calls[0][1]?.body as string)
    expect(body).toMatchObject({ search: true, image_search: false })
  })
})
