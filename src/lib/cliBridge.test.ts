import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type AppSettings, type TaskParams, type TaskRecord } from '../types'
import { createDefaultOpenAIProfile, normalizeSettings } from './apiProfiles'
import { normalizeParamsForSettings } from './paramCompatibility'
import { installCliBridge } from './cliBridge'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), submitTask: vi.fn(), dimensions: vi.fn(), removeTaskOutput: vi.fn() }))
let state: {
  settings: AppSettings
  params: TaskParams
  tasks: TaskRecord[]
  setParams: (patch: Partial<TaskParams>) => void
  setSettings: (settings: AppSettings) => void
  setReusedTaskApiProfile: () => void
}

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => false }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('./networkProxy', () => ({ getProxySetting: async () => ({ mode: 'system', url: '' }), setProxySetting: vi.fn() }))
vi.mock('./imageCache', () => ({ ensureImageCached: vi.fn(), ensureImageDimensionsCached: mocks.dimensions }))
vi.mock('../store', () => ({
  useStore: { getState: () => state },
  submitTask: mocks.submitTask,
  createInputImageFromFile: vi.fn(),
  waitForTaskSettled: vi.fn(),
  removeTaskOutput: mocks.removeTaskOutput,
}))

beforeEach(() => {
  vi.clearAllMocks()
  const profiles = [
    createDefaultOpenAIProfile({ id: 'gpt', model: 'gpt-image-2', apiKey: 'test-key' }),
    createDefaultOpenAIProfile({ id: 'seedream', provider: 'bytedance', model: 'doubao-seedream-5-5-261028', apiKey: 'test-key' }),
  ]
  state = {
    settings: normalizeSettings({ profiles, activeProfileId: 'seedream' }),
    params: { ...DEFAULT_PARAMS },
    tasks: [],
    setParams: (patch) => { state.params = { ...state.params, ...patch } },
    setSettings: (settings) => { state.settings = settings },
    setReusedTaskApiProfile: vi.fn(),
  }
  mocks.invoke.mockResolvedValue(undefined)
  mocks.listen.mockResolvedValue(() => {})
  mocks.dimensions.mockResolvedValue(undefined)
  mocks.removeTaskOutput.mockResolvedValue(true)
  // 在提交入口截取参数，不执行真实生成请求。
  mocks.submitTask.mockResolvedValue([])
  installCliBridge()
})

async function send(tool: string, args: Record<string, unknown>) {
  mocks.invoke.mockClear()
  const listener = mocks.listen.mock.calls[0][1]
  listener({ payload: { id: 1, tool, arguments: args } })
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === 'cli_respond')).toBe(true))
  return mocks.invoke.mock.calls.find(([cmd]) => cmd === 'cli_respond')![1]
}

describe('CLI Seedream dimensions', () => {
  it('uses explicit generation dimensions even after choosing a preset ratio', async () => {
    state.params = { ...DEFAULT_PARAMS, aspect_ratio: '16:9', resolution: '1K' }
    await send('generate_image', { prompt: '测试', size: '1281x721' })
    expect(mocks.submitTask).toHaveBeenCalledOnce()
    expect(normalizeParamsForSettings(state.params, state.settings)).toMatchObject({ size: '1281x721', aspect_ratio: 'custom', resolution: undefined })
  })

  it('uses the target profile when switching profiles and setting dimensions together', async () => {
    state.settings = normalizeSettings({ ...state.settings, activeProfileId: 'gpt' })
    const reply = await send('update_settings', { active_profile_id: 'seedream', params: { size: '8192x512' } })
    expect(reply.error).toBeUndefined()
    expect(state.settings.activeProfileId).toBe('seedream')
    expect(normalizeParamsForSettings(state.params, state.settings)).toMatchObject({ size: '8192x512', aspect_ratio: 'custom' })
  })

  it.each(['auto', '1K', '1.5K', '2K'])('leaves custom mode for %s', async (size) => {
    state.params = { ...DEFAULT_PARAMS, size: '1281x721', aspect_ratio: 'custom' }
    const reply = await send('update_settings', { params: { size } })
    expect(reply.error).toBeUndefined()
    expect(normalizeParamsForSettings(state.params, state.settings)).toMatchObject({ size: size === 'auto' ? '2K' : size, aspect_ratio: 'auto' })
  })

  it('preserves the current custom mode if no size is supplied', async () => {
    state.params = { ...DEFAULT_PARAMS, size: '1281x721', aspect_ratio: 'custom' }
    await send('update_settings', { params: { output_format: 'jpeg' } })
    expect(state.params).toMatchObject({ size: '1281x721', aspect_ratio: 'custom', output_format: 'jpeg' })
  })

  it('keeps GPT size parsing unchanged when switching away from Seedream', async () => {
    await send('update_settings', { active_profile_id: 'gpt', params: { size: '1536x1024' } })
    expect(state.params.size).toBe('1536x1024')
    expect(state.params.aspect_ratio).toBeUndefined()
  })

  it('rejects an invalid Seedream size before submitting', async () => {
    const reply = await send('generate_image', { prompt: '测试', size: '4K' })
    expect(reply.error).toContain('Seedream size')
    expect(mocks.submitTask).not.toHaveBeenCalled()
  })
})

