import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type CustomProviderDefinition, type TaskRecord } from '../types'
import { callImageApi } from './api'
import { getActiveApiProfile, importCustomProviderSettingsFromJson, normalizeCustomProviderDefinition, normalizeSettings } from './apiProfiles'
import { getImageActualParams } from './imageActualParams'
import { getImageModelOptions } from './imageModelParams'
import { resolveCustomProviderModel } from './imageProviderMappings'
import { normalizeParamsForSettings } from './paramCompatibility'

const provider: CustomProviderDefinition = {
  id: 'custom-size', name: '尺寸配置',
  imageSize: { mode: 'aspect-ratio', ratios: ['auto', '1:1', '16:9'], resolutions: ['1K', '2K'] },
  submit: {
    path: 'generate',
    body: { size: '$params.size', ratio: '$params.aspect_ratio', resolution: '$resolution.lower', quality: '$params.quality' },
    result: { b64JsonPaths: ['image'] },
  },
  modelOverrides: [{
    models: ['pixel-*'], imageSize: { mode: 'pixels' },
    submit: { path: 'pixels', body: { size: '$params.size' }, result: { b64JsonPaths: ['image'] } },
  }],
}

function settings(model = 'example-image') {
  return normalizeSettings({
    customProviders: [provider], activeProfileId: 'test',
    profiles: [{ id: 'test', provider: provider.id, baseUrl: 'https://example.com/v1', apiKey: 'test', model }],
  })
}

afterEach(() => vi.restoreAllMocks())

describe('自定义服务商尺寸模式', () => {
  it('清洗导入配置，保留模型覆盖及配置往返', () => {
    const normalized = normalizeCustomProviderDefinition({
      ...provider,
      imageSize: { mode: 'aspect-ratio', ratios: ['auto', '16:9', '0:1', '错误', '16:9'], resolutions: ['2k', '2K', '4k'] },
    })!
    expect(normalized.imageSize).toEqual({ mode: 'aspect-ratio', ratios: ['auto', '16:9'], resolutions: ['2K', '4K'] })
    const imported = importCustomProviderSettingsFromJson(JSON.stringify({ customProviders: [normalized], profiles: [] }))
    expect(imported.customProviders[0].imageSize).toEqual(normalized.imageSize)
    expect(resolveCustomProviderModel(imported.customProviders[0], 'pixel-test').imageSize).toEqual({ mode: 'pixels' })
    expect(normalizeCustomProviderDefinition({ ...provider, imageSize: { mode: 'aspect-ratio', ratios: [], resolutions: ['1K'] } })?.imageSize).toBeUndefined()
  })

  it('模型覆盖继承顶层尺寸选项，也可单独指定选项', () => {
    const config = normalizeCustomProviderDefinition({ ...provider, modelOverrides: [
      { models: ['inherit-*'], submit: provider.submit },
      { models: ['custom-*'], submit: provider.submit, imageSize: { mode: 'aspect-ratio', ratios: ['3:1'], resolutions: ['4K'] } },
    ] })!
    expect(resolveCustomProviderModel(config, 'inherit-image').imageSize).toEqual(provider.imageSize)
    expect(resolveCustomProviderModel(config, 'custom-image').imageSize).toEqual({ mode: 'aspect-ratio', ratios: ['3:1'], resolutions: ['4K'] })
  })

  it('任意模型均可直接保存比例档位，输出格式和质量保持独立', async () => {
    const config = settings()
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '4992x3328', aspect_ratio: '16:9', resolution: '2k', quality: 'high', output_format: 'webp' }, config)
    expect(params).toMatchObject({ size: 'auto', aspect_ratio: '16:9', resolution: '2K', quality: 'high', output_format: 'webp' })
    expect(normalizeParamsForSettings(params, normalizeSettings(JSON.parse(JSON.stringify(config))))).toEqual(params)
    expect(getImageModelOptions(getActiveApiProfile(config), config.customProviders[0].imageSize).resolutions).toEqual(['1K', '2K'])
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ image: 'aW1hZ2U=' })))
    await callImageApi({ settings: config, params, prompt: '猫', inputImageDataUrls: [] })
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ ratio: '16:9', resolution: '2k', quality: 'high' })
  })

  it('切换模式时清除无效尺寸，旧宽高不参与比例或档位推算', () => {
    const ratio = settings()
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '4992x3328', aspect_ratio: '4:5', resolution: '4K' }, ratio)
    expect(params).toMatchObject({ size: 'auto', aspect_ratio: 'auto', resolution: '1K' })
    const pixels = normalizeParamsForSettings({ ...params, size: '1536x1024' }, settings('pixel-test'))
    expect(pixels).toMatchObject({ size: '1536x1024', aspect_ratio: undefined, resolution: undefined })
    expect(normalizeParamsForSettings(pixels, ratio)).toMatchObject({ size: 'auto', aspect_ratio: 'auto', resolution: '1K' })
  })

  it('任务结果根据真实宽高显示，与当前供应商配置无关', () => {
    const task = { apiProvider: provider.id, apiModel: 'example-image', params: { ...DEFAULT_PARAMS, aspect_ratio: '16:9', resolution: '2K' } } as TaskRecord
    expect(getImageActualParams(task, '1024x1024', { size: '999x999', aspect_ratio: '16:9', resolution: '2K' })).toMatchObject({ size: '1024x1024', aspect_ratio: '1:1', resolution: '1K' })
    expect(getImageActualParams(task, '')).toMatchObject({ size: undefined, aspect_ratio: undefined, resolution: undefined })
  })

  it.each([
    ['gemini-example-image', 'aspect-ratio'], ['gemini-example-image', 'pixels'],
    ['grok-imagine-image', 'aspect-ratio'], ['grok-imagine-image', 'pixels'],
    ['grok-imagine-image-2.0', 'aspect-ratio'], ['grok-imagine-image-2.0', 'pixels'],
  ] as const)('%s 的 %s 尺寸模式保持原有质量参数规则', async (model, mode) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ image: 'aW1hZ2U=' })))
    const config = settings(model)
    for (const imageSize of [undefined, mode === 'pixels' ? { mode } : provider.imageSize]) {
      const current = normalizeSettings({ ...config, customProviders: [{ ...provider, imageSize }] })
      const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'low' }, current)
      await callImageApi({ settings: current, params, prompt: '猫', inputImageDataUrls: [] })
    }
    const original = JSON.parse(String(fetch.mock.calls[0][1]?.body))
    const configured = JSON.parse(String(fetch.mock.calls[1][1]?.body))
    expect(configured.quality).toBe(original.quality)
    if (model === 'grok-imagine-image-2.0') expect(configured.quality).toBe('low')
    else expect(configured).not.toHaveProperty('quality')
  })
})
