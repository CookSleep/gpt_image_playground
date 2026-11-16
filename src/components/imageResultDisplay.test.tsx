// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import { useStore } from '../store'
import { createDefaultOpenAIProfile, normalizeSettings } from '../lib/apiProfiles'
import { normalizeParamsForSettings } from '../lib/paramCompatibility'
import TaskCard from './TaskCard'
import DetailModal from './DetailModal'

vi.mock('../lib/imageCache', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/imageCache')>(),
  ensureImageDimensionsCached: async (id: string) => id === 'image-a' ? { width: 2496, height: 1664 } : { width: 1024, height: 1024 },
  getCachedImage: () => 'data:image/png;base64,aW1hZ2U=',
  ensureImageThumbnailCached: async () => ({ src: 'data:image/png;base64,aW1hZ2U=', width: 2496, height: 1664 }),
  subscribeImageThumbnail: () => () => {},
}))

vi.mock('./ViewportTooltip', () => ({
  default: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? <span role="tooltip">{children}</span> : null,
}))

let el: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
})

afterEach(async () => {
  await act(async () => root.unmount())
  el.remove()
})

async function renderImages(overrides: Partial<TaskRecord>) {
  const task: TaskRecord = {
    id: 'image-result-task', prompt: 'example',
    params: { ...DEFAULT_PARAMS, aspect_ratio: '16:9', resolution: '1K' },
    apiProvider: 'bytedance', apiModel: 'doubao-seedream-5-0-260128',
    inputImageIds: [], outputImages: ['image-a'], status: 'done', error: null,
    createdAt: 0, finishedAt: 1, elapsed: 1,
    ...overrides,
  }
  useStore.setState({ tasks: [task], detailTaskId: task.id })
  await act(async () => root.render(<>
    <section data-testid="card"><TaskCard task={task} onReuse={() => {}} onEditOutputs={() => {}} onDelete={() => {}} onClick={() => {}} /></section>
    <section data-testid="detail"><DetailModal /></section>
  </>))
  const img = el.querySelector<HTMLImageElement>('[data-testid="detail"] img[data-image-id="image-a"]')!
  Object.defineProperties(img, { naturalWidth: { value: 2496, configurable: true }, naturalHeight: { value: 1664, configurable: true } })
  await act(async () => img.dispatchEvent(new Event('load')))
  return {
    task,
    card: el.querySelector('[data-testid="card"]')!,
    detail: el.querySelector('[data-testid="detail"] .grid.grid-cols-2')!,
  }
}

