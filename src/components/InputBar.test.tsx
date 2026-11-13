// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import { useStore } from '../store'
import { createDefaultFalProfile, DEFAULT_SETTINGS, normalizeSettings } from '../lib/apiProfiles'
import InputBar from './InputBar'
import Lightbox from './Lightbox'
import ConfirmDialog from './ConfirmDialog'
import { cacheImage } from '../lib/imageCache'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'

vi.mock('../lib/canvasImage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/canvasImage')>(),
  createMaskPreviewDataUrl: vi.fn(async () => 'data:image/png;base64,aW1hZ2U='),
}))

vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>()
  return {
    ...actual,
    addImageFromFile: async (file: File) => {
      actual.useStore.getState().addInputImage({ id: file.name, dataUrl: 'data:image/png;base64,aW1hZ2U=' })
    },
  }
})

vi.mock('./ViewportTooltip', () => ({
  default: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? <span data-tooltip>{children}</span> : null,
}))

describe('参考图超限提示', () => {
  let root: Root
  let container: HTMLDivElement
  const images = Array.from({ length: 4 }, (_, idx) => ({ id: `input-${idx}`, dataUrl: `data:image/png;base64,${idx}` }))
  const profile = createDefaultFalProfile({ id: 'fal', model: 'xai/grok-imagine-image' })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('innerWidth', 400)
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }),
      appMode: 'gallery', inputImages: images, maskDraft: null, prompt: '',
      params: { ...DEFAULT_PARAMS },
      reusedTaskApiProfileId: null, reusedTaskApiModel: null, tasks: [],
      lightboxImageId: null, confirmDialog: null, maskEditorImageId: null, sketchBoard: null,
      lightboxContext: { type: 'input' },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<InputBar />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('超限图保留并置灰，悬浮显示原因，切换到更高上限恢复', () => {
    const thumb = container.querySelector<HTMLElement>('[data-input-image-index="3"]')!
    expect(container.querySelectorAll('[data-input-image-index]')).toHaveLength(4)
    expect(thumb.querySelector('.grayscale')).not.toBeNull()
    act(() => { thumb.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(container.querySelector('[data-tooltip]')?.textContent).toContain('3 张参考图上限')
    act(() => useStore.getState().setSettings({ profiles: [{ ...profile, model: 'xai/grok-imagine-image/v2.0' }] }))
    expect(container.querySelectorAll('.grayscale')).toHaveLength(0)
    expect(useStore.getState().inputImages).toEqual(images)
  })

  it('长按显示原因，松开后的兼容点击不会打开预览', () => {
    const thumb = container.querySelector<HTMLElement>('[data-input-image-index="3"]')!
    const start = new Event('touchstart', { bubbles: true, cancelable: true })
    Object.defineProperty(start, 'touches', { value: [{ clientX: 10, clientY: 10 }] })
    act(() => { thumb.dispatchEvent(start) })
    act(() => vi.advanceTimersByTime(450))
    expect(container.querySelector('[data-tooltip]')?.textContent).toContain('3 张参考图上限')
    act(() => {
      thumb.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }))
      thumb.querySelector('button')!.click()
    })
    expect(useStore.getState().lightboxImageId).toBeNull()
  })

  it('达到上限后仍能打开添加菜单', () => {
    const add = container.querySelector<HTMLButtonElement>('button[aria-label="添加图片"]')!
    act(() => add.click())
    expect(add.getAttribute('aria-expanded')).toBe('true')
  })

  it.each(['gif', 'svg'] as const)('进入 Agent 清理 %s、数量和透明输出，切回画廊不恢复', (output_format) => {
    act(() => {
      useStore.getState().setSettings({ profiles: [{ ...profile, model: 'openai/gpt-image-2.6/sunburst' }] })
      useStore.setState({ inputImages: [], params: { ...DEFAULT_PARAMS, output_format, n: 4, transparent_output: true } })
    })
    expect(useStore.getState().params.output_format).toBe(output_format)
    act(() => useStore.setState({ appMode: 'agent' }))
    expect(useStore.getState().params).toMatchObject({ output_format: 'png', n: 1, transparent_output: false })
    act(() => useStore.setState({ appMode: 'gallery' }))
    expect(useStore.getState().params).toMatchObject({ output_format: 'png', n: 1, transparent_output: false })
  })

  it.each(['ask', 'mask', 'sketch'] as const)('不支持遮罩时直接进入画板，默认行为为 %s', async (referenceImageEditAction) => {
    cacheImage(images[0].id, images[0].dataUrl)
    await act(async () => {
      useStore.setState({ lightboxImageId: images[0].id, lightboxImageList: [images[0].id] })
      useStore.getState().setSettings({ referenceImageEditAction })
      root.render(<><Lightbox /><ConfirmDialog /></>)
    })
    const edit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '编辑图片')!
    act(() => edit.click())
    expect(useStore.getState().confirmDialog).toBeNull()
    expect(useStore.getState().maskEditorImageId).toBeNull()
    expect(useStore.getState().settings.referenceImageEditAction).toBe(referenceImageEditAction)
    expect(useStore.getState().sketchBoard).toMatchObject({ replaceImageId: images[0].id })
  })

  it('已有遮罩不支持时置灰并提示，切回支持的模型后恢复', () => {
    act(() => {
      useStore.getState().setSettings({ profiles: [{ ...profile, apiKey: 'test-key' }] })
      useStore.setState({ prompt: '编辑图片', maskDraft: { targetImageId: images[0].id, maskDataUrl: images[0].dataUrl, updatedAt: 1 } })
    })
    const submits = container.querySelectorAll<HTMLButtonElement>('button[aria-label="遮罩编辑"]')
    expect(submits.length).toBeGreaterThan(0)
    for (const button of submits) expect(button.disabled).toBe(true)
    const thumb = container.querySelector<HTMLElement>('[data-input-image-index="0"]')!
    expect(thumb.querySelector('.grayscale')).not.toBeNull()
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === '移除遮罩')).toBe(false)
    act(() => { thumb.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(container.querySelector('[data-tooltip]')?.textContent).toContain('当前模型不支持遮罩编辑')
    act(() => { thumb.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    const start = new Event('touchstart', { bubbles: true, cancelable: true })
    Object.defineProperty(start, 'touches', { value: [{ clientX: 10, clientY: 10 }] })
    act(() => { thumb.dispatchEvent(start) })
    act(() => vi.advanceTimersByTime(450))
    expect(container.querySelector('[data-tooltip]')?.textContent).toContain('当前模型不支持遮罩编辑')
    act(() => useStore.getState().setSettings({ profiles: [{ ...profile, model: 'openai/gpt-image-2.6/sunburst', apiKey: 'test-key' }] }))
    expect(thumb.querySelector('.grayscale')).toBeNull()
    expect(useStore.getState().maskDraft).not.toBeNull()
    expect(useStore.getState().inputImages).toEqual(images)
    for (const button of submits) expect(button.disabled).toBe(false)
  })

  it('不支持的遮罩主图预览提供移除遮罩，普通参考图仍可替换', async () => {
    for (const image of images) cacheImage(image.id, image.dataUrl)
    cacheImage('historical-mask', 'data:image/png;base64,bWFzaw==')
    await act(async () => {
      useStore.setState({
        lightboxImageId: images[0].id, lightboxImageList: images.map((image) => image.id),
        maskDraft: { targetImageId: images[0].id, maskDataUrl: images[0].dataUrl, updatedAt: 1 },
        tasks: [{ id: 'history', maskTargetImageId: images[0].id, maskImageId: 'historical-mask' } as TaskRecord],
      })
      root.render(<Lightbox />)
    })
    expect(container.textContent).toContain('移除遮罩')
    expect(container.textContent).toContain('替换图片')
    expect(container.textContent).not.toContain('编辑图片')
    await act(async () => { useStore.setState({ lightboxImageId: images[1].id }) })
    expect(container.textContent).toContain('替换图片')
    expect(container.textContent).not.toContain('移除遮罩')
    await act(async () => { useStore.setState({ lightboxImageId: images[0].id }) })
    const remove = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '移除遮罩')!
    await act(async () => remove.click())
    expect(useStore.getState().maskDraft).toBeNull()
    expect(container.querySelector('img.pointer-events-none')).toBeNull()
    expect(useStore.getState().inputImages).toEqual(images)
    expect(useStore.getState().lightboxImageId).toBe(images[0].id)
    expect(container.textContent).toContain('替换图片')
    expect(container.textContent).toContain('编辑图片')
    const edit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '编辑图片')!
    act(() => edit.click())
    expect(useStore.getState().confirmDialog).toBeNull()
    expect(useStore.getState().sketchBoard).toMatchObject({ replaceImageId: images[0].id })
  })

  it('历史预览使用对应任务的遮罩，不受同图的输入草稿影响', async () => {
    const historicalMask = 'data:image/png;base64,bWFzaw=='
    cacheImage(images[0].id, images[0].dataUrl)
    cacheImage('history-mask', historicalMask)
    await act(async () => {
      useStore.setState({ maskDraft: { targetImageId: images[0].id, maskDataUrl: 'draft-mask', updatedAt: 1 } })
      useStore.getState().setLightboxImageId(images[0].id, [images[0].id], '', {}, {
        type: 'history', maskTargetImageId: images[0].id, maskImageId: 'history-mask',
      })
      root.render(<Lightbox />)
    })
    expect(createMaskPreviewDataUrl).toHaveBeenLastCalledWith(images[0].dataUrl, historicalMask)
    expect(container.querySelector('img.pointer-events-none')).not.toBeNull()
    expect(container.textContent).not.toContain('移除遮罩')
    expect(container.textContent).not.toContain('编辑图片')
    await act(async () => useStore.getState().clearMaskDraft())
    expect(container.querySelector('img.pointer-events-none')).not.toBeNull()
    await act(async () => useStore.getState().setLightboxImageId(images[0].id, [images[0].id], '', {}, { type: 'input' }))
    expect(container.querySelector('img.pointer-events-none')).toBeNull()
    expect(container.textContent).toContain('编辑图片')
    await act(async () => useStore.getState().setLightboxImageId(images[0].id, [images[0].id], '', {}, { type: 'history' }))
    expect(container.querySelector('img.pointer-events-none')).toBeNull()
    expect(container.textContent).not.toContain('编辑图片')
    act(() => useStore.getState().setLightboxImageId(null))
    expect(useStore.getState().lightboxContext).toBeNull()
  })

  it('纵向滑动留给原生滚动，不触发排序和长按提示', () => {
    const thumb = container.querySelector<HTMLElement>('[data-input-image-index="3"]')!
    for (const [type, x, y] of [['touchstart', 10, 10], ['touchmove', 12, 40], ['touchmove', 60, 50]] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] })
      act(() => { thumb.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(false)
    }
    act(() => vi.advanceTimersByTime(450))
    expect(container.querySelector('[data-tooltip]')).toBeNull()
    expect(document.body.style.overflow).not.toBe('hidden')
    expect(useStore.getState().inputImages).toEqual(images)
  })

  it('滚动参考图区时关闭缩略图提示', () => {
    const thumb = container.querySelector<HTMLElement>('[data-input-image-index="3"]')!
    act(() => { thumb.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(container.querySelector('[data-tooltip]')).not.toBeNull()
    act(() => { container.querySelector('[role="region"][aria-label="参考图"]')!.dispatchEvent(new Event('scroll')) })
    expect(container.querySelector('[data-tooltip]')).toBeNull()
  })

  it.each(['paste', 'change', 'drop'])('%s 添加超限文件时全部保留并置灰', async (type) => {
    const files = Array.from({ length: 20 }, (_, idx) => new File(['image'], `file-${idx}.png`, { type: 'image/png' }))
    const event = new Event(type, { bubbles: true, cancelable: true })
    const target = type === 'change' ? container.querySelector<HTMLInputElement>('input[type="file"]')! : document
    if (type === 'change') Object.defineProperty(target, 'files', { value: files })
    if (type === 'paste') Object.defineProperty(event, 'clipboardData', { value: { items: files.map((file) => ({ type: file.type, getAsFile: () => file })) } })
    if (type === 'drop') Object.defineProperty(event, 'dataTransfer', { value: { files, getData: () => '' } })
    await act(async () => { target.dispatchEvent(event) })
    expect(useStore.getState().inputImages).toHaveLength(24)
    expect(container.querySelectorAll('[data-input-image-index]')).toHaveLength(24)
    expect(container.querySelectorAll('.grayscale')).toHaveLength(21)
  })
})
