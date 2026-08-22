import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultFalProfile,
  createDefaultOpenAIProfile,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from './apiProfiles'
import { buildSettingsFromUrlParams, clearUrlSettingParams, getExplicitUrlSettingsIds, hasUrlSettingParams } from './urlSettings'

afterEach(() => {
  vi.unstubAllEnvs()
})

async function importPresetConfigOnlyUrlSettings(options: { locked?: boolean, multiple?: boolean } = {}) {
  vi.resetModules()
  vi.stubEnv('VITE_SHOW_PRESET_CONFIG_ONLY', 'true')
  if (options.locked) vi.stubEnv('VITE_LOCK_PRESET_CONFIG_PARAMS', 'true')
  vi.stubEnv('VITE_DEFAULT_API_URL', 'https://default.example.com/v1')
  const apiProfiles = await import('./apiProfiles')
  const presetConfig = await import('./presetConfig')
  presetConfig.setPresetConfig({
    customProviders: [],
    profiles: options.multiple
      ? [
          apiProfiles.createDefaultOpenAIProfile({ id: 'preset-a', name: 'Preset A', isDefault: true }),
          apiProfiles.createDefaultOpenAIProfile({ id: 'preset-b', name: 'Preset B' }),
        ]
      : [apiProfiles.createDefaultOpenAIProfile()],
  })
  return import('./urlSettings')
}

