import { clearImages, clearTasks, getAllImages, getAllTasks, putImage, putTask } from './db'
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate'
import { DEFAULT_SETTINGS, type AppSettings, type ExportData, type StoredImage, type TaskRecord } from '../types'

export interface SyncSnapshot {
  version: number
  exportedAt: number
  settings: AppSettings
  tasks: TaskRecord[]
  images: StoredImage[]
  deletedTaskIds: Record<string, number>
  deletedImageIds: Record<string, number>
}

export interface SnapshotImageFile {
  path: string
  ext: string
  bytes: Uint8Array
  createdAt: number
  updatedAt: number
  source?: 'upload' | 'generated'
}

const SNAPSHOT_VERSION = 3
const TOMBSTONE_STORAGE_KEY = 'gpt-image-playground-sync-tombstones'

export interface SyncTombstones {
  deletedTaskIds: Record<string, number>
  deletedImageIds: Record<string, number>
}

export async function buildLocalSnapshot(settings: AppSettings): Promise<SyncSnapshot> {
  const exportedAt = Date.now()
  const tasks = (await getAllTasks()).map((task) => normalizeTask(task, exportedAt))
  const images = (await getAllImages()).map((image) => normalizeImage(image, exportedAt))
  const tombstones = readSyncTombstones()

  return {
    version: SNAPSHOT_VERSION,
    exportedAt,
    settings: normalizeSettings(settings, exportedAt),
    tasks,
    images,
    deletedTaskIds: { ...tombstones.deletedTaskIds },
    deletedImageIds: { ...tombstones.deletedImageIds },
  }
}

export function mergeSnapshots(local: SyncSnapshot, remote: SyncSnapshot): SyncSnapshot {
  const exportedAt = Math.max(local.exportedAt, remote.exportedAt)
  const settings = pickNewerSettings(local.settings, remote.settings)
  const deletedTaskIds = mergeTombstones(local.deletedTaskIds, remote.deletedTaskIds)
  const deletedImageIds = mergeTombstones(local.deletedImageIds, remote.deletedImageIds)
  const tasks = mergeRecords(local.tasks, remote.tasks, getTaskTimestamp).filter((task) => {
    const deletedAt = deletedTaskIds[task.id]
    return deletedAt == null || deletedAt < getTaskTimestamp(task)
  })
  const images = mergeRecords(local.images, remote.images, getImageTimestamp).filter((image) => {
    const deletedAt = deletedImageIds[image.id]
    return deletedAt == null || deletedAt < getImageTimestamp(image)
  })

  return {
    version: SNAPSHOT_VERSION,
    exportedAt,
    settings,
    tasks,
    images,
    deletedTaskIds,
    deletedImageIds,
  }
}

export async function replaceLocalData(snapshot: SyncSnapshot) {
  await clearTasks()
  await clearImages()

  for (const image of snapshot.images) {
    await putImage(image)
  }

  for (const task of snapshot.tasks) {
    await putTask(task)
  }
}

export function snapshotToExportData(snapshot: SyncSnapshot): ExportData {
  const imageFiles: ExportData['imageFiles'] = {}

  for (const img of snapshot.images) {
    const { ext } = parseDataUrl(img.dataUrl)
    imageFiles[img.id] = {
      path: getRemoteImagePath(img.id, ext),
      createdAt: img.createdAt,
      updatedAt: img.updatedAt,
      source: img.source,
    }
  }

  return {
    version: SNAPSHOT_VERSION,
    exportedAt: new Date(snapshot.exportedAt).toISOString(),
    settings: snapshot.settings,
    tasks: snapshot.tasks,
    deletedTaskIds: { ...snapshot.deletedTaskIds },
    deletedImageIds: { ...snapshot.deletedImageIds },
    imageFiles,
  }
}

