import { describe, expect, it } from 'vitest'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, importCustomProviderSettingsFromJson, normalizeSettings } from './apiProfiles'
import { createCustomProfileImportUrl } from './profileImportUrl'
import { buildSettingsFromUrlParams } from './urlSettings'
import { describeImportLink } from './importLink'

describe('createCustomProfileImportUrl', () => {
  it.each([undefined, [], [{ id: 'custom-provider' }]])('缺少有效服务商定义的无 ID 链接不覆盖已有自定义配置：%j', (customProviders) => {
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

  it('无 ID 配置不占用同一载荷中显式指定的配置 ID', () => {
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

  it.each([false, true])('相同分享链接复用已有配置并保留默认标记，自定义服务商：%s', (custom) => {
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
    const params = new URL(createCustomProfileImportUrl('https://example.com', profile, current.customProviders[0], {
      includeApiKey: true, useNewApiAddress: false, useNewApiKey: false, useNewApiModel: false,
    })).searchParams
    expect(describeImportLink(params, current).hasConfigChanges).toBe(false)
    const next = normalizeSettings({ ...current, ...buildSettingsFromUrlParams(current, params) })
    expect(next.profiles).toEqual(current.profiles)
    expect(next.activeProfileId).toBe('saved')
    expect(describeImportLink(params, next).hasConfigChanges).toBe(false)
    expect(buildSettingsFromUrlParams(next, params).profiles).toEqual(current.profiles)
  })

  it.each([{ timeout: 42 }, { apiKey: 'different' }, { apiProxy: true }, { description: 'different' }])('配置字段不同时仍创建新配置：%j', (patch) => {
    const profile = createDefaultOpenAIProfile({ id: 'saved', apiKey: 'key' })
    const current = normalizeSettings({ profiles: [profile] })
    const params = new URL(createCustomProfileImportUrl('https://example.com', { ...profile, ...patch }, undefined, {
      includeApiKey: true, useNewApiAddress: false, useNewApiKey: false, useNewApiModel: false,
    })).searchParams
    expect(describeImportLink(params, current).hasConfigChanges).toBe(true)
    expect(buildSettingsFromUrlParams(current, params).profiles).toHaveLength(2)
  })

  it('omits unused providers from built-in profile links and imports them normally', () => {
    const profile = createDefaultOpenAIProfile({ id: 'built-in', apiKey: 'key' })
    const url = new URL(createCustomProfileImportUrl('https://playground.example.com', profile, undefined, {
      includeApiKey: true, useNewApiAddress: false, useNewApiKey: false, useNewApiModel: false,
    }))
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
      { includeApiKey: true, useNewApiAddress: false, useNewApiKey: false, useNewApiModel: false },
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