describe('图片结果参数', () => {
  it.each([undefined, '2k', '1024x1024'])('卡片和详情均使用实测尺寸，忽略接口 size=%s', async (size) => {
    const params = { size, aspect_ratio: '16:9', resolution: '1K' }
    const result = await renderImages({ actualParams: params, actualParamsByImage: { 'image-a': params } })
    expect(result.card.textContent).toContain('2496×1664')
    expect(result.card.textContent).toContain('比例3:2')
    expect(result.card.textContent).toContain('分辨率2K')
    expect(result.detail.textContent).toContain('比例16:9|3:2')
    expect(result.detail.textContent).toContain('分辨率1K|2K')
    expect(result.task.params).toMatchObject({ aspect_ratio: '16:9', resolution: '1K' })
    const badge = Array.from(result.card.querySelectorAll('[role="button"]')).find((item) => item.textContent === '2K')!
    expect(badge.className).toContain('bg-yellow-100')
    await act(async () => badge.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(result.card.querySelector('[role="tooltip"]')?.textContent).toBe('图片实际值')
  })

  it('自动比例保留卡片省略和详情灰色对比', async () => {
    const result = await renderImages({ params: { ...DEFAULT_PARAMS, aspect_ratio: 'auto', resolution: '2K' } })
    expect(result.card.textContent).not.toContain('比例')
    expect(result.detail.textContent).toContain('比例auto|3:2')
    expect(result.detail.textContent).toContain('分辨率2K')
    expect(result.detail.textContent).not.toContain('2K|2K')
    const badge = Array.from(result.detail.querySelectorAll('[role="button"]')).find((item) => item.textContent === '3:2')!
    expect(badge.className).not.toContain('bg-yellow-100')
  })

  it.each([
    { apiProvider: 'google', apiModel: 'gemini-3.1-flash-image' },
    { apiProvider: 'xai', apiModel: 'grok-imagine-image' },
    { apiProvider: 'openai', apiModel: 'gemini-3.1-flash-image' },
    { apiProvider: 'fal', apiModel: 'fal-ai/nano-banana-2' },
  ])('不同模型和接口都按图片像素推算：$apiProvider / $apiModel', async (source) => {
    const result = await renderImages({ ...source, actualParams: { size: '4k', aspect_ratio: '1:1', resolution: '4K' } })
    expect(result.card.textContent).toContain('比例3:2')
    expect(result.card.textContent).toContain('分辨率2K')
    expect(result.detail.textContent).toContain('比例16:9|3:2')
    expect(result.detail.textContent).toContain('分辨率1K|2K')
  })

  it('OpenAI 的尺寸按实测像素对比，其他参数继续使用接口响应', async () => {
    const result = await renderImages({
      apiProvider: 'openai', apiModel: 'gpt-image-2',
      params: { ...DEFAULT_PARAMS, size: '1024x1024', quality: 'low' },
      actualParams: { size: '1024x1024', quality: 'high' },
    })
    expect(result.card.textContent).toContain('尺寸2496x1664')
    expect(result.detail.textContent).toContain('尺寸1024x1024|2496x1664')
    expect(result.detail.textContent).toContain('质量low|high')
    const badge = Array.from(result.detail.querySelectorAll('[role="button"]')).find((item) => item.textContent === 'high')!
    await act(async () => badge.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(result.detail.querySelector('[role="tooltip"]')?.textContent).toBe('API 实际响应值')
  })

  it('切换结果图时详情按当前图片计算，卡片仍对应封面图', async () => {
    const result = await renderImages({ outputImages: ['image-a', 'image-b'], actualParams: { size: '2k' } })
    const next = el.querySelector<HTMLButtonElement>('[data-testid="detail"] button.absolute.right-2')!
    await act(async () => next.click())
    const img = el.querySelector<HTMLImageElement>('[data-testid="detail"] img[data-image-id="image-b"]')!
    Object.defineProperties(img, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } })
    await act(async () => img.dispatchEvent(new Event('load')))
    expect(result.detail.textContent).toContain('比例16:9|1:1')
    expect(result.detail.textContent).toContain('分辨率1K')
    expect(result.detail.textContent).not.toContain('1K|2K')
    expect(result.card.textContent).toContain('分辨率2K')
  })

  it.each(['1K', '2K'])('Seedream 档位请求只比较分辨率，不将像素尺寸误标黄：%s', async (resolution) => {
    const profile = createDefaultOpenAIProfile({ provider: 'bytedance', model: 'doubao-seedream-5-5-260825' })
    const settings = normalizeSettings({ profiles: [profile], activeProfileId: profile.id })
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, aspect_ratio: 'auto', resolution }, settings)
    expect(params.size).toBe(resolution)
    const result = await renderImages({ params, apiModel: profile.model, actualParams: { size: resolution } })
    expect(result.card.textContent).toContain('尺寸2496x1664')
    expect(result.card.textContent).toContain('分辨率2K')
    const highlighted = Array.from(result.card.querySelectorAll('.bg-yellow-100')).map((item) => item.textContent)
    expect(highlighted).toEqual(resolution === '1K' ? ['2K'] : [])
    expect(result.detail.textContent).toContain(resolution === '1K' ? '分辨率1K|2K' : '分辨率2K')
  })

  it('Seedream 自定义像素尺寸不一致时仍标黄', async () => {
    const profile = createDefaultOpenAIProfile({ provider: 'bytedance', model: 'doubao-seedream-5-5-260825' })
    const settings = normalizeSettings({ profiles: [profile], activeProfileId: profile.id })
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, aspect_ratio: 'custom', size: '1024x1024' }, settings)
    const result = await renderImages({ params, apiModel: profile.model })
    expect(result.card.querySelector('.bg-yellow-100')?.textContent).toBe('2496x1664')
    expect(result.detail.textContent).toContain('尺寸1024x1024|2496x1664')
    expect(result.detail.textContent).not.toContain('分辨率')
  })
})
