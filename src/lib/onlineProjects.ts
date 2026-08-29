import type { AgentConversation, AppSettings, FavoriteCollection, Project, ProjectCanvasState, ProjectCanvasViewport, StoredImage, StoredImageThumbnail, TaskRecord } from '../types'
import { authFetch } from '../auth/api'
import { dataUrlToBlob } from './canvasImage'
import { blobToDataUrl } from './dataUrl'
import { buildExportZip, readExportZip, readExportZipFileAsDataUrl } from './exportZip'
import { getAgentConversationProjectId } from './agentConversationScope'
import { normalizeProjectCanvas } from './projectCanvas'

const LEGACY_PROJECT_UPLOAD_ID_KEY = 'gpt-image-playground:legacy-project-upload-id'

function fetchOnlineProjectResource(path: string) {
  // 时间戳同时绕过仍在控制页面的旧版 Service Worker Cache Storage。
  return authFetch(`${path}?_=${Date.now()}`, { cache: 'no-store' })
}

export interface OnlineProjectResponse {
  id: string
  title: string
  archive_size: number
  archive_sha256: string
  created_at: string
  updated_at: string
}

export interface OnlineProjectImageResponse {
  project_id: string
  image_id: string
  task_id?: string
  source?: StoredImage['source']
  image_url?: string
  mime_type: string
  width?: number
  height?: number
  image_size: number
  image_sha256: string
  created_at: string
  updated_at: string
}

