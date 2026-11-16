import { describe, expect, it } from 'vitest'
import { calculateImageSize, getActualRatioAndResolution, normalizeCodexCliImageSize, prependCodexCliSizePrompt, stripInjectedCodexCliSizePrompt } from './size'

describe('calculateImageSize', () => {
  it('uses common 16:9 display resolutions for the built-in tiers', () => {
    expect(calculateImageSize('1K', '16:9')).toBe('1280x720')
    expect(calculateImageSize('2K', '16:9')).toBe('2560x1440')
    expect(calculateImageSize('4K', '16:9')).toBe('3840x2160')
  })

  it('uses matching portrait presets for common ratios', () => {
    expect(calculateImageSize('2K', '9:16')).toBe('1440x2560')
    expect(calculateImageSize('2K', '2:3')).toBe('1440x2160')
    expect(calculateImageSize('2K', '3:4')).toBe('1536x2048')
  })

  it('falls back to budget-based sizing for custom ratios', () => {
    expect(calculateImageSize('2K', '5:4')).toBe('2288x1824')
  })
})

describe('Codex CLI size compatibility', () => {
  it('normalizes custom sizes to the 1K pixel budget', () => {
    expect(normalizeCodexCliImageSize('2048x2048')).toBe('1024x1024')
    expect(normalizeCodexCliImageSize('2048x1536')).toBe('1024x768')
    expect(normalizeCodexCliImageSize('1536x1024')).toBe('1536x1024')
  })

  it('preserves non-preset ratios approximately and clamps excessive ratios', () => {
    expect(normalizeCodexCliImageSize('2500x2000')).toBe(calculateImageSize('1K', '5:4'))
    const [width, height] = normalizeCodexCliImageSize('4000x1000').split('x').map(Number)
    expect(width / height).toBeCloseTo(3, 2)
    expect(width * height).toBeLessThanOrEqual(1_572_864)
  })

  it('prepends a concise resolution hint only for explicit sizes', () => {
    expect(prependCodexCliSizePrompt('Draw a cat.\n', '1024x1024')).toBe('Generate at 1024x1024 resolution. Draw a cat.\n')
    expect(prependCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', '1024x1024')).toBe('Generate at 1024x1024 resolution. Draw a cat.')
    expect(prependCodexCliSizePrompt('Draw a cat.', 'auto')).toBe('Draw a cat.')
  })

  it('strips only the matching injected resolution hint', () => {
    expect(stripInjectedCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', 'Draw a cat.', '1024x1024')).toBe('Draw a cat.')
    expect(stripInjectedCodexCliSizePrompt('Generate at 2048x2048 resolution. Draw a cat.', 'Draw a cat.', '1024x1024')).toBe('Generate at 2048x2048 resolution. Draw a cat.')
    expect(stripInjectedCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', 'Generate at 1024x1024 resolution. Draw a cat.', '1024x1024')).toBe('Generate at 1024x1024 resolution. Draw a cat.')
    expect(stripInjectedCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', 'Draw a cat.', 'auto')).toBe('Generate at 1024x1024 resolution. Draw a cat.')
  })
})

describe('getActualRatioAndResolution', () => {
  it('reports the ratio and tier a model actually returned', () => {
    // Seedream 5.0 把 1K 请求提升到 2K，自动比例实际出图为 4:3
    expect(getActualRatioAndResolution('2304x1728', { aspect_ratio: 'auto', resolution: '1K' })).toEqual({ aspect_ratio: '4:3', resolution: '2K' })
    expect(getActualRatioAndResolution('5504x3072', { aspect_ratio: '16:9', resolution: '2K' })).toEqual({ aspect_ratio: '16:9', resolution: '4K' })
  })

  it('keeps requested values within rounding differences', () => {
    expect(getActualRatioAndResolution('1184x864', { aspect_ratio: '4:3', resolution: '1K' })).toEqual({ aspect_ratio: '4:3', resolution: '1K' })
    expect(getActualRatioAndResolution('2730x1536', { aspect_ratio: '16:9', resolution: '2K' })).toEqual({ aspect_ratio: '16:9', resolution: '2K' })
    expect(getActualRatioAndResolution('1773x1330', { aspect_ratio: '4:3', resolution: '1.5K' })).toEqual({ aspect_ratio: '4:3', resolution: '1.5K' })
    expect(getActualRatioAndResolution('2048x2048', { aspect_ratio: '1:1', resolution: '2k' })).toEqual({ aspect_ratio: '1:1', resolution: '2k' })
  })

  it('names exact ratios with the labels offered in settings', () => {
    expect(getActualRatioAndResolution('2048x1024', { aspect_ratio: 'auto' }).aspect_ratio).toBe('2:1')
    expect(getActualRatioAndResolution('1280x1024', { aspect_ratio: '16:9' }).aspect_ratio).toBe('5:4')
    expect(getActualRatioAndResolution('768x1664', { aspect_ratio: 'auto' }).aspect_ratio).toBe('9:19.5')
  })

  it('returns nothing without a measurable size', () => {
    expect(getActualRatioAndResolution(undefined, { resolution: '1K' })).toEqual({})
    expect(getActualRatioAndResolution('2k', { resolution: '1K' })).toEqual({})
    expect(getActualRatioAndResolution('0x1024', {})).toEqual({})
    expect(getActualRatioAndResolution('9999999999999999999999x1024', {})).toEqual({})
  })

  it('同一像素尺寸的档位不随请求档位改变', () => {
    for (const resolution of ['1K', '1.5K', '2K', '4K']) {
      expect(getActualRatioAndResolution('1770x1770', { resolution }).resolution).toBe('1.5K')
      expect(getActualRatioAndResolution('2496x1664', { resolution }).resolution).toBe('2K')
    }
  })
})
