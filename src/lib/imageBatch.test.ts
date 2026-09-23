import { describe, expect, it } from 'vitest'
import { batchCount, runInBatches } from './imageBatch'

describe('image batches', () => {
  it('splits 30 images of 4 into 8 batches', () => {
    expect(batchCount(30, 4)).toBe(8)
    expect(batchCount(4, 4)).toBe(1)
  })

  it('starts the next batch only after the current one finishes', async () => {
    let active = 0
    let maxActive = 0
    const seen: number[] = []
    await runInBatches([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      seen.push(item)
      active -= 1
    })
    expect(maxActive).toBe(2)
    expect(seen.slice(0, 2).sort()).toEqual([1, 2])
    expect(seen.slice(2, 4).sort()).toEqual([3, 4])
    expect(seen[4]).toBe(5)
  })
})
