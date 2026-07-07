import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import {
  ATLAS_CLOUD_BASE_URL,
  ATLAS_CLOUD_DEFAULT_IMAGE_SIZE,
  ATLAS_CLOUD_DEFAULT_QUALITY,
  ATLAS_CLOUD_IMAGE_MODEL,
  ATLAS_CLOUD_PROVIDER_ID,
  createDefaultFalProfile,
  createDefaultOpenAIProfile,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from './apiProfiles'
import { getOutputImageLimitForSettings, normalizeParamsForSettings } from './paramCompatibility'

describe('parameter compatibility', () => {
  it('limits OpenAI output count to 10', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: false })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(getOutputImageLimitForSettings(settings)).toBe(10)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 12 }, settings).n).toBe(10)
  })

  it('limits fal.ai output count to 4', () => {
    const falProfile = createDefaultFalProfile({ apiKey: 'fal-key' })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [falProfile],
      activeProfileId: falProfile.id,
    })

    expect(getOutputImageLimitForSettings(settings)).toBe(4)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 8 }, settings).n).toBe(4)
  })

  it('keeps OpenAI streaming output count so the request can disable streaming', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 4 }, settings).n).toBe(4)
  })

  it('only replaces fal.ai auto size in text-to-image mode', () => {
    const falProfile = createDefaultFalProfile({ apiKey: 'fal-key' })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [falProfile],
      activeProfileId: falProfile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings).size).toBe('1360x1024')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings, { hasInputImages: true }).size).toBe('auto')
  })

  it('normalizes Atlas Cloud params to the supported image schema', () => {
    const atlasCloudProfile = createDefaultOpenAIProfile({
      id: 'atlascloud-profile',
      provider: ATLAS_CLOUD_PROVIDER_ID,
      baseUrl: ATLAS_CLOUD_BASE_URL,
      apiKey: 'atlas-key',
      model: ATLAS_CLOUD_IMAGE_MODEL,
    })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: [{ id: ATLAS_CLOUD_PROVIDER_ID, name: 'Atlas Cloud', submit: { path: 'model/generateImage' } }],
      profiles: [atlasCloudProfile],
      activeProfileId: atlasCloudProfile.id,
    })

    expect(getOutputImageLimitForSettings(settings)).toBe(1)
    expect(normalizeParamsForSettings({
      ...DEFAULT_PARAMS,
      n: 3,
      size: 'auto',
      quality: 'auto',
      output_format: 'webp',
      moderation: 'auto',
      output_compression: 80,
    }, settings)).toMatchObject({
      n: 1,
      size: ATLAS_CLOUD_DEFAULT_IMAGE_SIZE,
      quality: ATLAS_CLOUD_DEFAULT_QUALITY,
      output_format: 'png',
      moderation: 'low',
      output_compression: null,
    })
  })
})
