import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  CURRENT_THUMBNAIL_VERSION: 2,
  getImage: vi.fn(),
  getImageThumbnail: vi.fn(),
  getStoredFreshImageThumbnail: vi.fn(),
}))

vi.mock('./db', () => db)

import {
  cacheImage,
  cacheThumbnail,
  clearImageCaches,
  deleteImageCacheEntry,
  ensureImageThumbnailCached,
  getCachedImage,
  scheduleThumbnailBackfill,
  subscribeImageThumbnail,
} from './imageCache'

describe('imageCache', () => {
  beforeEach(() => {
    clearImageCaches()
    vi.clearAllMocks()
    db.getImage.mockResolvedValue(undefined)
    db.getImageThumbnail.mockResolvedValue(undefined)
    db.getStoredFreshImageThumbnail.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('evicts the least recently used images and thumbnails', async () => {
    for (let i = 0; i < 8; i++) cacheImage(`image-${i}`, `data-${i}`)
    expect(getCachedImage('image-0')).toBe('data-0')
    cacheImage('image-8', 'data-8')

    expect(getCachedImage('image-1')).toBeUndefined()
    expect(getCachedImage('image-0')).toBe('data-0')

    for (let i = 0; i < 80; i++) {
      cacheThumbnail(`thumbnail-${i}`, {
        dataUrl: `thumbnail-data-${i}`,
        thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
      })
    }
    await expect(ensureImageThumbnailCached('thumbnail-0')).resolves.toMatchObject({ dataUrl: 'thumbnail-data-0' })
    cacheThumbnail('thumbnail-80', {
      dataUrl: 'thumbnail-data-80',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })
    db.getStoredFreshImageThumbnail.mockResolvedValue({
      thumbnailDataUrl: 'stored-thumbnail',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })

    await expect(ensureImageThumbnailCached('thumbnail-1')).resolves.toMatchObject({ dataUrl: 'stored-thumbnail' })
    expect(db.getStoredFreshImageThumbnail).toHaveBeenCalledWith('thumbnail-1')
  })

  it('only caches thumbnails from the current version', async () => {
    cacheThumbnail('image', {
      dataUrl: 'stale-thumbnail',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION - 1,
    })
    db.getStoredFreshImageThumbnail.mockResolvedValue({
      thumbnailDataUrl: 'fresh-thumbnail',
      width: 640,
      height: 480,
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })

    await expect(ensureImageThumbnailCached('image')).resolves.toEqual({
      dataUrl: 'fresh-thumbnail',
      width: 640,
      height: 480,
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })
    expect(db.getStoredFreshImageThumbnail).toHaveBeenCalledOnce()

    db.getStoredFreshImageThumbnail.mockClear()
    await ensureImageThumbnailCached('image')
    expect(db.getStoredFreshImageThumbnail).not.toHaveBeenCalled()
  })

  it('deletes individual entries and clears both caches', async () => {
    cacheImage('deleted', 'deleted-data')
    cacheThumbnail('deleted', {
      dataUrl: 'deleted-thumbnail',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })
    deleteImageCacheEntry('deleted')
    db.getStoredFreshImageThumbnail.mockResolvedValueOnce({
      thumbnailDataUrl: 'stored-deleted-thumbnail',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })

    expect(getCachedImage('deleted')).toBeUndefined()
    await expect(ensureImageThumbnailCached('deleted')).resolves.toMatchObject({
      dataUrl: 'stored-deleted-thumbnail',
    })
    expect(db.getStoredFreshImageThumbnail).toHaveBeenCalledWith('deleted')

    cacheImage('cleared', 'cleared-data')
    cacheThumbnail('cleared', {
      dataUrl: 'cleared-thumbnail',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })
    clearImageCaches()
    db.getStoredFreshImageThumbnail.mockClear()
    db.getStoredFreshImageThumbnail.mockResolvedValueOnce({
      thumbnailDataUrl: 'stored-cleared-thumbnail',
      thumbnailVersion: db.CURRENT_THUMBNAIL_VERSION,
    })

    expect(getCachedImage('cleared')).toBeUndefined()
    await expect(ensureImageThumbnailCached('cleared')).resolves.toMatchObject({
      dataUrl: 'stored-cleared-thumbnail',
    })
    expect(db.getStoredFreshImageThumbnail).toHaveBeenCalledWith('cleared')
  })

  it('prioritizes visible thumbnail backfills and notifies subscribers', async () => {
    vi.useFakeTimers()
    db.getImage.mockResolvedValue({ width: 1000, height: 1000 })
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

    expect(db.getImage.mock.calls.map(([id]) => id)).toEqual(['visible', 'background'])
    expect(db.getImageThumbnail.mock.calls.map(([id]) => id)).toEqual(['visible', 'background'])
    expect(onThumbnail).toHaveBeenCalledWith({
      dataUrl: 'visible-thumbnail',
      width: 1000,
      height: 1000,
    })
    unsubscribe()
  })

  it('allows a failed thumbnail backfill to be scheduled again', async () => {
    vi.useFakeTimers()
    db.getImage.mockResolvedValue({ width: 1000, height: 1000 })
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
  })
})
