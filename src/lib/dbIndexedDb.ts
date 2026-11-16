import type { AgentConversation, TaskRecord, StoredImage, StoredImageThumbnail } from '../types'
import { dbTransaction, openDB, STORE_AGENT_CONVERSATIONS, STORE_IMAGES, STORE_TASKS, STORE_THUMBNAILS } from './idb'
import { disableBlobStorage, fromImageRecord, fromThumbnailRecord, getStoredImageRecord, getStoredThumbnailRecord, toImageRecord, toThumbnailRecord, type StoredImageRecord } from './imageBlob'

// 浏览器拒绝保存 Blob 时（旧版 Safari 报 UnknownError，部分隐私模式报 DataCloneError）改存原始字符串，之后本次会话都存字符串；
// 其他错误（空间不足、连接关闭等）与 Blob 无关，照常抛出
const BLOB_REJECTED_ERRORS = new Set(['DataCloneError', 'UnknownError'])

async function putWithBlobFallback(storeName: string, original: object, record: object): Promise<IDBValidKey> {
  try {
    return await dbTransaction(storeName, 'readwrite', (s) => s.put(record))
  } catch (err) {
    if (record === original || !BLOB_REJECTED_ERRORS.has((err as Error | null)?.name ?? '')) throw err
    disableBlobStorage(err)
    return dbTransaction(storeName, 'readwrite', (s) => s.put(original))
  }
}

// ===== Tasks =====

export function getAllTasks(): Promise<TaskRecord[]> {
  return dbTransaction(STORE_TASKS, 'readonly', (s) => s.getAll())
}

export function putTask(task: TaskRecord): Promise<IDBValidKey> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.put(task))
}

export function deleteTask(id: string): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.delete(id))
}

export function commitTaskDeletion(deletedTaskIds: string[], updatedTasks: TaskRecord[], updatedConversations: AgentConversation[]): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_TASKS, STORE_AGENT_CONVERSATIONS], 'readwrite')
        const taskStore = tx.objectStore(STORE_TASKS)
        const conversationStore = tx.objectStore(STORE_AGENT_CONVERSATIONS)
        for (const id of deletedTaskIds) taskStore.delete(id)
        for (const task of updatedTasks) taskStore.put(task)
        for (const conversation of updatedConversations) conversationStore.put(conversation)
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export function clearTasks(): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.clear())
}

// ===== Agent conversations =====

export function getAllAgentConversations(): Promise<AgentConversation[]> {
  return dbTransaction(STORE_AGENT_CONVERSATIONS, 'readonly', (s) => s.getAll())
}

export function putAgentConversation(conversation: AgentConversation): Promise<IDBValidKey> {
  return dbTransaction(STORE_AGENT_CONVERSATIONS, 'readwrite', (s) => s.put(conversation))
}

export function clearAgentConversations(): Promise<undefined> {
  return dbTransaction(STORE_AGENT_CONVERSATIONS, 'readwrite', (s) => s.clear())
}

export function replaceAgentConversations(conversations: AgentConversation[]): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_AGENT_CONVERSATIONS, 'readwrite')
        const store = tx.objectStore(STORE_AGENT_CONVERSATIONS)
        store.clear()
        for (const conversation of conversations) store.put(conversation)
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

// ===== Images =====

export function getImage(id: string): Promise<StoredImage | undefined> {
  return getStoredImageRecord(id).then(fromImageRecord)
}

/** 只取元数据（宽高等），不读出图片内容 */
export async function getImageMeta(id: string): Promise<Omit<StoredImage, 'dataUrl'> | undefined> {
  const rec = await getStoredImageRecord(id)
  if (!rec) return undefined
  const { blob, dataUrl, ...meta } = rec
  return meta
}

export function updateImageDimensions(id: string, width: number, height: number): Promise<boolean> {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS], 'readwrite')
    const images = tx.objectStore(STORE_IMAGES)
    const thumbnails = tx.objectStore(STORE_THUMBNAILS)
    let updated = false
    const req = images.get(id)
    req.onsuccess = () => {
      if (!req.result) return
      images.put({ ...req.result, width, height })
      updated = true
      const thumbnail = thumbnails.get(id)
      thumbnail.onsuccess = () => {
        if (thumbnail.result) thumbnails.put({ ...thumbnail.result, width, height })
      }
    }
    tx.oncomplete = () => resolve(updated)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  }))
}

export function getStoredImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  return getStoredThumbnailRecord(id).then(fromThumbnailRecord)
}

export function putImageThumbnail(thumbnail: StoredImageThumbnail): Promise<IDBValidKey> {
  return putWithBlobFallback(STORE_THUMBNAILS, thumbnail, toThumbnailRecord(thumbnail))
}

export async function getAllImages(): Promise<StoredImage[]> {
  const records = await dbTransaction<StoredImageRecord[]>(STORE_IMAGES, 'readonly', (s) => s.getAll())
  const images = await Promise.all(records.map(fromImageRecord))
  return images.filter((image): image is StoredImage => image != null)
}

export async function getAllImageIds(opts?: { includeThumbnails?: boolean }): Promise<string[]> {
  const stores = opts?.includeThumbnails ? [STORE_IMAGES, STORE_THUMBNAILS] : [STORE_IMAGES]
  const keys = await Promise.all(stores.map((store) => dbTransaction(store, 'readonly', (s) => s.getAllKeys())))
  return [...new Set(keys.flat().map(String))]
}

export function putImage(image: StoredImage): Promise<IDBValidKey> {
  return putWithBlobFallback(STORE_IMAGES, image, toImageRecord(image))
}

export function deleteImage(id: string): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS], 'readwrite')
        tx.objectStore(STORE_IMAGES).delete(id)
        tx.objectStore(STORE_THUMBNAILS).delete(id)
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
      }),
  )
}

export function clearImages(): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS], 'readwrite')
        tx.objectStore(STORE_IMAGES).clear()
        tx.objectStore(STORE_THUMBNAILS).clear()
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
      }),
  )
}