export function snapshotToZipBlob(snapshot: SyncSnapshot): Blob {
  const exportedAt = snapshot.exportedAt
  const exportData = snapshotToExportData(snapshot)
  const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}

  for (const img of snapshot.images) {
    const { bytes, ext } = parseDataUrl(img.dataUrl)
    const path = `images/${img.id}.${ext}`
    zipFiles[path] = [bytes, { mtime: new Date(img.updatedAt ?? img.createdAt ?? exportedAt) }]
  }

  zipFiles['manifest.json'] = [strToU8(JSON.stringify(exportData, null, 2)), { mtime: new Date(exportedAt) }]

  const zipped = zipSync(zipFiles, { level: 6 })
  return new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
}

export function snapshotToDirectoryManifest(snapshot: SyncSnapshot): ExportData {
  return snapshotToExportData(snapshot)
}

export function snapshotToDirectoryFiles(snapshot: SyncSnapshot): SnapshotImageFile[] {
  const exportedAt = snapshot.exportedAt
  return snapshot.images.map((img) => {
    const { bytes, ext } = parseDataUrl(img.dataUrl)
    return {
      path: getRemoteImagePath(img.id, ext),
      ext,
      bytes,
      createdAt: img.updatedAt ?? img.createdAt ?? exportedAt,
      updatedAt: img.updatedAt ?? img.createdAt ?? exportedAt,
      source: img.source,
    }
  })
}

export function snapshotToManifestJson(snapshot: SyncSnapshot) {
  return JSON.stringify(snapshotToDirectoryManifest(snapshot), null, 2)
}

export async function readSnapshotFromBlob(blob: Blob): Promise<SyncSnapshot> {
  const buffer = await blob.arrayBuffer()
  return readSnapshotFromBuffer(buffer)
}

export function dataUrlToBinary(dataUrl: string) {
  return parseDataUrl(dataUrl)
}

export function binaryToDataUrl(bytes: Uint8Array, filePath: string): string {
  return bytesToDataUrl(bytes, filePath)
}

export async function readSnapshotFromFile(file: File): Promise<SyncSnapshot> {
  return readSnapshotFromBlob(file)
}

export async function snapshotFromManifest(
  manifest: unknown,
  readImageBytes: (path: string) => Promise<Uint8Array | null>,
): Promise<SyncSnapshot> {
  if (!isPlainObject(manifest)) {
    throw new Error('无效的数据格式')
  }

  const raw = manifest as Partial<ExportData> & { version?: number }
  if (!raw.tasks || !raw.imageFiles || typeof raw.imageFiles !== 'object') {
    throw new Error('无效的数据格式')
  }

  const exportedAt = parseExportedAt(raw.exportedAt)
  const settings = normalizeSettings(raw.settings ?? {}, exportedAt)
  const tasks = (raw.tasks ?? []).map((task) => normalizeTask(task, exportedAt))
  const deletedTaskIds = normalizeTombstones(raw.deletedTaskIds)
  const deletedImageIds = normalizeTombstones(raw.deletedImageIds)
  const images: StoredImage[] = []

  for (const [id, info] of Object.entries(raw.imageFiles)) {
    const bytes = await readImageBytes(info.path)
    if (!bytes) continue
    images.push(
      normalizeImage(
        {
          id,
          dataUrl: bytesToDataUrl(bytes, info.path),
          createdAt: info.createdAt,
          updatedAt: info.updatedAt ?? info.createdAt,
          source: info.source,
        },
        exportedAt,
      ),
    )
  }

  return {
    version: typeof raw.version === 'number' ? raw.version : SNAPSHOT_VERSION,
    exportedAt,
    settings,
    tasks,
    images,
    deletedTaskIds,
    deletedImageIds,
  }
}

export async function importSnapshotIntoLocalData(file: File) {
  const snapshot = await readSnapshotFromFile(file)
  await replaceLocalData(snapshot)
  return snapshot
}