describe('CLI 比例与档位', () => {
  it('设置比例和档位后由 Seedream 共用逻辑计算宽高', async () => {
    const reply = await send('update_settings', { params: { aspect_ratio: '16:9', resolution: '2k' } })
    expect(reply.error).toBeUndefined()
    expect(normalizeParamsForSettings(state.params, state.settings)).toMatchObject({ size: '2730x1536', aspect_ratio: '16:9', resolution: '2K' })
  })

  it('从自定义宽高设置档位时恢复自动比例', async () => {
    state.params = { ...DEFAULT_PARAMS, size: '1281x721', aspect_ratio: 'custom' }
    await send('update_settings', { params: { resolution: '1.5K' } })
    expect(state.params).toMatchObject({ aspect_ratio: 'auto', resolution: '1.5K' })
  })

  it('generate 使用自定义服务商的模型覆盖选项', async () => {
    state.settings = normalizeSettings({
      profiles: [createDefaultOpenAIProfile({ id: 'custom', provider: 'custom-test', model: 'example-image', apiKey: 'test-key' })],
      activeProfileId: 'custom',
      customProviders: [{ id: 'custom-test', name: '测试', imageSize: { mode: 'pixels' }, submit: { path: 'generate' }, modelOverrides: [
        { models: ['example-*'], imageSize: { mode: 'aspect-ratio', ratios: ['auto', '3:1'], resolutions: ['4K', '8K'] }, submit: { path: 'generate' } },
      ] }],
    })
    await send('generate_image', { prompt: '测试', aspect_ratio: '3:1', resolution: '8k' })
    expect(mocks.submitTask).toHaveBeenCalledOnce()
    expect(normalizeParamsForSettings(state.params, state.settings)).toMatchObject({ size: 'auto', aspect_ratio: '3:1', resolution: '8K' })
    const reply = await send('update_settings', { params: { resolution: '2K' } })
    expect(reply.error).toContain('4K、8K')
  })

  it.each([{ aspect_ratio: '不合法' }, { resolution: '4K' }, { size: '1024x1024', resolution: '2K' }])('无效尺寸设置不修改参数：%s', async (params) => {
    const original = { ...state.params }
    const reply = await send('update_settings', { params })
    expect(reply.error).toBeTruthy()
    expect(state.params).toEqual(original)
  })

  it('具体宽高模式拒绝比例设置', async () => {
    const reply = await send('update_settings', { active_profile_id: 'gpt', params: { aspect_ratio: '16:9' } })
    expect(reply.error).toContain('具体宽高')
    expect(state.settings.activeProfileId).toBe('seedream')
  })
})

