import { strFromU8, strToU8, type AsyncUnzipOptions, unzip, zip } from 'fflate'

import type { AgentConversation, AppSettings, ExportData, FavoriteCollection, StoredImage, StoredImageThumbnail, TaskRecord } from '../types'
import { bytesToDataUrl, dataUrlToBytes } from './dataUrl'
import { getNumberedFileNameBase, sanitizeFileNamePart } from './exportFileName'
import { getDataUrlDecodedByteSize } from './imageApiShared'

type ZipFiles = Record<string, Uint8Array | [Uint8Array, { mtime: Date; level?: 0 }]>

export const MAX_EXPORT_ZIP_BYTES = 2 * 1024 * 1024 * 1024
const DEFAULT_EXPORT_PART_BYTES = 256 * 1024 * 1024
const EXPORT_PART_SAFETY_BYTES = 128 * 1024 * 1024
const ZIP_BASE_OVERHEAD_BYTES = 1024 * 1024
const ZIP_ENTRY_OVERHEAD_BYTES = 1024

export interface BuildExportZipOptions {
  exportConfig?: boolean
  exportTasks?: boolean
}

export interface BuildExportZipParams {
  options: BuildExportZipOptions
  exportedAt: number
  settings: AppSettings
  tasks: TaskRecord[]
  images: StoredImage[]
  thumbnailsByImageId: Map<string, StoredImageThumbnail>
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
  agentConversations: AgentConversation[]
  imageTasks?: TaskRecord[]
  includeManifestData?: boolean
  backupPart?: ExportData['backupPart']
}

export interface ExportZipContents {
  manifest: ExportData
  files: Record<string, Uint8Array>
}

export interface ExportImageSize {
  id: string
  bytes: number
}

export interface ExportZipPlanPart {
  imageIds: string[]
  tasks: TaskRecord[]
  agentConversations: AgentConversation[]
  includeBaseData: boolean
}

