import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { AGNES_IMAGE_SIZES, AGNES_SIZE_TIERS, getAgnesImageSize, normalizeAgnesImageSize } from './agnes'
import { createDefaultAgnesProfile, DEFAULT_SETTINGS, normalizeApiProfile, normalizeSettings } from './apiProfiles'
import { normalizeParamsForSettings } from './paramCompatibility'

describe('Agnes sizes and defaults', () => {
  it('keeps every documented native size unchanged', () => {
    for (const [ratio, base] of Object.entries(AGNES_IMAGE_SIZES)) {
      for (const [idx, tier] of AGNES_SIZE_TIERS.entries()) {
        const size = `${base[0] * (idx + 1)}x${base[1] * (idx + 1)}`
        expect(getAgnesImageSize(size)).toEqual({ size: tier, ratio })
        expect(normalizeAgnesImageSize(size)).toBe(size)
      }
    }
  })

  it('maps auto and common display resolutions to supported tiers and ratios', () => {
    expect(getAgnesImageSize('auto')).toEqual({ size: '1K', ratio: '1:1' })
    expect(getAgnesImageSize('1920x1080')).toEqual({ size: '2K', ratio: '16:9' })
    expect(getAgnesImageSize('2560x1440')).toEqual({ size: '2K', ratio: '16:9' })
    expect(getAgnesImageSize('4K')).toEqual({ size: '4K', ratio: '1:1' })
  })

  it('preserves 4K sizes beyond OpenAI limits and clears unsupported controls', () => {
    const profile = createDefaultAgnesProfile()
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '5248x2944', quality: 'high', output_format: 'jpeg', output_compression: 80, moderation: 'low' }, settings)).toMatchObject({
      size: '5248x2944', quality: 'auto', output_format: 'png', output_compression: null, moderation: 'auto',
    })
    expect(normalizeApiProfile({ provider: 'agnes' })).toMatchObject({ provider: 'agnes', model: 'agnes-image-2.5-flash', baseUrl: 'https://apihub.agnes-ai.com/v1', transparentBackgroundMethod: 'local' })
  })
})
