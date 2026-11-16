import { DEFAULT_PARAMS, type StoredImage, type StoredImageThumbnail, type TaskRecord } from '../types'
import * as indexedDbBackend from './dbIndexedDb'
import * as tauriBackend from './dbTauri'
import { isTauri } from './platform'
import { normalizeTaskImageMetadata } from './taskState'
import { hasImageDimensions } from './size'

const THUMBNAIL_MAX_SIZE = 720
const THUMBNAIL_QUALITY = 0.9
const THUMBNAIL_VERSION = 2

export const CURRENT_THUMBNAIL_VERSION = THUMBNAIL_VERSION

const imageDimensionsPending = new Map<string, Promise<{ width: number; height: number } | undefined>>()

// 底层存取按平台转发：网页版用 IndexedDB，客户端用 Rust 侧的 SQLite 与图片文件；标注类型以约束两套实现接口一致
const backend: typeof indexedDbBackend = isTauri ? tauriBackend : indexedDbBackend

export const {
  deleteTask,
  commitTaskDeletion,
  clearTasks,
  getAllAgentConversations,
  putAgentConversation,
  clearAgentConversations,
  replaceAgentConversations,
  getImage,
  getImageMeta,
  updateImageDimensions,
  getStoredImageThumbnail,
  putImageThumbnail,
  getAllImages,
  getAllImageIds,
  putImage,
  deleteImage,
  clearImages,
} = backend

export function putTask(task: TaskRecord): Promise<IDBValidKey> {
  return backend.putTask(normalizeTaskImageMetadata(task))
}

/** 旧任务记录没有 GPT Image 2.6 参数，帧参数也可能为 null，读出时补全，之后使用的任务参数都是完整的 */
export async function getAllTasks(): Promise<TaskRecord[]> {
  return (await backend.getAllTasks()).map((task) => ({
    ...task,
    params: {
      ...task.params,
      complexity: task.params.complexity ?? DEFAULT_PARAMS.complexity,
      frame_count: task.params.frame_count ?? DEFAULT_PARAMS.frame_count,
      frame_duration_ms: task.params.frame_duration_ms ?? DEFAULT_PARAMS.frame_duration_ms,
    },
  }))
}

// ===== Thumbnails =====

async function saveImageDimensions(id: string, size: { width: number; height: number }) {
  try {
    return await updateImageDimensions(id, size.width, size.height) ? size : undefined
  } catch (err) {
    console.warn('保存图片尺寸失败', id, err)
    return size
  }
}

/** 优先复用原图元数据；旧记录缺失时按需补全，同一张图片的并发读取共用一次解析。 */
export async function getImageDimensions(id: string): Promise<{ width: number; height: number } | undefined> {
  const pending = imageDimensionsPending.get(id)
  if (pending) return pending
  const request = (async () => {
    const meta = await getImageMeta(id)
    if (!meta) return undefined
    if (hasImageDimensions(meta)) return { width: meta.width, height: meta.height }
    const thumbnail = await getStoredImageThumbnail(id)
    if (hasImageDimensions(thumbnail)) {
      return saveImageDimensions(id, { width: thumbnail.width, height: thumbnail.height })
    }
    const image = await getImage(id)
    if (!image) return undefined
    const decoded = await loadImage(image.dataUrl)
    const size = { width: decoded.naturalWidth, height: decoded.naturalHeight }
    if (!hasImageDimensions(size)) return undefined
    return saveImageDimensions(id, size)
  })().catch((err) => {
    console.warn('读取图片尺寸失败', id, err)
    return undefined
  }).finally(() => {
    imageDimensionsPending.delete(id)
  })
  imageDimensionsPending.set(id, request)
  return request
}

