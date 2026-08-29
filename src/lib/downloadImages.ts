import { zipSync } from 'fflate'
import type { ProjectCanvasCrop, TaskRecord } from '../types'
import { ensureImageCached } from '../store'
import { canvasToBlob, loadImage } from './canvasImage'
import { getNumberedFileNameBase, sanitizeFileNamePart } from './exportFileName'

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
}

export interface DownloadImagesResult {
  successCount: number
  failCount: number
}

export interface DownloadImageZipEntry {
  imageId: string
  fileNameBase?: string
}

export type ImageExportFormat = 'png' | 'jpg' | 'svg' | 'psd'

export interface ImageExportOptions {
  crop?: ProjectCanvasCrop
  scale?: number
  rotation?: number
  flipX?: boolean
  flipY?: boolean
}

type TaskOutputZipTask = Pick<TaskRecord, 'id' | 'createdAt' | 'outputImages'>

export { formatExportFileTime } from './exportFileName'

export async function downloadImageIds(imageIds: string[], fileNameBase = 'images'): Promise<DownloadImagesResult> {
  if (imageIds.length === 0) return { successCount: 0, failCount: 0 }

  let successCount = 0
  let failCount = 0
  const multiple = imageIds.length > 1

  for (let index = 0; index < imageIds.length; index++) {
    try {
      const blob = await getImageBlob(imageIds[index])
      const order = String(index + 1).padStart(2, '0')
      const base = getFileNameBase(fileNameBase) || (multiple ? 'images' : 'image')
      const fileName = multiple
        ? `${base}-${order}.${getBlobExtension(blob)}`
        : `${base}.${getBlobExtension(blob)}`
      triggerDownload(blob, fileName)
      successCount++
      if (multiple) await delay(100)
    } catch (err) {
      console.error(err)
      failCount++
    }
  }

  return { successCount, failCount }
}

/** 将单张图片导出为指定格式并按图片名下载。 */
export async function exportImage(imageIdOrUrl: string, fileNameBase: string, format: ImageExportFormat, options: ImageExportOptions = {}): Promise<void> {
  const sourceBlob = await getImageBlob(imageIdOrUrl)
  const base = getFileNameBase(fileNameBase) || 'image'
  const canvas = await renderFinalCanvas(sourceBlob, options)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  if (format === 'jpg') {
    const flattened = document.createElement('canvas')
    flattened.width = canvas.width
    flattened.height = canvas.height
    const flattenedCtx = flattened.getContext('2d')
    if (!flattenedCtx) throw new Error('当前浏览器不支持 Canvas')
    flattenedCtx.fillStyle = '#ffffff'
    flattenedCtx.fillRect(0, 0, flattened.width, flattened.height)
    flattenedCtx.drawImage(canvas, 0, 0)
    const blob = await canvasToBlob(flattened, 'image/jpeg', 0.92)
    triggerDownload(blob, `${base}.jpg`)
    return
  }

  if (format === 'svg') {
    const dataUrl = await blobToDataUrl(await canvasToBlob(canvas, 'image/png'))
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><image href="${dataUrl}" width="100%" height="100%" /></svg>`
    triggerDownload(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${base}.svg`)
    return
  }

  if (format === 'psd') {
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
    triggerDownload(new Blob([encodePsd(pixels.data, canvas.width, canvas.height)], { type: 'image/vnd.adobe.photoshop' }), `${base}.psd`)
    return
  }

  const blob = await canvasToBlob(canvas, 'image/png')
  triggerDownload(blob, `${base}.${format}`)
}

export async function downloadImageEntriesAsZip(entries: DownloadImageZipEntry[], zipFileNameBase = 'images'): Promise<DownloadImagesResult> {
  if (entries.length === 0) return { successCount: 0, failCount: 0 }

  let successCount = 0
  let failCount = 0
  const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}
  const usedNames = new Set<string>()

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    try {
      const blob = await getImageBlob(entry.imageId)
      const order = String(index + 1).padStart(2, '0')
      const base = sanitizeFileNamePart(entry.fileNameBase || `image-${order}`) || `image-${order}`
      const ext = getBlobExtension(blob)
      let fileName = `${base}.${ext}`
      let duplicateIndex = 2
      while (usedNames.has(fileName)) {
        fileName = `${base}-${String(duplicateIndex).padStart(2, '0')}.${ext}`
        duplicateIndex++
      }
      usedNames.add(fileName)
      zipFiles[fileName] = [new Uint8Array(await blob.arrayBuffer()), { mtime: new Date() }]
      successCount++
    } catch (err) {
      console.error(err)
      failCount++
    }
  }

  if (successCount > 0) {
    const zipped = zipSync(zipFiles, { level: 6 })
    const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
    triggerDownload(new Blob([buffer], { type: 'application/zip' }), `${sanitizeFileNamePart(zipFileNameBase) || 'images'}.zip`)
  }

  return { successCount, failCount }
}