export function sortTasksForDisplay(tasks: TaskRecord[]) {
  return [...tasks].sort((a, b) => {
    const createdDiff = (b.createdAt ?? 0) - (a.createdAt ?? 0)
    if (createdDiff !== 0) return createdDiff

    const updatedDiff = (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    if (updatedDiff !== 0) return updatedDiff

    return b.id.localeCompare(a.id)
  })
}

function readSnapshotFromBuffer(buffer: ArrayBuffer): SyncSnapshot {
  const unzipped = unzipSync(new Uint8Array(buffer))
  const manifestBytes = unzipped['manifest.json']
  if (!manifestBytes) throw new Error('ZIP 中缺少 manifest.json')

  const raw = JSON.parse(strFromU8(manifestBytes)) as Partial<ExportData> & { version?: number }
  if (!raw.tasks || !raw.imageFiles) {
    throw new Error('无效的数据格式')
  }

  const exportedAt = parseExportedAt(raw.exportedAt)
  const settings = normalizeSettings(raw.settings ?? {}, exportedAt)
  const tasks = (raw.tasks ?? []).map((task) => normalizeTask(task, exportedAt))
  const deletedTaskIds = normalizeTombstones(raw.deletedTaskIds)
  const deletedImageIds = normalizeTombstones(raw.deletedImageIds)
  const images: StoredImage[] = []

  for (const [id, info] of Object.entries(raw.imageFiles)) {
    const bytes = unzipped[info.path]
    if (!bytes) continue
    images.push(
      normalizeImage(
        {
          id,
          dataUrl: bytesToDataUrl(bytes, info.path),
          createdAt: info.createdAt,
          updatedAt: info.updatedAt ?? info.createdAt,
          source: info.source,
        },
        exportedAt,
      ),
    )
  }

  return {
    version: typeof raw.version === 'number' ? raw.version : SNAPSHOT_VERSION,
    exportedAt,
    settings,
    tasks,
    images,
    deletedTaskIds,
    deletedImageIds,
  }
}

function mergeRecords<T extends { id: string }>(
  local: T[],
  remote: T[],
  getTimestamp: (item: T) => number,
) {
  const merged = new Map<string, T>()

  for (const item of [...local, ...remote]) {
    const current = merged.get(item.id)
    if (!current || getTimestamp(item) >= getTimestamp(current)) {
      merged.set(item.id, item)
    }
  }

  return Array.from(merged.values())
}

export function readSyncTombstones(): SyncTombstones {
  try {
    const raw = localStorage.getItem(TOMBSTONE_STORAGE_KEY)
    if (!raw) {
      return { deletedTaskIds: {}, deletedImageIds: {} }
    }
    const parsed = JSON.parse(raw) as Partial<SyncTombstones>
    return {
      deletedTaskIds: normalizeTombstones(parsed.deletedTaskIds),
      deletedImageIds: normalizeTombstones(parsed.deletedImageIds),
    }
  } catch {
    return { deletedTaskIds: {}, deletedImageIds: {} }
  }
}

export function replaceSyncTombstones(tombstones: SyncTombstones) {
  try {
    localStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify({
      deletedTaskIds: normalizeTombstones(tombstones.deletedTaskIds),
      deletedImageIds: normalizeTombstones(tombstones.deletedImageIds),
    }))
  } catch {
    /* 忽略本地存储失败 */
  }
}

export function markTaskDeleted(taskId: string, deletedAt = Date.now()) {
  const tombstones = readSyncTombstones()
  tombstones.deletedTaskIds[taskId] = deletedAt
  replaceSyncTombstones(tombstones)
}

export function markImageDeleted(imageId: string, deletedAt = Date.now()) {
  const tombstones = readSyncTombstones()
  tombstones.deletedImageIds[imageId] = deletedAt
  replaceSyncTombstones(tombstones)
}

export function clearSyncTombstones() {
  replaceSyncTombstones({ deletedTaskIds: {}, deletedImageIds: {} })
}

