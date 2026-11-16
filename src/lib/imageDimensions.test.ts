import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const backend = vi.hoisted(() => ({
  getImage: vi.fn(),
  getImageMeta: vi.fn(),
  getStoredImageThumbnail: vi.fn(),
  updateImageDimensions: vi.fn(),
  putImage: vi.fn(),
  putImageThumbnail: vi.fn(),
}))

vi.mock('./platform', () => ({ isTauri: false }))
vi.mock('./dbIndexedDb', async (importOriginal) => ({
  ...await importOriginal<typeof import('./dbIndexedDb')>(),
  ...backend,
}))

import { getImageDimensions, getImageThumbnail } from './db'

describe('图片真实宽高', () => {
  const decode = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()
    backend.getImageMeta.mockResolvedValue({ id: 'image' })
    backend.getImage.mockResolvedValue({ id: 'image', dataUrl: 'original' })
    backend.updateImageDimensions.mockResolvedValue(true)
    vi.stubGlobal('Image', class {
      naturalWidth = 2496
      naturalHeight = 1664
      onload?: () => void
      onerror?: () => void
      set src(value: string) {
        decode(value)
        queueMicrotask(() => value === 'broken' ? this.onerror?.() : this.onload?.())
      }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('已有宽高时只读元数据，不读取或解码原图', async () => {
    backend.getImageMeta.mockResolvedValue({ id: 'image', width: 2496, height: 1664 })
    expect(await getImageDimensions('image')).toEqual({ width: 2496, height: 1664 })
    expect(backend.getImage).not.toHaveBeenCalled()
    expect(backend.getStoredImageThumbnail).not.toHaveBeenCalled()
    expect(decode).not.toHaveBeenCalled()
  })

  it('并发读取缺少宽高的旧图片只解析一次，保存后可复用', async () => {
    backend.updateImageDimensions.mockImplementation(async (id, width, height) => {
      backend.getImageMeta.mockResolvedValue({ id, width, height })
      return true
    })
    const results = await Promise.all([getImageDimensions('image'), getImageDimensions('image')])
    expect(results).toEqual([{ width: 2496, height: 1664 }, { width: 2496, height: 1664 }])
    await getImageDimensions('image')
    expect(decode).toHaveBeenCalledExactlyOnceWith('original')
    expect(backend.updateImageDimensions).toHaveBeenCalledExactlyOnceWith('image', 2496, 1664)
  })

  it('缩略图记录中的原图宽高可用于补全，无需读取原图', async () => {
    backend.getStoredImageThumbnail.mockResolvedValue({ width: 2496, height: 1664 })
    expect(await getImageDimensions('image')).toEqual({ width: 2496, height: 1664 })
    expect(backend.getImage).not.toHaveBeenCalled()
    expect(backend.updateImageDimensions).toHaveBeenCalledWith('image', 2496, 1664)
  })

  it('当前版本缩略图缺少宽高时仍能补全', async () => {
    backend.getStoredImageThumbnail.mockResolvedValue({ id: 'image', thumbnailDataUrl: 'thumbnail', thumbnailVersion: 2 })
    expect(await getImageThumbnail('image')).toMatchObject({ width: 2496, height: 1664, thumbnailDataUrl: 'thumbnail' })
    expect(decode).toHaveBeenCalledOnce()
  })

  it('解析期间图片已删除时不恢复图片记录', async () => {
    backend.updateImageDimensions.mockResolvedValue(false)
    expect(await getImageDimensions('image')).toBeUndefined()
  })

  it('真实宽高写入失败时仍返回解析结果，后续读取会重试保存', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    backend.updateImageDimensions.mockRejectedValueOnce(new Error('storage full'))
    expect(await getImageDimensions('image')).toEqual({ width: 2496, height: 1664 })
    expect(warn).toHaveBeenCalledWith('保存图片尺寸失败', 'image', expect.any(Error))
    expect(await getImageDimensions('image')).toEqual({ width: 2496, height: 1664 })
    expect(backend.updateImageDimensions).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('缩略图已有的真实宽高不因元数据写入失败而丢失', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    backend.getStoredImageThumbnail.mockResolvedValue({ width: 2496, height: 1664 })
    backend.updateImageDimensions.mockRejectedValue(new Error('storage full'))
    expect(await getImageDimensions('image')).toEqual({ width: 2496, height: 1664 })
    expect(backend.getImage).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('重建缩略图后即使保存失败，仍返回缩略图及真实宽高', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('document', { createElement: () => ({
      getContext: () => ({ drawImage: vi.fn() }),
      toDataURL: () => 'generated-thumbnail',
    }) })
    backend.putImageThumbnail.mockRejectedValue(new Error('storage full'))
    backend.updateImageDimensions.mockRejectedValue(new Error('storage full'))
    expect(await getImageThumbnail('image')).toMatchObject({ thumbnailDataUrl: 'generated-thumbnail', width: 2496, height: 1664 })
    expect(decode).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('缩略图重建期间原图被删除时不写回原图', async () => {
    vi.stubGlobal('document', { createElement: () => ({
      getContext: () => ({ drawImage: vi.fn() }),
      toDataURL: () => 'generated-thumbnail',
    }) })
    backend.updateImageDimensions.mockResolvedValue(false)
    expect(await getImageThumbnail('image')).toBeUndefined()
    expect(backend.putImage).not.toHaveBeenCalled()
  })

  it('原图损坏时所有并发调用都返回空值，后续可重试', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    backend.getImage.mockResolvedValue({ id: 'image', dataUrl: 'broken' })
    expect(await Promise.all([getImageDimensions('image'), getImageDimensions('image')])).toEqual([undefined, undefined])
    expect(backend.updateImageDimensions).not.toHaveBeenCalled()
    backend.getImage.mockResolvedValue({ id: 'image', dataUrl: 'original' })
    expect(await getImageDimensions('image')).toEqual({ width: 2496, height: 1664 })
    vi.restoreAllMocks()
  })
})