describe('CLI 参数查询', () => {
  it('返回当前配置的可用选项、范围和默认值，不改变配置或参数', async () => {
    const original = structuredClone({ settings: state.settings, params: state.params })
    const reply = await send('get_parameters', {})
    expect(reply.error).toBeUndefined()
    const result = reply.result.data.profiles[0]
    expect(result.id).toBe('seedream')
    expect(result.models[0]).toMatchObject({
      model: 'doubao-seedream-5-5-261028', size_mode: 'seedream', reference_images: { max: 10 }, mask: { enabled: false },
      parameters: {
        resolution: { value: '2K', enabled: true, options: [{ value: '1K' }, { value: '1.5K' }, { value: '2K' }] },
        quality: { visible: false, enabled: false }, n: { min: 1, max: 10 }, watermark: { value: false },
      },
    })
    expect({ settings: state.settings, params: state.params }).toEqual(original)
    expect(JSON.stringify(reply.result.data)).not.toContain('test-key')
    expect(mocks.submitTask).not.toHaveBeenCalled()
  })

  it('查询全部配置和模型，分别使用模型覆盖后的尺寸选项', async () => {
    state.settings = normalizeSettings({
      profiles: [createDefaultOpenAIProfile({ id: 'custom', provider: 'custom-test', model: 'pixels-model, ratio-model', selectedModel: 'ratio-model' })],
      activeProfileId: 'custom',
      customProviders: [{ id: 'custom-test', name: '测试', imageSize: { mode: 'pixels' }, submit: { path: 'generate' }, modelOverrides: [
        { models: ['ratio-*'], imageSize: { mode: 'aspect-ratio', ratios: ['auto', '3:1'], resolutions: ['4K', '8K'] }, submit: { path: 'generate' } },
      ] }],
    })
    const reply = await send('get_parameters', { all: true })
    const models = reply.result.data.profiles[0].models
    expect(models.map((model: { model: string; size_mode: string }) => [model.model, model.size_mode])).toEqual([['pixels-model', 'pixels'], ['ratio-model', 'aspect-ratio']])
    expect(models[0].parameters.size.options).toContainEqual({ label: '1K 1:1', value: '1024x1024', enabled: true })
    expect(models[1].parameters.resolution.options.map((option: { value: string }) => option.value)).toEqual(['4K', '8K'])
    expect(models[1].parameters.aspect_ratio.options.map((option: { value: string }) => option.value)).toEqual(['auto', '3:1'])
    const current = await send('get_parameters', {})
    expect(current.result.data.profiles[0].models[0].model).toBe('ratio-model')
    const selected = await send('get_parameters', { profile_id: 'custom', model: 'pixels-model' })
    expect(selected.result.data.profiles[0].models[0].size_mode).toBe('pixels')
    expect(state.settings.profiles[0].selectedModel).toBe('ratio-model')
  })

  it('按参考图和输出格式预览限制，使用规整后的格式计算数量上限', async () => {
    state.settings = normalizeSettings({ profiles: [createDefaultOpenAIProfile({ id: 'fal', provider: 'fal', model: 'fal-ai/gpt-image-2.6-sunburst' })], activeProfileId: 'fal' })
    const generated = await send('get_parameters', { output_format: 'svg' })
    expect(generated.result.data.profiles[0].models[0].parameters.n.max).toBe(1)
    const edited = await send('get_parameters', { output_format: 'svg', has_input_images: true })
    const params = edited.result.data.profiles[0].models[0].parameters
    expect(params.output_format.value).toBe('png')
    expect(params.n.max).toBe(4)
    expect(params.output_format.options.find((option: { value: string }) => option.value === 'svg')).toMatchObject({ enabled: false, disabled_reason: 'fal.ai 的参考图编辑不支持 SVG' })
    expect(params.quality.options.find((option: { value: string }) => option.value === 'max').enabled).toBe(false)
    expect(state.params.output_format).toBe(DEFAULT_PARAMS.output_format)
  })

  it('查询其他配置不改变当前配置，预览 JPEG 时禁用透明背景', async () => {
    const reply = await send('get_parameters', { profile_id: 'gpt', output_format: 'jpeg' })
    const params = reply.result.data.profiles[0].models[0].parameters
    expect(params.output_compression).toMatchObject({ enabled: true, min: 0, max: 100, nullable: true })
    expect(params.transparent_output).toMatchObject({ enabled: false, disabled_reason: 'JPEG 不支持透明背景' })
    expect(state.settings.activeProfileId).toBe('seedream')
  })

  it.each([{ profile_id: 'missing' }, { model: 'missing' }, { all: true, profile_id: 'gpt' }, { output_format: 'invalid' }])('拒绝无效查询：%s', async (args) => {
    const reply = await send('get_parameters', args)
    expect(reply.error).toBeTruthy()
  })

  it('查询返回的 Gemini 搜索开关和思考等级可以通过 settings set 修改', async () => {
    state.settings = normalizeSettings({ profiles: [createDefaultOpenAIProfile({ id: 'google', provider: 'google', model: 'gemini-3.1-flash-image-preview' })], activeProfileId: 'google' })
    const reply = await send('get_parameters', {})
    expect(reply.result.data.profiles[0].models[0].parameters.thinking_level).toMatchObject({ value: 'auto', enabled: true })
    const saved = await send('update_settings', { params: { google_search: true, image_search: true, thinking_level: 'high' } })
    expect(saved.error).toBeUndefined()
    expect(state.params).toMatchObject({ google_search: true, image_search: true, thinking_level: 'high' })
    const invalid = await send('update_settings', { params: { thinking_level: 'medium' } })
    expect(invalid.error).toContain('不支持此思考等级')
    expect(state.params.thinking_level).toBe('high')
  })
})