export async function buildExportZip(params: BuildExportZipParams) {
  const exportedAtDate = new Date(params.exportedAt)
  const imageTasks = params.options.exportTasks ? params.imageTasks ?? params.tasks : []
  const imageCreatedAtFallback = getImageCreatedAtFallback(imageTasks)
  const imageFileNameBases = getImageFileNameBases(imageTasks)
  const imageFiles: ExportData['imageFiles'] = {}
  const thumbnailFiles: NonNullable<ExportData['thumbnailFiles']> = {}
  const zipFiles: ZipFiles = {}
  const usedImagePaths = new Set<string>()

  if (params.options.exportTasks) {
    for (const img of params.images) {
      const { ext, bytes } = dataUrlToBytes(img.dataUrl)
      const path = getUniqueImagePath(imageFileNameBases.get(img.id) || `image-${img.id}`, ext, usedImagePaths)
      const pathBase = path.slice('images/'.length, -(ext.length + 1))
      const createdAt = img.createdAt ?? imageCreatedAtFallback.get(img.id) ?? params.exportedAt
      imageFiles[img.id] = {
        path,
        createdAt,
        source: img.source,
        width: img.width,
        height: img.height,
      }
      zipFiles[path] = [bytes, { mtime: new Date(createdAt), level: 0 }]

      const thumbnail = params.thumbnailsByImageId.get(img.id)
      if (thumbnail?.thumbnailDataUrl) {
        const { ext: thumbnailExt, bytes: thumbnailBytes } = dataUrlToBytes(thumbnail.thumbnailDataUrl)
        const thumbnailPath = `thumbnails/${pathBase}.${thumbnailExt}`
        imageFiles[img.id].width = imageFiles[img.id].width ?? thumbnail.width
        imageFiles[img.id].height = imageFiles[img.id].height ?? thumbnail.height
        thumbnailFiles[img.id] = {
          path: thumbnailPath,
          width: thumbnail.width,
          height: thumbnail.height,
          thumbnailVersion: thumbnail.thumbnailVersion,
        }
        zipFiles[thumbnailPath] = [thumbnailBytes, { mtime: new Date(createdAt), level: 0 }]
      }
    }
  }

  const manifest: ExportData = {
    version: 3,
    exportedAt: exportedAtDate.toISOString(),
  }

  if (params.backupPart) manifest.backupPart = params.backupPart
  if (params.options.exportConfig && params.includeManifestData !== false) manifest.settings = params.settings
  if (params.options.exportTasks) {
    if (params.includeManifestData !== false || params.tasks.length) manifest.tasks = params.tasks
    if (params.includeManifestData !== false || params.agentConversations.length) manifest.agentConversations = params.agentConversations
    if (params.includeManifestData !== false) {
      manifest.favoriteCollections = params.favoriteCollections
      manifest.defaultFavoriteCollectionId = params.defaultFavoriteCollectionId
    }
    manifest.imageFiles = imageFiles
    manifest.thumbnailFiles = thumbnailFiles
  }

  zipFiles['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { mtime: exportedAtDate }]

  return {
    manifest,
    bytes: await new Promise<Uint8Array>((resolve, reject) => {
      zip(zipFiles, { level: 6 }, (err, bytes) => {
        if (err) {
          reject(err)
          return
        }
        resolve(bytes)
      })
    }),
  }
}

export function getExportZipPlan(
  params: Omit<BuildExportZipParams, 'images' | 'thumbnailsByImageId'>,
  images: ExportImageSize[],
  options: { maxBytes?: number; partBytes?: number } = {},
) {
  const maxBytes = options.maxBytes ?? MAX_EXPORT_ZIP_BYTES
  const safetyBytes = Math.min(EXPORT_PART_SAFETY_BYTES, Math.floor(maxBytes * 0.1))
  const partBytes = Math.min(options.partBytes ?? DEFAULT_EXPORT_PART_BYTES, maxBytes - safetyBytes)
  const manifestBytes = getBaseManifestEstimatedBytes(params)
  const plannedTasks = params.options.exportTasks ? params.tasks : []
  const plannedConversations = params.options.exportTasks ? params.agentConversations : []
  const taskBytes = plannedTasks.map(getJsonEstimatedBytes)
  const conversationBytes = plannedConversations.map(getJsonEstimatedBytes)
  const plannedImages = params.options.exportTasks ? images : []
  const estimatedBytes = manifestBytes
    + taskBytes.reduce((total, bytes) => total + bytes, 0)
    + conversationBytes.reduce((total, bytes) => total + bytes, 0)
    + plannedImages.reduce((total, image) => total + image.bytes, 0)
  if (estimatedBytes < partBytes) {
    return [{
      imageIds: plannedImages.map((image) => image.id),
      tasks: plannedTasks,
      agentConversations: plannedConversations,
      includeBaseData: true,
    }]
  }

  const parts: ExportZipPlanPart[] = [{ imageIds: [], tasks: [], agentConversations: [], includeBaseData: true }]
  const sizes = [manifestBytes]
  const addItem = (bytes: number, errorMessage: string, append: (part: ExportZipPlanPart) => void) => {
    let index = parts.length - 1
    const hasItems = parts[index].imageIds.length > 0 || parts[index].tasks.length > 0 || parts[index].agentConversations.length > 0
    if (hasItems && sizes[index] + bytes >= partBytes) {
      parts.push({ imageIds: [], tasks: [], agentConversations: [], includeBaseData: false })
      sizes.push(ZIP_BASE_OVERHEAD_BYTES)
      index++
    }
    if (sizes[index] + bytes >= maxBytes) throw new Error(errorMessage)
    append(parts[index])
    sizes[index] += bytes
  }

  for (let index = 0; index < plannedTasks.length; index++) {
    addItem(taskBytes[index], '单条任务或 Agent 对话超过 2 GB，无法生成备份。', (part) => part.tasks.push(plannedTasks[index]))
  }
  for (let index = 0; index < plannedConversations.length; index++) {
    addItem(conversationBytes[index], '单条任务或 Agent 对话超过 2 GB，无法生成备份。', (part) => part.agentConversations.push(plannedConversations[index]))
  }
  for (const image of plannedImages) {
    addItem(image.bytes, `图片 ${image.id} 过大，无法放入小于 2 GB 的备份分片。`, (part) => part.imageIds.push(image.id))
  }
  return parts
}

export function createExportBlob(bytes: Uint8Array): Blob {
  if (bytes.byteLength >= MAX_EXPORT_ZIP_BYTES) {
    throw new Error('生成的备份文件超过浏览器支持的大小，请重试。')
  }
  const parts: BlobPart[] = []
  const chunkBytes = 256 * 1024 * 1024
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    parts.push(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength)) as BlobPart)
  }
  return new Blob(parts, { type: 'application/zip' })
}

export async function readExportZipManifest(bytes: Uint8Array, validateFiles = true): Promise<ExportData> {
  const entryNames = new Set<string>()
  const files = await unzipFiles(bytes, { filter: (file) => {
    if (validateFiles) entryNames.add(file.name)
    return file.name === 'manifest.json'
  } })
  const manifestBytes = files['manifest.json']
  if (!manifestBytes) throw new Error('ZIP 中缺少 manifest.json')
  const manifest = JSON.parse(strFromU8(manifestBytes)) as ExportData
  if (validateFiles) assertExportZipFiles(manifest, (path) => entryNames.has(path))
  return manifest
}

