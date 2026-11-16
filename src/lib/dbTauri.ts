import { invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core'
import type { AgentConversation, TaskRecord, StoredImage, StoredImageThumbnail } from '../types'
import { base64ToBytes, bytesToBase64 } from './dataUrl'

// 与 src-tauri/src/storage/images.rs 中的 RAW_DATA_URL_MIME 保持一致
export const RAW_DATA_URL_MIME = 'text/x-data-url'

type FileMeta = {
  mime: string
  width: number | null
  height: number | null
  source: StoredImage['source'] | null
  createdAt: number | null
  thumbnailVersion: number | null
}

/** Rust 侧返回 { code, message }，转成带 code 的 Error，便于上层沿用现有的错误处理 */
export async function call<T>(cmd: string, args?: InvokeArgs, opts?: InvokeOptions): Promise<T> {
  try {
    return await invoke<T>(cmd, args, opts)
  } catch (err) {
    const info = err as { code?: string; message?: string } | string | null
    if (typeof info === 'object' && info?.message) throw Object.assign(new Error(info.message), { code: info.code })
    throw new Error(String(err))
  }
}

const toDocs = (items: Array<{ id: string }>) => items.map((item) => ({ id: item.id, data: JSON.stringify(item) }))

/**
 * base64 dataUrl 解码成二进制。读回时会重新编码成规范 base64，因此只接受规范形式，
 * 保证读回的 dataUrl 与原串完全一致（图片 id 是原串的哈希）；其他情况按原文保存，读取时原样返回
 */
export function dataUrlToPayload(dataUrl: string): { mime: string; bytes: Uint8Array } {
  const raw = { mime: RAW_DATA_URL_MIME, bytes: new TextEncoder().encode(dataUrl) }
  const comma = dataUrl.indexOf(',')
  const head = comma > 0 ? dataUrl.slice(0, comma) : ''
  if (!head.startsWith('data:') || !head.endsWith(';base64')) return raw
  const mime = head.slice(5, -7)
  // mime 会放进请求头：只接受可打印 ASCII，且首尾不能有空格（请求头会去掉首尾空白）
  if (!/^[!-~]([ -~]*[!-~])?$/.test(mime) || mime === RAW_DATA_URL_MIME) return raw
  const base64 = dataUrl.slice(comma + 1)
  if (base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return raw
  const bytes = base64ToBytes(base64)
  // 字符集和长度合规后，只有末尾一组可能含非零的多余比特，重新编码末尾一组即可确认是否规范
  const tailLen = 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  if (base64 && bytesToBase64(bytes.subarray(bytes.length - tailLen)) !== base64.slice(-4)) return raw
  return { mime, bytes }
}

export function payloadToDataUrl(mime: string, bytes: Uint8Array): string {
  if (mime === RAW_DATA_URL_MIME) return new TextDecoder().decode(bytes)
  return `data:${mime};base64,${bytesToBase64(bytes)}`
}

/** 响应格式：4 字节小端 JSON 长度 + 元数据 JSON + 文件内容；空响应表示不存在 */
function decodeFile(res: ArrayBuffer): { meta: FileMeta; bytes: Uint8Array } | undefined {
  const buf = new Uint8Array(res)
  if (!buf.length) return undefined
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true)
  const meta = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + len))) as FileMeta
  return { meta, bytes: buf.subarray(4 + len) }
}

/** 元数据可能来自外部备份：非有限数值和未知 source 直接忽略；id 可能含任意字符，编码后再放进请求头 */
function putFile(cmd: string, id: string, dataUrl: string, meta: Record<string, unknown>) {
  const payload = dataUrlToPayload(dataUrl)
  const headers: Record<string, string> = { 'x-id': encodeURIComponent(id), 'x-mime': payload.mime }
  for (const [key, value] of Object.entries(meta)) {
    if (Number.isFinite(value)) headers[`x-${key}`] = String(value)
  }
  if (meta.source === 'upload' || meta.source === 'generated' || meta.source === 'mask') headers['x-source'] = meta.source
  return call<null>(cmd, payload.bytes, { headers })
}

