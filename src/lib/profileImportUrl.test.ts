import { describe, expect, it } from 'vitest'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { createCustomProfileImportUrl } from './profileImportUrl'
import { buildSettingsFromUrlParams } from './urlSettings'

describe('createCustomProfileImportUrl', () => {
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