export function getOnlineProjectRecord(project: Project) {
  const remoteId = project.remoteId ?? project.id
  return {
    id: remoteId,
    title: project.title,
    initialPrompt: project.initialPrompt,
    storage: project.storage,
    remoteId,
    defaultFavoriteCollectionId: project.defaultFavoriteCollectionId,
    canvas: project.canvas,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

export function getTaskReferencedImageIds(task: TaskRecord) {
  return [
    ...task.inputImageIds,
    ...(task.maskTargetImageId ? [task.maskTargetImageId] : []),
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...task.outputImages,
    ...(task.transparentOriginalImages ?? []),
    ...(task.streamPartialImageIds ?? []),
  ]
}

export function getAgentConversationReferencedImageIds(conversation: AgentConversation) {
  return [
    ...conversation.rounds.flatMap((round) => [
      ...round.inputImageIds,
      ...(round.maskTargetImageId ? [round.maskTargetImageId] : []),
      ...(round.maskImageId ? [round.maskImageId] : []),
    ]),
    ...conversation.messages.flatMap((message) => [
      ...(message.inputImageIds ?? []),
      ...(message.maskTargetImageId ? [message.maskTargetImageId] : []),
      ...(message.maskImageId ? [message.maskImageId] : []),
    ]),
  ]
}

interface ProjectArchiveState {
  settings: AppSettings
  tasks: TaskRecord[]
  agentConversations: AgentConversation[]
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
}

async function buildProjectArchive(state: ProjectArchiveState, project: Project | null, tasks: TaskRecord[], agentConversations: AgentConversation[]) {
  const projects = project ? [{
    id: project.id,
    title: project.title,
    initialPrompt: project.initialPrompt,
    storage: project.storage,
    remoteId: project.remoteId,
    defaultFavoriteCollectionId: project.defaultFavoriteCollectionId,
    canvas: project.canvas,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }] : []
  const { bytes } = buildExportZip({
    options: { exportConfig: false, exportTasks: true },
    exportedAt: Date.now(),
    settings: state.settings,
    tasks,
    projects,
    images: [],
    thumbnailsByImageId: new Map(),
    favoriteCollections: state.favoriteCollections,
    defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
    agentConversations,
  })
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' })
}

export function buildOnlineProjectArchive(state: ProjectArchiveState & { projects: Project[] }, projectId: string) {
  const project = state.projects.find((item) => item.id === projectId)
  if (!project) throw new Error('找不到需要同步的项目')
  const favoriteCollections = state.favoriteCollections.filter((collection) => collection.projectId === projectId)
  const defaultFavoriteCollectionId = project.defaultFavoriteCollectionId !== undefined
    ? project.defaultFavoriteCollectionId
    : favoriteCollections[0]?.id ?? null
  const agentConversations = state.agentConversations
    .filter((conversation) => getAgentConversationProjectId(conversation, state.tasks) === projectId)
    .map((conversation) => conversation.projectId === projectId ? conversation : { ...conversation, projectId })
  return buildProjectArchive(
    {
      ...state,
      favoriteCollections,
      defaultFavoriteCollectionId,
    },
    project,
    state.tasks.filter((task) => task.projectId === projectId),
    agentConversations,
  )
}

export async function buildLegacyProjectArchive(state: {
  settings: AppSettings
  tasks: TaskRecord[]
  agentConversations: AgentConversation[]
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
}) {
  const tasks = state.tasks.filter((task) => !task.projectId)
  const agentConversations = state.agentConversations.filter((conversation) => !conversation.projectId)
  return buildProjectArchive({
    ...state,
    favoriteCollections: state.favoriteCollections.filter((collection) => !collection.projectId),
  }, null, tasks, agentConversations)
}

export function getLegacyProjectUploadId() {
  try {
    const existing = localStorage.getItem(LEGACY_PROJECT_UPLOAD_ID_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    localStorage.setItem(LEGACY_PROJECT_UPLOAD_ID_KEY, id)
    return id
  } catch {
    return crypto.randomUUID()
  }
}

export function clearLegacyProjectUploadId() {
  try {
    localStorage.removeItem(LEGACY_PROJECT_UPLOAD_ID_KEY)
  } catch {
    // localStorage 不可用时无需清理
  }
}

export async function uploadOnlineProject(id: string, title: string, archive: Blob): Promise<OnlineProjectResponse> {
  const form = new FormData()
  form.set('id', id)
  form.set('title', title)
  form.set('archive', archive, `${id}.zip`)
  const resp = await authFetch('/api/v1/projects', {
    method: 'POST',
    body: form,
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `在线项目保存失败：HTTP ${resp.status}`)
  }
  return await resp.json() as OnlineProjectResponse
}

export async function saveOnlineProjectTask(project: Project, task: TaskRecord): Promise<OnlineProjectResponse> {
  const remoteId = project.remoteId ?? project.id
  const resp = await authFetch(`/api/v1/projects/${encodeURIComponent(remoteId)}/tasks/${encodeURIComponent(task.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_title: project.title, project: getOnlineProjectRecord(project), task }),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `在线任务记录保存失败：HTTP ${resp.status}`)
  }
  return await resp.json() as OnlineProjectResponse
}

export async function deleteOnlineProjectTask(projectId: string, taskId: string): Promise<OnlineProjectResponse | null> {
  const resp = await authFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' })
  if (resp.status === 404) return null
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `在线任务记录删除失败：HTTP ${resp.status}`)
  }
  return await resp.json() as OnlineProjectResponse
}

export async function listOnlineProjects(): Promise<OnlineProjectResponse[]> {
  const resp = await fetchOnlineProjectResource('/api/v1/projects')
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `在线项目列表加载失败：HTTP ${resp.status}`)
  }
  const data = await resp.json() as unknown
  if (!Array.isArray(data)) return []
  return data.filter((item): item is OnlineProjectResponse => {
    if (!item || typeof item !== 'object') return false
    const record = item as Record<string, unknown>
    return typeof record.id === 'string' && typeof record.title === 'string' && typeof record.archive_size === 'number' && typeof record.archive_sha256 === 'string' && typeof record.created_at === 'string' && typeof record.updated_at === 'string'
  })
}

export async function downloadOnlineProject(id: string): Promise<Uint8Array> {
  const resp = await fetchOnlineProjectResource(`/api/v1/projects/${encodeURIComponent(id)}`)
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `在线项目内容加载失败：HTTP ${resp.status}`)
  }
  return new Uint8Array(await resp.arrayBuffer())
}

export async function uploadOnlineProjectImage(projectId: string, taskId: string | undefined, image: StoredImage): Promise<OnlineProjectImageResponse> {
  const blob = await dataUrlToBlob(image.dataUrl)
  const form = new FormData()
  form.set('image_id', image.id)
  if (taskId) form.set('task_id', taskId)
  if (image.source) form.set('source', image.source)
  if (image.width) form.set('width', String(image.width))
  if (image.height) form.set('height', String(image.height))
  form.set('image', blob, image.id)
  const resp = await authFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/images`, {
    method: 'POST',
    body: form,
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `项目图片保存失败：HTTP ${resp.status}`)
  }
  return await resp.json() as OnlineProjectImageResponse
}

export async function listOnlineProjectImages(projectId: string): Promise<OnlineProjectImageResponse[]> {
  const resp = await fetchOnlineProjectResource(`/api/v1/projects/${encodeURIComponent(projectId)}/images`)
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `项目图片列表加载失败：HTTP ${resp.status}`)
  }
  const data = await resp.json() as unknown
  if (!Array.isArray(data)) return []
  return data.filter((item): item is OnlineProjectImageResponse => {
    if (!item || typeof item !== 'object') return false
    const record = item as Record<string, unknown>
    const sourceValid = record.source === undefined || record.source === 'upload' || record.source === 'generated' || record.source === 'mask'
    return typeof record.project_id === 'string' && typeof record.image_id === 'string' && sourceValid && (record.image_url === undefined || typeof record.image_url === 'string') && typeof record.mime_type === 'string' && typeof record.image_size === 'number' && typeof record.image_sha256 === 'string' && typeof record.created_at === 'string' && typeof record.updated_at === 'string'
  })
}

export async function downloadOnlineProjectImage(projectId: string, image: OnlineProjectImageResponse, options: { forceDataUrl?: boolean } = {}): Promise<StoredImage> {
  const resp = await authFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(image.image_id)}`)
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `项目图片加载失败：HTTP ${resp.status}`)
  }
  const migratedURL = resp.headers.get('X-Project-Image-URL')
  if (migratedURL && !options.forceDataUrl) {
    return {
      id: image.image_id,
      dataUrl: migratedURL,
      source: image.source,
      width: image.width,
      height: image.height,
      createdAt: Date.parse(image.created_at) || undefined,
    }
  }
  const dataUrl = await blobToDataUrl(await resp.blob(), image.mime_type)
  return {
    id: image.image_id,
    dataUrl: options.forceDataUrl ? dataUrl : migratedURL || dataUrl,
    source: image.source,
    width: image.width,
    height: image.height,
    createdAt: Date.parse(image.created_at) || undefined,
  }
}

export async function deleteOnlineProjectImage(projectId: string, imageId: string) {
  const resp = await authFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(imageId)}`, { method: 'DELETE' })
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `项目图片删除失败：HTTP ${resp.status}`)
  }
}