// ===== Tasks =====

// 同一任务按提交顺序写入；会话整体替换与涉及会话的删除事务共用写入顺序。
const taskWrites = new Map<string, Promise<void>>()
let tasksCleared = Promise.resolve()
let conversationWrites = Promise.resolve()

function queueDocumentMutation(ids: string[], run: () => Promise<unknown>, writesConversations = false): Promise<void> {
  const result = Promise.all([
    ids.length ? tasksCleared : undefined,
    writesConversations ? conversationWrites : undefined,
    ...ids.map((id) => taskWrites.get(id)),
  ]).then(run).then(() => undefined)
  const settled = result.catch(() => undefined)
  if (writesConversations) conversationWrites = settled
  for (const id of ids) taskWrites.set(id, settled)
  void settled.then(() => {
    for (const id of ids) {
      if (taskWrites.get(id) === settled) taskWrites.delete(id)
    }
  })
  return result
}

export async function getAllTasks(): Promise<TaskRecord[]> {
  await Promise.all([tasksCleared, ...taskWrites.values()])
  return call('tasks_get_all')
}

export async function putTask(task: TaskRecord): Promise<IDBValidKey> {
  const args = { id: task.id, data: JSON.stringify(task) }
  await queueDocumentMutation([task.id], () => call('task_put', args))
  return task.id
}

export async function deleteTask(id: string): Promise<undefined> {
  await queueDocumentMutation([id], () => call('task_delete', { id }))
  return undefined
}

export async function commitTaskDeletion(deletedTaskIds: string[], updatedTasks: TaskRecord[], updatedConversations: AgentConversation[]): Promise<undefined> {
  const args = { deletedIds: [...deletedTaskIds], tasks: toDocs(updatedTasks), conversations: toDocs(updatedConversations) }
  const ids = [...new Set([...deletedTaskIds, ...updatedTasks.map((task) => task.id)])]
  await queueDocumentMutation(ids, () => call('tasks_commit_deletion', args), updatedConversations.length > 0)
  return undefined
}

export async function clearTasks(): Promise<undefined> {
  const result = Promise.all([tasksCleared, ...taskWrites.values()]).then(() => call('tasks_clear'))
  tasksCleared = result.then(() => undefined, () => undefined)
  await result
  return undefined
}

// ===== Agent conversations =====

export async function getAllAgentConversations(): Promise<AgentConversation[]> {
  await conversationWrites
  return call('conversations_get_all')
}

export async function putAgentConversation(conversation: AgentConversation): Promise<IDBValidKey> {
  const args = { id: conversation.id, data: JSON.stringify(conversation) }
  await queueDocumentMutation([], () => call('conversation_put', args), true)
  return conversation.id
}

export async function clearAgentConversations(): Promise<undefined> {
  await queueDocumentMutation([], () => call('conversations_clear'), true)
  return undefined
}

export async function replaceAgentConversations(conversations: AgentConversation[]): Promise<undefined> {
  const args = { conversations: toDocs(conversations) }
  await queueDocumentMutation([], () => call('conversations_replace', args), true)
  return undefined
}

// ===== Images =====

/** 原图文件内容与元数据，不经过 base64，供导出等只需要二进制的场景使用 */
export async function getImageFile(id: string) {
  return decodeFile(await call<ArrayBuffer>('image_get', { id }))
}

/** 缩略图文件内容与元数据，不经过 base64，供显示和导出使用 */
export async function getThumbnailFile(id: string) {
  return decodeFile(await call<ArrayBuffer>('thumbnail_get', { id }))
}

/** 与 Rust 侧 ImageStat 对应：只查询记录和文件大小，不读取文件内容 */
export type ImageStat = {
  id: string
  bytes: number
  width: number | null
  height: number | null
  thumbnailBytes: number | null
  thumbnailVersion: number | null
}

export function getImageStats(): Promise<ImageStat[]> {
  return call('image_stats')
}

