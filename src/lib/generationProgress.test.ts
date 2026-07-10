import { describe, expect, it } from 'vitest'

import { formatRunDuration, getGenerationProgress } from './generationProgress'

describe('generation progress copy', () => {
  it('formats running duration as a compact timer', () => {
    expect(formatRunDuration(18_400)).toBe('00:18')
    expect(formatRunDuration(61_000)).toBe('01:01')
    expect(formatRunDuration(3_661_000)).toBe('1:01:01')
  })

  it('shows running time without pretending to know a percentage', () => {
    const progress = getGenerationProgress({
      status: 'running',
      createdAt: '2026-07-10T00:00:00.000Z',
      elapsedMs: null,
    }, Date.parse('2026-07-10T00:00:18.000Z'))

    expect(progress.timingText).toBe('生成中 · 00:18')
    expect(progress.detailText).toBe('已运行 00:18')
    expect(progress.hint).toBeNull()
  })

  it('adds a long-running hint after one minute', () => {
    const progress = getGenerationProgress({
      status: 'running',
      createdAt: '2026-07-10T00:00:00.000Z',
      elapsedMs: null,
    }, Date.parse('2026-07-10T00:01:08.000Z'))

    expect(progress.timingText).toBe('生成中 · 01:08')
    expect(progress.hint).toBe('仍在生成，图片任务可能需要更久')
  })

  it('shows final elapsed time after completion', () => {
    const progress = getGenerationProgress({
      status: 'done',
      createdAt: '2026-07-10T00:00:00.000Z',
      elapsedMs: 23_400,
    })

    expect(progress.timingText).toBe('耗时 23 秒')
    expect(progress.detailText).toBe('总耗时 23 秒')
    expect(progress.hint).toBeNull()
  })
})