export async function deleteOnlineProject(id: string): Promise<void> {
  const resp = await authFetch(`/api/v1/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (resp.status === 404) return
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `在线项目删除失败：HTTP ${resp.status}`)
  }
}

export async function renameOnlineProject(id: string, title: string): Promise<OnlineProjectResponse> {
  const resp = await authFetch(`/api/v1/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `在线项目重命名失败：HTTP ${resp.status}`)
  }
  return await resp.json() as OnlineProjectResponse
}

export async function saveOnlineProjectCanvas(project: Project, canvas: Project['canvas'], options: { keepalive?: boolean } = {}): Promise<OnlineProjectResponse> {
  const remoteId = project.remoteId ?? project.id
  const resp = await authFetch(`/api/v1/projects/${encodeURIComponent(remoteId)}/canvas`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canvas }),
    keepalive: options.keepalive,
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `项目画布保存失败：HTTP ${resp.status}`)
  }
  return await resp.json() as OnlineProjectResponse
}

export async function saveOnlineProjectViewport(project: Project, viewport: ProjectCanvasViewport): Promise<OnlineProjectResponse> {
  const remoteId = project.remoteId ?? project.id
  const resp = await authFetch(`/api/v1/projects/${encodeURIComponent(remoteId)}/canvas/viewport`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewport }),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `项目视口保存失败：HTTP ${resp.status}`)
  }
  return await resp.json() as OnlineProjectResponse
}

export async function getOnlineProjectCanvas(projectId: string): Promise<ProjectCanvasState | null> {
  const resp = await fetchOnlineProjectResource(`/api/v1/projects/${encodeURIComponent(projectId)}/canvas`)
  if (resp.status === 404) return null
  if (!resp.ok) {
    const data = await resp.json().catch(() => null) as { message?: string } | null
    throw new Error(data?.message || `项目画布加载失败：HTTP ${resp.status}`)
  }
  const data = await resp.json().catch(() => null) as { canvas?: unknown } | null
  return normalizeProjectCanvas(data?.canvas) ?? null
}

export function createOnlineProject(response: OnlineProjectResponse): Project {
  return {
    id: response.id,
    title: response.title,
    initialPrompt: '',
    storage: 'online',
    remoteId: response.id,
    remoteArchiveSha256: response.archive_sha256,
    syncPending: false,
    createdAt: Date.parse(response.created_at) || Date.now(),
    updatedAt: Date.parse(response.updated_at) || Date.now(),
  }
}

export function readOnlineProjectArchive(bytes: Uint8Array): {
  project?: Project
  tasks: TaskRecord[]
  agentConversations: AgentConversation[]
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
  images: StoredImage[]
  thumbnails: StoredImageThumbnail[]
} {
  const { manifest, files } = readExportZip(bytes)
  const images = Object.entries(manifest.imageFiles ?? {}).flatMap(([id, info]) => {
    const dataUrl = readExportZipFileAsDataUrl(files, info.path)
    if (!dataUrl) return []
    return [{ id, dataUrl, createdAt: info.createdAt, source: info.source, width: info.width, height: info.height }]
  })
  const thumbnails = Object.entries(manifest.thumbnailFiles ?? {}).flatMap(([id, info]) => {
    const thumbnailDataUrl = readExportZipFileAsDataUrl(files, info.path)
    if (!thumbnailDataUrl) return []
    return [{ id, thumbnailDataUrl, width: info.width, height: info.height, thumbnailVersion: info.thumbnailVersion }]
  })
  return {
    project: manifest.projects?.[0],
    tasks: manifest.tasks ?? [],
    agentConversations: manifest.agentConversations ?? [],
    favoriteCollections: manifest.favoriteCollections ?? [],
    defaultFavoriteCollectionId: manifest.defaultFavoriteCollectionId ?? null,
    images,
    thumbnails,
  }
}
