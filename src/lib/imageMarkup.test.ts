import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { callImageApi } from './api'
import { composeMarkupDataUrl } from './canvasImage'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'

vi.mock('./canvasImage', () => ({
  toApiInputImageDataUrl: async (url: string) => url,
  composeMarkupDataUrl: vi.fn(async () => 'composite'),
}))
vi.mock('./openaiCompatibleImageApi', () => ({ callOpenAICompatibleImageApi: vi.fn(async () => ({ images: [] })) }))

beforeEach(() => vi.clearAllMocks())

describe('独立标注请求兼容性', () => {
  it.each([
    { model: 'gpt-image-2', apiMode: 'images' as const, separate: false },
    { model: 'gpt-image-2.5-flare', apiMode: 'images' as const, separate: true },
    { model: 'gpt-image-2.6-sunburst', apiMode: 'images' as const, separate: true },
    { model: 'grok-imagine-image', apiMode: 'images' as const, separate: false },
    { model: 'gpt-6.1-sol', apiMode: 'responses' as const, separate: false },
  ])('$model / $apiMode 按接口能力发送标注', async ({ model, apiMode, separate }) => {
    const profile = createDefaultOpenAIProfile({ model, apiMode })
    await callImageApi({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }),
      params: { ...DEFAULT_PARAMS }, prompt: '修改标注区域',
      inputImageDataUrls: ['original'], inputImageUrls: ['https://example.com/original.png'], markupDataUrl: 'markup',
    })
    expect(callOpenAICompatibleImageApi).toHaveBeenCalledWith(expect.objectContaining({
      inputImageDataUrls: [separate ? 'original' : 'composite'],
      inputImageUrls: [separate ? 'https://example.com/original.png' : null],
      markupDataUrl: separate ? 'markup' : undefined,
    }), expect.anything(), null)
    expect(composeMarkupDataUrl).toHaveBeenCalledTimes(separate ? 0 : 1)
  })
})
