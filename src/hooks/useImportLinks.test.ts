import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../types'
import { createDefaultOpenAIProfile, normalizeSettings } from '../lib/apiProfiles'
import { handledImportLinks } from '../lib/importLink'
import { createCustomProfileImportUrl } from '../lib/profileImportUrl'
import { promptImportLink } from './useImportLinks'

const SHARE_OPTIONS = { includeApiKey: true, useNewApiAddress: false, useNewApiKey: false, useNewApiModel: false }

const mock = vi.hoisted(() => ({
  state: {} as Record<string, any>,
}))

vi.mock('../store', () => ({
  restoreExplicitPresetConfig: vi.fn(async () => false),
  useStore: {
    getState: () => mock.state,
    subscribe: () => () => {},
  },
}))

function mockState(settings: AppSettings) {
  mock.state = {
    settings,
    setSettings: vi.fn((next) => { mock.state.settings = normalizeSettings(next) }),
    showToast: vi.fn(),
    setConfirmDialog: vi.fn(),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  handledImportLinks.clear()
})

describe('promptImportLink', () => {
  it('相同初始配置自动导入时保留完整本地设置', async () => {
    const settings = normalizeSettings({ colorMode: 'dark', enterSubmit: true, uiFont: 'system' })
    mockState(settings)
    promptImportLink(createCustomProfileImportUrl('https://example.com', settings.profiles[0], undefined, SHARE_OPTIONS), true)
    await vi.waitFor(() => expect(mock.state.setSettings).toHaveBeenCalled())
    expect(mock.state.settings).toEqual(settings)
    expect(mock.state.setConfirmDialog).not.toHaveBeenCalled()
    expect(mock.state.showToast).not.toHaveBeenCalled()
  })

  it.each([
    [undefined, 'other'], ['true', 'other'], ['false', 'other'],
    [undefined, 'saved'], ['true', 'saved'], ['false', 'saved'],
  ])('相同配置不弹窗，开关为 %s，当前配置为 %s', async (value, activeProfileId) => {
    vi.stubEnv('VITE_SHOW_CONFIG_CHANGE_DIALOG', value)
    const profile = createDefaultOpenAIProfile({ id: 'saved', name: '已保存' })
    mockState(normalizeSettings({ profiles: [createDefaultOpenAIProfile({ id: 'other' }), profile], activeProfileId }))
    promptImportLink(createCustomProfileImportUrl('https://example.com', profile, undefined, SHARE_OPTIONS), true)
    await vi.waitFor(() => expect(mock.state.setSettings).toHaveBeenCalled())
    expect(mock.state.settings.activeProfileId).toBe('saved')
    expect(mock.state.setConfirmDialog).not.toHaveBeenCalled()
    if (activeProfileId === 'other') expect(mock.state.showToast).toHaveBeenCalledWith('已切换到「已保存」', 'success')
    else expect(mock.state.showToast).not.toHaveBeenCalled()
  })

  it('关闭弹窗时直接应用配置变更', async () => {
    vi.stubEnv('VITE_SHOW_CONFIG_CHANGE_DIALOG', 'false')
    mockState(normalizeSettings({}))
    promptImportLink(new URLSearchParams({ apiUrl: 'https://new.example.com/v1' }), true)
    await vi.waitFor(() => expect(mock.state.setSettings).toHaveBeenCalled())
    expect(mock.state.settings.profiles.some((profile: { baseUrl: string }) => profile.baseUrl === 'https://new.example.com/v1')).toBe(true)
    expect(mock.state.setConfirmDialog).not.toHaveBeenCalled()
    expect(mock.state.showToast).toHaveBeenCalledWith('配置已导入', 'success')
  })

  it('切换到地址、Key 和模型不同的已有配置时提示切换', async () => {
    const profile = createDefaultOpenAIProfile({ id: 'saved', name: '已保存', baseUrl: 'https://saved.example.com/v1', apiKey: 'example-saved', model: 'gpt-image-2.6-sunburst' })
    const settings = normalizeSettings({
      profiles: [createDefaultOpenAIProfile({ id: 'other', baseUrl: 'https://other.example.com/v1', apiKey: 'example-other', model: 'gpt-image-2' }), profile],
      activeProfileId: 'other',
    })
    mockState(settings)
    promptImportLink(createCustomProfileImportUrl('https://example.com', profile, undefined, SHARE_OPTIONS), true)
    await vi.waitFor(() => expect(mock.state.showToast).toHaveBeenCalled())
    expect(mock.state.settings.activeProfileId).toBe('saved')
    expect(mock.state.settings.profiles).toEqual(settings.profiles)
    expect(mock.state.setConfirmDialog).not.toHaveBeenCalled()
    expect(mock.state.showToast).toHaveBeenCalledWith('已切换到「已保存」', 'success')
  })

  it('修改已有配置并切换时仍提示导入', async () => {
    vi.stubEnv('VITE_SHOW_CONFIG_CHANGE_DIALOG', 'false')
    const profile = createDefaultOpenAIProfile({ id: 'saved', name: '已保存', baseUrl: 'https://saved.example.com/v1' })
    mockState(normalizeSettings({ profiles: [createDefaultOpenAIProfile({ id: 'other' }), profile], activeProfileId: 'other' }))
    promptImportLink(new URLSearchParams({ settings: JSON.stringify({ profiles: [{ ...profile, baseUrl: 'https://new.example.com/v1' }] }) }), true)
    await vi.waitFor(() => expect(mock.state.showToast).toHaveBeenCalled())
    expect(mock.state.settings.activeProfileId).toBe('saved')
    expect(mock.state.settings.profiles).toHaveLength(2)
    expect(mock.state.settings.profiles.find((item: { id: string }) => item.id === 'saved').baseUrl).toBe('https://new.example.com/v1')
    expect(mock.state.showToast).toHaveBeenCalledWith('配置已导入', 'success')
  })

  it('默认展示配置变更弹窗，确认前不导入', async () => {
    mockState(normalizeSettings({}))
    promptImportLink(new URLSearchParams({ apiUrl: 'https://new.example.com/v1' }), true)
    await vi.waitFor(() => expect(mock.state.setConfirmDialog).toHaveBeenCalled())
    expect(mock.state.setSettings).not.toHaveBeenCalled()
  })
})