function pickNewerSettings(local: AppSettings, remote: AppSettings) {
  const remoteIsNewer = getSettingsTimestamp(remote) >= getSettingsTimestamp(local)
  const primary = remoteIsNewer ? remote : local
  const secondary = remoteIsNewer ? local : remote

  return {
    ...primary,
    baseUrl: pickApiStringSetting(local.baseUrl, remote.baseUrl, DEFAULT_SETTINGS.baseUrl, remoteIsNewer),
    apiKey: pickApiStringSetting(local.apiKey, remote.apiKey, DEFAULT_SETTINGS.apiKey, remoteIsNewer),
    model: pickApiStringSetting(local.model, remote.model, DEFAULT_SETTINGS.model, remoteIsNewer),
    timeout: pickNumericSetting(local.timeout, remote.timeout, DEFAULT_SETTINGS.timeout, remoteIsNewer),
    apiMode: pickEnumSetting(local.apiMode, remote.apiMode, DEFAULT_SETTINGS.apiMode, remoteIsNewer),
    storageMode: pickEnumSetting(local.storageMode, remote.storageMode, DEFAULT_SETTINGS.storageMode, remoteIsNewer),
    webdav: {
      url: pickCredentialSetting(local.webdav.url, remote.webdav.url),
      username: pickCredentialSetting(local.webdav.username, remote.webdav.username),
      password: pickCredentialSetting(local.webdav.password, remote.webdav.password),
      syncOnStartup: pickBooleanSetting(local.webdav.syncOnStartup, remote.webdav.syncOnStartup, remoteIsNewer),
    },
    updatedAt: Math.max(getSettingsTimestamp(local), getSettingsTimestamp(remote)),
  }
}

function getSettingsTimestamp(settings: AppSettings) {
  return settings.updatedAt ?? 0
}

function pickApiStringSetting(local: string, remote: string, defaultValue: string, remoteIsNewer: boolean) {
  const localMeaningful = isMeaningfulStringSetting(local, defaultValue)
  const remoteMeaningful = isMeaningfulStringSetting(remote, defaultValue)

  if (localMeaningful && !remoteMeaningful) return local
  if (remoteMeaningful && !localMeaningful) return remote
  return remoteIsNewer ? remote : local
}

function pickNumericSetting(local: number, remote: number, defaultValue: number, remoteIsNewer: boolean) {
  const localMeaningful = local !== defaultValue
  const remoteMeaningful = remote !== defaultValue

  if (localMeaningful && !remoteMeaningful) return local
  if (remoteMeaningful && !localMeaningful) return remote
  return remoteIsNewer ? remote : local
}

function pickEnumSetting<T extends string>(local: T, remote: T, defaultValue: T, remoteIsNewer: boolean) {
  const localMeaningful = local !== defaultValue
  const remoteMeaningful = remote !== defaultValue

  if (localMeaningful && !remoteMeaningful) return local
  if (remoteMeaningful && !localMeaningful) return remote
  return remoteIsNewer ? remote : local
}

function pickCredentialSetting(local: string, remote: string) {
  if (local.trim()) return local
  return remote
}

function pickBooleanSetting(local: boolean, remote: boolean, remoteIsNewer: boolean) {
  return remoteIsNewer ? remote : local
}

function isMeaningfulStringSetting(value: string, defaultValue: string) {
  return value.trim() !== '' && value !== defaultValue
}

function getTaskTimestamp(task: TaskRecord) {
  return task.updatedAt ?? task.finishedAt ?? task.createdAt ?? 0
}

function getImageTimestamp(image: StoredImage) {
  return image.updatedAt ?? image.createdAt ?? 0
}

function mergeTombstones(local: Record<string, number>, remote: Record<string, number>) {
  const merged: Record<string, number> = { ...local }
  for (const [id, deletedAt] of Object.entries(remote)) {
    const current = merged[id]
    if (current == null || deletedAt >= current) {
      merged[id] = deletedAt
    }
  }
  return merged
}

