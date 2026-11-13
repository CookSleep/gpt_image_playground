import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, getActiveApiProfile, normalizeSettings } from './apiProfiles'
import { getOutputImageLimitForSettings, getParamDisabledReasons, getTaskParamSupport, normalizeParamsForSettings } from './paramCompatibility'

describe('parameter compatibility', () => {
  it.each(['google/nano-banana-2.1', 'xai/grok-imagine-image/v2.0/text-to-image', 'bytedance/seedream/v5.5/text-to-image'])('allows automatic ratios for fal.ai %s', (model) => {
    expect(getParamDisabledReasons(createDefaultFalProfile({ model })).autoSize).toBeUndefined()
  })

  it('only disables automatic size for fal.ai GPT Image generation', () => {
    const profile = createDefaultFalProfile({ model: 'openai/gpt-image-2.6/sunburst' })
    expect(getParamDisabledReasons(profile).autoSize).toBe('当前模型的文生图模式不支持自动尺寸')
    expect(getParamDisabledReasons(profile, { hasInputImages: true }).autoSize).toBeUndefined()
  })

  it.each(['google/nano-banana-2.1', 'xai/grok-imagine-image/v2.0/text-to-image', 'bytedance/seedream/v5.5/text-to-image'])('keeps output count when SVG falls back to PNG for %s', (model) => {
    const profile = createDefaultFalProfile({ model })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, output_format: 'svg', n: 4 }, settings)).toMatchObject({ output_format: 'png', n: 4 })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, output_format: 'svg', n: 8 }, settings)).toMatchObject({ output_format: 'png', n: 4 })
  })
  it.each([
    ['google/nano-banana-2.1', 'gemini', 4, 'local'],
    ['xai/grok-imagine-image/v2.0/text-to-image', 'grok', 4, 'local'],
    ['bytedance/seedream/v5.5/text-to-image', 'seedream', 4, 'api'],
  ])('normalizes fal.ai family controls for %s', (model, family, count, method) => {
    const profile = createDefaultFalProfile({ model })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 8, resolution: '2K', aspect_ratio: '16:9', google_search: true, thinking_level: 'medium', complexity: 'high' }, settings)
    expect(getOutputImageLimitForSettings(settings)).toBe(count)
    expect(params).toMatchObject({ n: count, aspect_ratio: '16:9', resolution: '2K', complexity: 'auto' })
    expect(getActiveApiProfile(settings).transparentBackgroundMethod).toBe(method)
    expect(params.google_search).toBe(family === 'gemini' ? true : undefined)
    expect(params.thinking_level).toBe(family === 'gemini' ? 'medium' : undefined)
  })
  it.each([
    ['gemini-nano-banana-2.1', true],
    ['gemini-3-pro-image', false],
    ['gemini-2.5-flash-image', false],
  ])('captures supported Google controls for %s', (model, thinking) => {
    const profile = createDefaultOpenAIProfile({ provider: 'google', model })
    expect(getTaskParamSupport(DEFAULT_SETTINGS, profile)).toEqual({ thinking, complexity: false })
  })

  it.each(['gpt-image-2.5', 'gpt-image-2.6'])('uses the Responses image tool model for complexity: %s', (imageGenerationModel) => {
    const profile = createDefaultOpenAIProfile({ apiMode: 'responses', model: 'example-text-model', imageGenerationModel })
    expect(getTaskParamSupport(DEFAULT_SETTINGS, profile)).toEqual({ thinking: false, complexity: imageGenerationModel === 'gpt-image-2.6' })
  })

  it('limits OpenAI output count to 10', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: false })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(getOutputImageLimitForSettings(settings)).toBe(10)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 12 }, settings).n).toBe(10)
  })

  it('limits fal.ai output count to 4', () => {
    const falProfile = createDefaultFalProfile({ apiKey: 'fal-key' })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [falProfile],
      activeProfileId: falProfile.id,
    })

    expect(getOutputImageLimitForSettings(settings)).toBe(4)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 8 }, settings).n).toBe(4)
  })

  it('limits fal.ai SVG generation to one image and falls back to PNG for reference edits', () => {
    const profile = createDefaultFalProfile({ model: 'openai/gpt-image-2.6/sunburst' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })

    expect(getParamDisabledReasons(profile).svg).toBeUndefined()
    expect(getParamDisabledReasons(profile, { hasInputImages: true }).svg).toBe('fal.ai 的参考图编辑不支持 SVG')
    expect(getOutputImageLimitForSettings(settings, 'svg')).toBe(1)
    expect(getOutputImageLimitForSettings(settings, 'png')).toBe(4)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, output_format: 'svg', n: 4 }, settings)).toMatchObject({ output_format: 'svg', n: 1 })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, output_format: 'svg', n: 4 }, settings, { hasInputImages: true })).toMatchObject({ output_format: 'png', n: 4 })
  })

  it('keeps OpenAI streaming output count so the request can disable streaming', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 4 }, settings).n).toBe(4)
  })

  it('only replaces fal.ai auto size in text-to-image mode', () => {
    const falProfile = createDefaultFalProfile({ apiKey: 'fal-key' })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [falProfile],
      activeProfileId: falProfile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings).size).toBe('1360x1024')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings, { hasInputImages: true }).size).toBe('auto')
  })

  it('limits Codex CLI custom sizes to 1K while preserving auto', () => {
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', codexCli: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profile],
      activeProfileId: profile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2048x2048' }, settings).size).toBe('1024x1024')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings).size).toBe('auto')
  })

  it('applies Codex CLI parameter limits to custom providers', () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: [{
        id: 'custom-provider',
        name: 'Custom Provider',
        submit: { path: 'images/generations' },
      }],
      profiles: [{
        ...createDefaultOpenAIProfile(),
        provider: 'custom-provider',
        codexCli: true,
      }],
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2048x2048', quality: 'high' }, settings)).toMatchObject({
      size: '1024x1024',
      quality: DEFAULT_PARAMS.quality,
    })
  })

  it('does not apply Codex CLI parameter limits to fal.ai', () => {
    const profile = createDefaultFalProfile({ codexCli: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      codexCli: true,
      profiles: [profile],
      activeProfileId: profile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2048x2048' }, settings).size).toBe('2048x2048')
  })

  it.each(['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] as const)('keeps 2.5 quality levels for %s', (model) => {
    const profile = createDefaultOpenAIProfile({ model })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile] })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'xhigh' }, settings).quality).toBe('xhigh')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'max' }, settings).quality).toBe('max')
  })

  it.each(['openai/gpt-image-2.5/sunburst', 'openai/gpt-image-2.5/flare'] as const)('keeps fal.ai 2.5 quality levels for %s', (model) => {
    const profile = createDefaultFalProfile({ model })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'xhigh' }, settings).quality).toBe('xhigh')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'max' }, settings).quality).toBe('max')
  })

  it.each(['vendor/gpt-image-2.5-custom', 'my-gpt-image-2.5-proxy'])('keeps 2.5 quality levels for a custom provider model %s', (model) => {
    const profile = { ...createDefaultOpenAIProfile({ model }), provider: 'custom-provider' }
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: [{ id: 'custom-provider', name: 'Custom Provider', submit: { path: 'images/generations' } }],
      profiles: [profile],
      activeProfileId: profile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'xhigh' }, settings).quality).toBe('xhigh')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'max' }, settings).quality).toBe('max')
  })

  it('falls back to high when an older image model receives a 2.5 quality level', () => {
    const profile = createDefaultOpenAIProfile({ model: 'gpt-image-2' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile] })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'max' }, settings).quality).toBe('high')
  })
})