describe('URL settings params', () => {
  it('reports only IDs explicitly included in URL settings and profileId', () => {
    const params = new URLSearchParams('profileId=preset-query-profile')
    params.set('settings', JSON.stringify({
      customProviders: [{ id: 'preset-provider' }, { name: 'No ID' }],
      profiles: [{ id: 'preset-json-profile' }, { provider: 'openai' }],
    }))

    expect(getExplicitUrlSettingsIds(params)).toEqual({
      providerIds: ['preset-provider'],
      profileIds: ['preset-json-profile', 'preset-query-profile'],
    })
  })

  it('creates and activates a new OpenAI profile for legacy URL params', () => {
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1&apiKey=test-key')),
    })

    expect(next.profiles).toHaveLength(2)
    expect(next.activeProfileId).not.toBe(current.activeProfileId)
    expect(next.profiles.find((profile) => profile.id === next.activeProfileId)).toMatchObject({
      name: 'URL 参数配置',
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: DEFAULT_IMAGES_MODEL,
    })
  })

  it('uses and updates the profile ID from an OpenAI share URL', () => {
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const first = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('profileId=shared-openai&apiUrl=https://api.example.com/v1&model=model-v1')),
    })
    const second = normalizeSettings({
      ...first,
      ...buildSettingsFromUrlParams(first, new URLSearchParams('profileId=shared-openai&apiUrl=https://api.example.com/v2&model=model-v2')),
    })

    expect(second.profiles.filter((profile) => profile.id === 'shared-openai')).toHaveLength(1)
    expect(second.profiles.find((profile) => profile.id === 'shared-openai')).toMatchObject({
      baseUrl: 'https://api.example.com/v2/v1',
      model: 'model-v2',
    })
  })

  it('preserves fields omitted from a same-ID OpenAI share URL', () => {
    const existingProfile = createDefaultOpenAIProfile({
      id: 'shared-openai',
      name: 'Existing OpenAI',
      baseUrl: 'https://old.example.com/v1',
      apiKey: 'existing-key',
      model: 'existing-responses-model',
      timeout: 900,
      apiMode: 'responses',
      apiProxy: true,
      responseFormatB64Json: true,
    })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [createDefaultOpenAIProfile(), existingProfile],
      activeProfileId: DEFAULT_SETTINGS.activeProfileId,
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('profileId=shared-openai&apiUrl=https://new.example.com/v1&profileName=Shared')),
    })

    expect(next.activeProfileId).toBe(existingProfile.id)
    expect(next.profiles.find((profile) => profile.id === existingProfile.id)).toMatchObject({
      name: 'Shared',
      baseUrl: 'https://new.example.com/v1',
      apiKey: 'existing-key',
      model: 'existing-responses-model',
      timeout: 900,
      apiMode: 'responses',
      apiProxy: true,
      responseFormatB64Json: true,
    })
  })

  it('generates unique IDs for ID-less profiles in settings URLs', () => {
    const params = new URLSearchParams()
    params.set('settings', JSON.stringify({
      customProviders: [{ id: 'url-provider', name: 'URL Provider', submit: { path: 'generate' } }],
      profiles: [
        { provider: 'url-provider', model: 'model-a' },
        { provider: 'url-provider', model: 'model-b' },
      ],
    }))

    const next = normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...buildSettingsFromUrlParams(DEFAULT_SETTINGS, params),
    })
    const ids = next.profiles.map((profile) => profile.id)

    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('uses model from URL params for OpenAI profiles', () => {
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1&apiKey=test-key&model=custom-image-model')),
    })

    expect(next.profiles.find((profile) => profile.id === next.activeProfileId)).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'custom-image-model',
      apiMode: 'images',
    })
  })

  it('uses reasoning effort from URL params for Responses profiles', () => {
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiMode=responses&reasoningEffort=max')),
    })

    expect(next.profiles.find((profile) => profile.id === next.activeProfileId)).toMatchObject({
      apiMode: 'responses',
      reasoningEffort: 'max',
    })
  })

  it('uses profile name from URL params for OpenAI profiles', () => {
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1&apiKey=test-key&profileName=测试配置')),
    })

    expect(next.profiles.find((profile) => profile.id === next.activeProfileId)).toMatchObject({
      name: '测试配置',
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
    })
  })

  it('creates a separate profile when the API URL trailing slash differs', () => {
    const existingProfile = createDefaultOpenAIProfile({
      id: 'existing-openai',
      name: 'Existing OpenAI',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
    })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [createDefaultOpenAIProfile(), existingProfile],
      activeProfileId: DEFAULT_SETTINGS.activeProfileId,
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1/&apiKey=test-key')),
    })

    expect(next.profiles).toHaveLength(3)
    expect(next.activeProfileId).not.toBe(existingProfile.id)
    expect(next.profiles.find((profile) => profile.id === next.activeProfileId)?.baseUrl).toBe('https://api.example.com/v1/')
  })

  it('creates a separate profile when URL profile name differs', () => {
    const existingProfile = createDefaultOpenAIProfile({
      id: 'existing-openai',
      name: 'Existing OpenAI',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
    })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [createDefaultOpenAIProfile(), existingProfile],
      activeProfileId: DEFAULT_SETTINGS.activeProfileId,
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1/&apiKey=test-key&profileName=URL Profile')),
    })
    const activeProfile = next.profiles.find((profile) => profile.id === next.activeProfileId)

    expect(next.profiles).toHaveLength(3)
    expect(next.activeProfileId).not.toBe(existingProfile.id)
    expect(activeProfile).toMatchObject({
      name: 'URL Profile',
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'test-key',
    })
  })

  it('creates a separate profile when URL codex CLI option differs', () => {
    const existingProfile = createDefaultOpenAIProfile({
      id: 'existing-openai',
      name: 'Existing OpenAI',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      codexCli: false,
    })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [createDefaultOpenAIProfile(), existingProfile],
      activeProfileId: DEFAULT_SETTINGS.activeProfileId,
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1/&apiKey=test-key&codexCli=true')),
    })
    const activeProfile = next.profiles.find((profile) => profile.id === next.activeProfileId)

    expect(next.profiles).toHaveLength(3)
    expect(next.activeProfileId).not.toBe(existingProfile.id)
    expect(activeProfile).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'test-key',
      codexCli: true,
    })
  })

  it('creates a separate profile when URL streaming options differ', () => {
    const existingProfile = createDefaultOpenAIProfile({
      id: 'existing-openai',
      name: 'Existing OpenAI',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      streamImages: true,
      streamPartialImages: 0,
    })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [createDefaultOpenAIProfile(), existingProfile],
      activeProfileId: DEFAULT_SETTINGS.activeProfileId,
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1/&apiKey=test-key&streamImages=true&streamPartialImages=3')),
    })
    const activeProfile = next.profiles.find((profile) => profile.id === next.activeProfileId)

    expect(next.profiles).toHaveLength(3)
    expect(next.activeProfileId).not.toBe(existingProfile.id)
    expect(activeProfile).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'test-key',
      streamImages: true,
      streamPartialImages: 3,
    })
  })

  it('creates an OpenAI profile from legacy params even when fal is active', () => {
    const falProfile = createDefaultFalProfile({ id: 'fal-active', apiKey: 'fal-key' })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [falProfile],
      activeProfileId: falProfile.id,
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1&apiKey=openai-key')),
    })

    expect(next.profiles).toHaveLength(2)
    expect(next.profiles.find((profile) => profile.id === next.activeProfileId)).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'openai-key',
    })
  })

  it('applies the codex CLI query parameter to a requested custom profile', () => {
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: [{
        id: 'custom-provider',
        name: 'Custom Provider',
        submit: { path: 'images/generations' },
      }],
      profiles: [{
        ...createDefaultOpenAIProfile({ id: 'custom-profile' }),
        provider: 'custom-provider',
        codexCli: false,
      }],
      activeProfileId: 'custom-profile',
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('profileId=custom-profile&codexCli=true')),
    })

    expect(next.profiles).toHaveLength(1)
    expect(next.activeProfileId).toBe('custom-profile')
    expect(next.profiles[0]).toMatchObject({ provider: 'custom-provider', codexCli: true })
  })

  it('applies the transparent background method to the active fal profile', () => {
    const falProfile = createDefaultFalProfile({ id: 'fal-profile' })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [falProfile],
      activeProfileId: falProfile.id,
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('transparentBackgroundMethod=local')),
    })

    expect(next.profiles[0].transparentBackgroundMethod).toBe('local')
  })

  it('applies the transparent background method to a requested custom profile', () => {
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: [{ id: 'custom-provider', name: 'Custom Provider', submit: { path: 'images/generations' } }],
      profiles: [{
        ...createDefaultOpenAIProfile({ id: 'custom-profile' }),
        provider: 'custom-provider',
      }],
      activeProfileId: 'custom-profile',
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('profileId=custom-profile&transparentBackgroundMethod=local')),
    })

    expect(next.activeProfileId).toBe('custom-profile')
    expect(next.profiles[0].transparentBackgroundMethod).toBe('local')
  })

  it('clears known URL setting params without touching unrelated params', () => {
    const params = new URLSearchParams('reasoningEffort=high&transparentBackgroundMethod=local&foo=bar')

    expect(hasUrlSettingParams(params)).toBe(true)
    clearUrlSettingParams(params)

    expect(params.toString()).toBe('foo=bar')
  })

  it('imports settings with custom providers from URL params', () => {
    const importedSettings = {
      customProviders: [{
        id: 'custom-json',
        name: 'Custom JSON',
        submit: {
          path: 'images/generations',
          method: 'POST',
          contentType: 'json',
          body: { model: '$profile.model', prompt: '$prompt' },
          result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: [] },
        },
      }],
      profiles: [{
        id: 'custom-profile',
        name: 'Custom Profile',
        provider: 'custom-json',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'custom-key',
        model: 'custom-model',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
    }
    const params = new URLSearchParams()
    params.set('settings', JSON.stringify(importedSettings))

    const next = normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...buildSettingsFromUrlParams(DEFAULT_SETTINGS, params),
    })

    expect(next.customProviders).toHaveLength(1)
    expect(next.customProviders[0]).toMatchObject({ id: 'custom-json', name: 'Custom JSON' })
    expect(next.activeProfileId).toBe('custom-profile')
    expect(next.profiles[0]).toMatchObject({
      id: 'custom-profile',
      provider: 'custom-json',
      apiKey: 'custom-key',
      model: 'custom-model',
    })
  })

  it('activates the first profile imported from URL settings when current settings are customized', () => {
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [createDefaultOpenAIProfile({
        id: 'current-openai',
        name: 'Current OpenAI',
        baseUrl: 'https://current.example.com/v1',
        apiKey: 'current-key',
        model: 'current-model',
      })],
      activeProfileId: 'current-openai',
    })
    const importedSettings = {
      customProviders: [{
        id: 'custom-json',
        name: 'Custom JSON',
        submit: {
          path: 'images/generations',
          method: 'POST',
          contentType: 'json',
          body: { model: '$profile.model', prompt: '$prompt' },
          result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: [] },
        },
      }],
      profiles: [{
        id: 'custom-profile',
        name: 'Custom Profile',
        provider: 'custom-json',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'custom-key',
        model: 'custom-model',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
    }
    const params = new URLSearchParams()
    params.set('settings', JSON.stringify(importedSettings))

    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, params),
    })
    const activeProfile = next.profiles.find((profile) => profile.id === next.activeProfileId)

    expect(next.activeProfileId).not.toBe('current-openai')
    expect(activeProfile).toMatchObject({
      provider: 'custom-json',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'custom-key',
      model: 'custom-model',
    })
  })

  it('imports custom provider settings wrapper from URL params', () => {
    const params = new URLSearchParams()
    params.set('settings', JSON.stringify({
      version: 1,
      settings: {
        customProviders: [{
          id: 'wrapped-custom',
          name: 'Wrapped Custom',
          submit: {
            path: 'images/generations',
            method: 'POST',
            contentType: 'json',
            body: { model: '$profile.model', prompt: '$prompt' },
            result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: [] },
          },
        }],
        profiles: [{
          id: 'wrapped-profile',
          name: 'Wrapped Profile',
          provider: 'wrapped-custom',
          baseUrl: 'https://wrapped.example.com/v1',
          apiKey: 'wrapped-key',
          model: 'wrapped-model',
          timeout: 300,
          apiMode: 'images',
          codexCli: false,
          apiProxy: false,
        }],
      },
    }))

    const next = normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...buildSettingsFromUrlParams(DEFAULT_SETTINGS, params),
    })

    expect(next.customProviders).toHaveLength(1)
    expect(next.customProviders[0]).toMatchObject({ id: 'wrapped-custom', name: 'Wrapped Custom' })
    expect(next.profiles).toHaveLength(1)
    expect(next.profiles[0]).toMatchObject({
      id: 'wrapped-profile',
      provider: 'wrapped-custom',
      baseUrl: 'https://wrapped.example.com/v1',
      apiKey: 'wrapped-key',
      model: 'wrapped-model',
    })
  })

  it('patches the active profile instead of creating a new one when only default config is shown', async () => {
    const { buildSettingsFromUrlParams } = await importPresetConfigOnlyUrlSettings()
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1&apiKey=test-key&model=custom-model&profileName=导入配置&apiMode=responses')),
    })

    expect(next.profiles).toHaveLength(1)
    expect(next.customProviders).toHaveLength(0)
    expect(next.activeProfileId).toBe(current.activeProfileId)
    expect(next.profiles[0]).toMatchObject({
      id: current.activeProfileId,
      provider: 'openai',
      name: '导入配置',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'custom-model',
      apiMode: 'responses',
    })
  })

  it('ignores imported custom providers and non-default provider profiles when only default config is shown', async () => {
    const { buildSettingsFromUrlParams } = await importPresetConfigOnlyUrlSettings()
    const importedSettings = {
      customProviders: [{
        id: 'custom-json',
        name: 'Custom JSON',
        submit: {
          path: 'images/generations',
          method: 'POST',
          contentType: 'json',
          body: { model: '$profile.model', prompt: '$prompt' },
          result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: [] },
        },
      }],
      profiles: [{
        id: 'custom-profile',
        name: 'Custom Profile',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'custom-key',
        model: 'custom-model',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
    }
    const params = new URLSearchParams()
    params.set('settings', JSON.stringify(importedSettings))

    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, params),
    })

    expect(next.profiles).toHaveLength(1)
    expect(next.customProviders).toHaveLength(0)
    expect(next.activeProfileId).toBe(current.activeProfileId)
    expect(next.profiles[0]).toMatchObject({
      provider: 'openai',
      baseUrl: current.profiles[0].baseUrl,
      apiKey: current.profiles[0].apiKey,
      model: current.profiles[0].model,
    })
  })

  it('patches from a matching imported profile without importing custom providers when only default config is shown', async () => {
    const { buildSettingsFromUrlParams } = await importPresetConfigOnlyUrlSettings()
    const importedSettings = {
      customProviders: [{
        id: 'custom-json',
        name: 'Custom JSON',
        submit: {
          path: 'images/generations',
          method: 'POST',
          contentType: 'json',
          body: { model: '$profile.model', prompt: '$prompt' },
          result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: [] },
        },
      }],
      profiles: [{
        id: 'custom-profile',
        name: 'Custom Profile',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'custom-key',
        model: 'custom-model',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }, {
        id: 'openai-profile',
        name: 'OpenAI Profile',
        provider: 'openai',
        baseUrl: 'https://openai.example.com/v1',
        apiKey: 'openai-key',
        model: 'openai-model',
        timeout: 120,
        apiMode: 'responses',
        codexCli: true,
        apiProxy: true,
      }],
    }
    const params = new URLSearchParams()
    params.set('settings', JSON.stringify(importedSettings))

    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, params),
    })

    expect(next.profiles).toHaveLength(1)
    expect(next.customProviders).toHaveLength(0)
    expect(next.activeProfileId).toBe(current.activeProfileId)
    expect(next.profiles[0]).toMatchObject({
      id: current.activeProfileId,
      provider: 'openai',
      name: 'OpenAI Profile',
      baseUrl: 'https://openai.example.com/v1',
      apiKey: 'openai-key',
      model: 'openai-model',
      timeout: 120,
      apiMode: 'responses',
      codexCli: true,
      apiProxy: true,
    })
  })

  it('does not switch away from the default custom provider when only default config is shown', async () => {
    const { buildSettingsFromUrlParams } = await importPresetConfigOnlyUrlSettings()
    const customProvider = {
      id: 'custom-default',
      name: 'Custom Default',
      submit: {
        path: 'images/generations',
        method: 'POST' as const,
        contentType: 'json' as const,
        body: { model: '$profile.model', prompt: '$prompt' },
        result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: [] },
      },
    }
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: [customProvider],
      profiles: [{
        ...createDefaultOpenAIProfile({ id: 'custom-default-profile' }),
        name: 'Custom Default Profile',
        provider: customProvider.id,
        baseUrl: 'https://custom-default.example.com/v1',
        apiKey: 'custom-default-key',
        model: 'custom-default-model',
      }],
      activeProfileId: 'custom-default-profile',
    })
    const params = new URLSearchParams()
    params.set('settings', JSON.stringify({
      customProviders: [{
        id: 'another-custom',
        name: 'Another Custom',
        submit: customProvider.submit,
      }],
      profiles: [{
        id: 'openai-profile',
        name: 'Ignored OpenAI',
        provider: 'openai',
        baseUrl: 'https://openai.example.com/v1',
        apiKey: 'openai-key',
        model: 'openai-model',
        timeout: 120,
        apiMode: 'responses',
        codexCli: true,
        apiProxy: true,
      }, {
        id: 'matching-custom-profile',
        name: 'Patched Custom Default',
        provider: customProvider.id,
        baseUrl: 'https://patched-custom.example.com/v1',
        apiKey: 'patched-custom-key',
        model: 'patched-custom-model',
        timeout: 240,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
    }))
    params.set('codexCli', 'true')

    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, params),
    })

    expect(next.customProviders).toHaveLength(1)
    expect(next.customProviders[0].id).toBe(customProvider.id)
    expect(next.profiles).toHaveLength(1)
    expect(next.activeProfileId).toBe(current.activeProfileId)
    expect(next.profiles[0]).toMatchObject({
      id: current.activeProfileId,
      provider: customProvider.id,
      name: 'Patched Custom Default',
      baseUrl: 'https://patched-custom.example.com/v1',
      apiKey: 'patched-custom-key',
      model: 'patched-custom-model',
      timeout: 240,
      apiMode: 'images',
      codexCli: true,
    })
  })

  it('patches and activates the preset profile selected by profileId', async () => {
    const { buildSettingsFromUrlParams } = await importPresetConfigOnlyUrlSettings({ multiple: true })
    const profileA = createDefaultOpenAIProfile({
      id: 'preset-a',
      name: 'Preset A',
      apiKey: 'key-a',
      model: 'model-a',
      isDefault: true,
    })
    const profileB = createDefaultOpenAIProfile({
      id: 'preset-b',
      name: 'Preset B',
      apiKey: 'key-b',
      model: 'model-b',
    })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profileA, profileB],
      activeProfileId: profileA.id,
    })
    const params = new URLSearchParams('profileId=preset-b&apiUrl=https://preset-b.example.com/v1')
    params.set('settings', JSON.stringify({
      profiles: [{
        id: 'preset-b',
        provider: 'openai',
        model: 'patched-model-b',
        timeout: 240,
        transparentBackgroundMethod: 'local',
      }],
    }))

    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, params),
    })

    expect(next.activeProfileId).toBe(profileB.id)
    expect(next.profiles.find((profile) => profile.id === profileA.id)).toMatchObject({
      name: 'Preset A',
      apiKey: 'key-a',
      model: 'model-a',
    })
    expect(next.profiles.find((profile) => profile.id === profileB.id)).toMatchObject({
      name: 'Preset B',
      baseUrl: 'https://preset-b.example.com/v1',
      apiKey: 'key-b',
      model: 'patched-model-b',
      timeout: 240,
      transparentBackgroundMethod: 'local',
    })
  })

  it('applies the transparent background method in preset-only mode', async () => {
    const { buildSettingsFromUrlParams } = await importPresetConfigOnlyUrlSettings()
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('transparentBackgroundMethod=local')),
    })

    expect(next.profiles[0].transparentBackgroundMethod).toBe('local')
  })

  it('preserves a trailing slash when overriding a custom preset API URL', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_SHOW_PRESET_CONFIG_ONLY', 'true')
    const apiProfiles = await import('./apiProfiles')
    const presetConfig = await import('./presetConfig')
    const provider = {
      id: 'custom-preset',
      name: 'Custom Preset',
      submit: { path: 'custom/image-tasks' },
    }
    const profile = apiProfiles.createDefaultOpenAIProfile({
      id: 'custom-preset-profile',
      provider: provider.id,
      baseUrl: 'https://old.example.com/',
      apiMode: 'images',
    })
    presetConfig.setPresetConfig({ customProviders: [provider], profiles: [profile] })
    const { buildSettingsFromUrlParams } = await import('./urlSettings')
    const current = apiProfiles.normalizeSettings({
      ...apiProfiles.DEFAULT_SETTINGS,
      customProviders: [provider],
      profiles: [profile],
      activeProfileId: profile.id,
    })

    const next = apiProfiles.normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams(
        'profileId=custom-preset-profile&apiUrl=https://new.example.com/',
      )),
    })

    expect(next.profiles[0].baseUrl).toBe('https://new.example.com/')
  })

  it('ignores a same-ID settings profile with a conflicting provider in preset-only mode', async () => {
    const { buildSettingsFromUrlParams } = await importPresetConfigOnlyUrlSettings({ multiple: true })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [
        createDefaultOpenAIProfile({ id: 'preset-a', isDefault: true }),
        createDefaultOpenAIProfile({ id: 'preset-b', model: 'original-model' }),
      ],
      activeProfileId: 'preset-a',
    })
    const params = new URLSearchParams('profileId=preset-b&apiKey=query-key')
    params.set('settings', JSON.stringify({
      profiles: [{
        id: 'preset-b',
        provider: 'fal',
        apiKey: 'json-key',
        model: 'conflicting-model',
      }],
    }))

    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, params),
    })

    expect(next.activeProfileId).toBe('preset-b')
    expect(next.profiles.find((profile) => profile.id === 'preset-b')).toMatchObject({
      provider: 'openai',
      apiKey: 'query-key',
      model: 'original-model',
    })
  })

  it('does not fall back to another settings profile when the requested preset ID is missing', async () => {
    const { buildSettingsFromUrlParams } = await importPresetConfigOnlyUrlSettings({ multiple: true })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [
        createDefaultOpenAIProfile({ id: 'preset-a', isDefault: true }),
        createDefaultOpenAIProfile({ id: 'preset-b', model: 'original-model' }),
      ],
      activeProfileId: 'preset-a',
    })
    const params = new URLSearchParams('profileId=preset-b&apiKey=query-key')
    params.set('settings', JSON.stringify({
      profiles: [{
        id: 'other-profile',
        provider: 'openai',
        apiKey: 'json-key',
        model: 'fallback-model',
      }],
    }))

    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, params),
    })

    expect(next.activeProfileId).toBe('preset-b')
    expect(next.profiles.find((profile) => profile.id === 'preset-b')).toMatchObject({
      apiKey: 'query-key',
      model: 'original-model',
    })
  })

  it('only applies the API key from URL parameters when preset parameters are locked', async () => {
    const { buildSettingsFromUrlParams } = await importPresetConfigOnlyUrlSettings({ locked: true })
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams(
        'apiUrl=https://changed.example.com/v1&apiKey=changed-key&model=changed-model&transparentBackgroundMethod=local',
      )),
    })

    expect(next.profiles[0]).toMatchObject({
      baseUrl: current.profiles[0].baseUrl,
      apiKey: 'changed-key',
      model: current.profiles[0].model,
      transparentBackgroundMethod: 'api',
    })
  })

  it('ignores an invalid explicit profileId in preset-only mode', async () => {
    const { buildSettingsFromUrlParams } = await importPresetConfigOnlyUrlSettings({ multiple: true })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [
        createDefaultOpenAIProfile({ id: 'preset-a', apiKey: 'key-a', isDefault: true }),
        createDefaultOpenAIProfile({ id: 'preset-b', apiKey: 'key-b' }),
      ],
      activeProfileId: 'preset-a',
    })

    expect(buildSettingsFromUrlParams(current, new URLSearchParams(
      'profileId=missing-preset&apiKey=changed-key',
    ))).toEqual({})
  })
})
