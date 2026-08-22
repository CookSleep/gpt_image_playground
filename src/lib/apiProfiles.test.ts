import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FAL_BASE_URL,
  DEFAULT_FAL_MODEL,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_OPENAI_PROFILE_ID,
  DEFAULT_SETTINGS,
  createDefaultOpenAIProfile,
  createDefaultFalProfile,
  getApiProviderLabel,
  getActiveApiProfile,
  getCustomProviderDefinition,
  findEquivalentApiProfile,
  importCustomProviderDefinitionFromJson,
  importCustomProviderSettingsFromJson,
  getDefaultApiProfileId,
  mergePresetImportedSettings as mergeDefaultImportedSettings,
  mergeImportedSettings,
  normalizeApiProfile,
  normalizeSettings,
  switchApiProfileProvider,
  validateApiProfile,
} from './apiProfiles'
import { CUSTOM_PROVIDER_LLM_PROMPT, DEFAULT_CUSTOM_PROVIDER_JSON } from './settingsCustomProvider'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('validateApiProfile', () => {
  it('allows empty API URL when API proxy is enabled and available', () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')

    expect(validateApiProfile(createDefaultOpenAIProfile({
      baseUrl: '',
      apiKey: 'test-key',
      apiProxy: true,
    }))).toBeNull()
  })

  it('still requires API URL when API proxy is unavailable', () => {
    expect(validateApiProfile(createDefaultOpenAIProfile({
      baseUrl: '',
      apiKey: 'test-key',
      apiProxy: true,
    }))).toBe('缺少 API URL')
  })
})

describe('normalizeApiProfile', () => {
  it('uses provider defaults and preserves explicit transparent background methods', () => {
    expect(normalizeApiProfile({}).transparentBackgroundMethod).toBe('api')
    expect(normalizeApiProfile({ transparentBackgroundMethod: 'local' }).transparentBackgroundMethod).toBe('local')
    expect(normalizeApiProfile({}, { transparentBackgroundMethod: 'local' }).transparentBackgroundMethod).toBe('local')
    expect(normalizeApiProfile({ transparentBackgroundMethod: 'invalid' }).transparentBackgroundMethod).toBe('api')
    expect(normalizeApiProfile({ provider: 'fal' }).transparentBackgroundMethod).toBe('local')
    expect(normalizeApiProfile({ provider: 'fal', transparentBackgroundMethod: 'api' }).transparentBackgroundMethod).toBe('api')
    expect(normalizeApiProfile({ provider: 'fal', transparentBackgroundMethod: 'invalid' }).transparentBackgroundMethod).toBe('local')
  })
})

describe('normalizeSettings', () => {
  it('preserves a non-empty profile description and removes an empty one', () => {
    const settings = normalizeSettings({
      profiles: [
        createDefaultOpenAIProfile({ id: 'described', description: '支持 **Markdown**' }),
        createDefaultOpenAIProfile({ id: 'empty', description: '   ' }),
      ],
    })

    expect(settings.profiles[0].description).toBe('支持 **Markdown**')
    expect(settings.profiles[1].description).toBeUndefined()
  })
})

describe('default API URL env', () => {
  it('applies shared URL params from VITE_DEFAULT_API_URL to the default profile', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_DEFAULT_API_URL', 'https://app.example.com/?apiUrl=https%3A%2F%2Fapi.example.com&apiMode=responses&model=test-image-model&profileName=URL%20Profile&reasoningEffort=xhigh&codexCli=true&streamImages=true&streamPartialImages=3&transparentBackgroundMethod=local')

    const { DEFAULT_SETTINGS, createDefaultOpenAIProfile } = await import('./apiProfiles')

    expect(createDefaultOpenAIProfile()).toMatchObject({
      id: DEFAULT_OPENAI_PROFILE_ID,
      name: 'URL Profile',
      baseUrl: 'https://api.example.com',
      model: 'test-image-model',
      apiMode: 'responses',
      reasoningEffort: 'xhigh',
      codexCli: true,
      streamImages: true,
      streamPartialImages: 3,
      transparentBackgroundMethod: 'local',
    })
    expect(DEFAULT_SETTINGS.profiles[0]).toMatchObject({
      id: DEFAULT_OPENAI_PROFILE_ID,
      name: 'URL Profile',
      baseUrl: 'https://api.example.com',
      model: 'test-image-model',
      apiMode: 'responses',
      reasoningEffort: 'xhigh',
      codexCli: true,
      streamImages: true,
      streamPartialImages: 3,
      transparentBackgroundMethod: 'local',
    })
  })

  it('keeps settings URLs out of the default API base URL', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_DEFAULT_API_URL', 'https://example.com/?settings={}')

    const { DEFAULT_SETTINGS } = await import('./apiProfiles')

    expect(DEFAULT_SETTINGS.baseUrl).toBe('')
    expect(DEFAULT_SETTINGS.profiles[0].baseUrl).toBe('')
  })

  it('enables preset-only mode for an embedded config', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_DEFAULT_API_URL', 'embedded-config:e30=')
    vi.stubEnv('VITE_SHOW_PRESET_CONFIG_ONLY', 'true')

    const { createDefaultOpenAIProfile } = await import('./apiProfiles')
    const { isPresetConfigOnlyEnabled, setPresetConfig } = await import('./presetConfig')
    setPresetConfig({ customProviders: [], profiles: [createDefaultOpenAIProfile()] })

    expect(isPresetConfigOnlyEnabled()).toBe(true)
  })
})