export async function readExportZip(bytes: Uint8Array): Promise<ExportZipContents> {
  const files = await unzipFiles(bytes)
  const manifestBytes = files['manifest.json']
  if (!manifestBytes) throw new Error('ZIP 中缺少 manifest.json')
  const manifest = JSON.parse(strFromU8(manifestBytes)) as ExportData
  assertExportZipFiles(manifest, (path) => files[path] != null)

  return {
    manifest,
    files,
  }
}

function unzipFiles(bytes: Uint8Array, options: AsyncUnzipOptions = {}) {
  return new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(bytes, options, (err, files) => {
      if (err) {
        reject(err)
        return
      }
      resolve(files)
    })
  })
}

function assertExportZipFiles(manifest: ExportData, hasFile: (path: string) => boolean) {
  const paths = [
    ...Object.values(manifest.imageFiles ?? {}).map((file) => file.path),
    ...Object.values(manifest.thumbnailFiles ?? {}).map((file) => file.path),
  ]
  const missingPath = paths.find((path) => !hasFile(path))
  if (missingPath) throw new Error(`ZIP 中缺少 ${missingPath}`)
}

function getBaseManifestEstimatedBytes(params: Omit<BuildExportZipParams, 'images' | 'thumbnailsByImageId'>) {
  const manifest = {
    version: 3,
    exportedAt: new Date(params.exportedAt).toISOString(),
    ...(params.options.exportConfig ? { settings: params.settings } : {}),
    ...(params.options.exportTasks ? {
      tasks: [],
      favoriteCollections: params.favoriteCollections,
      defaultFavoriteCollectionId: params.defaultFavoriteCollectionId,
      agentConversations: [],
    } : {}),
  }
  return ZIP_BASE_OVERHEAD_BYTES + strToU8(JSON.stringify(manifest)).byteLength
}

function getJsonEstimatedBytes(value: unknown) {
  return strToU8(JSON.stringify(value)).byteLength + ZIP_ENTRY_OVERHEAD_BYTES
}

export function getExportImageEstimatedBytes(image: StoredImage, thumbnail?: StoredImageThumbnail) {
  return getDataUrlDecodedByteSize(image.dataUrl)
    + (thumbnail?.thumbnailDataUrl ? getDataUrlDecodedByteSize(thumbnail.thumbnailDataUrl) : 0)
    + ZIP_ENTRY_OVERHEAD_BYTES * (thumbnail?.thumbnailDataUrl ? 2 : 1)
}

export function readExportZipFileAsDataUrl(files: Record<string, Uint8Array>, path: string): string | null {
  const bytes = files[path]
  if (!bytes) return null
  return bytesToDataUrl(bytes, path)
}

function getImageCreatedAtFallback(tasks: TaskRecord[]) {
  const imageCreatedAtFallback = new Map<string, number>()

  for (const task of tasks) {
    for (const id of [
      ...(task.inputImageIds || []),
      ...(task.maskImageId ? [task.maskImageId] : []),
      ...(task.outputImages || []),
      ...(task.transparentOriginalImages || []),
      ...(task.streamPartialImageIds || []),
    ]) {
      if (!id) continue
      const prev = imageCreatedAtFallback.get(id)
      if (prev == null || task.createdAt < prev) imageCreatedAtFallback.set(id, task.createdAt)
    }
  }

  return imageCreatedAtFallback
}

function getImageFileNameBases(tasks: TaskRecord[]) {
  const bases = new Map<string, string>()

  for (const task of tasks) addImageFileNameBases(bases, task.outputImages || [], `task-${task.id}`)
  for (const task of tasks) addImageFileNameBases(bases, task.transparentOriginalImages || [], `task-${task.id}-orig`)
  for (const task of tasks) addImageFileNameBases(bases, task.streamPartialImageIds || [], `task-${task.id}-partial`)
  for (const task of tasks) addImageFileNameBases(bases, task.inputImageIds || [], `task-${task.id}-input`)
  for (const task of tasks) {
    if (task.maskImageId && !bases.has(task.maskImageId)) bases.set(task.maskImageId, `task-${task.id}-mask`)
  }

  return bases
}

function addImageFileNameBases(bases: Map<string, string>, imageIds: string[], fileNameBase: string) {
  const ids = imageIds.filter(Boolean)
  for (let index = 0; index < ids.length; index++) {
    if (bases.has(ids[index])) continue
    bases.set(ids[index], getNumberedFileNameBase(fileNameBase, index, ids.length))
  }
}

function getUniqueImagePath(fileNameBase: string, ext: string, usedPaths: Set<string>) {
  const base = sanitizeFileNamePart(fileNameBase) || 'image'
  let path = `images/${base}.${ext}`
  let duplicateIndex = 2
  while (usedPaths.has(path)) {
    path = `images/${base}-${String(duplicateIndex).padStart(2, '0')}.${ext}`
    duplicateIndex++
  }
  usedPaths.add(path)
  return path
}
