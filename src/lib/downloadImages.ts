import { zipSync } from 'fflate'
import type { TaskRecord } from '../types'
import { trackDataTransfer } from './dataOperations'
import { getNumberedFileNameBase, sanitizeFileNamePart } from './exportFileName'
import { ensureImageCached } from './imageCache'
import { apiFetch, isTauri } from './platform'
import { pickSaveDir, saveFile, saveFileToDir, type SaveDir } from './saveFile'

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
}

export interface DownloadImagesResult {
  successCount: number
  failCount: number
  /** 客户端中用户取消了保存对话框，调用方应静默返回 */
  canceled?: boolean
  /** 客户端中的保存位置：保存到目录时为目录，否则为文件路径 */
  location?: string
  /** 最后一个写入失败的原因（Rust 命令的错误），例如默认保存地址不可用 */
  error?: string
}

export interface DownloadImageZipEntry {
  imageId: string
  fileNameBase?: string
}

type TaskOutputZipTask = Pick<TaskRecord, 'id' | 'createdAt' | 'outputImages'>

export { formatExportFileTime } from './exportFileName'

/** 客户端的下载成功提示附上保存位置，便于找到文件 */
export function withSaveLocation(msg: string, location?: string) {
  return location ? `${msg}，已保存到 ${location}` : msg
}

/** Rust 命令的错误是字符串（例如默认保存地址不可用），附上原因；其他错误只提示下载失败 */
export function getDownloadErrorMessage(err: unknown) {
  return typeof err === 'string' ? `下载失败，${err}` : '下载失败'
}

/** dir 为客户端中已选好的保存目录；未传入时，客户端下载多张会先弹出一次目录选择框，单张弹出保存对话框（“默认地址”模式下都直接写入默认保存地址） */
export async function downloadImageIds(imageIds: string[], fileNameBase = 'images', dir?: SaveDir | null): Promise<DownloadImagesResult> {
  if (imageIds.length === 0) return { successCount: 0, failCount: 0 }

  let successCount = 0
  let failCount = 0
  let location: string | undefined
  let error: string | undefined
  const multiple = imageIds.length > 1
  const targetDir = dir ?? (isTauri && multiple ? await pickSaveDir() : null)
  if (isTauri && multiple && !targetDir) return { successCount, failCount, canceled: true }

  // 逐张写入期间计入进行中的数据操作，客户端关闭窗口时会先确认
  return trackDataTransfer(async () => {
    for (let index = 0; index < imageIds.length; index++) {
      try {
        const blob = await getImageBlob(imageIds[index])
        const order = String(index + 1).padStart(2, '0')
        const fileName = multiple
          ? `${fileNameBase}-${order}.${getBlobExtension(blob)}`
          : `${fileNameBase}.${getBlobExtension(blob)}`
        // 客户端写入文件时不经过浏览器清洗文件名，收藏夹名称等可能含有非法字符
        const name = isTauri ? sanitizeFileNamePart(fileName) || `image-${order}.${getBlobExtension(blob)}` : fileName
        const saved = targetDir ? await saveFileToDir(targetDir, blob, name) : await saveFile(blob, name)
        if (!saved) return { successCount, failCount, canceled: true }
        if (isTauri) location = targetDir?.path ?? saved
        successCount++
        if (multiple && !targetDir) await delay(100)
      } catch (err) {
        console.error(err)
        if (typeof err === 'string') error = err
        failCount++
      }
    }

    return { successCount, failCount, location, error }
  })
}

/** dir 为客户端中已选好的保存目录；未传入时客户端弹出保存对话框 */
export async function downloadImageEntriesAsZip(entries: DownloadImageZipEntry[], zipFileNameBase = 'images', dir?: SaveDir | null): Promise<DownloadImagesResult> {
  if (entries.length === 0) return { successCount: 0, failCount: 0 }
  // 打包期间计入进行中的数据操作，客户端关闭窗口时会先确认
  return trackDataTransfer(async () => {
    let successCount = 0
    let failCount = 0
    let location: string | undefined
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
      const fileName = `${sanitizeFileNamePart(zipFileNameBase) || 'images'}.zip`
      if (dir) {
        await saveFileToDir(dir, zipped, fileName)
        location = dir.path
      } else if (isTauri) {
        const saved = await saveFile(zipped, fileName)
        if (!saved) return { successCount: 0, failCount, canceled: true }
        location = saved
      } else {
        const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
        await saveFile(new Blob([buffer], { type: 'application/zip' }), fileName)
      }
    }

    return { successCount, failCount, location }
  })
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

  const res = await apiFetch(src)
  if (!res.ok && !src.startsWith('data:')) throw new Error(`读取图片失败：${imageIdOrUrl}`)
  return await res.blob()
}

function getBlobExtension(blob: Blob): string {
  return MIME_EXTENSIONS[blob.type.toLowerCase()] ?? blob.type.split('/')[1] ?? 'png'
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