export async function getImage(id: string): Promise<StoredImage | undefined> {
  const file = await getImageFile(id)
  if (!file) return undefined
  return {
    id,
    dataUrl: payloadToDataUrl(file.meta.mime, file.bytes),
    createdAt: file.meta.createdAt ?? undefined,
    source: file.meta.source ?? undefined,
    width: file.meta.width ?? undefined,
    height: file.meta.height ?? undefined,
  }
}

/** 只查询数据库中的元数据，不读取图片文件。 */
export async function getImageMeta(id: string): Promise<Omit<StoredImage, 'dataUrl'> | undefined> {
  const meta = await call<FileMeta | null>('image_meta', { id })
  if (!meta) return undefined
  return {
    id,
    createdAt: meta.createdAt ?? undefined,
    source: meta.source ?? undefined,
    width: meta.width ?? undefined,
    height: meta.height ?? undefined,
  }
}

export function updateImageDimensions(id: string, width: number, height: number): Promise<boolean> {
  return call('image_dimensions_update', { id, width, height })
}

export async function getStoredImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const file = await getThumbnailFile(id)
  if (!file) return undefined
  return {
    id,
    thumbnailDataUrl: payloadToDataUrl(file.meta.mime, file.bytes),
    width: file.meta.width ?? undefined,
    height: file.meta.height ?? undefined,
    thumbnailVersion: file.meta.thumbnailVersion ?? undefined,
  }
}

export async function putImageThumbnail(thumbnail: StoredImageThumbnail): Promise<IDBValidKey> {
  await putFile('thumbnail_put', thumbnail.id, thumbnail.thumbnailDataUrl, {
    width: thumbnail.width,
    height: thumbnail.height,
    'thumbnail-version': thumbnail.thumbnailVersion,
  })
  return thumbnail.id
}

/** 不提供一次性读取全部原图的命令，按 id 逐个读取 */
export async function getAllImages(): Promise<StoredImage[]> {
  const images: StoredImage[] = []
  for (const id of await getAllImageIds()) {
    const image = await getImage(id)
    if (image) images.push(image)
  }
  return images
}

export function getAllImageIds(opts?: { includeThumbnails?: boolean }): Promise<string[]> {
  return call('image_ids', opts?.includeThumbnails ? { includeThumbnails: true } : undefined)
}

export async function putImage(image: StoredImage): Promise<IDBValidKey> {
  await putFile('image_put', image.id, image.dataUrl, {
    width: image.width,
    height: image.height,
    source: image.source,
    'created-at': image.createdAt,
  })
  return image.id
}

export async function deleteImage(id: string): Promise<undefined> {
  await call('image_delete', { id })
  return undefined
}

export async function clearImages(): Promise<undefined> {
  await call('images_clear')
  return undefined
}

/** 与 Rust 侧 StorageInfo 对应，设置页“数据管理”中展示 */
export type StorageInfo = {
  dataDir: string
  dbBytes: number
  imageBytes: number
  imageCount: number
  thumbnailBytes: number
}

export function getStorageInfo(): Promise<StorageInfo> {
  return call('storage_info')
}

export async function openStorageDir(): Promise<void> {
  await call('storage_open_dir')
}

/** 选好的新数据目录：原目录、新目录与当前数据的文件数和大小 */
export type DataDirChange = {
  from: string
  to: string
  files: number
  bytes: number
  /** 不能使用所选目录的原因 */
  blocked: string | null
}

/** 弹出目录选择框选择新数据目录；所选目录不能使用时 blocked 为原因。取消时返回 null */
export function pickDataDir(): Promise<DataDirChange | null> {
  return call('data_dir_pick')
}

/** 确认更改：客户端随即重启，在下次启动时迁移 */
export async function changeDataDir(): Promise<void> {
  await call('data_dir_change')
}

/** 启动时确定数据目录的结果之一：标题、一句话结论、[标签, 路径] 列表与补充说明 */
export interface DataDirNotice {
  kind: 'success' | 'warning'
  title: string
  message: string
  paths: Array<[string, string]>
  details: string[]
}

/** 启动提示只返回一次；custom 表示数据目录不是默认位置 */
export function takeDataDirNotice(): Promise<{ notices: DataDirNotice[], custom: boolean }> {
  return call('data_dir_notice')
}