describe('mergeImportedSettings', () => {
  it('replaces the default OpenAI profile with legacy imported settings when current settings are untouched', () => {
    const merged = mergeImportedSettings(DEFAULT_SETTINGS, {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'imported-key',
      model: 'imported-model',
      timeout: 120,
      apiMode: 'responses',
      codexCli: true,
      apiProxy: true,
    })

    expect(merged.profiles).toHaveLength(1)
    expect(merged.activeProfileId).toBe(DEFAULT_OPENAI_PROFILE_ID)
    expect(merged.profiles[0]).toMatchObject({
      id: DEFAULT_OPENAI_PROFILE_ID,
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'imported-key',
      model: 'imported-model',
      timeout: 120,
      apiMode: 'responses',
      codexCli: true,
      apiProxy: true,
    })
  })

  it('does not replace a default profile whose transparent background method was changed', () => {
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile, transparentBackgroundMethod: 'local' })),
    })

    const merged = mergeImportedSettings(current, {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'imported-key',
      model: 'imported-model',
    })

    expect(merged.profiles.find((profile) => profile.id === DEFAULT_OPENAI_PROFILE_ID)?.transparentBackgroundMethod).toBe('local')
  })

  it('replaces the default provider list with imported profiles when current settings are untouched', () => {
    const merged = mergeImportedSettings(DEFAULT_SETTINGS, {
      profiles: [
        {
          id: 'imported-openai',
          name: 'Imported OpenAI',
          provider: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'openai-key',
          model: DEFAULT_IMAGES_MODEL,
          timeout: 300,
          apiMode: 'images',
          codexCli: false,
          apiProxy: false,
        },
        {
          id: 'imported-fal',
          name: 'Imported fal',
          provider: 'fal',
          baseUrl: DEFAULT_FAL_BASE_URL,
          apiKey: 'fal-key',
          model: DEFAULT_FAL_MODEL,
          timeout: 300,
          apiMode: 'images',
          codexCli: false,
          apiProxy: false,
        },
      ],
      activeProfileId: 'imported-fal',
    })

    expect(merged.profiles.map((profile) => profile.id)).toEqual(['imported-openai', 'imported-fal'])
    expect(merged.activeProfileId).toBe('imported-fal')
  })

  it('preserves different imported profile IDs with matching connections', () => {
    const merged = mergeImportedSettings(DEFAULT_SETTINGS, {
      profiles: [
        {
          id: 'imported-openai-a',
          name: 'Imported OpenAI A',
          provider: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'openai-key',
          model: DEFAULT_IMAGES_MODEL,
          timeout: 300,
          apiMode: 'images',
          codexCli: false,
          apiProxy: false,
        },
        {
          id: 'imported-openai-b',
          name: 'Imported OpenAI B',
          provider: 'openai',
          baseUrl: 'https://api.example.com/v1/',
          apiKey: 'openai-key',
          model: DEFAULT_IMAGES_MODEL,
          timeout: 600,
          apiMode: 'images',
          codexCli: true,
          apiProxy: true,
        },
      ],
      activeProfileId: 'imported-openai-b',
    })

    expect(merged.profiles.map((profile) => profile.id)).toEqual(['imported-openai-a', 'imported-openai-b'])
    expect(merged.activeProfileId).toBe('imported-openai-b')
  })

  it('appends imported legacy settings as a new profile when current settings are customized', () => {
    const current = mergeImportedSettings(DEFAULT_SETTINGS, {
      baseUrl: 'https://current.example.com/v1',
      apiKey: 'current-key',
      model: 'current-model',
    })
    const merged = mergeImportedSettings(current, {
      baseUrl: 'https://imported.example.com/v1',
      apiKey: 'imported-key',
      model: 'imported-model',
    })

    expect(merged.profiles).toHaveLength(2)
    expect(merged.activeProfileId).toBe(DEFAULT_OPENAI_PROFILE_ID)
    expect(merged.profiles[0]).toMatchObject({ apiKey: 'current-key', model: 'current-model' })
    expect(merged.profiles[1]).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://imported.example.com/v1',
      apiKey: 'imported-key',
      model: 'imported-model',
    })
    expect(merged.profiles[1].id).not.toBe(DEFAULT_OPENAI_PROFILE_ID)
  })

  it('appends imported profiles as new profiles when current settings are customized', () => {
    const current = mergeImportedSettings(DEFAULT_SETTINGS, {
      baseUrl: 'https://current.example.com/v1',
      apiKey: 'current-key',
      model: 'current-model',
    })
    const merged = mergeImportedSettings(current, {
      profiles: [
        {
          id: 'imported-openai',
          name: 'Imported OpenAI',
          provider: 'openai',
          baseUrl: 'https://imported.example.com/v1',
          apiKey: 'imported-key',
          model: DEFAULT_IMAGES_MODEL,
          timeout: 300,
          apiMode: 'images',
          codexCli: false,
          apiProxy: false,
        },
        {
          id: 'imported-fal',
          name: 'Imported fal',
          provider: 'fal',
          baseUrl: DEFAULT_FAL_BASE_URL,
          apiKey: 'fal-key',
          model: DEFAULT_FAL_MODEL,
          timeout: 300,
          apiMode: 'images',
          codexCli: false,
          apiProxy: false,
        },
      ],
      activeProfileId: 'imported-fal',
    })

    expect(merged.profiles).toHaveLength(3)
    expect(merged.activeProfileId).toBe(DEFAULT_OPENAI_PROFILE_ID)
    expect(merged.profiles[0]).toMatchObject({ apiKey: 'current-key', model: 'current-model' })
    expect(merged.profiles[1]).toMatchObject({ name: 'Imported OpenAI', provider: 'openai', apiKey: 'imported-key' })
    expect(merged.profiles[2]).toMatchObject({ name: 'Imported fal', provider: 'fal', apiKey: 'fal-key' })
    expect(new Set(merged.profiles.map((profile) => profile.id)).size).toBe(3)
  })

  it('preserves a new ID even when its connection matches an existing profile', () => {
    const current = mergeImportedSettings(DEFAULT_SETTINGS, {
      baseUrl: 'https://current.example.com/v1',
      apiKey: 'current-key',
      model: 'current-model',
    })
    const merged = mergeImportedSettings(current, {
      profiles: [
        {
          id: 'duplicate-openai',
          name: 'Duplicate OpenAI',
          provider: 'openai',
          baseUrl: 'https://current.example.com/v1/',
          apiKey: 'current-key',
          model: 'current-model',
          timeout: 600,
          apiMode: 'images',
          codexCli: true,
          apiProxy: true,
        },
        {
          id: 'new-fal',
          name: 'New fal',
          provider: 'fal',
          baseUrl: DEFAULT_FAL_BASE_URL,
          apiKey: 'fal-key',
          model: DEFAULT_FAL_MODEL,
          timeout: 300,
          apiMode: 'images',
          codexCli: false,
          apiProxy: false,
        },
      ],
    })

    expect(merged.profiles).toHaveLength(3)
    expect(merged.profiles[0]).toMatchObject({ apiKey: 'current-key', model: 'current-model' })
    expect(merged.profiles[1]).toMatchObject({ id: 'duplicate-openai', apiKey: 'current-key', model: 'current-model' })
    expect(merged.profiles[2]).toMatchObject({ provider: 'fal', apiKey: 'fal-key', model: DEFAULT_FAL_MODEL })
  })

  it('preserves an imported custom profile ID when its connection matches an existing profile', () => {
    const current = mergeImportedSettings(DEFAULT_SETTINGS, {
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
        id: 'existing-custom',
        name: 'Existing Custom',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'existing-key',
        model: 'custom-model',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
      activeProfileId: 'existing-custom',
    })
    const imported = normalizeSettings({
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
        id: 'imported-custom',
        name: 'Imported Custom',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: '',
        model: 'custom-model',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
    })
    const merged = mergeImportedSettings(current, imported)
    const match = findEquivalentApiProfile(merged, imported.profiles[0], imported.customProviders)

    expect(merged.profiles).toHaveLength(2)
    expect(match?.id).toBe('imported-custom')
  })

  it('does not replace existing custom providers when only the default profile remains', () => {
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: [{
        id: 'custom-existing',
        name: 'Existing Provider',
        submit: { path: 'images/generations' },
      }],
    })
    const merged = mergeImportedSettings(current, {
      customProviders: [{
        id: 'custom-imported',
        name: 'Imported Provider',
        submit: { path: 'images/generations' },
      }],
      profiles: [{
        id: 'imported-custom',
        name: 'Imported Custom',
        provider: 'custom-imported',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: '',
        model: 'custom-model',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
    })

    expect(merged.customProviders.map((provider) => provider.id)).toEqual(['custom-existing', 'custom-imported'])
    expect(merged.profiles).toHaveLength(2)
  })

  it('appends imported custom providers and keeps imported custom profile references', () => {
    const current = mergeImportedSettings(DEFAULT_SETTINGS, {
      baseUrl: 'https://current.example.com/v1',
      apiKey: 'current-key',
      model: 'current-model',
    })
    const merged = mergeImportedSettings(current, {
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
        id: 'imported-custom',
        name: 'Imported Custom',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'custom-key',
        model: 'custom-model',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
    })

    expect(merged.customProviders).toHaveLength(1)
    expect(merged.customProviders[0]).toMatchObject({ id: 'custom-json', name: 'Custom JSON' })
    expect(merged.profiles).toHaveLength(2)
    expect(merged.profiles[1]).toMatchObject({
      name: 'Imported Custom',
      provider: 'custom-json',
      apiKey: 'custom-key',
      model: 'custom-model',
    })
  })

  it('strips the default preset marker from ordinary imports', () => {
    const merged = mergeImportedSettings(DEFAULT_SETTINGS, {
      customProviders: [{
        id: 'import-provider',
        name: 'Imported Provider',
        submit: { path: 'generate' },
      }],
      profiles: [{
        ...createDefaultOpenAIProfile(),
        id: 'import-profile',
        isDefault: true,
        provider: 'import-provider',
      }],
      activeProfileId: 'import-profile',
    })

    expect(merged.profiles[0].isDefault).toBeUndefined()
  })

  it('preserves distinct profile IDs in trusted backup imports', () => {
    const profileA = createDefaultOpenAIProfile({ id: 'backup-profile-a', apiKey: 'same-key' })
    const profileB = createDefaultOpenAIProfile({ id: 'backup-profile-b', apiKey: 'same-key' })
    const merged = mergeImportedSettings(DEFAULT_SETTINGS, {
      ...DEFAULT_SETTINGS,
      profiles: [profileA, profileB],
      activeProfileId: profileA.id,
    }, { preserveInternalIds: true })

    expect(merged.profiles.map((profile) => profile.id)).toEqual([profileA.id, profileB.id])
  })

  it('strips the default preset marker from trusted backup imports', () => {
    const profile = createDefaultOpenAIProfile({ id: 'backup-profile', isDefault: true })
    const merged = mergeImportedSettings(DEFAULT_SETTINGS, {
      ...DEFAULT_SETTINGS,
      profiles: [profile],
      activeProfileId: profile.id,
    }, { preserveInternalIds: true })

    expect(merged.profiles[0]).toMatchObject({ id: profile.id, isDefault: undefined })
  })

  it('preserves distinct provider and profile IDs with identical content', () => {
    const providerA = { id: 'provider-a', name: 'Same Provider', submit: { path: 'generate' } }
    const providerB = { id: 'provider-b', name: 'Same Provider', submit: { path: 'generate' } }
    const profileA = createDefaultOpenAIProfile({ id: 'profile-a', provider: providerA.id, apiKey: 'same-key' })
    const profileB = createDefaultOpenAIProfile({ id: 'profile-b', provider: providerB.id, apiKey: 'same-key' })
    const merged = mergeImportedSettings(DEFAULT_SETTINGS, {
      customProviders: [providerA, providerB],
      profiles: [profileA, profileB],
      activeProfileId: profileA.id,
    })

    expect(merged.customProviders.map((provider) => provider.id)).toEqual([providerA.id, providerB.id])
    expect(merged.profiles.map((profile) => profile.id)).toEqual([profileA.id, profileB.id])
    expect(merged.profiles.map((profile) => profile.provider)).toEqual([providerA.id, providerB.id])
  })
})