function normalizeSettings(settings: Partial<AppSettings>, fallback: number): AppSettings {
  const isDefaultLike =
    (settings.baseUrl ?? DEFAULT_SETTINGS.baseUrl) === DEFAULT_SETTINGS.baseUrl &&
    (settings.apiKey ?? DEFAULT_SETTINGS.apiKey) === DEFAULT_SETTINGS.apiKey &&
    (settings.model ?? DEFAULT_SETTINGS.model) === DEFAULT_SETTINGS.model &&
    (settings.timeout ?? DEFAULT_SETTINGS.timeout) === DEFAULT_SETTINGS.timeout &&
    (settings.apiMode === 'responses' ? 'responses' : 'images') === DEFAULT_SETTINGS.apiMode &&
    (settings.storageMode === 'webdav' ? 'webdav' : 'local') === DEFAULT_SETTINGS.storageMode &&
    (settings.webdav?.url ?? DEFAULT_SETTINGS.webdav.url) === DEFAULT_SETTINGS.webdav.url &&
    (settings.webdav?.username ?? DEFAULT_SETTINGS.webdav.username) === DEFAULT_SETTINGS.webdav.username &&
    (settings.webdav?.password ?? DEFAULT_SETTINGS.webdav.password) === DEFAULT_SETTINGS.webdav.password &&
    (settings.webdav?.syncOnStartup ?? DEFAULT_SETTINGS.webdav.syncOnStartup) === DEFAULT_SETTINGS.webdav.syncOnStartup

  return {
    ...(settings as AppSettings),
    baseUrl: settings.baseUrl ?? '',
    apiKey: settings.apiKey ?? '',
    model: settings.model ?? '',
    timeout: settings.timeout ?? 0,
    apiMode: settings.apiMode === 'responses' ? 'responses' : 'images',
    storageMode: settings.storageMode === 'webdav' ? 'webdav' : 'local',
    webdav: {
      url: settings.webdav?.url ?? '',
      username: settings.webdav?.username ?? '',
      password: settings.webdav?.password ?? '',
      syncOnStartup: settings.webdav?.syncOnStartup ?? true,
    },
    updatedAt: settings.updatedAt ?? (isDefaultLike ? 0 : fallback),
  }
}

function normalizeTombstones(tombstones: unknown) {
  if (!tombstones || typeof tombstones !== 'object') return {}
  const record = tombstones as Record<string, unknown>
  const normalized: Record<string, number> = {}
  for (const [id, value] of Object.entries(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      normalized[id] = value
    }
  }
  return normalized
}

function normalizeTask(task: Partial<TaskRecord>, fallback: number): TaskRecord {
  return {
    ...(task as TaskRecord),
    id: task.id ?? `task-${fallback}`,
    prompt: task.prompt ?? '',
    params: task.params ?? {
      size: 'auto',
      quality: 'auto',
      output_format: 'png',
      output_compression: null,
      moderation: 'auto',
      n: 1,
    },
    inputImageIds: task.inputImageIds ?? [],
    outputImages: task.outputImages ?? [],
    status: task.status === 'done' || task.status === 'error' ? task.status : 'running',
    error: task.error ?? null,
    createdAt: task.createdAt ?? fallback,
    finishedAt: task.finishedAt ?? null,
    elapsed: task.elapsed ?? null,
    updatedAt: task.updatedAt ?? task.finishedAt ?? task.createdAt ?? fallback,
  }
}

function normalizeImage(image: Partial<StoredImage>, fallback: number): StoredImage {
  return {
    ...(image as StoredImage),
    id: image.id ?? `image-${fallback}`,
    dataUrl: image.dataUrl ?? '',
    createdAt: image.createdAt ?? fallback,
    updatedAt: image.updatedAt ?? image.createdAt ?? fallback,
    source: image.source,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseExportedAt(value: unknown) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

function parseDataUrl(dataUrl: string): { ext: string; bytes: Uint8Array } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  const mime = match?.[1] ?? 'image/png'
  const b64 = match?.[2] ?? dataUrl.replace(/^data:[^;]+;base64,/, '')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return {
    ext: mimeToExt(mime),
    bytes,
  }
}

function bytesToDataUrl(bytes: Uint8Array, filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
  }
  const mime = mimeMap[ext] ?? 'image/png'
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return `data:${mime};base64,${btoa(binary)}`
}

function getRemoteImagePath(imageId: string, ext: string) {
  return `${imageId}.${ext}`
}

function mimeToExt(mime: string) {
  const value = mime.toLowerCase()
  if (value === 'image/jpeg') return 'jpg'
  if (value === 'image/webp') return 'webp'
  if (value === 'image/gif') return 'gif'
  if (value === 'image/bmp') return 'bmp'
  if (value === 'image/svg+xml') return 'svg'
  return 'png'
}
