import { describe, expect, it } from 'vitest'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS } from './apiProfiles'
import { assertInputImageLimit, getInputImageLimit, getInputImageProfile } from './inputImageLimits'

describe('参考图数量限制', () => {
  it.each([
    ['openai', 'gpt-image-2.6-sunburst', 16],
    ['fal', 'openai/gpt-image-2.6/sunburst/edit', 16],
    ['google', 'gemini-3-pro-image-preview', 14],
    ['openai', 'gemini-3.1-flash-image', 14],
    ['fal', 'fal-ai/nano-banana-pro/edit', 14],
    ['fal', 'fal-ai/nano-banana-2/edit', 14],
    ['fal', 'google/nano-banana-2.1', 14],
    ['google', 'gemini-nano-banana-2.1', 14],
    ['google', 'gemini-2.5-flash-image', 16],
    ['fal', 'fal-ai/nano-banana/edit', 16],
    ['fal', 'xai/grok-imagine-image', 3],
    ['fal', 'xai/grok-imagine-image/quality/edit', 3],
    ['fal', 'xai/grok-imagine-image/v2.0/text-to-image', 5],
    ['xai', 'grok-imagine-image-2.0', 5],
    ['openai', 'grok-imagine-1.5-ext', 5],
    ['custom-example', 'grok-imagine-image-2.0', 5],
    ['bytedance', 'doubao-seedream-5-5-261028', 10],
    ['fal', 'bytedance/seedream/v5.5/edit', 10],
    ['openai', 'unrecognized-model', 16],
  ])('%s / %s：上限 %i', (provider, model, limit) => {
    const profile = createDefaultOpenAIProfile({ provider, model })
    expect(getInputImageLimit(profile)).toBe(limit)
    expect(() => assertInputImageLimit(profile, limit)).not.toThrow()
    expect(() => assertInputImageLimit(profile, limit + 1)).toThrow(`最多支持 ${limit} 张`)
  })

  it('Responses 的文本模型名称不决定图像输入限制', () => {
    expect(getInputImageLimit(createDefaultOpenAIProfile({ apiMode: 'responses', model: 'gemini-3-pro-image' }))).toBe(16)
  })

  it('使用选中模型、临时复用模型和 Agent 图像配置', () => {
    const main = createDefaultOpenAIProfile({ id: 'main', model: 'gpt-image-2.6-sunburst' })
    const fal = createDefaultOpenAIProfile({ id: 'fal', provider: 'fal', model: 'xai/grok-imagine-image, xai/grok-imagine-image/v2.0', selectedModel: 'xai/grok-imagine-image/v2.0' })
    const settings = { ...DEFAULT_SETTINGS, profiles: [main, fal], activeProfileId: main.id, reuseTaskApiProfileTemporarily: true }
    const state = { settings, appMode: 'gallery' as const, reusedTaskApiProfileId: fal.id, reusedTaskApiModel: null }
    expect(getInputImageLimit(getInputImageProfile(state))).toBe(5)
    expect(getInputImageLimit(getInputImageProfile({ ...state, reusedTaskApiModel: 'xai/grok-imagine-image' }))).toBe(3)
    expect(getInputImageLimit(getInputImageProfile({ ...state, settings: { ...settings, reuseTaskApiProfileTemporarily: false } }))).toBe(16)
    expect(getInputImageLimit(getInputImageProfile({ ...state, appMode: 'agent', settings: { ...settings, agentApiConfigMode: 'hybrid', agentTextProfileId: main.id, agentImageProfileId: fal.id } }))).toBe(5)
  })
})
