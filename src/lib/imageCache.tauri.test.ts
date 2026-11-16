import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: {
    CURRENT_THUMBNAIL_VERSION: 2,
    getImage: vi.fn(),
    getImageMeta: vi.fn(),
    getImageDimensions: vi.fn().mockResolvedValue({ width: 1200, height: 800 }),
    getImageThumbnail: vi.fn(),
  },
  getThumbnailFile: vi.fn(),
  getImageStats: vi.fn(),
}))

vi.mock('./platform', () => ({ isTauri: true }))
vi.mock('./db', () => mocks.db)
vi.mock('./dbTauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('./dbTauri')>(),
  getThumbnailFile: mocks.getThumbnailFile,
  getImageStats: mocks.getImageStats,
}))

import { clearImageCaches, ensureImageThumbnailCached, scheduleMissingThumbnailBackfill, subscribeImageThumbnail } from './imageCache'

const file = (thumbnailVersion: number, mime = 'image/webp', bytes = new Uint8Array([1, 2, 3])) => ({
  meta: { mime, width: 1200, height: 800, source: null, createdAt: null, thumbnailVersion },
  bytes,
})

describe('imageCache（客户端）', () => {
  let seq = 0
  const created: Blob[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    created.length = 0
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob)
      return `blob:test-${seq++}`
    })
    URL.revokeObjectURL = vi.fn()
    clearImageCaches()
    mocks.db.getImageMeta.mockResolvedValue({ width: 1000, height: 1000 })
  })

  afterEach(async () => {
    await vi.runAllTimersAsync()
    vi.useRealTimers()
  })

  it('批量补全只处理缺少当前版本缩略图的图片', async () => {
    vi.useFakeTimers()
    mocks.db.getImageThumbnail.mockResolvedValue(undefined)
    mocks.getImageStats.mockResolvedValue([
      { id: 'ok', bytes: 1, width: 100, height: 100, thumbnailBytes: 1, thumbnailVersion: 2 },
      { id: 'stale', bytes: 1, width: 100, height: 100, thumbnailBytes: 1, thumbnailVersion: 1 },
      { id: 'none', bytes: 1, width: 100, height: 100, thumbnailBytes: null, thumbnailVersion: null },
      { id: 'nosize', bytes: 1, width: null, height: null, thumbnailBytes: 1, thumbnailVersion: 2 },
    ])
    await scheduleMissingThumbnailBackfill(['ok', 'stale', 'none', 'nosize'])
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(mocks.db.getImageThumbnail).toHaveBeenCalledTimes(2))
    expect(mocks.db.getImageThumbnail.mock.calls.map(([id]) => id).sort()).toEqual(['none', 'stale'])
    // 宽高取自数据库记录，不为此读取图片文件
    expect(mocks.db.getImageMeta.mock.calls.map(([id]) => id)).toEqual(['stale', 'none'])
    expect(mocks.getImageStats).toHaveBeenCalledOnce()
  })

  it('查询图片信息失败时退回全部补全', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.db.getImageThumbnail.mockResolvedValue(undefined)
    mocks.getImageStats.mockRejectedValue(new Error('unavailable'))
    await scheduleMissingThumbnailBackfill(['a', 'b'])
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(mocks.db.getImageThumbnail).toHaveBeenCalledTimes(2))
  })

  it('缩略图二进制直接生成 Blob URL，不读取 dataUrl', async () => {
    mocks.getThumbnailFile.mockResolvedValue(file(2))
    const thumbnail = await ensureImageThumbnailCached('a')
    expect(thumbnail).toEqual({ src: expect.stringMatching(/^blob:test-/), width: 1200, height: 800, thumbnailVersion: 2 })
    expect(created[0].type).toBe('image/webp')
    expect(new Uint8Array(await created[0].arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))

    // 命中缓存时不再读盘
    await expect(ensureImageThumbnailCached('a')).resolves.toBe(thumbnail)
    expect(mocks.getThumbnailFile).toHaveBeenCalledOnce()
  })

  it('过期或缺失的缩略图不生成 URL', async () => {
    mocks.getThumbnailFile.mockResolvedValueOnce(file(1)).mockResolvedValueOnce(undefined)
    await expect(ensureImageThumbnailCached('old')).resolves.toBeUndefined()
    await expect(ensureImageThumbnailCached('missing')).resolves.toBeUndefined()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('按原文保存的 dataUrl 原样返回', async () => {
    const raw = 'data:image/svg+xml,<svg/>'
    mocks.getThumbnailFile.mockResolvedValue(file(2, 'text/x-data-url', new TextEncoder().encode(raw)))
    await expect(ensureImageThumbnailCached('raw')).resolves.toMatchObject({ src: raw })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('并发读取同一张时只保留一个 URL，多余的立即撤销', async () => {
    mocks.getThumbnailFile.mockResolvedValue(file(2))
    // 两个组件都已订阅（使用中），多余的 URL 从未交给组件，仍应立即撤销
    const releaseA = subscribeImageThumbnail('same', () => {})
    const releaseB = subscribeImageThumbnail('same', () => {})
    const [a, b] = await Promise.all([ensureImageThumbnailCached('same'), ensureImageThumbnailCached('same')])
    expect(a?.src).toBe(b?.src)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(a?.src)
    releaseA()
    releaseB()
  })
})
