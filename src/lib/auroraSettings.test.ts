import { describe, expect, it } from 'vitest'
import { applyOptimizedPrompt, hasCompleteSettings } from './auroraSettings'

describe('Aurora settings', () => {
  it('requires both image and prompt API keys', () => {
    expect(hasCompleteSettings({ imageApiKeyId: null, promptApiKeyId: null })).toBe(false)
    expect(hasCompleteSettings({ imageApiKeyId: '101', promptApiKeyId: null })).toBe(false)
    expect(hasCompleteSettings({ imageApiKeyId: '101', promptApiKeyId: '202' })).toBe(true)
  })

  it('only applies an optimized prompt after explicit confirmation', () => {
    expect(applyOptimizedPrompt('原提示词', '优化提示词', false)).toBe('原提示词')
    expect(applyOptimizedPrompt('原提示词', ' 优化提示词 ', true)).toBe('优化提示词')
  })
})