export function getTaskOutputImageZipEntries(tasks: TaskOutputZipTask[]): DownloadImageZipEntry[] {
  return [...tasks]
    .sort((a, b) => b.createdAt - a.createdAt)
    .flatMap((task) => getImageZipEntries(task.outputImages || [], `task-${task.id}`))
}

export function getImageZipEntries(imageIds: string[], fileNameBase = 'image'): DownloadImageZipEntry[] {
  return imageIds.map((imageId, index) => ({
    imageId,
    fileNameBase: getNumberedFileNameBase(fileNameBase, index, imageIds.length),
  }))
}

async function getImageBlob(imageIdOrUrl: string): Promise<Blob> {
  let src = imageIdOrUrl
  if (!imageIdOrUrl.startsWith('data:') && !imageIdOrUrl.startsWith('http://') && !imageIdOrUrl.startsWith('https://')) {
    src = await ensureImageCached(imageIdOrUrl) ?? imageIdOrUrl
  }

  const res = await fetch(src)
  if (!res.ok && !src.startsWith('data:')) throw new Error(`读取图片失败：${imageIdOrUrl}`)
  return await res.blob()
}

function getFileNameBase(value: string): string {
  const sanitized = sanitizeFileNamePart(value)
  return sanitized.replace(/\.(?:png|jpe?g|webp|gif|svg|psd)$/i, '')
}

async function loadBlobImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  try {
    return await loadImage(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function renderFinalCanvas(sourceBlob: Blob, options: ImageExportOptions): Promise<HTMLCanvasElement> {
  const image = await loadBlobImage(sourceBlob)
  const crop = options.crop ?? { x: 0, y: 0, width: 1, height: 1 }
  const sourceX = Math.round(image.naturalWidth * crop.x)
  const sourceY = Math.round(image.naturalHeight * crop.y)
  const sourceWidth = Math.max(1, Math.round(image.naturalWidth * crop.width))
  const sourceHeight = Math.max(1, Math.round(image.naturalHeight * crop.height))
  const scale = Math.max(0.01, options.scale ?? 1)
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const rotation = (options.rotation ?? 0) * Math.PI / 180
  const cos = Math.abs(Math.cos(rotation))
  const sin = Math.abs(Math.sin(rotation))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width * cos + height * sin))
  canvas.height = Math.max(1, Math.ceil(width * sin + height * cos))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate(rotation)
  ctx.scale(options.flipX ? -1 : 1, options.flipY ? -1 : 1)
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, -width / 2, -height / 2, width, height)
  return canvas
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`
}

function encodePsd(pixels: Uint8ClampedArray, width: number, height: number): ArrayBuffer {
  const headerSize = 26
  const sectionSize = 4
  const compressionSize = 2
  const output = new Uint8Array(headerSize + sectionSize * 3 + compressionSize + pixels.length)
  const view = new DataView(output.buffer)
  let offset = 0
  output.set([0x38, 0x42, 0x50, 0x53], offset)
  offset += 4
  view.setUint16(offset, 1); offset += 2
  offset += 6
  view.setUint16(offset, 4); offset += 2
  view.setUint32(offset, height); offset += 4
  view.setUint32(offset, width); offset += 4
  view.setUint16(offset, 8); offset += 2
  view.setUint16(offset, 3); offset += 2
  view.setUint32(offset, 0); offset += 4
  view.setUint32(offset, 0); offset += 4
  view.setUint32(offset, 0); offset += 4
  view.setUint16(offset, 0); offset += 2

  const channelSize = width * height
  const channels = [0, 1, 2, 3]
  for (const channel of channels) {
    for (let pixel = 0; pixel < channelSize; pixel++) output[offset++] = pixels[pixel * 4 + channel]
  }
  return output.buffer
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function getBlobExtension(blob: Blob): string {
  return MIME_EXTENSIONS[blob.type.toLowerCase()] ?? blob.type.split('/')[1] ?? 'png'
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
