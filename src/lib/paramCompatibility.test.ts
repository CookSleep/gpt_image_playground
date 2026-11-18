import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, getActiveApiProfile, normalizeSettings } from './apiProfiles'
import { getMaskDisabledReason, getImageOutputOptions, getParamDisabledReasons, getTaskParamSupport, normalizeParamsForSettings } from './paramCompatibility'
import { getImageParameterControls } from './imageParameterControls'

describe('parameter compatibility', () => {
  it.each([false, true])('复用旧任务时保留背景开关的含义：%s', (transparent_output) => {
    const params = { ...DEFAULT_PARAMS, background: undefined, transparent_output }
    expect(normalizeParamsForSettings(params, DEFAULT_SETTINGS).background).toBe(transparent_output ? 'transparent' : 'auto')
  })

  it.each(['gpt-image-2', 'seedream-5.5'])('仅在本地模式下提示背景设置入口：%s', (model) => {
    for (const method of ['api', 'local'] as const) {
      const profile = createDefaultOpenAIProfile({ model, transparentBackgroundMethod: method })
      const control = getImageParameterControls(DEFAULT_SETTINGS, profile, DEFAULT_PARAMS).parameters.background
      expect(control.hint).toBe(method === 'local' ? '当前基于本地后处理，可在「设置 → API 配置」中更改' : undefined)
    }
  })

  it.each(['images', 'responses'] as const)('normalizes stale Codex CLI parameters and disables their controls on %s', (apiMode) => {
    const profile = createDefaultOpenAIProfile({ codexCli: true, apiMode, imageGenerationModel: 'gpt-image-2.6-sunburst' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
    const params = { ...DEFAULT_PARAMS, output_format: 'webp' as const, output_compression: 10, moderation: 'low' as const, complexity: 'high' as const, background: 'transparent' as const, transparent_output: true }
    expect(normalizeParamsForSettings(params, settings)).toMatchObject({ output_format: 'png', output_compression: null, moderation: 'auto', complexity: 'auto', transparent_output: true })
    const controls = getImageParameterControls(settings, profile, params).parameters
    for (const key of ['output_format', 'output_compression', 'moderation', 'complexity'] as const) {
      expect(controls[key].disabledReason).toContain('Codex CLI')
    }
    expect(getTaskParamSupport(settings, profile).complexity).toBe(false)
    expect(getMaskDisabledReason(profile)).toBe('Codex CLI 不支持遮罩编辑')
    expect(getMaskDisabledReason({ ...profile, codexCli: false })).toBeUndefined()
    expect(getParamDisabledReasons({ ...profile, codexCli: false }).complexity).toBeUndefined()
  })
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
    expect(getImageOutputOptions(settings, getActiveApiProfile(settings), DEFAULT_PARAMS).limit).toBe(count)
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

    expect(getImageOutputOptions(settings, getActiveApiProfile(settings), DEFAULT_PARAMS).limit).toBe(10)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 12 }, settings).n).toBe(10)
  })

  it('limits fal.ai output count to 4', () => {
    const falProfile = createDefaultFalProfile({ apiKey: 'fal-key' })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [falProfile],
      activeProfileId: falProfile.id,
    })

    expect(getImageOutputOptions(settings, getActiveApiProfile(settings), DEFAULT_PARAMS).limit).toBe(4)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 8 }, settings).n).toBe(4)
  })

  it('limits fal.ai SVG generation to one image and falls back to PNG for reference edits', () => {
    const profile = createDefaultFalProfile({ model: 'openai/gpt-image-2.6/sunburst' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })

    const params = { ...DEFAULT_PARAMS, output_format: 'svg' as const, n: 4 }
    const controls = getImageParameterControls(settings, profile, params, { hasInputImages: true })
    expect(controls.output.format).toBe('png')
    expect(controls.parameters.n.max).toBe(4)
    expect(controls.parameters.frame_count.visible).toBe(false)
    expect(getParamDisabledReasons(profile).svg).toBeUndefined()
    expect(getParamDisabledReasons(profile, { hasInputImages: true }).svg).toBe('fal.ai 的参考图编辑不支持 SVG')
    expect(getImageOutputOptions(settings, getActiveApiProfile(settings), { ...DEFAULT_PARAMS, output_format: 'svg' }).limit).toBe(1)
    expect(getImageOutputOptions(settings, getActiveApiProfile(settings), { ...DEFAULT_PARAMS, output_format: 'png' }).limit).toBe(4)
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

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2048x2048', quality: 'high', output_format: 'gif', complexity: 'high', moderation: 'low' }, settings)).toMatchObject({
      size: '1024x1024',
      quality: DEFAULT_PARAMS.quality,
      output_format: 'png',
      complexity: 'auto',
      moderation: 'auto',
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
