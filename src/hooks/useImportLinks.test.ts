import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile, normalizeSettings } from '../lib/apiProfiles'
import { handledImportLinks } from '../lib/importLink'
import { createCustomProfileImportUrl } from '../lib/profileImportUrl'
import { promptImportLink } from './useImportLinks'

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

afterEach(() => {
  vi.unstubAllEnvs()
  handledImportLinks.clear()
})

describe('promptImportLink', () => {
  it('相同初始配置自动导入时保留完整本地设置', async () => {
    const settings = normalizeSettings({ colorMode: 'dark', enterSubmit: true, uiFont: 'system' })
    mock.state = {
      settings,
      setSettings: vi.fn((next) => { mock.state.settings = normalizeSettings(next) }),
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    }
    const link = createCustomProfileImportUrl('https://example.com', settings.profiles[0], undefined, {
      includeApiKey: true, useNewApiAddress: false, useNewApiKey: false, useNewApiModel: false,
    })
    promptImportLink(link, true)
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
    const settings = normalizeSettings({ profiles: [createDefaultOpenAIProfile({ id: 'other' }), profile], activeProfileId })
    mock.state = {
      settings,
      setSettings: vi.fn((next) => { mock.state.settings = normalizeSettings(next) }),
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    }
    const link = createCustomProfileImportUrl('https://example.com', profile, undefined, {
      includeApiKey: true, useNewApiAddress: false, useNewApiKey: false, useNewApiModel: false,
    })
    promptImportLink(link, true)
    await vi.waitFor(() => expect(mock.state.setSettings).toHaveBeenCalled())
    expect(mock.state.settings.activeProfileId).toBe('saved')
    expect(mock.state.setConfirmDialog).not.toHaveBeenCalled()
  })

  it('关闭弹窗时直接应用配置变更', async () => {
    vi.stubEnv('VITE_SHOW_CONFIG_CHANGE_DIALOG', 'false')
    mock.state = {
      settings: normalizeSettings({}),
      setSettings: vi.fn((next) => { mock.state.settings = normalizeSettings(next) }),
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    }
    promptImportLink(new URLSearchParams({ apiUrl: 'https://new.example.com/v1' }), true)
    await vi.waitFor(() => expect(mock.state.setSettings).toHaveBeenCalled())
    expect(mock.state.settings.profiles.some((profile: { baseUrl: string }) => profile.baseUrl === 'https://new.example.com/v1')).toBe(true)
    expect(mock.state.setConfirmDialog).not.toHaveBeenCalled()
  })

  it('默认展示配置变更弹窗，确认前不导入', async () => {
    mock.state = {
      settings: normalizeSettings({}),
      setSettings: vi.fn(),
      setConfirmDialog: vi.fn(),
    }
    promptImportLink(new URLSearchParams({ apiUrl: 'https://new.example.com/v1' }), true)
    await vi.waitFor(() => expect(mock.state.setConfirmDialog).toHaveBeenCalled())
    expect(mock.state.setSettings).not.toHaveBeenCalled()
  })
})
