// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import { useStore } from '../store'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from '../lib/apiProfiles'
import { normalizeParamsForSettings } from '../lib/paramCompatibility'
import DetailModal from './DetailModal'

vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>()
  return {
    ...actual,
    useStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useStore.getState>) => unknown) => selector(actual.useStore.getState()),
      actual.useStore,
    ),
  }
})

function renderTask(overrides: Partial<TaskRecord>) {
  const task: TaskRecord = {
    id: 'example-task', prompt: 'example', params: DEFAULT_PARAMS,
    inputImageIds: [], outputImages: [], status: 'done', error: null,
    createdAt: 0, finishedAt: 1, elapsed: 1,
    ...overrides,
  }
  useStore.setState({ tasks: [task], detailTaskId: task.id })
  const el = document.createElement('div')
  el.innerHTML = renderToStaticMarkup(<DetailModal />)
  return el.querySelector('.grid.grid-cols-2')!.textContent!
}

describe('任务详情参数', () => {
  it('显示任务保存的附加提示词，关闭当前开关不影响旧任务', () => {
    useStore.setState({ settings: { ...useStore.getState().settings, imagePromptHints: false } })
    renderTask({ promptHints: { prefix: '生成图像：', suffix: '请使用 google:search 搜索相关信息。' } })
    const html = renderToStaticMarkup(<DetailModal />)
    expect(html).not.toContain('附加提示词')
    expect(html).toContain('生成图像：\nexample\n请使用 google:search 搜索相关信息。')
    renderTask({})
    expect(renderToStaticMarkup(<DetailModal />)).not.toContain('生成图像：')
  })

  it.each(['example', '生成图像：\nexample\n请使用 google:search 搜索相关信息。'])('附加提示词不导致原文被标记为 API 改写：%s', (revisedPrompt) => {
    renderTask({
      sourceMode: 'agent', apiProvider: 'google', apiModel: 'gemini-nano-banana-2.1',
      promptHints: { prefix: '生成图像：', suffix: '请使用 google:search 搜索相关信息。' },
      outputImages: ['example-image'], revisedPromptByImage: { 'example-image': revisedPrompt },
    })
    const html = renderToStaticMarkup(<DetailModal />)
    expect(html).not.toContain('bg-yellow-100')
  })

  it.each(['google', 'openai', 'custom-example'])('按任务模型显示 Gemini 参数，不受当前配置影响：%s', (apiProvider) => {
    const text = renderTask({
      apiProvider, apiModel: 'gemini-3.1-flash-image',
      params: { ...DEFAULT_PARAMS, aspect_ratio: '16:9', resolution: '2K', thinking_level: 'high', google_search: true, image_search: true, quality: 'high', complexity: 'high', output_format: 'webp' },
    })
    for (const label of ['比例', '16:9', '分辨率', '2K', '思考等级', 'Google Search', 'Image Search', '数量', '透明背景false']) expect(text).toContain(label)
    for (const label of ['尺寸', '质量', '复杂度', '格式', '压缩率', '审核']) expect(text).not.toContain(label)
  })

  it.each(['xai', 'openai', 'custom-example'])('Grok 只在模型支持时显示质量：%s', (apiProvider) => {
    const params = { ...DEFAULT_PARAMS, aspect_ratio: '3:2', resolution: '2K', google_search: true, thinking_level: 'high' as const }
    for (const apiModel of ['grok-imagine-image', 'grok-imagine-image-2.0']) {
      const text = renderTask({ apiProvider, apiModel, params })
      expect(text.includes('质量')).toBe(apiModel === 'grok-imagine-image-2.0')
      for (const label of ['比例', '分辨率', '数量', '透明背景false']) expect(text).toContain(label)
      for (const label of ['搜索', '思考等级', '格式', '审核']) expect(text).not.toContain(label)
    }
  })

  it.each(['gemini-3.1-flash-image', 'grok-imagine-image-2.0'])('即使接口返回格式也不显示格式参数，保留透明背景处理状态：%s', (apiModel) => {
    const text = renderTask({ apiProvider: 'openai', apiModel, actualParams: { output_format: 'jpeg' }, transparentOutput: true })
    expect(text).not.toContain('格式')
    expect(text).toContain('透明背景true')
  })

  it('显示 Gemini 默认参数，未启用搜索时隐藏搜索项', () => {
    const text = renderTask({
      apiProvider: 'google', apiModel: 'gemini-nano-banana-2.1',
      params: { ...DEFAULT_PARAMS, aspect_ratio: 'auto', resolution: '1K' },
      paramSupport: { thinking: true, complexity: false },
    })
    for (const value of ['比例auto', '分辨率1K', '思考等级auto', '透明背景false']) expect(text).toContain(value)
    expect(text).not.toContain('搜索')
  })

  it('只显示请求配置支持的搜索和思考参数', () => {
    const text = renderTask({
      apiProvider: 'custom-example', apiModel: 'gemini-example-image',
      params: { ...DEFAULT_PARAMS, google_search: true },
      paramSupport: { thinking: false, complexity: false },
    })
    expect(text).toContain('Google Search')
    expect(text).not.toContain('Image Search')
    expect(text).not.toContain('思考等级')
  })

  it.each([true, false])('GPT 根据请求能力展示默认复杂度：%s', (complexity) => {
    const text = renderTask({
      apiProvider: 'openai', apiMode: 'responses', apiModel: 'example-text-model',
      paramSupport: { thinking: false, complexity },
    })
    expect(text.includes('复杂度auto')).toBe(complexity)
  })

  it.each(['png', 'jpeg', 'webp', 'svg', 'gif'] as const)('按格式展示压缩率、透明背景和动画参数：%s', (output_format) => {
    const text = renderTask({ apiProvider: 'openai', params: { ...DEFAULT_PARAMS, output_format } })
    expect(text.includes('压缩率未设置')).toBe(output_format === 'jpeg' || output_format === 'webp')
    expect(text.includes('透明背景false')).toBe(output_format !== 'jpeg')
    expect(text.includes('帧数')).toBe(output_format === 'gif')
    expect(text.includes('每帧时长')).toBe(output_format === 'gif')
  })

  it.each(['google', 'openai', 'custom-example'])('Gemini 2.5 仅在原生接口隐藏分辨率：%s', (provider) => {
    const profile = createDefaultOpenAIProfile({ provider, model: 'gemini-2.5-flash-image' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id,
      customProviders: provider === 'custom-example' ? [{ id: provider, name: 'Example', submit: { path: 'images', body: { resolution: '$params.resolution' } } }] : [],
    })
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, resolution: '1K' }, settings)
    expect(params.resolution).toBe(provider === 'google' ? undefined : '1K')
    const text = renderTask({ apiProvider: provider, apiModel: profile.model, params })
    expect(text.includes('分辨率')).toBe(provider !== 'google')
  })

  it('fal.ai 不展示未发送的压缩率和审核参数', () => {
    const text = renderTask({ apiProvider: 'fal', params: { ...DEFAULT_PARAMS, output_format: 'webp' } })
    expect(text).not.toContain('压缩率')
    expect(text).not.toContain('审核')
  })

  it.each([{}, { apiProvider: 'openai', apiMode: 'responses', apiModel: 'gemini-example-image' }] as Partial<TaskRecord>[])('旧任务和 Responses 图像工具保留通用参数：%j', (source) => {
    const text = renderTask({ ...source, params: { ...DEFAULT_PARAMS, output_format: 'jpeg', output_compression: 80, complexity: 'high' } })
    for (const label of ['尺寸', '质量', '复杂度', '格式jpeg', '压缩率80', '审核', '数量']) expect(text).toContain(label)
  })
})
