import { describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, importCustomProviderSettingsFromJson, normalizeSettings } from './apiProfiles'
import { createCustomProfileImportUrl, createOpenAIProfileImportUrl } from './profileImportUrl'
import { buildSettingsFromUrlParams } from './urlSettings'
import { describeImportLink } from './importLink'

const SHARE_OPTIONS = { includeApiKey: true, useNewApiAddress: false, useNewApiKey: false, useNewApiModel: false }

describe('createCustomProfileImportUrl', () => {
  it.each([undefined, [], [{ id: 'custom-provider' }]])('keeps the saved custom profile when an ID-less link lacks a valid provider: %j', (customProviders) => {
    const current = normalizeSettings({
      customProviders: [{ id: 'custom-provider', name: 'Custom', submit: { path: 'generate' } }],
      profiles: [createDefaultOpenAIProfile({ id: 'saved', provider: 'custom-provider', apiKey: 'key' })],
    })
    const params = new URLSearchParams({ settings: JSON.stringify({
      customProviders,
      profiles: [{ ...current.profiles[0], id: undefined }],
    }) })
    const next = normalizeSettings({ ...current, ...buildSettingsFromUrlParams(current, params) })
    expect(next.profiles.find((profile) => profile.id === 'saved')).toEqual(current.profiles[0])
    expect(next.customProviders).toEqual(current.customProviders)
    expect(next.profiles).toHaveLength(2)
    expect(next.activeProfileId).not.toBe('saved')
    expect(next.profiles.find((profile) => profile.id === next.activeProfileId)?.provider).toBe('openai')
    expect(describeImportLink(params, current).hasConfigChanges).toBe(true)
    expect(describeImportLink(params, next).hasConfigChanges).toBe(false)
  })

  it('does not give ID-less profiles an ID set explicitly in the same payload', () => {
    const profile = createDefaultOpenAIProfile({ id: 'saved', apiKey: 'key' })
    const current = normalizeSettings({ profiles: [profile] })
    const params = new URLSearchParams({ settings: JSON.stringify({ profiles: [
      { ...profile, id: undefined },
      { ...profile, timeout: 42 },
    ] }) })
    const next = normalizeSettings({ ...current, ...buildSettingsFromUrlParams(current, params) })
    expect(next.profiles).toHaveLength(2)
    expect(next.profiles.find((item) => item.id === 'saved')?.timeout).toBe(42)
    expect(next.activeProfileId).not.toBe('saved')
    expect(next.profiles.find((item) => item.id === next.activeProfileId)?.timeout).toBe(profile.timeout)
  })

  it.each([false, true])('reuses an identical saved profile and keeps its default flag (custom provider: %s)', (custom) => {
    const provider = custom ? { id: 'custom-provider', name: 'Custom', submit: { path: 'generate' } } : undefined
    const current = normalizeSettings({
      customProviders: provider ? [provider] : [],
      profiles: [
        createDefaultOpenAIProfile({ id: 'other', apiKey: 'other-key' }),
        createDefaultOpenAIProfile({ id: 'saved', provider: provider?.id ?? 'openai', apiKey: 'key', isDefault: true }),
      ],
      activeProfileId: 'other',
    })
    const profile = current.profiles[1]
    const params = new URL(createCustomProfileImportUrl('https://example.com', profile, current.customProviders[0], SHARE_OPTIONS)).searchParams
    expect(describeImportLink(params, current).hasConfigChanges).toBe(false)
    const next = normalizeSettings({ ...current, ...buildSettingsFromUrlParams(current, params) })
    expect(next.profiles).toEqual(current.profiles)
    expect(next.activeProfileId).toBe('saved')
    expect(describeImportLink(params, next).hasConfigChanges).toBe(false)
    expect(buildSettingsFromUrlParams(next, params).profiles).toEqual(current.profiles)
  })

  it.each([{ timeout: 42 }, { apiKey: 'different' }, { apiProxy: true }, { description: 'different' }])('creates a new profile when fields differ: %j', (patch) => {
    const profile = createDefaultOpenAIProfile({ id: 'saved', apiKey: 'key' })
    const current = normalizeSettings({ profiles: [profile] })
    const params = new URL(createCustomProfileImportUrl('https://example.com', { ...profile, ...patch }, undefined, SHARE_OPTIONS)).searchParams
    expect(describeImportLink(params, current).hasConfigChanges).toBe(true)
    expect(buildSettingsFromUrlParams(current, params).profiles).toHaveLength(2)
  })

  it('omits unused providers from built-in profile links and imports them normally', () => {
    const profile = createDefaultOpenAIProfile({ id: 'built-in', apiKey: 'key' })
    const url = new URL(createCustomProfileImportUrl('https://playground.example.com', profile, undefined, SHARE_OPTIONS))
    const json = url.searchParams.get('settings')!
    expect(JSON.parse(json)).not.toHaveProperty('customProviders')
    expect(importCustomProviderSettingsFromJson(json).profiles).toHaveLength(1)
    expect(buildSettingsFromUrlParams(DEFAULT_SETTINGS, url.searchParams).profiles).toHaveLength(1)

    const legacy = JSON.stringify({ customProviders: [], profiles: JSON.parse(json).profiles })
    expect(importCustomProviderSettingsFromJson(legacy).profiles).toHaveLength(1)
    expect(buildSettingsFromUrlParams(DEFAULT_SETTINGS, new URLSearchParams({ settings: legacy })).profiles).toHaveLength(1)
  })

  it('does not include the source profile ID in the shared URL', () => {
    const provider = { id: 'custom-provider', name: 'Custom Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({
      id: 'custom-profile',
      provider: provider.id,
      apiKey: 'secret-key',
      model: 'custom-model',
    })

    const result = createCustomProfileImportUrl(
      'https://playground.example.com/app?old=value#section',
      profile,
      provider,
      { includeApiKey: false, useNewApiAddress: false, useNewApiKey: true, useNewApiModel: false },
    )
    const url = new URL(result.replace('{key}', '%7Bkey%7D'))
    const settings = JSON.parse(url.searchParams.get('settings')!)

    expect(url.origin + url.pathname).toBe('https://playground.example.com/app')
    expect(url.hash).toBe('')
    expect(url.searchParams.has('profileId')).toBe(false)
    expect(settings.customProviders).toEqual([provider])
    expect(settings.profiles).toEqual([expect.objectContaining({
      provider: provider.id,
      apiKey: '{key}',
      model: 'custom-model',
    })])
    expect(settings.profiles[0]).not.toHaveProperty('id')
  })

  it('imports the shared custom profile without converting it to OpenAI', () => {
    const provider = { id: 'custom-provider', name: 'Custom Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({
      id: 'custom-profile',
      provider: provider.id,
      apiKey: 'secret-key',
      model: 'custom-model',
    })
    const url = new URL(createCustomProfileImportUrl(
      'https://playground.example.com',
      profile,
      provider,
      SHARE_OPTIONS,
    ))
    const next = normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...buildSettingsFromUrlParams(DEFAULT_SETTINGS, url.searchParams),
    })

    expect(next.activeProfileId).not.toBe(profile.id)
    expect(next.customProviders).toEqual([expect.objectContaining({
      id: provider.id,
      submit: expect.objectContaining({ path: 'generate' }),
    })])
    expect(next.profiles[0]).toMatchObject({
      provider: provider.id,
      apiKey: 'secret-key',
      model: 'custom-model',
    })
  })
})

