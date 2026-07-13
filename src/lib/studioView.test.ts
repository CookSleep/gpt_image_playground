import { describe, expect, it } from 'vitest'
import { buildGenerationNotice, cycleIndex, parseStudioDraft, parseStudioLocation, resolveTheme, sanitizeThemePreference, serializeStudioDraft, serializeStudioLocation, wheelCarouselDirection, withSingleRetry, carouselPosition } from './studioView'

describe('studio view state', () => {
  it('falls back to system when stored preference is invalid', () => {
    expect(sanitizeThemePreference('sepia')).toBe('system')
  })

  it('resolves system preference from the current color scheme', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
  })

  it('cycles gallery indexes in both directions', () => {
    expect(cycleIndex(0, -1, 4)).toBe(3)
    expect(cycleIndex(3, 1, 4)).toBe(0)
    expect(cycleIndex(2, 1, 0)).toBe(0)
  })

  it('round trips the locally persisted creation draft', () => {
    const draft = { prompt: '蓝色玻璃建筑', size: '1024x1536', quality: 'high', format: 'png', imageCount: 2 }
    expect(parseStudioDraft(serializeStudioDraft(draft))).toEqual(draft)
    expect(parseStudioDraft(JSON.stringify({ ...draft, selectedApiKeyId: 'legacy-key' }))).toEqual(draft)
    expect(parseStudioDraft('{bad json')).toBeNull()
  })

  it('assigns stable carousel positions around the current item', () => {
    expect([0, 1, 2, 3].map((index) => carouselPosition(index, 1, 4))).toEqual(['previous', 'current', 'next', 'hidden'])
    expect([0, 1, 2].map((index) => carouselPosition(index, 0, 3))).toEqual(['current', 'next', 'previous'])
  })

  it('retries a failed initial request once', async () => {
    let attempts = 0
    await expect(withSingleRetry(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary')
      return 'loaded'
    })).resolves.toBe('loaded')
    expect(attempts).toBe(2)
  })

  it('only switches carousel images for intentional horizontal wheel gestures', () => {
    expect(wheelCarouselDirection(0, 120)).toBe(0)
    expect(wheelCarouselDirection(80, 12)).toBe(1)
    expect(wheelCarouselDirection(-80, 12)).toBe(-1)
    expect(wheelCarouselDirection(10, 4)).toBe(0)
  })

  it('restores view state from the URL without persisting generation data', () => {
    expect(parseStudioLocation('?view=workspace&filter=error&generation=15')).toEqual({ view: 'workspace', filter: 'error', generationId: '15' })
    expect(parseStudioLocation('?view=unknown&filter=missing&generation=')).toEqual({ view: 'gallery', filter: 'all', generationId: '' })
    expect(serializeStudioLocation({ view: 'assets', filter: 'done', generationId: '15' })).toBe('?view=assets&filter=done&generation=15')
  })

  it('builds explicit feedback for generation lifecycle states', () => {
    expect(buildGenerationNotice('running', '机械猫')).toContain('任务已创建')
    expect(buildGenerationNotice('done', '机械猫')).toContain('生成完成')
    expect(buildGenerationNotice('error', '机械猫')).toContain('生成失败')
  })
})
