import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  CURRENT_THUMBNAIL_VERSION: 2,
  getImage: vi.fn(),
  getImageMeta: vi.fn(),
  getImageDimensions: vi.fn().mockResolvedValue({ width: 1200, height: 800 }),
  getImageThumbnail: vi.fn(),
}))
const imageBlob = vi.hoisted(() => ({
  getThumbnailSource: vi.fn(),
  getFreshThumbnailIds: vi.fn(),
}))

vi.mock('./db', () => db)
vi.mock('./imageBlob', () => imageBlob)

import {
  cacheImage,
  cacheThumbnail,
  clearImageCaches,
  deleteImageCacheEntry,
  ensureImageThumbnailCached,
  ensureImageDimensionsCached,
  getCachedImage,
  scheduleMissingThumbnailBackfill,
  scheduleThumbnailBackfill,
  subscribeImageThumbnail,
} from './imageCache'

describe('imageCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    URL.revokeObjectURL = vi.fn()
    clearImageCaches()
    vi.clearAllMocks()
    db.getImage.mockResolvedValue(undefined)
    db.getImageMeta.mockResolvedValue(undefined)
    db.getImageDimensions.mockReset().mockResolvedValue({ width: 1200, height: 800 })
    db.getImageThumbnail.mockResolvedValue(undefined)
    imageBlob.getThumbnailSource.mockResolvedValue(undefined)
    imageBlob.getFreshThumbnailIds.mockResolvedValue([])
  })

  afterEach(async () => {
    await vi.runAllTimersAsync()
    vi.useRealTimers()
  })

  it('evicts the least recently used images and thumbnails', async () => {
    for (let i = 0; i < 8; i++) cacheImage(`image-${i}`, `data-${i}`)
    expect(getCachedImage('image-0')).toBe('data-0')
    cacheImage('image-8', 'data-8')

    expect(getCachedImage('image-1')).toBeUndefined()
    expect(getCachedImage('image-0')).toBe('data-0')

    for (let i = 0; i < 200; i++) {
      cacheThumbnail(`thumbnail-${i}`, {
        src: `thumbnail-data-${i}`,
        thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
      })
    }
    await expect(ensureImageThumbnailCached('thumbnail-0')).resolves.toMatchObject({ src: 'thumbnail-data-0' })
    cacheThumbnail('thumbnail-200', {
      src: 'thumbnail-data-200',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })
    imageBlob.getThumbnailSource.mockResolvedValue({
      src: 'stored-thumbnail',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })

    await expect(ensureImageThumbnailCached('thumbnail-1')).resolves.toMatchObject({ src: 'stored-thumbnail' })
    expect(imageBlob.getThumbnailSource).toHaveBeenCalledWith('thumbnail-1', db.CURRENT_THUMBNAIL_VERSION)
  })

  it('keeps thumbnails in use and revokes blob URLs only after the last user leaves', () => {
    const revoke = vi.fn()
    URL.revokeObjectURL = revoke
    const version = db.CURRENT_THUMBNAIL_VERSION
    const releaseA = subscribeImageThumbnail('shown', () => {})
    const releaseB = subscribeImageThumbnail('shown', () => {})
    cacheThumbnail('shown', { src: 'blob:shown', thumbnailVersion: version })
    for (let i = 0; i < 200; i++) cacheThumbnail(`other-${i}`, { src: `blob:other-${i}`, thumbnailVersion: version })

    // 最久未用但正在显示的项被跳过，淘汰下一个
    expect(revoke.mock.calls).toEqual([['blob:other-0']])

    // 显示中被替换或删除，推迟到最后一个使用者离开再撤销
    cacheThumbnail('shown', { src: 'blob:shown-2', thumbnailVersion: version })
    deleteImageCacheEntry('shown')
    releaseA()
    releaseA()
    expect(revoke).not.toHaveBeenCalledWith('blob:shown')
    releaseB()
    expect(revoke).toHaveBeenCalledWith('blob:shown')
    expect(revoke).toHaveBeenCalledWith('blob:shown-2')
    expect(revoke).toHaveBeenCalledTimes(3)

    // dataUrl 不需要撤销
    cacheThumbnail('data', { src: 'data:image/webp;base64,AA==', thumbnailVersion: version })
    clearImageCaches()
    expect(revoke).not.toHaveBeenCalledWith('data:image/webp;base64,AA==')
  })

  it('only caches thumbnails from the current version', async () => {
    cacheThumbnail('image', {
      src: 'stale-thumbnail',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION - 1,
    })
    imageBlob.getThumbnailSource.mockResolvedValue({
      src: 'fresh-thumbnail',
      width: 640,
      height: 480,
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })

    await expect(ensureImageThumbnailCached('image')).resolves.toEqual({
      src: 'fresh-thumbnail',
      width: 640,
      height: 480,
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })
    expect(imageBlob.getThumbnailSource).toHaveBeenCalledOnce()

    imageBlob.getThumbnailSource.mockClear()
    await ensureImageThumbnailCached('image')
    expect(imageBlob.getThumbnailSource).not.toHaveBeenCalled()
  })

  it('deletes individual entries and clears both caches', async () => {
    cacheImage('deleted', 'deleted-data')
    cacheThumbnail('deleted', {
      src: 'deleted-thumbnail',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })
    deleteImageCacheEntry('deleted')
    imageBlob.getThumbnailSource.mockResolvedValueOnce({
      src: 'stored-deleted-thumbnail',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })

    expect(getCachedImage('deleted')).toBeUndefined()
    await expect(ensureImageThumbnailCached('deleted')).resolves.toMatchObject({
      src: 'stored-deleted-thumbnail',
    })
    expect(imageBlob.getThumbnailSource).toHaveBeenCalledWith('deleted', db.CURRENT_THUMBNAIL_VERSION)

    cacheImage('cleared', 'cleared-data')
    cacheThumbnail('cleared', {
      src: 'cleared-thumbnail',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })
    clearImageCaches()
    imageBlob.getThumbnailSource.mockClear()
    imageBlob.getThumbnailSource.mockResolvedValueOnce({
      src: 'stored-cleared-thumbnail',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })

    expect(getCachedImage('cleared')).toBeUndefined()
    await expect(ensureImageThumbnailCached('cleared')).resolves.toMatchObject({
      src: 'stored-cleared-thumbnail',
    })
    expect(imageBlob.getThumbnailSource).toHaveBeenCalledWith('cleared', db.CURRENT_THUMBNAIL_VERSION)
  })

  it('prioritizes visible thumbnail backfills and notifies subscribers', async () => {
    vi.useFakeTimers()
    db.getImageMeta.mockResolvedValue({ width: 1000, height: 1000 })
    db.getImageThumbnail.mockImplementation(async (id: string) => ({
      thumbnailDataUrl: `${id}-thumbnail`,
      width: 1000,
      height: 1000,
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    }))
    const onThumbnail = vi.fn()
    const unsubscribe = subscribeImageThumbnail('visible', onThumbnail)

    scheduleThumbnailBackfill(['background'])
    scheduleThumbnailBackfill(['visible'], 'visible')
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(db.getImageThumbnail).toHaveBeenCalledTimes(2))

    expect(db.getImageMeta.mock.calls.map(([id]) => id)).toEqual(['visible', 'background'])
    expect(db.getImageThumbnail.mock.calls.map(([id]) => id)).toEqual(['visible', 'background'])
    expect(onThumbnail).toHaveBeenCalledWith(expect.objectContaining({
      src: 'visible-thumbnail',
      width: 1000,
      height: 1000,
    }))
    unsubscribe()
  })

  it('allows a failed thumbnail backfill to be scheduled again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    db.getImageMeta.mockResolvedValue({ width: 1000, height: 1000 })
    db.getImageThumbnail
      .mockRejectedValueOnce(new Error('thumbnail failed'))
      .mockResolvedValueOnce({
        thumbnailDataUrl: 'retried-thumbnail',
        thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
      })

    scheduleThumbnailBackfill(['image'])
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(db.getImageThumbnail).toHaveBeenCalledOnce())

    scheduleThumbnailBackfill(['image'])
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(db.getImageThumbnail).toHaveBeenCalledTimes(2))
    warn.mockRestore()
  })

  it('先返回已有缩略图，宽高补全后同时通知卡片和详情', async () => {
    db.getImageMeta.mockResolvedValue({ id: 'image' })
    imageBlob.getThumbnailSource.mockResolvedValue({ src: 'ready-thumbnail', thumbnailVersion: 2 })
    let finish!: (size: { width: number; height: number }) => void
    db.getImageDimensions.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const onThumbnail = vi.fn()
    const unsubscribe = subscribeImageThumbnail('image', onThumbnail)

    expect(await ensureImageThumbnailCached('image')).toMatchObject({ src: 'ready-thumbnail' })
    expect(db.getImageDimensions).not.toHaveBeenCalled()
    const detail = ensureImageDimensionsCached('image')
    await vi.advanceTimersByTimeAsync(250)
    expect(db.getImageDimensions).toHaveBeenCalledOnce()
    expect(onThumbnail).not.toHaveBeenCalled()
    finish({ width: 2496, height: 1664 })
    expect(await detail).toEqual({ width: 2496, height: 1664 })
    expect(onThumbnail).toHaveBeenCalledWith(expect.objectContaining({ src: 'ready-thumbnail', width: 2496, height: 1664 }))
    expect(await ensureImageThumbnailCached('image')).toMatchObject({ width: 2496, height: 1664 })
    unsubscribe()
  })

  it('宽高补全与缩略图重建共享并发额度，可见图片优先', async () => {
    db.getImageMeta.mockResolvedValue({ id: 'image' })
    cacheThumbnail('visible', { src: 'visible-thumbnail', thumbnailVersion: 2 })
    let finish!: (size: { width: number; height: number }) => void
    db.getImageDimensions.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    db.getImageThumbnail.mockResolvedValue({ thumbnailDataUrl: 'background-thumbnail', width: 1000, height: 1000, thumbnailVersion: 2 })
    scheduleThumbnailBackfill(['background'])
    const detail = ensureImageDimensionsCached('visible')

    await vi.advanceTimersByTimeAsync(250)
    expect(db.getImageDimensions).toHaveBeenCalledWith('visible')
    expect(db.getImageThumbnail).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(db.getImageThumbnail).not.toHaveBeenCalled()
    finish({ width: 2496, height: 1664 })
    await detail
    await vi.advanceTimersByTimeAsync(250)
    expect(db.getImageThumbnail).toHaveBeenCalledExactlyOnceWith('background')
  })

  it('缺少缩略图时详情复用重建结果，不另行解析宽高', async () => {
    db.getImageMeta.mockResolvedValue({ id: 'image' })
    db.getImageThumbnail.mockResolvedValue({ thumbnailDataUrl: 'new-thumbnail', width: 2496, height: 1664, thumbnailVersion: 2 })
    const first = ensureImageDimensionsCached('image')
    const second = ensureImageDimensionsCached('image')
    await vi.advanceTimersByTimeAsync(250)
    expect(await first).toEqual({ width: 2496, height: 1664 })
    expect(await second).toEqual({ width: 2496, height: 1664 })
    expect(db.getImageThumbnail).toHaveBeenCalledOnce()
    expect(db.getImageDimensions).not.toHaveBeenCalled()
  })

  it('宽高读取失败后结束等待，后续访问可以重试', async () => {
    db.getImageMeta.mockResolvedValue({ id: 'image' })
    cacheThumbnail('image', { src: 'ready-thumbnail', thumbnailVersion: 2 })
    db.getImageDimensions.mockResolvedValueOnce(undefined)
    const first = ensureImageDimensionsCached('image')
    await vi.advanceTimersByTimeAsync(250)
    expect(await first).toBeUndefined()
    const second = ensureImageDimensionsCached('image')
    await vi.advanceTimersByTimeAsync(250)
    expect(await second).toEqual({ width: 1200, height: 800 })
    expect(db.getImageDimensions).toHaveBeenCalledTimes(2)
  })

  it('删除一张图片只取消它的宽高补全，不影响同批其他图片', async () => {
    db.getImageMeta.mockResolvedValue({ width: 1000, height: 1000 })
    const finish = new Map<string, (size: { width: number; height: number }) => void>()
    db.getImageDimensions.mockImplementation((id: string) => new Promise((resolve) => finish.set(id, resolve)))
    cacheThumbnail('a', { src: 'thumb-a', thumbnailVersion: 2 })
    cacheThumbnail('b', { src: 'thumb-b', thumbnailVersion: 2 })
    const notifyA = vi.fn()
    const notifyB = vi.fn()
    const releaseA = subscribeImageThumbnail('a', notifyA)
    const releaseB = subscribeImageThumbnail('b', notifyB)
    scheduleThumbnailBackfill(['a', 'b'])
    await vi.advanceTimersByTimeAsync(250)
    deleteImageCacheEntry('a')
    finish.get('a')!({ width: 1000, height: 1000 })
    finish.get('b')!({ width: 1000, height: 1000 })
    await vi.runAllTimersAsync()
    expect(notifyA).not.toHaveBeenCalled()
    expect(notifyB).toHaveBeenCalledWith(expect.objectContaining({ src: 'thumb-b', width: 1000 }))
    expect(await ensureImageThumbnailCached('a')).toBeUndefined()
    expect(await ensureImageThumbnailCached('b')).toMatchObject({ src: 'thumb-b' })
    releaseA()
    releaseB()
  })

  it('删除后不接收迟到的缩略图，重新出现的同 ID 可以再次补全', async () => {
    let finish!: (value: object) => void
    db.getImageThumbnail.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    scheduleThumbnailBackfill(['a'])
    await vi.advanceTimersByTimeAsync(250)
    deleteImageCacheEntry('a')
    finish({ thumbnailDataUrl: 'late', width: 1000, height: 1000, thumbnailVersion: 2 })
    await vi.runAllTimersAsync()
    expect(await ensureImageThumbnailCached('a')).toBeUndefined()
    db.getImageThumbnail.mockResolvedValue({ thumbnailDataUrl: 'new', width: 1000, height: 1000, thumbnailVersion: 2 })
    await vi.runAllTimersAsync()
    expect(await ensureImageThumbnailCached('a')).toMatchObject({ src: 'new' })
  })

  it('已有真实宽高直接返回，不等待后台队列', async () => {
    db.getImageMeta.mockResolvedValue({ id: 'image', width: 2496, height: 1664 })
    expect(await ensureImageDimensionsCached('image')).toEqual({ width: 2496, height: 1664 })
    expect(db.getImageThumbnail).not.toHaveBeenCalled()
    expect(db.getImageDimensions).not.toHaveBeenCalled()
  })

  it.each([
    { width: undefined, height: undefined, limit: 1 },
    { width: 4000, height: 2000, limit: 1 },
    { width: 2000, height: 2000, limit: 2 },
    { width: 2000, height: 1000, limit: 3 },
    { width: 1000, height: 1000, limit: 4 },
  ])('按图片尺寸控制并发上限 $limit', async ({ width, height, limit }) => {
    db.getImageMeta.mockResolvedValue({ width, height })
    const finish: Array<() => void> = []
    db.getImageThumbnail.mockImplementation(() => new Promise((resolve) => finish.push(() => resolve(undefined))))
    scheduleThumbnailBackfill(['a', 'b', 'c', 'd', 'e'])
    await vi.advanceTimersByTimeAsync(250)
    expect(db.getImageThumbnail).toHaveBeenCalledTimes(limit)
    await vi.advanceTimersByTimeAsync(1000)
    expect(db.getImageThumbnail).toHaveBeenCalledTimes(limit)
    db.getImageThumbnail.mockResolvedValue(undefined)
    finish.forEach((resolve) => resolve())
    await vi.runAllTimersAsync()
    expect(db.getImageThumbnail).toHaveBeenCalledTimes(5)
  })

  it('only reads originals for images missing a current thumbnail', async () => {
    vi.useFakeTimers()
    imageBlob.getFreshThumbnailIds.mockResolvedValue(['fresh-1', 'fresh-2'])
    db.getImageMeta.mockResolvedValue({ width: 1000, height: 1000 })
    db.getImageThumbnail.mockImplementation(async (id: string) => ({
      thumbnailDataUrl: `${id}-thumbnail`,
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    }))

    await scheduleMissingThumbnailBackfill(['fresh-1', 'missing', 'fresh-2', 'stale'])
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(db.getImageThumbnail).toHaveBeenCalledTimes(2))

    expect(imageBlob.getFreshThumbnailIds).toHaveBeenCalledWith(db.CURRENT_THUMBNAIL_VERSION)
    expect(db.getImageMeta.mock.calls.map(([id]) => id)).toEqual(['missing', 'stale'])
    expect(db.getImageThumbnail.mock.calls.map(([id]) => id)).toEqual(['missing', 'stale'])
  })

  it('falls back to backfilling every image when the thumbnail index query fails', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    imageBlob.getFreshThumbnailIds.mockRejectedValue(new Error('index missing'))
    db.getImageMeta.mockResolvedValue({ width: 1000, height: 1000 })

    await scheduleMissingThumbnailBackfill(['a', 'b'])
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(db.getImageThumbnail).toHaveBeenCalledTimes(2))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
