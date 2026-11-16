import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type CustomProviderSubmitMapping, type TaskParams } from '../types'
import { callImageApi } from './api'
import { importCustomProviderSettingsFromJson, normalizeSettings } from './apiProfiles'

function settings(submit: CustomProviderSubmitMapping, model = 'example-image') {
  return normalizeSettings({
    customProviders: [{ id: 'custom-template', name: '模板测试', submit: { ...submit, result: { b64JsonPaths: ['image'] } } }],
    activeProfileId: 'test',
    profiles: [{ id: 'test', provider: 'custom-template', model, baseUrl: 'https://example.com/v1', apiKey: 'test' }],
  })
}

afterEach(() => vi.restoreAllMocks())

describe('自定义提交模板的具体宽高变量', () => {
  it.each([
    { model: 'example-image', params: { size: '1536x1024' }, expected: { size: '1536x1024', original: '1536x1024' } },
    { model: 'example-image', params: { size: 'auto' }, expected: { original: 'auto' } },
    { model: 'example-image', params: { size: '4K' }, expected: { original: '4K' } },
    { model: 'example-image', params: { size: '16:9' }, expected: { original: '16:9' } },
    { model: 'seedream-5-5', params: { aspect_ratio: 'auto', resolution: '1.5K' }, expected: { original: '1.5K', ratio: 'auto', resolution: '1.5k' } },
    { model: 'seedream-5-5', params: { aspect_ratio: 'auto', resolution: '2K' }, expected: { original: '2K', ratio: 'auto', resolution: '2k' } },
    { model: 'seedream-5-5', params: { aspect_ratio: '16:9', resolution: '2K' }, expected: { size: '2730x1536', original: '2730x1536', ratio: '16:9', resolution: '2k' } },
    { model: 'seedream-5-5', params: { size: '2048x1152', aspect_ratio: 'custom' }, expected: { size: '2048x1152', original: '2048x1152' } },
    { model: 'gemini-example-image', params: { size: '1536x1024', aspect_ratio: '16:9', resolution: '2K' }, expected: { original: '16:9', ratio: '16:9', resolution: '2k' } },
  ])('$model，$params：只映射具体宽高，保留原参数', async ({ model, params, expected }) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ image: 'aW1hZ2U=' })))
    for (const contentType of ['json', 'multipart'] as const) {
      const config = settings({
        path: 'generate', contentType,
        body: { size: '$size.pixels', original: '$params.size', ratio: '$params.aspect_ratio', resolution: '$resolution.lower' },
        query: { size: '$size.pixels' },
      }, model)
      await callImageApi({ settings: config, params: { ...DEFAULT_PARAMS, ...params } as TaskParams, prompt: '猫', inputImageDataUrls: [] })
    }
    for (const [idx, call] of fetch.mock.calls.entries()) {
      expect(call[0]).toBe(`https://example.com/v1/generate${expected.size ? `?size=${expected.size}` : ''}`)
      expect(idx === 0 ? JSON.parse(String(call[1]?.body)) : Object.fromEntries((call[1]?.body as FormData).entries())).toEqual(expected)
    }
  })
})

describe('自定义提交模板的可选省略规则', () => {
  it.each(['json', 'multipart'] as const)('%s 仅省略显式配置的变量值，保留其他值和字面量', async (contentType) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ image: 'aW1hZ2U=' })))
    const config = settings({
      path: 'generate', contentType,
      body: { quality: '$params.quality', count: '$inputImages.count', transparent: '$params.transparent_output', literal: 'auto', n: '$params.n' },
      query: { quality: '$params.quality', count: '$inputImages.count', literal: 'auto' },
      omitValues: { '$params.quality': ['auto'], '$inputImages.count': [0], '$params.transparent_output': [false], '$params.n': ['1'] },
    })
    await callImageApi({ settings: config, params: DEFAULT_PARAMS, prompt: '猫', inputImageDataUrls: [] })
    expect(fetch.mock.calls[0][0]).toBe('https://example.com/v1/generate?literal=auto')
    const body = fetch.mock.calls[0][1]?.body
    expect(contentType === 'json' ? JSON.parse(String(body)) : Object.fromEntries((body as FormData).entries())).toEqual({ literal: 'auto', n: contentType === 'json' ? 1 : '1' })
  })

  it('规则支持嵌套模板，并且不会影响未声明规则的请求', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ image: 'aW1hZ2U=' })))
    const submit = { path: 'generate', body: { input: { quality: '$params.quality' }, values: ['$params.quality', 'auto'], count: '$inputImages.count', transparent: '$params.transparent_output' } }
    for (const omitValues of [{ '$params.quality': ['auto'] }, undefined]) {
      await callImageApi({ settings: settings({ ...submit, omitValues }), params: DEFAULT_PARAMS, prompt: '猫', inputImageDataUrls: [] })
    }
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ input: {}, values: ['auto'], count: 0, transparent: false })
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ input: { quality: 'auto' }, values: ['auto', 'auto'], count: 0, transparent: false })
  })

  it('显式值正常发送，GET 查询也按同一规则处理', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ image: 'aW1hZ2U=' })))
    const config = settings({ path: 'generate', method: 'GET', query: { quality: '$params.quality' }, omitValues: { '$params.quality': ['auto'] } })
    for (const quality of ['auto', 'high'] as const) {
      await callImageApi({ settings: config, params: { ...DEFAULT_PARAMS, quality }, prompt: '猫', inputImageDataUrls: [] })
    }
    expect(fetch.mock.calls[0][0]).toBe('https://example.com/v1/generate')
    expect(fetch.mock.calls[1][0]).toBe('https://example.com/v1/generate?quality=high')
  })

  it('导入和恢复保留省略规则，过滤无效规则值', () => {
    const imported = importCustomProviderSettingsFromJson(JSON.stringify({ name: '模板测试', submit: {
      path: 'generate', omitValues: { '$params.quality': ['auto', null, {}, []], '$params.n': [0, false], invalid: ['auto'], '$prompt': 'auto' },
    } }))
    const restored = normalizeSettings(JSON.parse(JSON.stringify({ customProviders: imported.customProviders })))
    expect(restored.customProviders[0].submit.omitValues).toEqual({ '$params.quality': ['auto'], '$params.n': [0, false] })
  })

  it.each([false, true])('遮罩是否发送由模板决定：映射为 %s', async (mapped) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ image: 'aW1hZ2U=' })))
    const mask = 'data:image/png;base64,aW1hZ2U='
    const config = settings({ path: 'generate', body: { prompt: '$prompt', ...(mapped ? { mask: '$mask.dataUrl' } : {}) } })
    await callImageApi({ settings: config, params: DEFAULT_PARAMS, prompt: '猫', inputImageDataUrls: [mask], maskDataUrl: mask })
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ prompt: '猫', ...(mapped ? { mask } : {}) })
  })
})