describe('mergePresetImportedSettings', () => {
  const createConfig = (model: string, path: string) => ({
    customProviders: [{
      id: 'source-provider',
      name: 'Deployed Provider',
      submit: { path },
    }],
    profiles: [{
      id: 'source-profile',
      name: 'Deployed Profile',
      provider: 'source-provider',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
      model,
      timeout: 300,
      apiMode: 'images' as const,
      codexCli: false,
      apiProxy: false,
    }],
  })

  it('applies each deployment change once and then keeps later local edits', () => {
    const initial = mergeDefaultImportedSettings(DEFAULT_SETTINGS, createConfig('model-v1', 'old/generate'))
    const previous = initial.settings
    previous.profiles[0].baseUrl = 'https://local.example.com/v1'
    previous.profiles[0].model = 'local-model'
    previous.profiles[0].timeout = 900
    const current = normalizeSettings({
      ...previous,
      profiles: [
        ...previous.profiles,
        createDefaultFalProfile({ id: 'user-profile', name: 'User Profile' }),
      ],
    })
    const nextConfig = createConfig('model-v2', 'v2/generate')
    nextConfig.profiles[0].baseUrl = 'https://new.example.com/v1'
    nextConfig.profiles[0].timeout = 600
    const result = mergeDefaultImportedSettings(current, nextConfig, { previousPresetConfig: initial.presetConfig })
    const merged = result.settings

    expect(merged.profiles[0]).toMatchObject({
      baseUrl: 'https://new.example.com/v1',
      model: 'model-v2',
      timeout: 600,
    })
    expect(merged.customProviders[0]).toMatchObject({ submit: { path: 'v2/generate' } })

    merged.profiles[0].baseUrl = 'https://later-local.example.com/v1'
    merged.profiles[0].model = 'later-local-model'
    merged.profiles[0].timeout = 1200
    merged.customProviders[0].submit.path = 'later-local/generate'
    const repeated = mergeDefaultImportedSettings(merged, nextConfig, { previousPresetConfig: result.presetConfig })
    const lastConfig = createConfig('model-v3', 'v2/generate')
    lastConfig.customProviders[0].name = 'Updated Provider'
    lastConfig.profiles[0].baseUrl = 'https://new.example.com/v1'
    lastConfig.profiles[0].timeout = 600
    const changedAgain = mergeDefaultImportedSettings(repeated.settings, lastConfig, { previousPresetConfig: repeated.presetConfig })

    expect(merged.activeProfileId).toBe('source-profile')
    expect(merged.profiles.map((profile) => profile.model)).toEqual(['later-local-model', DEFAULT_FAL_MODEL])
    expect(merged.profiles[0]).toMatchObject({
      id: 'source-profile',
      baseUrl: 'https://later-local.example.com/v1',
      timeout: 1200,
      isDefault: true,
    })
    expect(merged.customProviders).toHaveLength(1)
    expect(repeated.settings.profiles[0]).toMatchObject({
      baseUrl: 'https://later-local.example.com/v1',
      model: 'later-local-model',
      timeout: 1200,
    })
    expect(repeated.settings.customProviders[0]).toMatchObject({ id: 'source-provider', submit: { path: 'later-local/generate' } })
    expect(changedAgain.settings.profiles[0]).toMatchObject({
      baseUrl: 'https://later-local.example.com/v1',
      model: 'model-v3',
      timeout: 1200,
    })
    expect(changedAgain.settings.customProviders[0]).toMatchObject({
      name: 'Updated Provider',
      submit: { path: 'v2/generate' },
    })
  })

  it('updates matching preset parameters when parameters are locked', () => {
    const current = mergeDefaultImportedSettings(DEFAULT_SETTINGS, createConfig('model-v1', 'old/generate')).settings
    const merged = mergeDefaultImportedSettings(current, createConfig('model-v2', 'v2/generate'), {
      lockPresetParams: true,
    }).settings

    expect(merged.profiles[0]).toMatchObject({ id: 'source-profile', model: 'model-v2' })
    expect(merged.customProviders[0]).toMatchObject({ id: 'source-provider', submit: { path: 'v2/generate' } })
  })

  it('keeps the local API key while updating other locked preset parameters', () => {
    const initialConfig = createConfig('model-v1', 'old/generate')
    initialConfig.profiles[0].apiKey = 'deployed-key'
    const current = mergeDefaultImportedSettings(DEFAULT_SETTINGS, initialConfig, { lockPresetParams: true }).settings
    expect(current.profiles[0].apiKey).toBe('deployed-key')

    current.profiles[0].apiKey = 'user-key'
    const nextConfig = createConfig('model-v2', 'v2/generate')
    nextConfig.profiles[0].apiKey = 'new-deployed-key'
    const updated = mergeDefaultImportedSettings(current, nextConfig, { lockPresetParams: true }).settings
    nextConfig.profiles[0].apiKey = ''
    const cleared = mergeDefaultImportedSettings(updated, nextConfig, { lockPresetParams: true }).settings

    expect(updated.profiles[0]).toMatchObject({ apiKey: 'user-key', model: 'model-v2' })
    expect(cleared.profiles[0].apiKey).toBe('user-key')
  })

  it('preserves the saved profile order while updating locked presets by ID', () => {
    const previousConfig = {
      customProviders: [],
      profiles: [
        createDefaultOpenAIProfile({ id: 'preset-a', model: 'model-a', isDefault: true }),
        createDefaultOpenAIProfile({ id: 'preset-b', model: 'model-b' }),
      ],
    }
    const previous = mergeDefaultImportedSettings(DEFAULT_SETTINGS, previousConfig).settings
    const user = createDefaultFalProfile({ id: 'user-profile' })
    const current = normalizeSettings({
      ...previous,
      profiles: [previous.profiles[0], user, previous.profiles[1]],
    })
    const nextConfig = {
      customProviders: [],
      profiles: [
        createDefaultOpenAIProfile({ id: 'preset-b', model: 'model-b-v2' }),
        createDefaultOpenAIProfile({ id: 'preset-a', model: 'model-a-v2', isDefault: true }),
      ],
    }

    const merged = mergeDefaultImportedSettings(current, nextConfig, { lockPresetParams: true }).settings

    expect(merged.profiles.map((profile) => profile.id)).toEqual(['preset-a', 'user-profile', 'preset-b'])
    expect(merged.profiles.find((profile) => profile.id === 'preset-a')?.model).toBe('model-a-v2')
    expect(merged.profiles.find((profile) => profile.id === 'preset-b')?.model).toBe('model-b-v2')
  })

  it('keeps a user API key without duplicating an unchanged deployed config', () => {
    const config = createConfig('model-v1', 'old/generate')
    const current = mergeDefaultImportedSettings(DEFAULT_SETTINGS, config).settings
    current.profiles[0].apiKey = 'user-key'
    const result = mergeDefaultImportedSettings(current, createConfig('model-v1', 'old/generate'))

    expect(result.settings.profiles).toHaveLength(1)
    expect(result.settings.profiles[0].apiKey).toBe('user-key')
    expect(result.settings.customProviders).toHaveLength(1)
    expect(result.settings.profiles[0].id).toBe('source-profile')
  })

  it('keeps omitted profile fields when the deployed provider type is unchanged', () => {
    const previousConfig = importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [{ id: 'source-provider', name: 'Deployed Provider', submit: { path: 'generate' } }],
      profiles: [{
        id: 'source-profile',
        name: 'Deployed Profile',
        provider: 'source-provider',
        baseUrl: 'https://old.example.com/v1',
        apiKey: '',
        model: 'model-v1',
        timeout: 300,
        apiProxy: false,
      }],
    }), [], { deploymentConfig: true })
    const initial = mergeDefaultImportedSettings(DEFAULT_SETTINGS, previousConfig)
    const current = initial.settings
    current.profiles[0] = {
      ...current.profiles[0],
      name: '本地名称',
      baseUrl: 'https://local.example.com/v1',
      apiKey: 'user-key',
      timeout: 900,
      apiProxy: true,
    }
    const nextConfig = importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [{ id: 'source-provider', name: 'Renamed Provider', submit: { path: 'v2/generate' } }],
      profiles: [{
        id: 'source-profile',
        provider: 'source-provider',
        baseUrl: 'https://new.example.com/v1',
        model: 'model-v2',
      }],
    }), [], { deploymentConfig: true })

    const merged = mergeDefaultImportedSettings(current, nextConfig, {
      previousPresetConfig: initial.presetConfig,
    }).settings

    expect(merged.profiles[0]).toMatchObject({
      name: '本地名称',
      baseUrl: 'https://new.example.com/v1',
      apiKey: 'user-key',
      model: 'model-v2',
      timeout: 900,
      apiProxy: true,
    })
  })

  it('uses new provider defaults when a deployment changes the provider type', () => {
    const initialConfig = importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [{ id: 'source-provider', name: 'Provider', submit: { path: 'generate' } }],
      profiles: [{
        id: 'source-profile',
        provider: 'source-provider',
        baseUrl: 'https://custom.example.com/v1',
        model: 'custom-model',
      }],
    }), [], { deploymentConfig: true })
    const initial = mergeDefaultImportedSettings(DEFAULT_SETTINGS, initialConfig)
    const nextConfig = importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [],
      profiles: [{ id: 'source-profile', provider: 'fal' }],
    }), [], { deploymentConfig: true })

    const merged = mergeDefaultImportedSettings(initial.settings, nextConfig, {
      previousPresetConfig: initial.presetConfig,
    }).settings

    expect(merged.profiles[0]).toMatchObject({
      provider: 'fal',
      baseUrl: DEFAULT_FAL_BASE_URL,
      model: DEFAULT_FAL_MODEL,
    })
  })

  it('does not restore an explicitly empty API key while parameters are unlocked', () => {
    const previousConfig = importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [{ id: 'provider', name: 'Provider', submit: { path: 'generate' } }],
      profiles: [{ id: 'profile', provider: 'provider', apiKey: 'deployed-key', model: 'model-v1' }],
    }))
    const current = mergeDefaultImportedSettings(DEFAULT_SETTINGS, previousConfig).settings
    current.profiles[0].apiKey = 'user-key'
    const nextConfig = importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [{ id: 'provider', name: 'Provider', submit: { path: 'generate' } }],
      profiles: [{ id: 'profile', provider: 'provider', apiKey: '', model: 'model-v1' }],
    }))

    const merged = mergeDefaultImportedSettings(current, nextConfig).settings

    expect(merged.profiles[0].apiKey).toBe('user-key')
  })

  it('updates every deployed entry by ID regardless of array order', () => {
    const previousConfig = importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [
        { id: 'provider-a', name: 'Provider A', submit: { path: 'a' } },
        { id: 'provider-b', name: 'Provider B', submit: { path: 'b' } },
      ],
      profiles: [
        { id: 'profile-a', provider: 'provider-a', model: 'model-a', timeout: 111, isDefault: true },
        { id: 'profile-b', provider: 'provider-b', model: 'model-b', timeout: 222 },
      ],
    }))
    const current = mergeDefaultImportedSettings(DEFAULT_SETTINGS, previousConfig).settings
    const nextConfig = importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [
        { id: 'provider-b', name: 'Provider B2', submit: { path: 'b-v2' } },
        { id: 'provider-a', name: 'Provider A2', submit: { path: 'a-v2' } },
      ],
      profiles: [
        { id: 'profile-b', provider: 'provider-b', model: 'model-b-v2', timeout: 333, isDefault: true },
        { id: 'profile-a', provider: 'provider-a', model: 'model-a-v2', timeout: 444 },
      ],
    }))

    const merged = mergeDefaultImportedSettings(current, nextConfig, { lockPresetParams: true }).settings

    expect(merged.profiles.map((profile) => ({ id: profile.id, model: profile.model, timeout: profile.timeout }))).toEqual([
      { id: 'profile-a', model: 'model-a-v2', timeout: 444 },
      { id: 'profile-b', model: 'model-b-v2', timeout: 333 },
    ])
    expect(merged.customProviders.map((provider) => ({ id: provider.id, name: provider.name }))).toEqual([
      { id: 'provider-b', name: 'Provider B2' },
      { id: 'provider-a', name: 'Provider A2' },
    ])
  })

  it('treats changed IDs as removed and newly added entries', () => {
    const current = mergeDefaultImportedSettings(DEFAULT_SETTINGS, createConfig('model-v1', 'v1')).settings
    const merged = mergeDefaultImportedSettings(current, {
      customProviders: [{ id: 'provider-v2', name: 'Provider V2', submit: { path: 'v2' } }],
      profiles: [{ id: 'profile-v2', provider: 'provider-v2', model: 'model-v2' }],
    }).settings

    expect(merged.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'profile-v2' }),
      expect.objectContaining({ id: 'source-profile' }),
    ]))
    expect(merged.customProviders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'provider-v2' }),
      expect.objectContaining({ id: 'source-provider' }),
    ]))
  })

  it('generates profile IDs when creating settings from ordinary JSON', () => {
    const imported = importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [{ id: 'provider-a', name: 'Provider A', submit: { path: 'a' } }],
      profiles: [
        { provider: 'provider-a', model: 'model-a' },
        { provider: 'provider-a', model: 'model-b' },
      ],
    }))

    expect(imported.profiles.map((profile) => profile.id)).toEqual([
      expect.stringMatching(/^provider-a-imported-/),
      expect.stringMatching(/^provider-a-imported-/),
    ])
    expect(new Set(imported.profiles.map((profile) => profile.id)).size).toBe(2)
  })

  it('generates stable content-based IDs for ID-less preset profiles', () => {
    const config = {
      customProviders: [{ id: 'provider-a', name: 'Provider A', submit: { path: 'a' } }],
      profiles: [{ provider: 'provider-a', model: 'model-a' }],
    }
    const first = mergeDefaultImportedSettings(DEFAULT_SETTINGS, config).settings
    const second = mergeDefaultImportedSettings(first, config).settings
    const changed = mergeDefaultImportedSettings(second, {
      ...config,
      profiles: [{ provider: 'provider-a', model: 'model-b' }],
    }).settings

    expect(first.profiles[0].id).toMatch(/^provider-a-preset-/)
    expect(second.profiles).toHaveLength(1)
    expect(second.profiles[0].id).toBe(first.profiles[0].id)
    expect(changed.profiles).toHaveLength(2)
  })

  it('rejects duplicate profile IDs', () => {
    expect(() => importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [{ id: 'provider-a', name: 'Provider A', submit: { path: 'a' } }],
      profiles: [
        { id: 'profile-a', provider: 'provider-a', model: 'model-a' },
        { id: 'profile-a', provider: 'provider-a', model: 'model-b' },
      ],
    }))).toThrow('API 配置的 id「profile-a」重复')
  })

  it('rejects profiles that reference an unknown provider', () => {
    expect(() => importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [{ id: 'provider-a', name: 'Provider A', submit: { path: 'a' } }],
      profiles: [{ id: 'profile-a', provider: 'provider-missing', model: 'model-a' }],
    }))).toThrow('API 配置「profile-a」引用了不存在的自定义服务商')
  })

  it('rejects duplicate provider IDs before normalization', () => {
    expect(() => importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [
        { id: 'provider-a', name: 'Provider A', submit: { path: 'a' } },
        { id: 'provider-a', name: 'Provider B', submit: { path: 'b' } },
      ],
      profiles: [],
    }), [], { deploymentConfig: true })).toThrow('部署服务商「Provider B」的 id「provider-a」重复')
  })

  it('keeps the active user profile when updating the deployed config', () => {
    const previous = mergeDefaultImportedSettings(DEFAULT_SETTINGS, createConfig('model-v1', 'old/generate')).settings
    const userProfile = createDefaultFalProfile({ id: 'user-profile', name: 'User Profile' })
    const current = normalizeSettings({
      ...previous,
      profiles: [...previous.profiles, userProfile],
      activeProfileId: userProfile.id,
    })
    const merged = mergeDefaultImportedSettings(current, createConfig('model-v2', 'v2/generate')).settings

    expect(merged.activeProfileId).toBe(userProfile.id)
  })

  it('uses matching IDs without overwriting local parameters when unlocked', () => {
    const config = createConfig('model-v2', 'v2/generate')
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: config.customProviders,
      profiles: [{ ...config.profiles[0], apiKey: 'user-key' }],
      activeProfileId: config.profiles[0].id,
    })

    const merged = mergeDefaultImportedSettings(current, config).settings

    expect(merged.profiles[0].apiKey).toBe('user-key')
  })

  it('keeps removed preset entries and reuses the same IDs when they return', () => {
    const first = mergeDefaultImportedSettings(DEFAULT_SETTINGS, {
      customProviders: [
        { id: 'provider-a', name: 'Provider A', submit: { path: 'a' } },
        { id: 'provider-b', name: 'Provider B', submit: { path: 'b' } },
      ],
      profiles: [
        { id: 'profile-a', provider: 'provider-a', model: 'model-a', isDefault: true },
        { id: 'profile-b', provider: 'provider-b', model: 'model-b' },
      ],
    }).settings
    const removed = mergeDefaultImportedSettings(first, {
      customProviders: [{ id: 'provider-a', name: 'Provider A', submit: { path: 'a-v2' } }],
      profiles: [{ id: 'profile-a', provider: 'provider-a', model: 'model-a-v2' }],
    }).settings

    expect(removed.profiles[1]).toMatchObject({ id: 'profile-b', model: 'model-b' })
    expect(removed.customProviders[1]).toMatchObject({ id: 'provider-b', submit: { path: 'b' } })

    const restored = mergeDefaultImportedSettings(removed, {
      customProviders: [
        { id: 'provider-a', name: 'Provider A', submit: { path: 'a-v3' } },
        { id: 'provider-b', name: 'Provider B', submit: { path: 'b-v2' } },
      ],
      profiles: [
        { id: 'profile-a', provider: 'provider-a', model: 'model-a-v3', isDefault: true },
        { id: 'profile-b', provider: 'provider-b', model: 'model-b-v2' },
      ],
    }, { lockPresetParams: true }).settings

    expect(restored.profiles[1]).toMatchObject({ id: 'profile-b', model: 'model-b-v2' })
    expect(restored.customProviders[1]).toMatchObject({ id: 'provider-b', submit: { path: 'b-v2' } })
  })

  it('removes an unchanged deployed preset without history when it disappears from deployment', () => {
    const previousConfig = {
      customProviders: [
        { id: 'provider-a', name: 'Provider A', submit: { path: 'a' } },
        { id: 'provider-b', name: 'Provider B', submit: { path: 'b' } },
      ],
      profiles: [
        createDefaultOpenAIProfile({ id: 'profile-a', provider: 'provider-a', isDefault: true }),
        createDefaultOpenAIProfile({ id: 'profile-b', provider: 'provider-b' }),
      ],
    }
    const initial = mergeDefaultImportedSettings(DEFAULT_SETTINGS, previousConfig)
    const current = initial.settings
    const previousPresetConfig = initial.presetConfig
    const nextConfig = {
      customProviders: [previousConfig.customProviders[0]],
      profiles: [previousConfig.profiles[0]],
    }

    const removed = mergeDefaultImportedSettings(current, nextConfig, {
      previousPresetConfig,
    }).settings
    const retainedForHistory = mergeDefaultImportedSettings(current, nextConfig, {
      previousPresetConfig,
      usedPresetProfileIds: ['profile-b'],
    })
    const removedAfterHistoryCleared = mergeDefaultImportedSettings(retainedForHistory.settings, nextConfig, {
      previousPresetConfig: retainedForHistory.presetConfig,
    }).settings
    const modified = mergeDefaultImportedSettings(normalizeSettings({
      ...current,
      profiles: current.profiles.map((profile) => profile.id === 'profile-b' ? { ...profile, model: 'user-model' } : profile),
    }), nextConfig, {
      previousPresetConfig,
    }).settings
    const modifiedProvider = mergeDefaultImportedSettings(normalizeSettings({
      ...current,
      customProviders: current.customProviders.map((provider) =>
        provider.id === 'provider-b' ? { ...provider, submit: { ...provider.submit, path: 'user-b' } } : provider,
      ),
    }), nextConfig, {
      previousPresetConfig,
    }).settings

    expect(removed.profiles.map((profile) => profile.id)).toEqual(['profile-a'])
    expect(removed.customProviders.map((provider) => provider.id)).toEqual(['provider-a'])
    expect(retainedForHistory.settings.profiles.map((profile) => profile.id)).toEqual(['profile-a', 'profile-b'])
    expect(retainedForHistory.settings.customProviders.map((provider) => provider.id)).toEqual(['provider-a', 'provider-b'])
    expect(removedAfterHistoryCleared.profiles.map((profile) => profile.id)).toEqual(['profile-a'])
    expect(removedAfterHistoryCleared.customProviders.map((provider) => provider.id)).toEqual(['provider-a'])
    expect(modified.profiles[1]).toMatchObject({ id: 'profile-b', model: 'user-model' })
    expect(modified.customProviders.map((provider) => provider.id)).toEqual(['provider-a', 'provider-b'])
    expect(modifiedProvider.profiles.map((profile) => profile.id)).toEqual(['profile-a', 'profile-b'])
    expect(modifiedProvider.customProviders[1]).toMatchObject({ id: 'provider-b', submit: { path: 'user-b' } })
  })

  it('removes an untouched unlocked preset after applying a deployment update', () => {
    const initialConfig = {
      customProviders: [
        { id: 'provider-a', name: 'Provider A', submit: { path: 'a-v1' } },
        { id: 'provider-b', name: 'Provider B', submit: { path: 'b-v1' } },
      ],
      profiles: [
        createDefaultOpenAIProfile({ id: 'profile-a', provider: 'provider-a', isDefault: true }),
        createDefaultOpenAIProfile({ id: 'profile-b', provider: 'provider-b', model: 'model-v1' }),
      ],
    }
    const initial = mergeDefaultImportedSettings(DEFAULT_SETTINGS, initialConfig)
    const updatedConfig = {
      customProviders: [
        initialConfig.customProviders[0],
        { ...initialConfig.customProviders[1], submit: { path: 'b-v2' } },
      ],
      profiles: [
        initialConfig.profiles[0],
        { ...initialConfig.profiles[1], model: 'model-v2' },
      ],
    }
    const updated = mergeDefaultImportedSettings(initial.settings, updatedConfig, {
      previousPresetConfig: initial.presetConfig,
    })
    const removed = mergeDefaultImportedSettings(updated.settings, {
      customProviders: [updatedConfig.customProviders[0]],
      profiles: [updatedConfig.profiles[0]],
    }, {
      previousPresetConfig: updated.presetConfig,
    }).settings

    expect(updated.settings.profiles[1].model).toBe('model-v2')
    expect(updated.settings.customProviders[1].submit.path).toBe('b-v2')
    expect(removed.profiles.map((profile) => profile.id)).toEqual(['profile-a'])
    expect(removed.customProviders.map((provider) => provider.id)).toEqual(['provider-a'])
  })

  it('does not import preset profiles dismissed by the user', () => {
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [createDefaultFalProfile({ id: 'user-profile' })],
      activeProfileId: 'user-profile',
    })
    const merged = mergeDefaultImportedSettings(current, {
      customProviders: [],
      profiles: [createDefaultOpenAIProfile({ id: 'preset-a', isDefault: true })],
    }, { dismissedPresetProfileIds: ['preset-a'] }).settings

    expect(merged.profiles.map((profile) => profile.id)).toEqual(['user-profile'])
    expect(merged.activeProfileId).toBe('user-profile')
  })

  it('keeps a dismissed preset provider deleted while preset parameters are unlocked', () => {
    const config = createConfig('preset-model', 'generate')
    const current = mergeDefaultImportedSettings(DEFAULT_SETTINGS, config).settings
    const switched = switchApiProfileProvider(current.profiles[0], 'openai')
    const deleted = normalizeSettings({
      ...current,
      customProviders: [],
      profiles: [{ ...switched, model: 'local-openai-model' }],
    })

    const merged = mergeDefaultImportedSettings(deleted, config, {
      dismissedPresetProviderIds: ['source-provider'],
    }).settings

    expect(merged.customProviders).toEqual([])
    expect(merged.profiles[0]).toMatchObject({
      id: 'source-profile',
      provider: 'openai',
      model: 'local-openai-model',
    })
  })

  it('respects a filtered preset provider dismissal when locking is enabled', () => {
    const config = createConfig('preset-model', 'generate')
    const current = mergeDefaultImportedSettings(DEFAULT_SETTINGS, config).settings
    const user = createDefaultFalProfile({ id: 'user-profile' })
    const deleted = normalizeSettings({
      ...current,
      customProviders: [],
      profiles: [user],
      activeProfileId: user.id,
    })

    const merged = mergeDefaultImportedSettings(deleted, config, {
      lockPresetParams: true,
      dismissedPresetProfileIds: ['source-profile'],
      dismissedPresetProviderIds: ['source-provider'],
    }).settings

    expect(merged.customProviders).toEqual([])
    expect(merged.profiles).toEqual([user])
  })

  it('requires exactly one default when deploying multiple profiles', () => {
    const providers = [
      { id: 'provider-a', name: 'Provider A', submit: { path: 'a' } },
      { id: 'provider-b', name: 'Provider B', submit: { path: 'b' } },
    ]

    expect(() => mergeDefaultImportedSettings(DEFAULT_SETTINGS, {
      customProviders: providers,
      profiles: [
        { id: 'profile-a', provider: 'provider-a', isDefault: false },
        { id: 'profile-b', provider: 'provider-b', isDefault: false },
      ],
    })).toThrow('部署文件包含多个 API 配置时，必须且只能有一项设置 isDefault: true')

    expect(() => mergeDefaultImportedSettings(DEFAULT_SETTINGS, {
      customProviders: providers,
      profiles: [
        { id: 'profile-a', provider: 'provider-a', isDefault: true },
        { id: 'profile-b', provider: 'provider-b', isDefault: true },
      ],
    })).toThrow('部署文件包含多个 API 配置时，必须且只能有一项设置 isDefault: true')
  })

  it('uses isDefault instead of array position for multiple deployed profiles', () => {
    const merged = mergeDefaultImportedSettings(DEFAULT_SETTINGS, {
      customProviders: [
        { id: 'provider-a', name: 'Provider A', submit: { path: 'a' } },
        { id: 'provider-b', name: 'Provider B', submit: { path: 'b' } },
      ],
      profiles: [
        { id: 'profile-a', provider: 'provider-a' },
        { id: 'profile-b', provider: 'provider-b', isDefault: true },
      ],
    }).settings

    expect(merged.profiles.map((profile) => ({ id: profile.id, isDefault: profile.isDefault }))).toEqual([
      { id: 'profile-a', isDefault: undefined },
      { id: 'profile-b', isDefault: true },
    ])
  })

  it('keeps legacy fixed slots without matching them by array position', () => {
    const legacyProvider = { id: 'deployed-default-provider-0', name: 'Legacy Provider', submit: { path: 'old' } }
    const legacyProfile = createDefaultOpenAIProfile({
      id: 'deployed-default-profile-0',
      provider: legacyProvider.id,
      model: 'legacy-model',
    })
    const current = normalizeSettings({ ...DEFAULT_SETTINGS, customProviders: [legacyProvider], profiles: [legacyProfile] })
    const merged = mergeDefaultImportedSettings(current, createConfig('model-v2', 'v2')).settings

    expect(merged.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'source-profile', model: 'model-v2' }),
      expect.objectContaining({ id: legacyProfile.id, model: 'legacy-model' }),
    ]))
    expect(merged.customProviders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'source-provider' }),
      expect.objectContaining({ id: legacyProvider.id }),
    ]))
  })

  it('keeps every existing profile when the new preset list is empty', () => {
    const current = mergeDefaultImportedSettings(DEFAULT_SETTINGS, createConfig('model-v1', 'generate')).settings
    const merged = mergeDefaultImportedSettings(current, {
      customProviders: current.customProviders.map((provider) => ({ ...provider, submit: { path: 'v2/generate' } })),
      profiles: [],
    }).settings

    expect(merged.profiles).toHaveLength(1)
    expect(merged.profiles[0]).toMatchObject({ id: 'source-profile', isDefault: undefined })
  })
})

