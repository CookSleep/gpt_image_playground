import { describe, expect, it } from 'vitest'
import { formatActualCost } from './cost'

describe('formatActualCost', () => {
  it('formats actual costs with useful precision', () => {
    expect(formatActualCost(0)).toBe('$0.00')
    expect(formatActualCost(0.0375)).toBe('$0.0375')
    expect(formatActualCost(1.2)).toBe('$1.20')
  })
})
