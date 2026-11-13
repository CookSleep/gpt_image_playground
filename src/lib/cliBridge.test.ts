import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type AppSettings, type TaskParams } from '../types'
import { createDefaultOpenAIProfile, normalizeSettings } from './apiProfiles'
import { normalizeParamsForSettings } from './paramCompatibility'
import { installCliBridge } from './cliBridge'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), submitTask: vi.fn() }))
let state: {
  settings: AppSettings
  params: TaskParams
  setParams: (patch: Partial<TaskParams>) => void
  setSettings: (settings: AppSettings) => void
  setReusedTaskApiProfile: () => void
}

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => false }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('./networkProxy', () => ({ getProxySetting: async () => ({ mode: 'system', url: '' }), setProxySetting: vi.fn() }))
vi.mock('../store', () => ({
  useStore: { getState: () => state },
  submitTask: mocks.submitTask,
  createInputImageFromFile: vi.fn(),
  waitForTaskSettled: vi.fn(),
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
    setParams: (patch) => { state.params = { ...state.params, ...patch } },
    setSettings: (settings) => { state.settings = settings },
    setReusedTaskApiProfile: vi.fn(),
  }
  mocks.invoke.mockResolvedValue(undefined)
  mocks.listen.mockResolvedValue(() => {})
  // 在提交入口截取参数，不执行真实生成请求。
  mocks.submitTask.mockResolvedValue([])
  installCliBridge()
})

async function send(tool: string, args: Record<string, unknown>) {
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
