import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('preset config policy', () => {
  it('exposes every current preset profile in preset-only mode', async () => {
    vi.stubEnv('VITE_SHOW_PRESET_CONFIG_ONLY', 'true')
    const { createDefaultFalProfile, createDefaultOpenAIProfile } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    policy.setPresetConfig({
      customProviders: [],
      profiles: [
        createDefaultOpenAIProfile({ id: 'preset-a', isDefault: true }),
        createDefaultFalProfile({ id: 'preset-b' }),
      ],
    })

    expect(policy.isPresetConfigOnlyEnabled()).toBe(true)
    expect(policy.getPresetProfileIds()).toEqual(new Set(['preset-a', 'preset-b']))
    expect(policy.getDefaultPresetProfileId()).toBe('preset-a')
  })

  it('exposes an optional Markdown description for preset profiles', async () => {
    const { createDefaultOpenAIProfile } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    policy.setPresetConfig({
      customProviders: [],
      profiles: [createDefaultOpenAIProfile({ id: 'preset-a', description: '使用 [说明](https://example.com)' })],
    })

    expect(policy.getPresetProfileDescription('preset-a')).toBe('使用 [说明](https://example.com)')
    expect(policy.getPresetProfileDescription('missing')).toBeUndefined()
  })

  it('accepts the legacy preset-only environment variable', async () => {
    vi.stubEnv('VITE_SHOW_DEFAULT_CONFIG_ONLY', 'true')
    const { createDefaultOpenAIProfile } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    policy.setPresetConfig({ customProviders: [], profiles: [createDefaultOpenAIProfile()] })

    expect(policy.isPresetConfigOnlyEnabled()).toBe(true)
  })

  it('locks preset parameters and providers except API keys without preventing profile deletion', async () => {
    vi.stubEnv('VITE_LOCK_PRESET_CONFIG_PARAMS', 'true')
    const { createDefaultFalProfile, createDefaultOpenAIProfile, normalizeSettings } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    const source = createDefaultOpenAIProfile({
      id: 'preset-a',
      isDefault: true,
      provider: 'preset-provider',
      baseUrl: 'https://preset.example.com/v1',
      apiKey: 'deployed-key',
      model: 'preset-model',
    })
    const user = createDefaultFalProfile({ id: 'user-profile', model: 'user-model' })
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const removed = createDefaultOpenAIProfile({ id: 'preset-removed', provider: provider.id })
    policy.setPresetConfig({ customProviders: [provider], profiles: [source, removed] })

    const enforced = policy.enforcePresetConfigPolicy(normalizeSettings({
      customProviders: [{ ...provider, submit: { path: 'local/generate' } }],
      profiles: [{ ...source, baseUrl: 'https://local.example.com/v1', apiKey: 'user-key', model: 'local-model' }, user],
      activeProfileId: user.id,
    }))

    expect(enforced.profiles[0]).toMatchObject({
      id: source.id,
      baseUrl: 'https://preset.example.com/v1',
      apiKey: 'user-key',
      model: 'preset-model',
    })
    expect(enforced.profiles[1]).toMatchObject({ id: user.id, model: 'user-model' })
    expect(enforced.profiles.some((profile) => profile.id === removed.id)).toBe(false)
    expect(enforced.customProviders[0]).toEqual(provider)
    expect(enforced.activeProfileId).toBe(user.id)
    expect(policy.isPresetConfigDeletionPrevented()).toBe(false)
    expect(policy.isPresetProviderLocked(provider.id)).toBe(true)
    expect(policy.isPresetProviderDeletionPrevented(provider.id, enforced.profiles)).toBe(true)
    expect(policy.isPresetProviderDeletionPrevented('user-provider', enforced.profiles)).toBe(false)
  })

  it('allows removed presets to stay deleted by default', async () => {
    const { createDefaultFalProfile, createDefaultOpenAIProfile, normalizeSettings } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    const presetA = createDefaultOpenAIProfile({ id: 'preset-a', isDefault: true })
    const presetB = createDefaultFalProfile({ id: 'preset-b' })
    const user = createDefaultOpenAIProfile({ id: 'user-profile' })
    policy.setPresetConfig({ customProviders: [], profiles: [presetA, presetB] })

    const enforced = policy.enforcePresetConfigPolicy(normalizeSettings({
      profiles: [presetA, user],
      activeProfileId: user.id,
    }))

    expect(policy.isPresetProfile(presetA.id)).toBe(true)
    expect(policy.isPresetProfile(presetB.id)).toBe(true)
    expect(enforced.profiles.map((profile) => profile.id)).toEqual(['preset-a', 'user-profile'])
  })

  it('preserves the user order when the default preset is not first', async () => {
    const { createDefaultFalProfile, createDefaultOpenAIProfile, normalizeSettings } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    const presetA = createDefaultOpenAIProfile({ id: 'preset-a', isDefault: true })
    const presetB = createDefaultFalProfile({ id: 'preset-b' })
    const user = createDefaultOpenAIProfile({ id: 'user-profile' })
    policy.setPresetConfig({ customProviders: [], profiles: [presetA, presetB] })

    const enforced = policy.enforcePresetConfigPolicy(normalizeSettings({
      profiles: [presetB, user, presetA],
      activeProfileId: user.id,
    }))

    expect(enforced.profiles.map((profile) => profile.id)).toEqual(['preset-b', 'user-profile', 'preset-a'])
    expect(enforced.profiles[2].isDefault).toBe(true)
  })

  it('restores removed presets when deletion is prevented', async () => {
    vi.stubEnv('VITE_PREVENT_PRESET_CONFIG_DELETION', 'true')
    const { createDefaultFalProfile, createDefaultOpenAIProfile, normalizeSettings } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const presetA = createDefaultOpenAIProfile({ id: 'preset-a', isDefault: true })
    const presetB = createDefaultFalProfile({ id: 'preset-b' })
    const user = createDefaultOpenAIProfile({ id: 'user-profile' })
    policy.setPresetConfig({ customProviders: [provider], profiles: [presetA, presetB] })

    const enforced = policy.enforcePresetConfigPolicy(normalizeSettings({
      customProviders: [{ ...provider, submit: { path: 'local/generate' } }],
      profiles: [presetA, user],
      activeProfileId: user.id,
    }))

    expect(policy.isPresetConfigDeletionPrevented()).toBe(true)
    expect(policy.isPresetConfigParamsLocked()).toBe(false)
    expect(policy.isPresetProviderLocked(provider.id)).toBe(false)
    expect(policy.isPresetProviderDeletionPrevented(provider.id, enforced.profiles)).toBe(true)
    expect(enforced.customProviders[0].submit.path).toBe('local/generate')
    expect(enforced.profiles.map((profile) => profile.id)).toEqual(['preset-a', 'user-profile', 'preset-b'])
  })

  it('preserves dismissed provider IDs while deletion is prevented', async () => {
    vi.stubEnv('VITE_PREVENT_PRESET_CONFIG_DELETION', 'true')
    const { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    const { useStore } = await import('../store')
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'preset-profile', provider: provider.id })
    const preset = { customProviders: [provider], profiles: [profile] }
    policy.setPresetConfig(preset)
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, customProviders: [], profiles: [] }),
      dismissedPresetProviderIds: [provider.id],
    })

    await useStore.getState().setPresetImportedSettings(preset)
    useStore.getState().setSettings({ profiles: [profile] })

    const state = useStore.getState()
    expect(state.settings.customProviders).toEqual([expect.objectContaining({ id: provider.id })])
    expect(state.dismissedPresetProviderIds).toEqual([provider.id])
  })

  it('always prevents preset provider deletion in preset-only mode', async () => {
    vi.stubEnv('VITE_SHOW_PRESET_CONFIG_ONLY', 'true')
    const { createDefaultOpenAIProfile } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'preset-profile', provider: 'openai' })
    policy.setPresetConfig({ customProviders: [provider], profiles: [profile] })

    expect(policy.isPresetProviderDeletionPrevented(provider.id, [])).toBe(true)
  })

  it('locks preset parameters without restoring their deployment order', async () => {
    vi.stubEnv('VITE_LOCK_PRESET_CONFIG_PARAMS', 'true')
    const { createDefaultFalProfile, createDefaultOpenAIProfile, normalizeSettings } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    const presetA = createDefaultOpenAIProfile({ id: 'preset-a', isDefault: true, model: 'preset-a-model' })
    const presetB = createDefaultFalProfile({ id: 'preset-b', model: 'preset-b-model' })
    const user = createDefaultOpenAIProfile({ id: 'user-profile' })
    policy.setPresetConfig({ customProviders: [], profiles: [presetA, presetB] })

    const enforced = policy.enforcePresetConfigPolicy(normalizeSettings({
      profiles: [presetA, user, { ...presetB, model: 'local-model' }],
      activeProfileId: user.id,
    }))

    expect(enforced.profiles.map((profile) => profile.id)).toEqual(['preset-a', 'user-profile', 'preset-b'])
    expect(enforced.profiles[2].model).toBe('preset-b-model')
  })

  it('restores a dismissed provider while a current locked preset profile references it', async () => {
    vi.stubEnv('VITE_LOCK_PRESET_CONFIG_PARAMS', 'true')
    const { createDefaultOpenAIProfile, normalizeSettings } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const source = createDefaultOpenAIProfile({
      id: 'preset-profile',
      provider: provider.id,
      model: 'preset-model',
    })
    policy.setPresetConfig({ customProviders: [provider], profiles: [source] })
    const deleted = normalizeSettings({
      customProviders: [],
      profiles: [{ ...source, provider: 'openai', model: 'local-openai-model' }],
    })

    expect(policy.isPresetProviderDeletionPrevented(provider.id, [source])).toBe(true)

    const enforced = policy.enforcePresetConfigPolicy(deleted, { dismissedPresetProviderIds: [] })

    expect(enforced.customProviders).toEqual([provider])
    expect(enforced.profiles[0]).toMatchObject({
      id: source.id,
      provider: provider.id,
      model: 'preset-model',
    })
  })

  it('allows a dismissed provider to stay deleted after its only preset profile is deleted', async () => {
    vi.stubEnv('VITE_LOCK_PRESET_CONFIG_PARAMS', 'true')
    const { createDefaultFalProfile, createDefaultOpenAIProfile } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const source = createDefaultOpenAIProfile({ id: 'preset-profile', provider: provider.id })
    const user = createDefaultFalProfile({ id: 'user-profile' })
    policy.setPresetConfig({ customProviders: [provider], profiles: [source] })

    expect(policy.isPresetProviderDeletionPrevented(provider.id, [])).toBe(false)

    const merged = (await import('./apiProfiles')).mergePresetImportedSettings({
      customProviders: [],
      profiles: [user],
      activeProfileId: user.id,
    }, { customProviders: [provider], profiles: [source] }, {
      lockPresetParams: true,
      dismissedPresetProfileIds: [source.id],
      dismissedPresetProviderIds: [provider.id],
    }).settings
    const reloaded = policy.enforcePresetConfigPolicy(merged, {
      dismissedPresetProviderIds: [provider.id],
    })

    expect(reloaded.customProviders).toEqual([])
    expect(reloaded.profiles.map((profile) => profile.id)).toEqual([user.id])
  })

  it('keeps a shared provider protected while another current locked preset profile references it', async () => {
    vi.stubEnv('VITE_LOCK_PRESET_CONFIG_PARAMS', 'true')
    const { createDefaultOpenAIProfile } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profiles = [
      createDefaultOpenAIProfile({ id: 'preset-a', provider: provider.id, isDefault: true }),
      createDefaultOpenAIProfile({ id: 'preset-b', provider: provider.id }),
    ]
    policy.setPresetConfig({ customProviders: [provider], profiles })

    expect(policy.isPresetProviderDeletionPrevented(provider.id, [profiles[1]])).toBe(true)
  })

  it('uses the default OpenAI-compatible preset URL but not the fal.ai URL as the empty-field fallback', async () => {
    const { createDefaultFalProfile, createDefaultOpenAIProfile } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    policy.setPresetConfig({
      customProviders: [],
      profiles: [createDefaultOpenAIProfile({ id: 'openai-preset', baseUrl: 'https://preset.example.com/v1' })],
    })
    expect(policy.getDefaultPresetBaseUrl()).toBe('https://preset.example.com/v1')

    policy.setPresetConfig({
      customProviders: [],
      profiles: [createDefaultFalProfile({ id: 'fal-preset', baseUrl: 'https://fal-proxy.example.com' })],
    })
    expect(policy.getDefaultPresetBaseUrl()).toBe('')
  })
})