describe('CLI 任务结果', () => {
  beforeEach(() => {
    state.tasks = [{
      id: 'task-1', status: 'done', createdAt: 1, finishedAt: 2, elapsed: 1, error: null, prompt: '测试', params: { ...DEFAULT_PARAMS, aspect_ratio: '16:9', resolution: '2K' },
      inputImageIds: [], outputImages: ['image-1', 'image-2'], outputErrors: [{ requestIndex: 1, error: '生成失败' }],
      actualParams: { size: '9999x9999', aspect_ratio: '16:9', resolution: '4K' },
    }]
    mocks.invoke.mockImplementation(async (cmd, args) => cmd === 'image_paths' ? args.ids.map((id: string) => `D:/${id}.png`) : undefined)
    mocks.dimensions.mockImplementation(async (id) => id === 'image-1' ? { width: 1024, height: 1024 } : undefined)
  })

  it('历史逐项返回真实尺寸、未知尺寸和失败结果，保留请求参数', async () => {
    const reply = await send('list_history', {})
    expect(reply.error).toBeUndefined()
    expect(reply.result.data.tasks[0].params.resolution).toBe('2K')
    expect(reply.result.data.tasks[0].outputs).toEqual([
      { index: 1, image_id: 'image-1', width: 1024, height: 1024, aspect_ratio: '1:1', resolution: '1K' },
      { index: 2, error: '生成失败' },
      { index: 3, image_id: 'image-2', width: null, height: null, aspect_ratio: null, resolution: null },
    ])
  })

  it('generate 的 JSON 也包含逐张真实尺寸', async () => {
    mocks.submitTask.mockResolvedValue(['task-1'])
    const reply = await send('generate_image', { prompt: '测试' })
    expect(reply.result.data.tasks[0].outputs[0]).toMatchObject({ index: 1, width: 1024, height: 1024, resolution: '1K' })
  })

  it.each([1, 2])('删除第 %s 项复用界面的结果删除入口', async (index) => {
    const reply = await send('delete_task_result', { task_id: 'task-1', index })
    expect(reply.error).toBeUndefined()
    expect(mocks.removeTaskOutput).toHaveBeenCalledWith('task-1', index === 1
      ? { requestIndex: 0, outputImageIndex: 0, imageId: 'image-1', error: '' }
      : { requestIndex: 1, outputImageIndex: -1, imageId: '', error: '生成失败' })
    expect(reply.result.data).toEqual({ task_id: 'task-1', deleted_index: index })
  })

  it.each([0, 1.5, 99])('拒绝无效结果序号 %s', async (index) => {
    const reply = await send('delete_task_result', { task_id: 'task-1', index })
    expect(reply.error).toBeTruthy()
    expect(mocks.removeTaskOutput).not.toHaveBeenCalled()
  })

  it('不删除最后一个结果或未完成任务', async () => {
    state.tasks[0].outputImages = ['image-1']
    state.tasks[0].outputErrors = []
    expect((await send('delete_task_result', { task_id: 'task-1', index: 1 })).error).toContain('最后一项')
    state.tasks[0].status = 'running'
    expect((await send('delete_task_result', { task_id: 'task-1', index: 1 })).error).toContain('已完成')
    expect(mocks.removeTaskOutput).not.toHaveBeenCalled()
  })

  it('持久化失败时向 CLI 返回错误', async () => {
    mocks.removeTaskOutput.mockResolvedValue(false)
    expect((await send('delete_task_result', { task_id: 'task-1', index: 1 })).error).toContain('删除失败')
  })
})

describe('CLI 参考图数量校验', () => {
  it.each([
    ['openai', 'gpt-image-2', 16],
    ['google', 'gemini-3-pro-image', 14],
    ['fal', 'xai/grok-imagine-image', 3],
    ['fal', 'xai/grok-imagine-image/v2.0', 5],
    ['bytedance', 'doubao-seedream-5-5-261028', 10],
  ])('%s / %s 超限时向 CLI 返回具体错误', async (provider, model, limit) => {
    const profile = createDefaultOpenAIProfile({ id: 'test', provider, model, apiKey: 'test-key' })
    state.settings = normalizeSettings({ profiles: [profile], activeProfileId: profile.id })
    const reply = await send('generate_image', { prompt: '测试', reference_images: Array(limit + 1).fill('missing-image-id') })
    expect(reply.error).toContain(`最多支持 ${limit} 张参考图`)
    expect(mocks.submitTask).not.toHaveBeenCalled()
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === 'cli_progress')).toBe(false)
  })
})
