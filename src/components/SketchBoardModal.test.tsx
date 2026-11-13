// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from '../lib/apiProfiles'
import { canvasToBlob } from '../lib/canvasImage'
import { storeImage } from '../lib/db'
import SketchBoardModal from './SketchBoardModal'

const mocks = vi.hoisted(() => ({
  commentsChanged: false,
  saveComments: vi.fn(),
  image: { naturalWidth: 4096, naturalHeight: 2048 } as HTMLImageElement,
}))

vi.mock('../hooks/useSketchComments', () => ({
  useSketchComments: () => ({ comments: [], commentData: [], commentsChanged: mocks.commentsChanged, saveComments: mocks.saveComments }),
}))
vi.mock('../lib/canvasImage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/canvasImage')>(),
  loadImage: async () => mocks.image,
  canvasToBlob: vi.fn(async () => new Blob(['composite'], { type: 'image/png' })),
}))
vi.mock('../lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  storeImage: vi.fn(async () => 'composite'),
}))
vi.mock('../lib/imageCache', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/imageCache')>(),
  ensureImageCached: async () => 'data:image/png;base64,bWFya3Vw',
}))

describe('画板参考图保存', () => {
  let container: HTMLDivElement
  let root: Root
  let contexts: WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.commentsChanged = false
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    contexts = new WeakMap()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      if (!contexts.has(this)) {
        const ctx = new Proxy({} as CanvasRenderingContext2D, {
          get: (target, key) => {
            if (!(key in target)) Reflect.set(target, key, vi.fn())
            return Reflect.get(target, key)
          },
        })
        contexts.set(this, ctx)
      }
      return contexts.get(this)!
    } as unknown as typeof HTMLCanvasElement.prototype.getContext)
    const profile = createDefaultOpenAIProfile({ model: 'gemini-3-pro-image-preview' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }),
      appMode: 'gallery', inputImages: [{ id: 'original', dataUrl: 'original', markupImageId: 'markup' }],
      maskDraft: null, reusedTaskApiModel: null, reusedTaskApiProfileId: null,
      sketchBoard: { baseImageSrc: 'original', replaceImageId: 'original' },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.documentElement.classList.remove('dark')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([false, true])('合成保留原图尺寸和透明区域，深色主题：%s', async (dark) => {
    document.documentElement.classList.toggle('dark', dark)
    await act(async () => root.render(<SketchBoardModal />))
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="清空画布"]')!.click())
    const save = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '完成')!
    await act(async () => save.click())
    const canvas = vi.mocked(canvasToBlob).mock.calls[0][0]
    expect([canvas.width, canvas.height]).toEqual([4096, 2048])
    expect(contexts.get(canvas)!.fillRect).not.toHaveBeenCalled()
    expect(contexts.get(canvas)!.drawImage).toHaveBeenCalledWith(mocks.image, 0, 0)
    expect(useStore.getState().inputImages[0].id).toBe('composite')
  })

  it.each(['gallery', 'agent'] as const)('%s 中只改评论不导出图片或清除遮罩', async (appMode) => {
    mocks.commentsChanged = true
    const maskDraft = { targetImageId: 'original', maskDataUrl: 'mask', updatedAt: 1 }
    useStore.setState({ appMode, maskDraft })
    const images = useStore.getState().inputImages
    await act(async () => root.render(<SketchBoardModal />))
    const save = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '完成')!
    await act(async () => save.click())
    expect(mocks.saveComments).toHaveBeenCalledWith(0)
    expect(canvasToBlob).not.toHaveBeenCalled()
    expect(storeImage).not.toHaveBeenCalled()
    expect(useStore.getState().inputImages).toEqual(images)
    expect(useStore.getState().maskDraft).toEqual(maskDraft)
  })

  it('清空标注后的合成图与原图相同时移除旧标注层', async () => {
    vi.mocked(storeImage).mockResolvedValueOnce('original')
    await act(async () => root.render(<SketchBoardModal />))
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="清空画布"]')!.click())
    const save = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '完成')!
    await act(async () => save.click())
    expect(useStore.getState().inputImages).toEqual([{ id: 'original', dataUrl: 'original' }])
  })
})