describe('OpenAI share defaults', () => {
  it('explicitly restores defaults and disabled values in an existing profile', () => {
    const source = createDefaultOpenAIProfile({ apiMode: 'responses', streamImages: false, imageGenerationModel: '' })
    const params = new URL(createOpenAIProfileImportUrl('https://example.com', source, SHARE_OPTIONS)).searchParams
    for (const key of ['reasoningEffort', 'svgModel', 'svgReasoningEffort', 'responseFormatB64Json', 'imageGenerationModel']) expect(params.get(key)).toBe('')
    expect(params.get('codexCli')).toBe('false')
    expect(params.get('streamImages')).toBe('false')
    expect(params.has('apiProxy')).toBe(false)
    const current = normalizeSettings({ profiles: [createDefaultOpenAIProfile({
      id: 'target', apiMode: 'responses', reasoningEffort: 'high', svgModel: 'author', svgReasoningEffort: 'high', responseFormatB64Json: true,
      codexCli: true, streamImages: true, streamPartialImages: 3, transparentBackgroundMethod: 'local',
    })] })
    params.set('profileId', 'target')
    const next = normalizeSettings(buildSettingsFromUrlParams(current, params)).profiles[0]
    for (const key of ['reasoningEffort', 'svgModel', 'svgReasoningEffort', 'responseFormatB64Json', 'codexCli', 'streamImages', 'streamPartialImages', 'transparentBackgroundMethod', 'imageGenerationModel'] as const) expect(next[key]).toEqual(source[key])
    const omitted = normalizeSettings(buildSettingsFromUrlParams(current, new URLSearchParams('profileId=target&timeout=120'))).profiles[0]
    expect(omitted).toMatchObject({ reasoningEffort: 'high', svgModel: 'author', svgReasoningEffort: 'high', responseFormatB64Json: true, codexCli: true })
  })

  it('does not inherit deployment defaults when the shared values are explicitly empty', async () => {
    const source = createDefaultOpenAIProfile({ apiMode: 'responses', imageGenerationModel: '', streamImages: false })
    const params = new URL(createOpenAIProfileImportUrl('https://example.com', source, SHARE_OPTIONS)).searchParams
    vi.resetModules()
    vi.stubEnv('VITE_DEFAULT_API_URL', 'https://api.example.com?reasoningEffort=high&svgModel=author&svgReasoningEffort=high&responseFormatB64Json=true&codexCli=true&streamImages=true&streamPartialImages=3&transparentBackgroundMethod=local')
    try {
      const api = await import('./apiProfiles')
      const urls = await import('./urlSettings')
      const result = api.normalizeSettings(urls.buildSettingsFromUrlParams(api.DEFAULT_SETTINGS, params))
      const next = result.profiles.find((p) => p.id === result.activeProfileId)!
      expect(next).toMatchObject({ reasoningEffort: undefined, svgModel: undefined, svgReasoningEffort: undefined, responseFormatB64Json: undefined, codexCli: false, streamImages: false, transparentBackgroundMethod: 'api' })
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