export async function getImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const existingThumbnail = await getStoredImageThumbnail(id)
  if (existingThumbnail?.thumbnailVersion === THUMBNAIL_VERSION) {
    const size = await getImageDimensions(id)
    if (size && (existingThumbnail.width !== size.width || existingThumbnail.height !== size.height)) {
      return { ...existingThumbnail, ...size }
    }
    return existingThumbnail
  }

  const image = await getImage(id)
  if (!image) return undefined
  const legacyImage = image as StoredImage & Partial<StoredImageThumbnail>
  if (legacyImage.thumbnailDataUrl && legacyImage.thumbnailVersion === THUMBNAIL_VERSION && hasImageDimensions(legacyImage)) {
    const thumbnail: StoredImageThumbnail = {
      id,
      thumbnailDataUrl: legacyImage.thumbnailDataUrl,
      width: legacyImage.width,
      height: legacyImage.height,
      thumbnailVersion: THUMBNAIL_VERSION,
    }
    try {
      await putImageThumbnail(thumbnail)
    } catch (err) {
      console.warn('保存缩略图失败', id, err)
    }
    return thumbnail
  }

  const metadata = await safeCreateImageThumbnail(image.dataUrl)
  if (!metadata.thumbnailDataUrl) return undefined
  const thumbnail: StoredImageThumbnail = {
    id,
    thumbnailDataUrl: metadata.thumbnailDataUrl,
    width: metadata.width,
    height: metadata.height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
  try {
    await putImageThumbnail(thumbnail)
  } catch (err) {
    console.warn('保存缩略图失败', id, err)
  }
  if (metadata.width && metadata.height && (image.width !== metadata.width || image.height !== metadata.height)) {
    if (!await saveImageDimensions(id, { width: metadata.width, height: metadata.height })) return undefined
  }
  return thumbnail
}

// ===== Image hashing & dedup =====

export async function hashDataUrl(dataUrl: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return hashDataUrlFallback(dataUrl)
  }

  const data = new TextEncoder().encode(dataUrl)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hashDataUrlFallback(dataUrl: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193

  for (let i = 0; i < dataUrl.length; i++) {
    const code = dataUrl.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= code
    h2 = Math.imul(h2, 0x27d4eb2d)
  }

  return `fallback-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

export interface StoreImageResult {
  id: string
  width?: number
  height?: number
}

/**
 * 存储图片，若已存在（按 hash 去重）则跳过。
 * 返回 image id 及图片真实宽高。
 */
export async function storeImage(dataUrl: string, source: NonNullable<StoredImage['source']> = 'upload'): Promise<string> {
  return (await storeImageWithSize(dataUrl, source)).id
}

export async function storeImageWithSize(dataUrl: string, source: NonNullable<StoredImage['source']> = 'upload'): Promise<StoreImageResult> {
  const id = await hashDataUrl(dataUrl)
  const existing = await getImage(id)
  if (!existing) {
    const thumbnail = await safeCreateImageThumbnail(dataUrl)
    await putImage({
      id,
      dataUrl,
      createdAt: Date.now(),
      source,
      width: thumbnail.width,
      height: thumbnail.height,
    })
    if (thumbnail.thumbnailDataUrl) {
      await putImageThumbnail({
        id,
        thumbnailDataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: THUMBNAIL_VERSION,
      })
    }
    return { id, width: thumbnail.width, height: thumbnail.height }
  }

  if ((await getStoredImageThumbnail(id))?.thumbnailVersion !== THUMBNAIL_VERSION) {
    const thumbnail = await safeCreateImageThumbnail(existing.dataUrl)
    const width = thumbnail.width ?? existing.width
    const height = thumbnail.height ?? existing.height
    if (thumbnail.width && thumbnail.height && (existing.width !== thumbnail.width || existing.height !== thumbnail.height)) {
      await putImage({ ...existing, width: thumbnail.width, height: thumbnail.height })
    }
    if (thumbnail.thumbnailDataUrl) {
      await putImageThumbnail({
        id,
        thumbnailDataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: THUMBNAIL_VERSION,
      })
    }
    return { id, width, height }
  }
  return { id, ...await getImageDimensions(id) }
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = dataUrl
  })
}

async function createImageThumbnail(dataUrl: string): Promise<Omit<StoredImageThumbnail, 'id'>> {
  const image = await loadImage(dataUrl)
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (width <= 0 || height <= 0) throw new Error('图片尺寸无效')

  const scale = Math.min(1, THUMBNAIL_MAX_SIZE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

  return {
    thumbnailDataUrl: canvas.toDataURL('image/webp', THUMBNAIL_QUALITY),
    width,
    height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
}

async function safeCreateImageThumbnail(dataUrl: string): Promise<Partial<Omit<StoredImageThumbnail, 'id'>>> {
  try {
    return await createImageThumbnail(dataUrl)
  } catch {
    return {}
  }
}
