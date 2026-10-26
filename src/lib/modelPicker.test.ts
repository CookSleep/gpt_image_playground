import { describe, expect, it } from 'vitest'
import { createDefaultAgnesProfile, createDefaultGrokProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, getActiveApiProfile, getAgentImageApiProfile, normalizeSettings } from './apiProfiles'
import { getModelPickerOptions, getModelPickerSettingsPatch } from './modelPicker'

describe('cross-channel model picker', () => {
  const active = createDefaultOpenAIProfile({ id: 'openai', model: 'shared-model, model-b', apiKey: 'openai-key' })
  const grok = createDefaultGrokProfile({ id: 'grok', name: 'Grok channel', model: 'shared-model', apiKey: 'grok-key', showInModelPicker: true })
  const agnes = createDefaultAgnesProfile({ id: 'agnes', apiKey: 'agnes-key' })
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [active, grok, agnes], activeProfileId: active.id })

  it('includes the current and opted-in profiles, distinguishing identical models', () => {
    const options = getModelPickerOptions(settings, active, 'gallery')
    expect(options.map((option) => option.profileId)).toEqual(['openai', 'openai', 'grok'])
    expect(new Set(options.map((option) => option.value)).size).toBe(3)
    expect(options[2].label).toBe('Grok channel · shared-model')
  })

  it('switches credentials and endpoint along with the model', () => {
    const updated = normalizeSettings({ ...settings, ...getModelPickerSettingsPatch(settings, grok.id, 'shared-model', 'gallery') })
    expect(getActiveApiProfile(updated)).toMatchObject({ id: grok.id, apiKey: 'grok-key', baseUrl: grok.baseUrl, model: 'shared-model' })
    expect(updated.profiles[0].model).toBe('shared-model, model-b')
  })

  it('switches only the hybrid Agent image profile', () => {
    const hybrid = normalizeSettings({ ...settings, agentApiConfigMode: 'hybrid', agentImageProfileId: grok.id })
    const updated = normalizeSettings({ ...hybrid, ...getModelPickerSettingsPatch(hybrid, agnes.id, agnes.model, 'agent') })
    expect(updated.activeProfileId).toBe(active.id)
    expect(getAgentImageApiProfile(updated)?.id).toBe(agnes.id)
  })

  it('does not offer image-only profiles to the native Agent', () => {
    const native = normalizeSettings({ ...settings, agentApiConfigMode: 'native' })
    expect(getModelPickerOptions(native, active, 'agent').map((option) => option.profileId)).toEqual(['openai', 'openai'])
  })

  it('keeps older profiles opted out and remembers explicit preferences', () => {
    expect(settings.profiles.find((profile) => profile.id === agnes.id)?.showInModelPicker).toBe(false)
    expect(normalizeSettings(JSON.parse(JSON.stringify(settings))).profiles.find((profile) => profile.id === grok.id)?.showInModelPicker).toBe(true)
  })
})