describe('default API profile marker', () => {
  it('only recognizes the explicit default preset marker', () => {
    expect(getDefaultApiProfileId(normalizeSettings({ profiles: [{ id: DEFAULT_OPENAI_PROFILE_ID }] }))).toBeNull()
    expect(getDefaultApiProfileId({ profiles: [
      { id: DEFAULT_OPENAI_PROFILE_ID },
      { id: 'deployment-profile', isDefault: true },
    ] })).toBe('deployment-profile')
    expect(getDefaultApiProfileId(normalizeSettings({ profiles: [{ id: 'deployed-default-profile-0' }] }))).toBeNull()
    expect(getDefaultApiProfileId({ profiles: [{ id: 'deployed-default-profile-0-previous-1' }] })).toBeNull()
  })

  it('preserves profile order when marking the deployment default', () => {
    const userProfile = createDefaultFalProfile({ id: 'user-profile' })
    const builtIn = createDefaultOpenAIProfile()
    const deployed = createDefaultOpenAIProfile({ id: 'deployment-profile', isDefault: true })

    expect(normalizeSettings({ profiles: [userProfile, builtIn] }).profiles.map((profile) => profile.id)).toEqual([
      userProfile.id,
      DEFAULT_OPENAI_PROFILE_ID,
    ])
    expect(normalizeSettings({ profiles: [builtIn, userProfile, deployed] }).profiles.map((profile) => profile.id)).toEqual([
      builtIn.id,
      userProfile.id,
      deployed.id,
    ])
    expect(normalizeSettings({ profiles: [builtIn, userProfile, deployed] }).profiles[2].isDefault).toBe(true)
  })
})

describe('custom providers', () => {
  it('provides the built-in sub2api async manifest', () => {
    const settings = normalizeSettings({
      profiles: [{
        ...createDefaultOpenAIProfile(),
        provider: 'sb2api-async',
        baseUrl: 'https://sub2api.example.com/v1',
        apiProxy: true,
      }],
    })
    const provider = getCustomProviderDefinition(settings, 'sb2api-async')

    expect(settings.profiles[0]).toMatchObject({
      provider: 'sb2api-async',
      apiMode: 'images',
      apiProxy: false,
      streamImages: false,
    })
    expect(provider).toMatchObject({
      id: 'sb2api-async',
      name: 'sub2api（异步）',
      submit: {
        path: 'images/generations/async',
        body: { background: '$params.background' },
        taskIdPath: 'task_id',
      },
      editSubmit: {
        path: 'images/edits/async',
        body: { background: '$params.background' },
        taskIdPath: 'task_id',
      },
      poll: {
        path: 'images/tasks/{task_id}',
        intervalSeconds: 3,
        statusPath: 'status',
        successValues: ['completed'],
        failureValues: ['failed'],
        errorPath: 'error.message',
        result: { imageUrlPaths: ['result.data.*.url'] },
      },
    })
    expect(getApiProviderLabel(settings, 'sb2api-async')).toBe('sub2api（异步）')
  })

  it('includes native transparent backgrounds in the default custom provider templates', () => {
    const provider = JSON.parse(DEFAULT_CUSTOM_PROVIDER_JSON)

    expect(provider.submit.body.background).toBe('$params.background')
    expect(provider.editSubmit.body.background).toBe('$params.background')
    expect(CUSTOM_PROVIDER_LLM_PROMPT).toContain('$params.background')
  })

  it('defaults custom profiles based on their native transparent background mapping', () => {
    const settings = normalizeSettings({
      customProviders: [
        { id: 'custom-local', name: 'Custom Local', submit: { path: 'generate', body: { prompt: '$prompt' } } },
        { id: 'custom-native', name: 'Custom Native', submit: { path: 'generate', body: { background: '$params.background' } } },
        {
          id: 'custom-partial',
          name: 'Custom Partial',
          submit: { path: 'generate', body: { background: '$params.background' } },
          editSubmit: { path: 'edit', body: { prompt: '$prompt' } },
        },
      ],
      profiles: [
        { ...createDefaultOpenAIProfile({ id: 'local-profile' }), provider: 'custom-local', transparentBackgroundMethod: 'api' },
        { ...createDefaultOpenAIProfile({ id: 'native-profile' }), provider: 'custom-native', transparentBackgroundMethod: undefined },
        { ...createDefaultOpenAIProfile({ id: 'partial-profile' }), provider: 'custom-partial', transparentBackgroundMethod: undefined },
        {
          ...createDefaultOpenAIProfile({ id: 'draft-profile' }),
          providerDrafts: {
            'custom-local': { transparentBackgroundMethod: 'api' },
            'custom-native': {},
          },
        },
      ],
    })

    expect(settings.profiles.find((profile) => profile.id === 'local-profile')?.transparentBackgroundMethod).toBe('local')
    expect(settings.profiles.find((profile) => profile.id === 'native-profile')?.transparentBackgroundMethod).toBe('api')
    expect(settings.profiles.find((profile) => profile.id === 'partial-profile')?.transparentBackgroundMethod).toBe('local')
    expect(settings.profiles.find((profile) => profile.id === 'draft-profile')?.providerDrafts?.['custom-local']?.transparentBackgroundMethod).toBe('local')
    expect(settings.profiles.find((profile) => profile.id === 'draft-profile')?.providerDrafts?.['custom-native']?.transparentBackgroundMethod).toBe('api')
  })

  it('normalizes custom provider definitions and keeps custom profiles', () => {
    const settings = normalizeSettings({
      customProviders: [{
        id: 'custom-async',
        name: 'Custom Async',
        template: 'openai-compatible-async',
        generationPath: '/v1/images/generations',
        editPath: '/v1/images/edits',
        taskPath: '/v1/images/tasks/{task_id}',
      }],
      profiles: [{
        id: 'profile-custom',
        name: 'Custom Profile',
        provider: 'custom-async',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'key',
        model: 'model',
        timeout: 60,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
      activeProfileId: 'profile-custom',
    })

    expect(settings.customProviders[0]).toMatchObject({
      id: 'custom-async',
      template: 'http-image',
      submit: {
        path: 'images/generations',
        query: { async: 'true' },
        taskIdPath: 'data',
      },
      editSubmit: {
        path: 'images/edits',
        query: { async: 'true' },
        taskIdPath: 'data',
      },
      poll: {
        path: 'images/tasks/{task_id}',
      },
    })
    expect(settings.profiles[0].provider).toBe('custom-async')
  })

  it('normalizes an Apimart-style task manifest', () => {
    const provider = importCustomProviderDefinitionFromJson(JSON.stringify({
      name: 'Apimart GPT-Image-2',
      template: 'http-image',
      submit: {
        path: '/v1/images/generations',
        method: 'POST',
        contentType: 'json',
        body: {
          model: '$profile.model',
          prompt: '$prompt',
          n: '$params.n',
          size: '$params.size',
          resolution: '2k',
          image_urls: '$inputImages.dataUrls',
        },
        taskIdPath: 'data.0.task_id',
      },
      poll: {
        path: '/v1/tasks/{task_id}',
        method: 'GET',
        query: { language: 'zh' },
        statusPath: 'data.status',
        successValues: ['completed'],
        failureValues: ['failed', 'cancelled'],
        result: {
          imageUrlPaths: ['data.result.images.*.url.*'],
        },
      },
    }))

    expect(provider).toMatchObject({
      template: 'http-image',
      submit: {
        path: 'images/generations',
        taskIdPath: 'data.0.task_id',
      },
      poll: {
        path: 'tasks/{task_id}',
        query: { language: 'zh' },
        successValues: ['completed'],
        result: {
          imageUrlPaths: ['data.result.images.*.url.*'],
        },
      },
    })
  })

  it('imports wrapped custom provider settings with profiles', () => {
    const imported = importCustomProviderSettingsFromJson(JSON.stringify({
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
        name: 'Custom JSON',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        model: 'custom-model',
        apiMode: 'images',
      }],
    }))

    expect(imported.customProviders[0]).toMatchObject({ id: 'custom-json', name: 'Custom JSON' })
    expect(imported.profiles[0]).toMatchObject({
      name: 'Custom JSON',
      provider: 'custom-json',
      baseUrl: 'https://custom.example.com/v1',
      apiKey: '',
      model: 'custom-model',
      apiMode: 'images',
    })
  })

  it('imports wrapped custom provider settings from a json code block', () => {
    const imported = importCustomProviderSettingsFromJson(`\`\`\`json
{"customProviders":[{"id":"custom-json","name":"Custom JSON","submit":{"path":"images/generations","method":"POST","contentType":"json","body":{"model":"$profile.model","prompt":"$prompt"},"result":{"imageUrlPaths":["data.result.images.*.url.*"],"b64JsonPaths":[]}}}],"profiles":[{"name":"Custom JSON","provider":"custom-json","baseUrl":"https://custom.example.com/v1","model":"custom-model","apiMode":"images"}]}
\`\`\``)

    expect(imported.customProviders[0]).toMatchObject({ id: 'custom-json' })
    expect(imported.customProviders[0].submit.result).toMatchObject({
      imageUrlPaths: ['data.result.images.*.url.*'],
    })
    expect(imported.profiles[0]).toMatchObject({
      provider: 'custom-json',
      baseUrl: 'https://custom.example.com/v1',
    })
  })

  it('rejects markdown-corrupted profile fields when importing wrapped settings', () => {
    expect(() => importCustomProviderSettingsFromJson(JSON.stringify({
      customProviders: [{
        id: 'custom-apimart',
        name: 'APIMart',
        submit: { path: 'images/generations' },
      }],
      profiles: [{
        name: 'APIMart',
        provider: 'custom-apimart',
        baseUrl: '[https://api.apimart.ai/v1',
        model: 'gpt-image-2-official',
        apiMode: 'images](https://api.apimart.ai/v1%22,%22model%22:%22gpt-image-2-official%22,%22apiMode%22:%22images)',
      }],
    }))).toThrow('JSON 包含 Markdown 链接')
  })

  it('does not inherit fal URL and model when switching to a custom provider', () => {
    const provider = importCustomProviderDefinitionFromJson(JSON.stringify({
      name: 'Custom Provider',
      template: 'http-image',
      submit: { path: 'images/generations' },
    }))
    const profile = switchApiProfileProvider(createDefaultFalProfile(), provider.id, provider)

    expect(profile.provider).toBe(provider.id)
    expect(profile.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
    expect(profile.model).toBe(DEFAULT_IMAGES_MODEL)
    expect(profile.transparentBackgroundMethod).toBe('api')
  })

  it('rejects task mappings without poll configuration', () => {
    expect(() => importCustomProviderDefinitionFromJson(JSON.stringify({
      name: 'Invalid Async',
      submit: {
        path: 'images/generations',
        taskIdPath: 'task_id',
      },
    }))).toThrow('配置了 taskIdPath，但缺少 poll')
  })

  it('restores custom provider draft settings', () => {
    const provider = importCustomProviderDefinitionFromJson(JSON.stringify({
      name: 'Custom Provider',
      submit: { path: 'images/generations' },
    }))
    const customProfile = switchApiProfileProvider(createDefaultOpenAIProfile(), provider.id, provider)
    const openAIProfile = switchApiProfileProvider({ ...customProfile, codexCli: true, transparentBackgroundMethod: 'local' }, 'openai')
    const restoredProfile = switchApiProfileProvider(openAIProfile, provider.id, provider)

    expect(restoredProfile.codexCli).toBe(true)
    expect(restoredProfile.transparentBackgroundMethod).toBe('local')
    expect(openAIProfile.transparentBackgroundMethod).toBe('api')
  })

  it('uses API-mode specific streaming defaults and preserves partial image count', () => {
    expect(createDefaultOpenAIProfile().streamImages).toBe(false)
    expect(createDefaultOpenAIProfile({ apiMode: 'responses' }).streamImages).toBe(true)
    expect(createDefaultOpenAIProfile().streamPartialImages).toBe(1)
    expect(DEFAULT_SETTINGS.streamImages).toBe(false)
    expect(DEFAULT_SETTINGS.streamPartialImages).toBe(1)
    expect(DEFAULT_SETTINGS.profiles[0].streamImages).toBe(false)
    expect(DEFAULT_SETTINGS.profiles[0].streamPartialImages).toBe(1)
    expect(normalizeSettings({ apiMode: 'responses' }).streamImages).toBe(true)

    const normalized = normalizeSettings({
      profiles: [
        createDefaultOpenAIProfile({ streamImages: false, streamPartialImages: 3 }),
      ],
    })

    expect(normalized.streamImages).toBe(false)
    expect(normalized.streamPartialImages).toBe(3)
    expect(normalized.profiles[0].streamImages).toBe(false)
    expect(normalized.profiles[0].streamPartialImages).toBe(3)

    const clamped = normalizeSettings({
      profiles: [
        createDefaultOpenAIProfile({ streamPartialImages: 8 }),
      ],
    })

    expect(clamped.profiles[0].streamPartialImages).toBe(3)
  })

  it('normalizes supported reasoning efforts and ignores invalid values', () => {
    const supported = normalizeSettings({
      profiles: [createDefaultOpenAIProfile({ apiMode: 'responses', reasoningEffort: 'max' })],
    })
    const invalid = normalizeSettings({
      profiles: [{ ...createDefaultOpenAIProfile({ apiMode: 'responses' }), reasoningEffort: 'extreme' }],
    })

    expect(supported.profiles[0].reasoningEffort).toBe('max')
    expect(invalid.profiles[0].reasoningEffort).toBeUndefined()
  })

  it('normalizes custom providers to Images API mode', () => {
    const settings = normalizeSettings({
      customProviders: [{ id: 'custom-json', name: 'Custom JSON', submit: { path: 'images/generations' } }],
      profiles: [{
        id: 'custom-profile',
        name: 'Custom Profile',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'custom-key',
        model: 'custom-model',
        apiMode: 'responses',
        streamImages: true,
      }],
    })

    expect(settings.profiles[0]).toMatchObject({
      provider: 'custom-json',
      apiMode: 'images',
      streamImages: false,
    })
  })

  it('keeps provider order usable when custom providers are added after manual sorting', () => {
    const settings = normalizeSettings({
      providerOrder: ['fal', 'openai'],
      customProviders: [
        { id: 'custom-alpha', name: '示例服务商 A', submit: { path: 'images/generations' } },
        { id: 'custom-beta', name: '示例服务商 B', submit: { path: 'images/generations' } },
      ],
    })

    expect(settings.providerOrder).toEqual(['fal', 'openai', 'sb2api-async', 'custom-alpha', 'custom-beta'])
  })

  it('keeps active custom providers in Images API mode when legacy apiMode is responses', () => {
    const settings = normalizeSettings({
      apiMode: 'responses',
      customProviders: [{ id: 'custom-json', name: 'Custom JSON', submit: { path: 'images/generations' } }],
      activeProfileId: 'custom-profile',
      profiles: [{
        id: 'custom-profile',
        name: 'Custom Profile',
        provider: 'custom-json',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'custom-key',
        model: 'custom-model',
      }],
    })

    const activeProfile = getActiveApiProfile({ ...settings, apiMode: 'responses', streamImages: true })
    expect(activeProfile.apiMode).toBe('images')
    expect(activeProfile.streamImages).toBe(false)
  })

  it('keeps non-OpenAI providers in Images API mode when switching providers', () => {
    const provider = { id: 'custom-json', name: 'Custom JSON', submit: { path: 'images/generations' } }
    const openaiProfile = createDefaultOpenAIProfile({ apiMode: 'responses', streamImages: true })

    const falProfile = switchApiProfileProvider(openaiProfile, 'fal')
    const customProfile = switchApiProfileProvider(openaiProfile, provider.id, provider)

    expect(falProfile).toMatchObject({ provider: 'fal', apiMode: 'images', streamImages: false, transparentBackgroundMethod: 'local' })
    expect(customProfile).toMatchObject({ provider: provider.id, apiMode: 'images', streamImages: false })
  })

  it('keeps an explicitly empty fal.ai URL', () => {
    const profile = normalizeSettings({
      profiles: [createDefaultFalProfile({ id: 'fal-empty', baseUrl: '' })],
    }).profiles[0]

    expect(profile.baseUrl).toBe('')
  })

  it('enables Agent submit auto scroll by default', () => {
    expect(DEFAULT_SETTINGS.agentScrollToBottomAfterSubmit).toBe(true)
    expect(normalizeSettings({}).agentScrollToBottomAfterSubmit).toBe(true)
    expect(normalizeSettings({ agentScrollToBottomAfterSubmit: false }).agentScrollToBottomAfterSubmit).toBe(false)
  })

  it('enables Agent math formatting prompt by default', () => {
    expect(DEFAULT_SETTINGS.agentMathFormattingPrompt).toBe(true)
    expect(normalizeSettings({}).agentMathFormattingPrompt).toBe(true)
    expect(normalizeSettings({ agentMathFormattingPrompt: false }).agentMathFormattingPrompt).toBe(false)
  })

  it('disables prompt rewrite allowance by default', () => {
    expect(DEFAULT_SETTINGS.allowPromptRewrite).toBe(false)
    expect(normalizeSettings({}).allowPromptRewrite).toBe(false)
    expect(normalizeSettings({ allowPromptRewrite: true }).allowPromptRewrite).toBe(true)
  })

  it('restores OpenAI-compatible URL after switching through fal.ai', () => {
    const openaiProfile = createDefaultOpenAIProfile({
      baseUrl: 'https://api.compat.example.com/v1',
      model: 'custom-openai-model',
      apiProxy: false,
    })

    const falProfile = switchApiProfileProvider(openaiProfile, 'fal')
    const restoredProfile = switchApiProfileProvider(falProfile, 'openai')

    expect(falProfile.baseUrl).toBe(DEFAULT_FAL_BASE_URL)
    expect(restoredProfile.baseUrl).toBe('https://api.compat.example.com/v1')
    expect(restoredProfile.model).toBe('custom-openai-model')
    expect(restoredProfile.apiProxy).toBe(false)
  })
})
