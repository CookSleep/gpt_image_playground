import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AgentConversation,
  AgentMessage,
  AgentRound,
  ApiMode,
  ApiOverride,
  ApiProfile,
  AppSettings,
  AppMode,
  TaskParams,
  InputImage,
  MaskDraft,
  Project,
  ProjectCanvasState,
  ProjectCanvasViewport,
  StoredImage,
  StoredImageThumbnail,
  TaskRecord,
  FavoriteCollection,
  ResponsesApiResponse,
  ResponsesOutputItem,
} from './types'
import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_PARAMS } from './types'
import { DEFAULT_SETTINGS, getActiveApiProfile, getAgentImageApiProfile, getAgentTextApiProfile, getCustomProviderDefinition, mergeImportedSettings, normalizeSettings, validateApiProfile } from './lib/apiProfiles'
import { dismissAllTooltips } from './lib/tooltipDismiss'
import { remapImageMentionsForOrder, replaceImageMentionsForApi } from './lib/promptImageMentions'
import {
  CURRENT_THUMBNAIL_VERSION,
  getAllTasks,
  getAllProjects,
  putProject as dbPutProject,
  deleteProjectWithRecords as dbDeleteProjectWithRecords,
  clearProjects as dbClearProjects,
  putProjectWithRecords,
  replaceProjectCache,
  putTask as dbPutTask,
  deleteTask as dbDeleteTask,
  clearTasks as dbClearTasks,
  getAllAgentConversations,
  replaceAgentConversations,
  clearAgentConversations as dbClearAgentConversations,
  getImage,
  getImageThumbnail,
  getStoredFreshImageThumbnail,
  getAllImageIds,
  getAllImages,
  putImage,
  putImageThumbnail,
  deleteImage,
  clearImages,
  hashDataUrl,
  storeImage,
  storeImageReference,
  storeImageWithSize,
} from './lib/db'
import { createRequestId, getAccessToken, isAuthEnabled } from './auth/api'
import { buildLegacyProjectArchive, buildOnlineProjectArchive, clearLegacyProjectUploadId, createOnlineProject, deleteOnlineProject, deleteOnlineProjectImage, deleteOnlineProjectTask, downloadOnlineProject, downloadOnlineProjectImage, getAgentConversationReferencedImageIds, getLegacyProjectUploadId, getOnlineProjectCanvas, getTaskReferencedImageIds, listOnlineProjectImages, listOnlineProjects, readOnlineProjectArchive, renameOnlineProject, saveOnlineProjectCanvas, saveOnlineProjectTask, saveOnlineProjectViewport, uploadOnlineProject, uploadOnlineProjectImage } from './lib/onlineProjects'
import { callImageApi } from './lib/api'
import { callBackendImageApi } from './lib/backendImageApi'
import { callBackendCompositeImageApi, queryBackendCompositeImageTask } from './lib/backendCompositeImageApi'
import { callAgentConversationTitleApi, callAgentResponsesApi, callBatchImageSingle, parseBatchImageCallArguments, type AgentApiResultImage } from './lib/agentApi'
import { collectAgentRoundOutputImageSlots, extractAgentReferenceIds, getAgentCurrentReferenceId, getAgentGeneratedImageReferenceId, replaceAgentPromptImageReferencesForApi } from './lib/agentImageReferences'
import { showBrowserNotification } from './lib/browserNotification'
import { fetchImageUrlAsDataUrl, IMAGE_FETCH_CORS_HINT, MIME_MAP } from './lib/imageApiShared'
import { getFalErrorMessage, getFalQueuedImageResult } from './lib/falAiImageApi'
import { getCustomQueuedImageResult } from './lib/openaiCompatibleImageApi'
import { queryImageStatuses, type ImageStatusRecord } from './lib/imageStatusApi'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask } from './lib/mask'
import { getChangedParams, normalizeParamsForSettings } from './lib/paramCompatibility'
import { createTransparentOutputMeta, getTransparentRequestParams, removeKeyedBackgroundFromDataUrl } from './lib/transparentImage'
import { blobToDataUrl, fileToDataUrl } from './lib/dataUrl'
import { formatExportFileTime } from './lib/exportFileName'
import { buildExportZip, readExportZip, readExportZipFileAsDataUrl } from './lib/exportZip'
import { getAgentConversationProjectId, getChangedAgentConversationProjectIds } from './lib/agentConversationScope'
import { ensureProjectCanvas, normalizeProjectCanvas, removeCanvasFavoriteCollection } from './lib/projectCanvas'
import { getTaskOutputImageSlots, removeTaskOutputImage as removeTaskOutputImageRecord } from './lib/singleImageOperations'
import { playCompletionSound } from './lib/completionSound'

export const ALL_FAVORITES_COLLECTION_ID = '__all_favorites__'
export const ALL_PROJECTS_ID = '__all_projects__'
export const LOCAL_PROJECT_ID = '__local_project__'
export const DEFAULT_FAVORITE_COLLECTION_ID = '__default_favorites__'
export const DEFAULT_FAVORITE_COLLECTION_NAME = '默认'

// ===== Image cache =====
// 内存缓存，id → dataUrl。只保留少量最近使用图片，避免大量 4K data URL 常驻内存。

const imageCache = new Map<string, string>()
const thumbnailCache = new Map<string, { dataUrl: string; width?: number; height?: number; thumbnailVersion?: number }>()
const thumbnailBackfillIds = new Map<string, 'visible' | 'background'>()
const thumbnailBackfillRunningIds = new Set<string>()
const thumbnailSubscribers = new Map<string, Set<(thumbnail: { dataUrl: string; width?: number; height?: number }) => void>>()
let thumbnailBackfillScheduled = false
const MAX_IMAGE_CACHE_ENTRIES = 8
const MAX_THUMBNAIL_CACHE_ENTRIES = 80
const MAX_THUMBNAIL_BACKFILL_CONCURRENT = 4
const FAL_RECOVERY_POLL_MS = 10_000
const CUSTOM_RECOVERY_POLL_MS = 10_000
const COMPOSITE_RECOVERY_POLL_MS = 5_000
const COMPOSITE_RECOVERY_TIMEOUT_MS = 10 * 60 * 1000
const IMAGE_STATUS_RECOVERY_POLL_MS = 5_000
const SUPPORT_PROMPT_IMAGE_THRESHOLD = 50
const AGENT_INPUT_DRAFT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000
const AGENT_ROUND_IMAGE_MENTION_RE = /@(?:第)?(\d+)轮图(\d+)/g
const falRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const customRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const compositeRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const imageStatusRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const agentImageStatusRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const openAIWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
const activeTaskExecutions = new Set<string>()
const agentRoundControllers = new Map<string, AbortController>()
const projectPersistenceQueues = new Map<string, Promise<IDBValidKey>>()
const onlineProjectSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
const onlineProjectSyncQueues = new Map<string, Promise<void>>()
const onlineProjectSyncErrors = new Set<string>()
const onlineProjectCanvasSyncQueues = new Map<string, Promise<void>>()
const onlineProjectCanvasSyncErrors = new Set<string>()
const onlineTaskSyncQueues = new Map<string, Promise<void>>()
const onlineTaskSyncRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const onlineTaskSyncErrors = new Set<string>()
let agentConversationPersistenceReady = false
let agentConversationMigrationPending = false
let onlineProjectCacheReady = false
const OPENAI_INTERRUPTED_ERROR = '请求中断'
const AGENT_STOPPED_MESSAGE = '已停止生成。'
const AGENT_CONVERSATION_TITLE_MAX_LENGTH = 28
const PROJECT_TITLE_MAX_LENGTH = 36
const ERROR_TOAST_MAX_LENGTH = 80
type ToastType = 'info' | 'success' | 'error'
type AgentInputDraft = {
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  updatedAt?: number
}

export function getErrorToastMessage(message: string): string {
  const text = message.trim()
  if (!text) return '操作失败'

  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? ''
  const separatorIndex = firstLine.search(/[：:]/)
  if (separatorIndex > 0) {
    const title = firstLine.slice(0, separatorIndex).trim()
    if (isErrorToastTitle(title)) return title
  }

  if (firstLine.length > ERROR_TOAST_MAX_LENGTH) return '操作失败，请查看详情'
  return firstLine || '操作失败'
}

function getToastMessage(message: string, type: ToastType): string {
  return type === 'error' ? getErrorToastMessage(message) : message
}

function isErrorToastTitle(title: string): boolean {
  return /(?:失败|错误|异常|报错|无法|不能|超时|中断|断开|请先|请输入|已达上限|不存在|已丢失)$/.test(title)
}

export type SettingsTab = 'general' | 'agent' | 'api' | 'data' | 'about'

const TIMEOUT_STREAMING_HINT = '也可尝试打开「流式传输」，并提高「请求中间步骤图像数」来维持连接。'
const TIMEOUT_PARTIAL_IMAGES_ZERO_HINT = '官方流式接口不发送心跳，当前「请求中间步骤图像数」为 0，连接可能因无数据传输而断开。建议提高到 2 或 3。'
const TIMEOUT_PARTIAL_IMAGES_LOW_HINT = '也可尝试提高「请求中间步骤图像数」来维持连接，避免长时间无数据传输导致断开。'

type TimeoutStreamingHintProfile = Pick<ApiProfile, 'provider' | 'streamImages' | 'streamPartialImages'>

function getTimeoutStreamingHint(profile?: TimeoutStreamingHintProfile | null) {
  if (profile?.provider !== 'openai') return ''
  const partialImages = profile.streamPartialImages ?? DEFAULT_SETTINGS.streamPartialImages ?? 0
  if (profile.streamImages !== true) return TIMEOUT_STREAMING_HINT
  if (partialImages === 0) return TIMEOUT_PARTIAL_IMAGES_ZERO_HINT
  return partialImages < 3 ? TIMEOUT_PARTIAL_IMAGES_LOW_HINT : ''
}

function createOpenAITimeoutError(timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。${getTimeoutStreamingHint(profile)}`
}

export function getCachedImage(id: string): string | undefined {
  const dataUrl = imageCache.get(id)
  if (dataUrl) {
    imageCache.delete(id)
    imageCache.set(id, dataUrl)
  }
  return dataUrl
}

function cacheImage(id: string, dataUrl: string) {
  imageCache.delete(id)
  imageCache.set(id, dataUrl)
  while (imageCache.size > MAX_IMAGE_CACHE_ENTRIES) {
    const oldestKey = imageCache.keys().next().value
    if (oldestKey == null) break
    imageCache.delete(oldestKey)
  }
}

function getCachedThumbnail(id: string) {
  const thumbnail = thumbnailCache.get(id)
  if (thumbnail?.thumbnailVersion === CURRENT_THUMBNAIL_VERSION) {
    thumbnailCache.delete(id)
    thumbnailCache.set(id, thumbnail)
    return thumbnail
  }
  if (thumbnail) {
    thumbnailCache.delete(id)
  }
  return undefined
}

function cacheThumbnail(id: string, thumbnail: { dataUrl: string; width?: number; height?: number; thumbnailVersion?: number }) {
  if (thumbnail.thumbnailVersion !== CURRENT_THUMBNAIL_VERSION) return
  thumbnailCache.delete(id)
  thumbnailCache.set(id, thumbnail)
  while (thumbnailCache.size > MAX_THUMBNAIL_CACHE_ENTRIES) {
    const oldestKey = thumbnailCache.keys().next().value
    if (oldestKey == null) break
    thumbnailCache.delete(oldestKey)
  }
}

export async function ensureImageCached(id: string): Promise<string | undefined> {
  const cached = getCachedImage(id)
  if (cached) return cached
  const rec = await getImage(id)
  if (rec) {
    cacheImage(id, rec.dataUrl)
    return rec.dataUrl
  }
  return undefined
}

export async function ensureImageThumbnailCached(id: string): Promise<{ dataUrl: string; width?: number; height?: number } | undefined> {
  const cached = getCachedThumbnail(id)
  if (cached) {
    const image = await getImage(id)
    if (!image?.width || !image.height || (cached.width === image.width && cached.height === image.height)) return cached
    const corrected = { ...cached, width: image.width, height: image.height }
    cacheThumbnail(id, corrected)
    return corrected
  }

  const rec = await getStoredFreshImageThumbnail(id)
  if (!rec?.thumbnailDataUrl) {
    scheduleThumbnailBackfill([id], 'visible')
    const image = await getImage(id)
    if (!image?.dataUrl) return undefined
    // 远程 URL 可能因跨域限制无法写入 canvas，直接使用原图保证仍可展示。
    return { dataUrl: image.dataUrl, width: image.width, height: image.height }
  }

  const image = await getImage(id)

  const thumbnail = {
    dataUrl: rec.thumbnailDataUrl,
    width: image?.width ?? rec.width,
    height: image?.height ?? rec.height,
    thumbnailVersion: rec.thumbnailVersion,
  }
  cacheThumbnail(id, thumbnail)
  return thumbnail
}

export function subscribeImageThumbnail(id: string, callback: (thumbnail: { dataUrl: string; width?: number; height?: number }) => void) {
  let subscribers = thumbnailSubscribers.get(id)
  if (!subscribers) {
    subscribers = new Set()
    thumbnailSubscribers.set(id, subscribers)
  }
  subscribers.add(callback)
  return () => {
    subscribers?.delete(callback)
    if (subscribers?.size === 0) thumbnailSubscribers.delete(id)
  }
}

function notifyImageThumbnail(id: string, thumbnail: { dataUrl: string; width?: number; height?: number }) {
  thumbnailSubscribers.get(id)?.forEach((callback) => callback(thumbnail))
}

function scheduleThumbnailBackfill(ids: Iterable<string>, priority: 'visible' | 'background' = 'background') {
  for (const id of ids) {
    if (getCachedThumbnail(id) || thumbnailBackfillRunningIds.has(id)) continue
    const currentPriority = thumbnailBackfillIds.get(id)
    if (!currentPriority || priority === 'visible') thumbnailBackfillIds.set(id, priority)
  }
  scheduleThumbnailBackfillTick()
}

function scheduleThumbnailBackfillTick() {
  if (thumbnailBackfillScheduled || thumbnailBackfillIds.size === 0) return
  thumbnailBackfillScheduled = true

  const run = () => {
    thumbnailBackfillScheduled = false
    void processNextThumbnailBackfill()
  }

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 2_000 })
  } else {
    globalThis.setTimeout(run, 250)
  }
}

async function processNextThumbnailBackfill() {
  if (thumbnailBackfillRunningIds.size > 0) return

  const ids = await getNextThumbnailBackfillBatch()
  for (const id of ids) startThumbnailBackfill(id)

  if (thumbnailBackfillIds.size > 0) scheduleThumbnailBackfillTick()
}

async function getNextThumbnailBackfillBatch() {
  const candidates = getOrderedThumbnailBackfillIds().slice(0, MAX_THUMBNAIL_BACKFILL_CONCURRENT)
  if (candidates.length === 0) return []

  const sizes = await Promise.all(candidates.map(async (id) => {
    const image = await getImage(id)
    return { width: image?.width, height: image?.height }
  }))
  const concurrency = getThumbnailConcurrencyForBatch(sizes)
  const selected = candidates.slice(0, concurrency)
  for (const id of selected) thumbnailBackfillIds.delete(id)
  return selected
}

function getOrderedThumbnailBackfillIds() {
  const visible: string[] = []
  const background: string[] = []
  for (const [id, priority] of thumbnailBackfillIds) {
    if (priority === 'visible') visible.push(id)
    else background.push(id)
  }
  return [...visible, ...background]
}

function getThumbnailConcurrencyForBatch(sizes: Array<{ width?: number; height?: number }>) {
  let maxMegapixels = 0
  for (const { width, height } of sizes) {
    if (!width || !height) return 1
    maxMegapixels = Math.max(maxMegapixels, (width * height) / 1_000_000)
  }
  const megapixels = maxMegapixels
  if (megapixels >= 8) return 1
  if (megapixels >= 4) return 2
  if (megapixels >= 2) return 3
  return 4
}

function startThumbnailBackfill(id: string) {
  thumbnailBackfillRunningIds.add(id)

  void (async () => {
    if (getCachedThumbnail(id)) return

    const [thumbnail, image] = await Promise.all([getImageThumbnail(id), getImage(id)])
    if (thumbnail?.thumbnailDataUrl) {
      cacheThumbnail(id, {
        dataUrl: thumbnail.thumbnailDataUrl,
        width: image?.width ?? thumbnail.width,
        height: image?.height ?? thumbnail.height,
        thumbnailVersion: thumbnail.thumbnailVersion,
      })
      notifyImageThumbnail(id, {
        dataUrl: thumbnail.thumbnailDataUrl,
        width: image?.width ?? thumbnail.width,
        height: image?.height ?? thumbnail.height,
      })
    }
  })().catch(() => {
    // Keep thumbnail generation best-effort; cards remain on placeholders if it fails.
  }).finally(() => {
    thumbnailBackfillRunningIds.delete(id)
    scheduleThumbnailBackfillTick()
  })
}

function orderImagesWithMaskFirst(images: InputImage[], maskTargetImageId: string | null | undefined) {
  if (!maskTargetImageId) return images
  const maskIdx = images.findIndex((img) => img.id === maskTargetImageId)
  if (maskIdx <= 0) return images
  const next = [...images]
  const [maskImage] = next.splice(maskIdx, 1)
  next.unshift(maskImage)
  return next
}

function isAgentTask(task: TaskRecord) {
  return task.sourceMode === 'agent' || Boolean(task.agentConversationId || task.agentRoundId)
}

function showTaskCompletionNotification(title: string, body: string) {
  const settings = normalizeSettings(useStore.getState().settings)
  if (!settings.taskCompletionNotification) return
  showBrowserNotification(title, { body })
}

function countSuccessfulOutputImages(tasks: TaskRecord[]) {
  return tasks.reduce((count, task) => count + (task.status === 'done' && !isAgentTask(task) ? task.outputImages.length : 0), 0)
}

function skipSupportPromptForImportedData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptOpen) return {}
    return { supportPromptSkippedForImportedData: true }
  })
}

function showSupportPromptForExistingLocalData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed || state.supportPromptOpen) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptSkippedForImportedData) return {}
    return { supportPromptOpen: true }
  })
}

function maybeOpenSupportPrompt(previousTasks: TaskRecord[], nextTasks: TaskRecord[], taskId: string) {
  const state = useStore.getState()
  if (state.supportPromptDismissed || state.supportPromptOpen || state.supportPromptSkippedForImportedData) return

  const previousTask = previousTasks.find((task) => task.id === taskId)
  const nextTask = nextTasks.find((task) => task.id === taskId)
  if (!nextTask || previousTask?.status === 'done' || nextTask.status !== 'done' || nextTask.outputImages.length === 0) return

  const previousCount = countSuccessfulOutputImages(previousTasks)
  const nextCount = countSuccessfulOutputImages(nextTasks)
  if (previousCount <= SUPPORT_PROMPT_IMAGE_THRESHOLD && nextCount > SUPPORT_PROMPT_IMAGE_THRESHOLD) {
    useStore.setState({ supportPromptOpen: true })
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeAgentRound(value: unknown, fallbackIndex: number): AgentRound | null {
  if (!value || typeof value !== 'object') return null
  const round = value as Partial<AgentRound>
  if (typeof round.id !== 'string' || !round.id) return null
  if (typeof round.userMessageId !== 'string' || !round.userMessageId) return null

  const imageStatusRequestIds = normalizeStringArray(round.imageStatusRequestIds)
  const canRecoverRunningRound = imageStatusRequestIds.length > 0
  const status = round.status === 'running' && canRecoverRunningRound
    ? 'running'
    : round.status === 'running'
    ? 'error'
    : round.status === 'error' || round.status === 'done'
    ? round.status
    : 'done'

  return {
    id: round.id,
    ...(typeof round.requestId === 'string' ? { requestId: round.requestId } : {}),
    index: typeof round.index === 'number' ? round.index : fallbackIndex + 1,
    parentRoundId: typeof round.parentRoundId === 'string' ? round.parentRoundId : null,
    userMessageId: round.userMessageId,
    ...(typeof round.assistantMessageId === 'string' ? { assistantMessageId: round.assistantMessageId } : {}),
    prompt: typeof round.prompt === 'string' ? round.prompt : '',
    inputImageIds: normalizeStringArray(round.inputImageIds),
    maskTargetImageId: typeof round.maskTargetImageId === 'string' ? round.maskTargetImageId : null,
    maskImageId: typeof round.maskImageId === 'string' ? round.maskImageId : null,
    outputTaskIds: normalizeStringArray(round.outputTaskIds),
    ...(imageStatusRequestIds.length ? { imageStatusRequestIds } : {}),
    ...(round.imageStatusRecoverable === true ? { imageStatusRecoverable: true } : {}),
    ...(typeof round.imageStatusApiProfileId === 'string' ? { imageStatusApiProfileId: round.imageStatusApiProfileId } : {}),
    ...(typeof round.responseId === 'string' ? { responseId: round.responseId } : {}),
    ...(Array.isArray(round.responseOutput) ? { responseOutput: round.responseOutput } : {}),
    status,
    error: status === 'error'
      ? typeof round.error === 'string' ? round.error : '上次请求已中断'
      : null,
    createdAt: typeof round.createdAt === 'number' ? round.createdAt : Date.now(),
    finishedAt: typeof round.finishedAt === 'number' ? round.finishedAt : null,
  }
}

function normalizeAgentMessage(value: unknown): AgentMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Partial<AgentMessage>
  if (typeof message.id !== 'string' || !message.id) return null
  if (message.role !== 'user' && message.role !== 'assistant') return null
  if (typeof message.roundId !== 'string' || !message.roundId) return null

  return {
    id: message.id,
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    roundId: message.roundId,
    ...(Array.isArray(message.inputImageIds) ? { inputImageIds: normalizeStringArray(message.inputImageIds) } : {}),
    maskTargetImageId: typeof message.maskTargetImageId === 'string' ? message.maskTargetImageId : null,
    maskImageId: typeof message.maskImageId === 'string' ? message.maskImageId : null,
    ...(Array.isArray(message.outputTaskIds) ? { outputTaskIds: normalizeStringArray(message.outputTaskIds) } : {}),
    createdAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
  }
}

function normalizeAgentConversations(value: unknown): AgentConversation[] {
  if (!Array.isArray(value)) return []

  return value
    .filter((item): item is AgentConversation => Boolean(item) && typeof item === 'object' && typeof (item as AgentConversation).id === 'string')
    .map((conversation) => {
      const normalizedRounds = Array.isArray(conversation.rounds)
        ? conversation.rounds.map(normalizeAgentRound).filter((round): round is AgentRound => Boolean(round))
        : []
      const hasBranchParents = normalizedRounds.some((round) => round.parentRoundId)
      const hasStoredActiveRound = typeof conversation.activeRoundId === 'string'
      const rounds = hasBranchParents || hasStoredActiveRound
        ? normalizedRounds
        : normalizedRounds.map((round, index) => ({
            ...round,
            parentRoundId: index > 0 ? normalizedRounds[index - 1].id : null,
          }))
      const roundIds = new Set(rounds.map((round) => round.id))
      const messages = Array.isArray(conversation.messages)
        ? conversation.messages
            .map(normalizeAgentMessage)
            .filter((message): message is AgentMessage => message != null && roundIds.has(message.roundId))
        : []
      return {
        id: conversation.id,
        ...(typeof conversation.projectId === 'string' ? { projectId: conversation.projectId } : {}),
        title: typeof conversation.title === 'string' && conversation.title.trim() ? conversation.title : '新对话',
        activeRoundId: typeof conversation.activeRoundId === 'string' && roundIds.has(conversation.activeRoundId) ? conversation.activeRoundId : rounds[rounds.length - 1]?.id ?? null,
        createdAt: typeof conversation.createdAt === 'number' ? conversation.createdAt : Date.now(),
        updatedAt: typeof conversation.updatedAt === 'number' ? conversation.updatedAt : Date.now(),
        rounds,
        messages,
      }
    })
}

function mergeImportedAgentConversations(current: AgentConversation[], imported: AgentConversation[]) {
  const merged = [...current]
  const indexes = new Map(merged.map((conversation, index) => [conversation.id, index]))

  for (const conversation of imported) {
    const index = indexes.get(conversation.id)
    if (index == null) {
      indexes.set(conversation.id, merged.length)
      merged.push(conversation)
    } else {
      merged[index] = conversation
    }
  }

  return merged
}

function mergeAgentConversationsForStorage(stored: AgentConversation[], legacy: AgentConversation[]) {
  const merged = new Map<string, AgentConversation>()
  for (const conversation of stored) merged.set(conversation.id, conversation)
  for (const conversation of legacy) {
    const existing = merged.get(conversation.id)
    if (!existing || conversation.updatedAt >= existing.updatedAt) {
      merged.set(conversation.id, conversation)
    }
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
}

function getPersistableResponseOutputItem(item: ResponsesOutputItem): ResponsesOutputItem {
  if (item.type !== 'image_generation_call' || item.result == null) return item

  if (typeof item.result === 'string') {
    const { result: _result, ...rest } = item
    return rest
  }

  if (!isRecord(item.result)) return item
  const { b64_json: _b64Json, base64: _base64, image: _image, data: _data, ...restResult } = item.result
  if (Object.keys(restResult).length === 0) {
    const { result: _result, ...rest } = item
    return rest
  }

  return { ...item, result: restResult }
}

function getPersistableAgentConversations(conversations: AgentConversation[]): AgentConversation[] {
  return conversations.map((conversation) => ({
    ...conversation,
    rounds: conversation.rounds.map((round) => round.responseOutput?.length
      ? {
          ...round,
          responseOutput: round.responseOutput.map(getPersistableResponseOutputItem),
        }
      : round,
    ),
  }))
}

function stripPersistedAgentConversations(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((conversation) => {
    if (!isRecord(conversation) || !Array.isArray(conversation.rounds)) return conversation
    return {
      ...conversation,
      rounds: conversation.rounds.map((round) => {
        if (!isRecord(round) || !Array.isArray(round.responseOutput)) return round
        return {
          ...round,
          responseOutput: round.responseOutput.map((item) =>
            isRecord(item) ? getPersistableResponseOutputItem(item as ResponsesOutputItem) : item,
          ),
        }
      }),
    }
  })
}

export function migratePersistedState(persistedState: unknown): unknown {
  if (!isRecord(persistedState)) return persistedState
  return {
    ...persistedState,
    agentConversations: stripPersistedAgentConversations(persistedState.agentConversations),
  }
}

function normalizeFavoriteCollectionName(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

function normalizeProjects(value: unknown): Project[] {
  if (!Array.isArray(value)) return []
  const projects: Project[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)) continue
    const initialPrompt = typeof item.initialPrompt === 'string' ? item.initialPrompt.trim() : ''
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    if (!title && !initialPrompt) continue
    const createdAt = typeof item.createdAt === 'number' ? item.createdAt : Date.now()
    const canvas = normalizeProjectCanvas(item.canvas)
    ids.add(item.id)
    projects.push({
      id: item.id,
      title: title || createProjectTitle(initialPrompt),
      initialPrompt,
      storage: item.storage === 'online' ? 'online' : 'local',
      ...(typeof item.remoteId === 'string' && item.remoteId ? { remoteId: item.remoteId } : {}),
      ...(typeof item.remoteArchiveSha256 === 'string' && item.remoteArchiveSha256 ? { remoteArchiveSha256: item.remoteArchiveSha256 } : {}),
      ...(item.syncPending === true ? { syncPending: true } : {}),
      ...(item.defaultFavoriteCollectionId === null || typeof item.defaultFavoriteCollectionId === 'string'
        ? { defaultFavoriteCollectionId: item.defaultFavoriteCollectionId }
        : {}),
      ...(canvas ? { canvas } : {}),
      createdAt,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : createdAt,
    })
  }
  return projects
}

function normalizeProjectCanvasCache(value: unknown) {
  if (!isRecord(value)) return {}
  const cache: Record<string, ProjectCanvasState> = {}
  for (const [projectId, rawCanvas] of Object.entries(value)) {
    const canvas = normalizeProjectCanvas(rawCanvas)
    if (canvas) cache[projectId] = canvas
  }
  return cache
}

function createProjectTitle(prompt: string) {
  const title = prompt.replace(/\s+/g, ' ').trim()
  const chars = Array.from(title)
  if (chars.length <= PROJECT_TITLE_MAX_LENGTH) return title || '未命名项目'
  return `${chars.slice(0, PROJECT_TITLE_MAX_LENGTH - 3).join('')}...`
}


function createDefaultFavoriteCollection(now = Date.now(), projectId?: string): FavoriteCollection {
  return {
    id: projectId ? `${DEFAULT_FAVORITE_COLLECTION_ID}:${projectId}` : DEFAULT_FAVORITE_COLLECTION_ID,
    ...(projectId ? { projectId } : {}),
    name: DEFAULT_FAVORITE_COLLECTION_NAME,
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeFavoriteCollections(value: unknown): FavoriteCollection[] {
  const now = Date.now()
  const collections = Array.isArray(value) ? value : []
  const normalized: FavoriteCollection[] = []
  const ids = new Set<string>()
  for (const item of collections) {
    if (!isRecord(item)) continue
    if (typeof item.id !== 'string' || !item.id.trim()) continue
    const id = item.id
    const projectId = typeof item.projectId === 'string' && item.projectId && item.projectId !== ALL_PROJECTS_ID && item.projectId !== LOCAL_PROJECT_ID
      ? item.projectId
      : undefined
    const scopedId = `${projectId ?? ''}\n${id}`
    if (id === ALL_FAVORITES_COLLECTION_ID || ids.has(scopedId)) continue
    const name = normalizeFavoriteCollectionName(typeof item.name === 'string' ? item.name : '')
    if (!name) continue
    ids.add(scopedId)
    normalized.push({
      id,
      ...(projectId ? { projectId } : {}),
      name: name.slice(0, 60),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : now,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : now,
    })
  }
  return normalized
}

function ensureDefaultFavoriteCollection(collections: FavoriteCollection[]) {
  if (collections.length > 0) return collections
  return [createDefaultFavoriteCollection(), ...collections]
}

/** 确保"默认"收藏夹存在（用于兜底孤立收藏任务） */
function ensureDefaultNamedCollection(collections: FavoriteCollection[]) {
  if (getDefaultNamedFavoriteCollectionId(collections)) return collections
  return [createDefaultFavoriteCollection(), ...collections]
}

function getDefaultNamedFavoriteCollectionId(collections: FavoriteCollection[]) {
  return collections.find((collection) => collection.id === DEFAULT_FAVORITE_COLLECTION_ID)?.id
    ?? collections.find((collection) => collection.name === DEFAULT_FAVORITE_COLLECTION_NAME)?.id
    ?? null
}

function resolveDefaultFavoriteCollectionId(collections: FavoriteCollection[], preferredId: unknown) {
  if (preferredId === null) return null
  if (typeof preferredId === 'string' && collections.some((collection) => collection.id === preferredId)) return preferredId
  if (collections.some((collection) => collection.id === DEFAULT_FAVORITE_COLLECTION_ID)) return DEFAULT_FAVORITE_COLLECTION_ID
  return collections[0]?.id ?? null
}

export function getFavoriteScopeProjectId(activeProjectId: string | null) {
  return activeProjectId && activeProjectId !== ALL_PROJECTS_ID && activeProjectId !== LOCAL_PROJECT_ID
    ? activeProjectId
    : undefined
}

export function getFavoriteCollectionsForProject(collections: FavoriteCollection[], projectId?: string) {
  return collections.filter((collection) => collection.projectId === projectId)
}

function getFavoriteDefaultForProject(state: AppState, projectId?: string) {
  const collections = getFavoriteCollectionsForProject(state.favoriteCollections, projectId)
  if (!projectId) return resolveDefaultFavoriteCollectionId(collections, state.defaultFavoriteCollectionId)
  const project = state.projects.find((item) => item.id === projectId)
  return resolveDefaultFavoriteCollectionId(collections, project?.defaultFavoriteCollectionId)
}

export function getActiveFavoriteCollections(state = useStore.getState()) {
  return getFavoriteCollectionsForProject(state.favoriteCollections, getFavoriteScopeProjectId(state.activeProjectId))
}

export function getActiveDefaultFavoriteCollectionId(state = useStore.getState()) {
  return getFavoriteDefaultForProject(state, getFavoriteScopeProjectId(state.activeProjectId))
}

function ensureProjectFavoriteCollections(collections: FavoriteCollection[], projects: Project[]) {
  const normalized = normalizeFavoriteCollections(collections)
  const legacyCollections = getFavoriteCollectionsForProject(normalized)
  const next = [...normalized]
  for (const project of projects) {
    if (project.id === LOCAL_PROJECT_ID) continue
    if (getFavoriteCollectionsForProject(next, project.id).length > 0) continue
    if (legacyCollections.length > 0) {
      next.push(...legacyCollections.map((collection) => ({ ...collection, projectId: project.id })))
      continue
    }
    next.push(createDefaultFavoriteCollection(Date.now(), project.id))
  }
  return next
}

function createAgentConversation(now = Date.now(), projectId?: string): AgentConversation {
  return {
    id: genId(),
    ...(projectId ? { projectId } : {}),
    title: '新对话',
    activeRoundId: null,
    createdAt: now,
    updatedAt: now,
    rounds: [],
    messages: [],
  }
}

function createAgentConversationTitle(prompt: string, fallbackTitle: string) {
  const title = prompt.replace(/\s+/g, ' ').trim()
  if (!title) return fallbackTitle
  const chars = Array.from(title)
  if (chars.length <= AGENT_CONVERSATION_TITLE_MAX_LENGTH) return title
  return `${chars.slice(0, AGENT_CONVERSATION_TITLE_MAX_LENGTH - 3).join('')}...`
}

function isEmptyAgentConversation(conversation: AgentConversation) {
  return conversation.rounds.length === 0 && conversation.messages.length === 0 && !conversation.activeRoundId
}

function getLatestAgentConversation(conversations: AgentConversation[]) {
  return conversations.reduce<AgentConversation | null>((latest, conversation) => {
    if (!latest) return conversation
    if (conversation.updatedAt !== latest.updatedAt) return conversation.updatedAt > latest.updatedAt ? conversation : latest
    return conversation.createdAt > latest.createdAt ? conversation : latest
  }, null)
}

export function getPersistedState(state: AppState) {
  const settings = normalizeSettings(state.settings)
  const galleryInputDraft = getPersistableGalleryInputDraft(state)
  return {
    settings,
    params: state.params,
    ...(settings.persistInputOnRestart && (state.appMode === 'gallery' || galleryInputDraft)
      ? {
          prompt: galleryInputDraft?.prompt ?? '',
          inputImages: galleryInputDraft?.inputImages.map((img) => ({ id: img.id, dataUrl: '' })) ?? [],
        }
      : {}),
    dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
    appMode: state.appMode,
    activeProjectId: state.activeProjectId,
    projectCanvasCache: state.projectCanvasCache,
    galleryInputDraft: settings.persistInputOnRestart && galleryInputDraft
      ? { ...galleryInputDraft, inputImages: galleryInputDraft.inputImages.map((img) => ({ id: img.id, dataUrl: '' })) }
      : null,
    ...(agentConversationMigrationPending && !agentConversationPersistenceReady
      ? { agentConversations: getPersistableAgentConversations(state.agentConversations) }
      : {}),
    activeAgentConversationId: state.activeAgentConversationId,
    agentInputDrafts: getPersistableAgentInputDrafts(state),
    agentSidebarCollapsed: state.agentSidebarCollapsed,
    agentAssetTab: state.agentAssetTab,
    agentAssetPanelCollapsed: state.agentAssetPanelCollapsed,
    favoriteCollections: state.favoriteCollections,
    defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
    supportPromptDismissed: state.supportPromptDismissed,
    supportPromptOpen: state.supportPromptOpen,
    supportPromptSkippedForImportedData: state.supportPromptSkippedForImportedData,
  }
}

async function replaceStoredAgentConversations(conversations: AgentConversation[]) {
  await replaceAgentConversations(conversations.map(getPersistableAgentConversation))
}

function getPersistableAgentConversation(conversation: AgentConversation): AgentConversation {
  return getPersistableAgentConversations([conversation])[0]!
}

function mergePersistedState(persistedState: unknown, currentState: AppState): AppState {
  if (!persistedState || typeof persistedState !== 'object') return currentState

  const persisted = persistedState as Partial<AppState>
  const settings = normalizeSettings(persisted.settings ?? currentState.settings)
  const hasPersistedAgentConversations = Array.isArray(persisted.agentConversations)
  if (hasPersistedAgentConversations && normalizeAgentConversations(persisted.agentConversations).length > 0) {
    agentConversationMigrationPending = true
  }
  const agentConversations = hasPersistedAgentConversations
    ? normalizeAgentConversations(persisted.agentConversations)
    : currentState.agentConversations
  const activeAgentConversationId =
    typeof persisted.activeAgentConversationId === 'string' && (!hasPersistedAgentConversations || agentConversations.some((conversation) => conversation.id === persisted.activeAgentConversationId))
      ? persisted.activeAgentConversationId
      : agentConversations[0]?.id ?? null
  const appMode = persisted.appMode === 'agent' ? 'agent' : 'gallery'
  const activeProjectId = typeof persisted.activeProjectId === 'string' ? persisted.activeProjectId : null
  const galleryInputDraft = settings.persistInputOnRestart
    ? normalizeAgentInputDraft(persisted.galleryInputDraft ?? {
        prompt: persisted.prompt,
        inputImages: persisted.inputImages,
        maskDraft: null,
        maskEditorImageId: null,
      })
    : null
  const normalizedAgentInputDrafts = hasPersistedAgentConversations
    ? normalizeAgentInputDrafts(persisted.agentInputDrafts, agentConversations)
    : normalizeAgentInputDraftsByKey(persisted.agentInputDrafts)
  let agentInputDrafts = cleanStaleAgentInputDrafts(normalizedAgentInputDrafts, activeAgentConversationId)
  if (appMode === 'agent' && activeAgentConversationId && !agentInputDrafts[activeAgentConversationId] && settings.persistInputOnRestart && typeof persisted.prompt === 'string') {
    agentInputDrafts = {
      ...agentInputDrafts,
      [activeAgentConversationId]: normalizeAgentInputDraft({
        prompt: persisted.prompt,
        inputImages: persisted.inputImages,
        maskDraft: null,
        maskEditorImageId: null,
      }, Date.now()),
    }
  }
  const restoredAgentDraft = appMode === 'agent' && activeAgentConversationId
    ? agentInputDrafts[activeAgentConversationId] ?? null
    : null
  const favoriteCollections = Array.isArray(persisted.favoriteCollections)
    ? ensureDefaultFavoriteCollection(normalizeFavoriteCollections(persisted.favoriteCollections))
    : currentState.favoriteCollections
  const defaultFavoriteCollectionId = resolveDefaultFavoriteCollectionId(favoriteCollections, persisted.defaultFavoriteCollectionId)
  const projectCanvasCache = normalizeProjectCanvasCache(persisted.projectCanvasCache)
  return {
    ...currentState,
    ...persisted,
    settings,
    appMode,
    activeProjectId,
    projectCanvasCache,
    galleryInputDraft: galleryInputDraft && !isEmptyAgentInputDraft(galleryInputDraft) ? galleryInputDraft : null,
    agentConversations,
    activeAgentConversationId,
    agentInputDrafts,
    agentSidebarCollapsed: Boolean(persisted.agentSidebarCollapsed),
    agentAssetTab: persisted.agentAssetTab === 'references' ? 'references' : 'outputs',
    agentAssetPanelCollapsed: Boolean(persisted.agentAssetPanelCollapsed),
    favoriteCollections,
    defaultFavoriteCollectionId,
    activeFavoriteCollectionId: null,
    favoritePickerTaskIds: null,
    favoritePickerImageIds: null,
    supportPromptDismissed: Boolean(persisted.supportPromptDismissed),
    supportPromptOpen: Boolean(persisted.supportPromptOpen),
    supportPromptSkippedForImportedData: Boolean(persisted.supportPromptSkippedForImportedData),
    prompt: restoredAgentDraft ? restoredAgentDraft.prompt : galleryInputDraft?.prompt ?? '',
    inputImages: restoredAgentDraft ? restoredAgentDraft.inputImages : galleryInputDraft?.inputImages ?? [],
    maskDraft: restoredAgentDraft ? restoredAgentDraft.maskDraft : galleryInputDraft?.maskDraft ?? null,
    maskEditorImageId: restoredAgentDraft ? restoredAgentDraft.maskEditorImageId : galleryInputDraft?.maskEditorImageId ?? null,
  }
}

// ===== Store 类型 =====

interface AppState {
  // 模式
  appMode: AppMode
  setAppMode: (mode: AppMode) => void

  // 项目
  projects: Project[]
  projectCanvasCache: Record<string, ProjectCanvasState>
  projectsLoaded: boolean
  activeProjectId: string | null
  createProject: (prompt: string, options?: { autoRecord?: boolean }) => string
  renameProject: (id: string, title: string) => void
  touchProjectUpdatedAt: (id: string) => void
  updateProjectCanvas: (id: string, canvas: ProjectCanvasState) => void
  updateProjectCanvasViewport: (id: string, viewport: ProjectCanvasViewport) => void
  flushProjectCanvasOnExit: (id: string, canvas: ProjectCanvasState, force?: boolean) => void
  setActiveProjectId: (id: string | null) => void
  deleteProject: (id: string) => Promise<void>
  legacyProjectSaving: boolean
  saveLegacyProjectOnline: () => Promise<void>

  // 设置
  settings: AppSettings
  setSettings: (s: Partial<AppSettings>) => void
  oidcApiOverride: ApiOverride | null
  setOidcApiOverride: (apiOverride: ApiOverride | null) => void
  agentOidcApiOverride: ApiOverride | null
  setAgentOidcApiOverride: (apiOverride: ApiOverride | null) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  replaceInputImage: (idx: number, img: InputImage) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[], options?: { equivalentImageIds?: Record<string, string> }) => void
  moveInputImage: (fromIdx: number, toIdx: number) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void
  galleryInputDraft: AgentInputDraft | null

  // 参数
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void
  reusedTaskApiProfileId: string | null
  reusedTaskApiProfileName: string | null
  reusedTaskApiProfileMissing: boolean
  setReusedTaskApiProfile: (profileId: string | null, missing?: boolean, profileName?: string | null) => void

  // Agent
  agentConversations: AgentConversation[]
  agentConversationsLoaded: boolean
  activeAgentConversationId: string | null
  agentInputDrafts: Record<string, AgentInputDraft>
  setAgentInputPrompt: (conversationId: string, prompt: string) => void
  addAgentInputImage: (conversationId: string, img: InputImage) => void
  replaceAgentInputImage: (conversationId: string, idx: number, img: InputImage) => void
  removeAgentInputImage: (conversationId: string, idx: number) => void
  clearAgentInputImages: (conversationId: string) => void
  setAgentInputImages: (conversationId: string, imgs: InputImage[], options?: { equivalentImageIds?: Record<string, string> }) => void
  moveAgentInputImage: (conversationId: string, fromIdx: number, toIdx: number) => void
  agentSidebarCollapsed: boolean
  agentAssetTab: 'references' | 'outputs'
  agentAssetPanelCollapsed: boolean
  agentMobileHeaderVisible: boolean
  agentEditingRoundId: string | null
  agentEditingConversationId: string | null
  agentGeneratingTitleIds: Record<string, true>
  createAgentConversation: () => string
  setActiveAgentConversationId: (id: string | null) => void
  setActiveAgentRoundId: (conversationId: string, roundId: string | null) => void
  renameAgentConversation: (id: string, title: string) => void
  deleteAgentConversation: (id: string) => void
  setAgentSidebarCollapsed: (collapsed: boolean) => void
  setAgentAssetTab: (tab: 'references' | 'outputs') => void
  setAgentAssetPanelCollapsed: (collapsed: boolean) => void
  setAgentMobileHeaderVisible: (visible: boolean) => void
  setAgentEditingRoundId: (id: string | null) => void
  setAgentEditingConversationId: (id: string | null) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void
  favoriteCollections: FavoriteCollection[]
  setFavoriteCollections: (collections: FavoriteCollection[]) => void
  defaultFavoriteCollectionId: string | null
  setDefaultFavoriteCollectionId: (id: string | null) => void
  activeFavoriteCollectionId: string | null
  isManageCollectionsModalOpen: boolean
  setActiveFavoriteCollectionId: (id: string | null) => void
  openManageCollectionsModal: () => void
  closeManageCollectionsModal: () => void
  favoritePickerTaskIds: string[] | null
  favoritePickerImageIds: string[] | null
  openFavoritePicker: (taskIds: string[]) => void
  openImageFavoritePicker: (imageIds: string[]) => void
  closeFavoritePicker: () => void
  streamPreviews: Record<string, string>
  streamPreviewSlots: Record<string, Record<string, string>>
  setTaskStreamPreview: (taskId: string, image?: string, requestIndex?: number) => void

  // 搜索和筛选
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'running' | 'done' | 'error'
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void

  // 多选
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void
  selectedFavoriteCollectionIds: string[]
  setSelectedFavoriteCollectionIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleFavoriteCollectionSelection: (id: string, force?: boolean) => void
  clearFavoriteCollectionSelection: () => void

  // UI
  detailTaskId: string | null
  detailImageId: string | null
  setDetailTaskId: (id: string | null) => void
  setDetailImage: (taskId: string, imageId: string) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  setLightboxImageId: (id: string | null, list?: string[]) => void
  showSettings: boolean
  settingsTabRequest: SettingsTab | null
  setShowSettings: (v: boolean, tab?: SettingsTab) => void
  supportPromptOpen: boolean
  supportPromptDismissed: boolean
  supportPromptSkippedForImportedData: boolean
  setSupportPromptOpen: (v: boolean) => void
  dismissSupportPrompt: () => void

  // Toast
  toast: { message: string; type: ToastType } | null
  showToast: (message: string, type?: ToastType) => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    checkbox?: {
      label: string
      defaultChecked?: boolean
      disabled?: boolean
      tone?: 'primary' | 'danger'
    }
    confirmText?: string
    cancelText?: string
    showCancel?: boolean
    buttons?: Array<{
      label: string
      tone?: 'primary' | 'secondary' | 'danger' | 'warning'
      action: (checkboxChecked?: boolean) => void
    }>
    icon?: 'info' | 'copy'
    minConfirmDelayMs?: number
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    action?: (checkboxChecked?: boolean) => void
    cancelAction?: (checkboxChecked?: boolean) => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void
}

function isImageReferencedByState(state: AppState, imageId: string) {
  if (state.inputImages.some((img) => img.id === imageId)) return true
  if (state.galleryInputDraft?.inputImages.some((img) => img.id === imageId)) return true
  if (Object.values(state.agentInputDrafts).some((draft) => draft.inputImages.some((img) => img.id === imageId))) return true
  if (state.tasks.some((task) =>
    task.inputImageIds.includes(imageId) ||
    task.outputImages.includes(imageId) ||
    task.transparentOriginalImages?.includes(imageId) ||
    task.streamPartialImageIds?.includes(imageId) ||
    task.maskTargetImageId === imageId ||
    task.maskImageId === imageId
  )) return true
  return state.agentConversations.some((conversation) =>
    conversation.rounds.some((round) =>
      round.inputImageIds.includes(imageId) ||
      round.maskTargetImageId === imageId ||
      round.maskImageId === imageId
    ) ||
    conversation.messages.some((message) =>
      message.inputImageIds?.includes(imageId) ||
      message.maskTargetImageId === imageId ||
      message.maskImageId === imageId
    ),
  )
}

export async function deleteImageIfUnreferenced(imageId: string) {
  imageCache.delete(imageId)
  thumbnailCache.delete(imageId)
  thumbnailBackfillIds.delete(imageId)
  thumbnailBackfillRunningIds.delete(imageId)
  thumbnailSubscribers.delete(imageId)
  if (isImageReferencedByState(useStore.getState(), imageId)) return
  try {
    await deleteImage(imageId)
  } catch {
    // 清理是内存/存储优化，失败不影响替换结果。
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeInputImages(value: unknown): InputImage[] {
  if (!Array.isArray(value)) return []
  return value
    .map((img): InputImage | null => {
      if (!isRecord(img) || typeof img.id !== 'string') return null
      return { id: img.id, dataUrl: typeof img.dataUrl === 'string' ? img.dataUrl : '' }
    })
    .filter((img): img is InputImage => img != null)
}

function normalizeMaskDraft(value: unknown): MaskDraft | null {
  if (!isRecord(value)) return null
  if (typeof value.targetImageId !== 'string' || typeof value.maskDataUrl !== 'string') return null
  return {
    targetImageId: value.targetImageId,
    maskDataUrl: value.maskDataUrl,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
  }
}

function normalizeAgentInputDraft(value: unknown, fallbackUpdatedAt = Date.now()): AgentInputDraft {
  const draft = isRecord(value) ? value : {}
  const updatedAt = typeof draft.updatedAt === 'number' && Number.isFinite(draft.updatedAt) ? draft.updatedAt : fallbackUpdatedAt
  return {
    prompt: typeof draft.prompt === 'string' ? draft.prompt : '',
    inputImages: normalizeInputImages(draft.inputImages),
    maskDraft: normalizeMaskDraft(draft.maskDraft),
    maskEditorImageId: typeof draft.maskEditorImageId === 'string' ? draft.maskEditorImageId : null,
    updatedAt,
  }
}

function normalizeAgentInputDrafts(value: unknown, conversations: AgentConversation[]): Record<string, AgentInputDraft> {
  if (!isRecord(value)) return {}
  const conversationIds = new Set(conversations.map((conversation) => conversation.id))
  const drafts: Record<string, AgentInputDraft> = {}
  for (const [conversationId, draft] of Object.entries(value)) {
    if (!conversationIds.has(conversationId)) continue
    const normalized = normalizeAgentInputDraft(draft)
    if (!isEmptyAgentInputDraft(normalized)) drafts[conversationId] = normalized
  }
  return drafts
}

function normalizeAgentInputDraftsByKey(value: unknown): Record<string, AgentInputDraft> {
  if (!isRecord(value)) return {}
  const drafts: Record<string, AgentInputDraft> = {}
  for (const [conversationId, draft] of Object.entries(value)) {
    const normalized = normalizeAgentInputDraft(draft)
    if (!isEmptyAgentInputDraft(normalized)) drafts[conversationId] = normalized
  }
  return drafts
}

export function cleanStaleAgentInputDrafts(drafts: Record<string, AgentInputDraft>, activeConversationId: string | null, now = Date.now()) {
  const cutoff = now - AGENT_INPUT_DRAFT_RETENTION_MS
  const next: Record<string, AgentInputDraft> = {}
  for (const [conversationId, draft] of Object.entries(drafts)) {
    if (conversationId === activeConversationId || (draft.updatedAt ?? now) >= cutoff) {
      next[conversationId] = draft
    }
  }
  return next
}

function clearInputDraftState(): Pick<AgentInputDraft, 'prompt' | 'inputImages' | 'maskDraft' | 'maskEditorImageId'> {
  return {
    prompt: '',
    inputImages: [],
    maskDraft: null,
    maskEditorImageId: null,
  }
}

function copyAgentInputDraft(draft: AgentInputDraft): AgentInputDraft {
  return {
    prompt: draft.prompt,
    inputImages: draft.inputImages.map((img) => ({ ...img })),
    maskDraft: draft.maskDraft ? { ...draft.maskDraft } : null,
    maskEditorImageId: draft.maskEditorImageId,
    updatedAt: draft.updatedAt ?? Date.now(),
  }
}

function getCurrentAgentInputDraft(state: Pick<AppState, 'prompt' | 'inputImages' | 'maskDraft' | 'maskEditorImageId'>): AgentInputDraft {
  return {
    prompt: state.prompt,
    inputImages: state.inputImages,
    maskDraft: state.maskDraft,
    maskEditorImageId: state.maskEditorImageId,
    updatedAt: Date.now(),
  }
}

function isEmptyAgentInputDraft(draft: AgentInputDraft) {
  return draft.prompt.length === 0 && draft.inputImages.length === 0 && !draft.maskDraft && !draft.maskEditorImageId
}

function setAgentInputDraft(drafts: Record<string, AgentInputDraft>, conversationId: string, draft: AgentInputDraft) {
  const next = { ...drafts }
  if (isEmptyAgentInputDraft(draft)) {
    delete next[conversationId]
  } else {
    next[conversationId] = copyAgentInputDraft(draft)
  }
  return next
}

function saveActiveAgentInputDrafts(state: Pick<AppState, 'appMode' | 'activeAgentConversationId' | 'agentInputDrafts' | 'prompt' | 'inputImages' | 'maskDraft' | 'maskEditorImageId'>) {
  if (state.appMode !== 'agent' || !state.activeAgentConversationId) return state.agentInputDrafts
  return setAgentInputDraft(state.agentInputDrafts, state.activeAgentConversationId, getCurrentAgentInputDraft(state))
}

function saveGalleryInputDraft(state: Pick<AppState, 'appMode' | 'galleryInputDraft' | 'prompt' | 'inputImages' | 'maskDraft' | 'maskEditorImageId'>) {
  if (state.appMode !== 'gallery') return state.galleryInputDraft
  const draft = getCurrentAgentInputDraft(state)
  return isEmptyAgentInputDraft(draft) ? null : copyAgentInputDraft(draft)
}

function getPersistableGalleryInputDraft(state: AppState) {
  return saveGalleryInputDraft(state)
}

function restoreGalleryInputDraftState(draft: AgentInputDraft | null): Pick<AgentInputDraft, 'prompt' | 'inputImages' | 'maskDraft' | 'maskEditorImageId'> {
  if (!draft) return clearInputDraftState()
  return {
    prompt: draft.prompt,
    inputImages: draft.inputImages.map((img) => ({ ...img })),
    maskDraft: draft.maskDraft ? { ...draft.maskDraft } : null,
    maskEditorImageId: draft.maskEditorImageId,
  }
}

function restoreAgentInputDraftState(drafts: Record<string, AgentInputDraft>, conversationId: string | null): Pick<AgentInputDraft, 'prompt' | 'inputImages' | 'maskDraft' | 'maskEditorImageId'> {
  const draft = conversationId ? drafts[conversationId] : null
  return restoreGalleryInputDraftState(draft ?? null)
}

function syncActiveInputDraft<T extends Partial<AgentInputDraft>>(
  state: AppState,
  patch: T,
): T & { agentInputDrafts?: Record<string, AgentInputDraft>; galleryInputDraft?: AgentInputDraft | null } {
  const draft: AgentInputDraft = {
    prompt: patch.prompt ?? state.prompt,
    inputImages: patch.inputImages ?? state.inputImages,
    maskDraft: patch.maskDraft !== undefined ? patch.maskDraft : state.maskDraft,
    maskEditorImageId: patch.maskEditorImageId !== undefined ? patch.maskEditorImageId : state.maskEditorImageId,
  }
  if (state.appMode === 'gallery') {
    return {
      ...patch,
      galleryInputDraft: isEmptyAgentInputDraft(draft) ? null : copyAgentInputDraft(draft),
    }
  }
  if (!state.activeAgentConversationId) return patch
  return {
    ...patch,
    agentInputDrafts: setAgentInputDraft(state.agentInputDrafts, state.activeAgentConversationId, draft),
  }
}

function getPersistableAgentInputDrafts(state: AppState) {
  const drafts = saveActiveAgentInputDrafts(state)
  const conversationIds = new Set(state.agentConversations.map((conversation) => conversation.id))
  const persistable: Record<string, AgentInputDraft> = {}
  for (const [conversationId, draft] of Object.entries(drafts)) {
    if (!conversationIds.has(conversationId) || isEmptyAgentInputDraft(draft)) continue
    persistable[conversationId] = {
      ...copyAgentInputDraft(draft),
      inputImages: draft.inputImages.map((img) => ({ id: img.id, dataUrl: '' })),
    }
  }
  return persistable
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Projects
      projects: [],
      projectCanvasCache: {},
      projectsLoaded: false,
      activeProjectId: null,
      legacyProjectSaving: false,
      createProject: (prompt, options) => {
        const now = Date.now()
        const online = isAuthEnabled() && (options?.autoRecord === true || Boolean(getAccessToken()))
        const id = online ? crypto.randomUUID() : genId()
        const defaultCollection = createDefaultFavoriteCollection(now, id)
        const project: Project = {
          id,
          title: createProjectTitle(prompt),
          initialPrompt: prompt.trim(),
          storage: online ? 'online' : 'local',
          ...(online ? { remoteId: id, syncPending: true } : {}),
          defaultFavoriteCollectionId: defaultCollection.id,
          createdAt: now,
          updatedAt: now,
        }
        get().setAppMode('gallery')
        set((state) => ({
          projects: [project, ...state.projects],
          favoriteCollections: [...state.favoriteCollections, defaultCollection],
          activeProjectId: project.id,
          selectedTaskIds: [],
          selectedFavoriteCollectionIds: [],
          activeAgentConversationId: null,
          agentEditingRoundId: null,
          agentEditingConversationId: null,
        }))
        queueProjectSave(project)
        return project.id
      },
      renameProject: (id, title) => {
        const project = get().projects.find((item) => item.id === id)
        const normalizedTitle = title.replace(/\s+/g, ' ').trim()
        if (!project || !normalizedTitle) return
        const updated = {
          ...project,
          title: createProjectTitle(normalizedTitle),
          updatedAt: Date.now(),
        }
        set((state) => ({
          projects: [updated, ...state.projects.filter((item) => item.id !== id)],
        }))
        queueProjectSave(updated)
        if (project.storage !== 'online' || !project.remoteId) return
        if (project.syncPending) {
          scheduleOnlineProjectSync(project.id)
          return
        }
        void renameOnlineProject(project.remoteId, updated.title).catch((err) => {
          const current = get().projects.find((item) => item.id === id)
          if (current?.title === updated.title) {
            const restored = { ...project, updatedAt: Date.now() }
            set((state) => ({
              projects: [restored, ...state.projects.filter((item) => item.id !== id)],
            }))
            queueProjectSave(restored)
          }
          get().showToast(err instanceof Error ? err.message : String(err), 'error')
        })
      },
      touchProjectUpdatedAt: (id) => {
        const project = get().projects.find((item) => item.id === id)
        if (!project) return
        const updated = { ...project, updatedAt: Date.now() }
        set((state) => ({
          projects: state.projects.map((item) => item.id === id ? updated : item),
        }))
        queueProjectSave(updated)
      },
      updateProjectCanvas: (id, canvas) => {
        const project = get().projects.find((item) => item.id === id)
        const now = Date.now()
        const updated: Project | null = project
          ? {
              ...project,
              canvas,
              ...(project.storage === 'online' ? { syncPending: true } : {}),
              updatedAt: now,
            }
          : id === LOCAL_PROJECT_ID
            ? {
                id: LOCAL_PROJECT_ID,
                title: '本地数据',
                initialPrompt: '',
                storage: 'local',
                canvas,
                createdAt: now,
                updatedAt: now,
              }
          : null
        if (!updated) return
        set((state) => ({
          projectCanvasCache: { ...state.projectCanvasCache, [id]: canvas },
          projects: project
            ? state.projects.map((item) => item.id === id ? updated : item)
            : [updated, ...state.projects],
        }))
        queueProjectSave(updated)
        if (updated.storage === 'online' && updated.remoteId) queueOnlineProjectCanvasSync(updated)
      },
      updateProjectCanvasViewport: (id, viewport) => {
        const project = get().projects.find((item) => item.id === id)
        const baseCanvas = project?.canvas ?? get().projectCanvasCache[id]
        if (!baseCanvas && id !== LOCAL_PROJECT_ID) return
        if (baseCanvas && baseCanvas.viewport.x === viewport.x && baseCanvas.viewport.y === viewport.y && baseCanvas.viewport.scale === viewport.scale) return
        const canvas = { ...(baseCanvas ?? ensureProjectCanvas(undefined, [])), viewport }
        const now = Date.now()
        const updated: Project | null = project
          ? { ...project, canvas, updatedAt: now }
          : id === LOCAL_PROJECT_ID
            ? {
                id: LOCAL_PROJECT_ID,
                title: '本地数据',
                initialPrompt: '',
                storage: 'local',
                canvas,
                createdAt: now,
                updatedAt: now,
              }
            : null
        if (!updated) return
        set((state) => ({
          projectCanvasCache: { ...state.projectCanvasCache, [id]: canvas },
          projects: project
            ? state.projects.map((item) => item.id === id ? updated : item)
            : [updated, ...state.projects],
        }))
        queueProjectSave(updated)
        if (updated.storage === 'online' && updated.remoteId) queueOnlineProjectViewportSync(updated)
      },
      flushProjectCanvasOnExit: (id, canvas, force = false) => {
        const project = get().projects.find((item) => item.id === id)
        if (!project) return
        const hasPendingSave = force
          || projectPersistenceQueues.has(id)
          || onlineProjectSyncTimers.has(id)
          || onlineProjectSyncQueues.has(id)
          || onlineProjectCanvasSyncQueues.has(id)
          || Boolean(project.syncPending)
        if (!hasPendingSave) return
        const updated: Project = {
          ...project,
          canvas,
          ...(project.storage === 'online' ? { syncPending: true } : {}),
          updatedAt: Date.now(),
        }
        set((state) => ({
          projectCanvasCache: { ...state.projectCanvasCache, [id]: canvas },
          projects: state.projects.map((item) => item.id === id ? updated : item),
        }))
        queueProjectSave(updated)
        if (updated.storage === 'online' && updated.remoteId) {
          void saveOnlineProjectCanvas(updated, canvas, { keepalive: true }).catch(() => undefined)
        }
      },
      setActiveProjectId: (activeProjectId) => {
        const changed = get().activeProjectId !== activeProjectId
        set({
          activeProjectId,
          selectedTaskIds: [],
          selectedFavoriteCollectionIds: [],
          searchQuery: '',
          filterStatus: 'all',
          filterFavorite: false,
          activeFavoriteCollectionId: null,
          ...(changed ? {
            activeAgentConversationId: null,
            agentEditingRoundId: null,
            agentEditingConversationId: null,
          } : {}),
        })
        if (!changed || !isAuthEnabled() || !getAccessToken()) return
        const refresh = () => {
          if (useStore.getState().activeProjectId === activeProjectId) void initStore()
        }
        if (onlineProjectCacheReady) refresh()
        else if (initStoreInFlight) void initStoreInFlight.then(refresh)
      },
      deleteProject: async (id) => {
        const isLocalProject = id === LOCAL_PROJECT_ID
        const project = get().projects.find((item) => item.id === id)
        if (!project && !isLocalProject) return
        const timer = onlineProjectSyncTimers.get(id)
        if (timer) clearTimeout(timer)
        onlineProjectSyncTimers.delete(id)
        await onlineProjectSyncQueues.get(id)?.catch(() => undefined)
        await onlineProjectCanvasSyncQueues.get(id)?.catch(() => undefined)
        if (project?.storage === 'online' && project.remoteId) {
          try {
            await deleteOnlineProject(project.remoteId)
          } catch (err) {
            get().showToast(err instanceof Error ? err.message : String(err), 'error')
            return
          }
        }
        const state = get()
        const deletedTasks = state.tasks.filter((task) => isLocalProject ? !task.projectId : task.projectId === id)
        const deletedTaskIds = deletedTasks.map((task) => task.id)
        const deletedConversationIds = new Set(
          state.agentConversations
            .filter((conversation) => {
              const projectId = getAgentConversationProjectId(conversation, state.tasks)
              return isLocalProject ? !projectId : projectId === id
            })
            .map((conversation) => conversation.id),
        )
        const deletedImageIds = new Set<string>()
        for (const task of deletedTasks) {
          for (const imageId of getTaskReferencedImageIds(task)) deletedImageIds.add(imageId)
        }
        for (const conversation of state.agentConversations) {
          if (!deletedConversationIds.has(conversation.id)) continue
          for (const imageId of getAgentConversationReferencedImageIds(conversation)) deletedImageIds.add(imageId)
        }
        for (const conversationId of deletedConversationIds) {
          for (const image of state.agentInputDrafts[conversationId]?.inputImages ?? []) deletedImageIds.add(image.id)
        }
        const clearActiveInput = state.activeProjectId === id
        if (clearActiveInput) {
          for (const image of state.inputImages) deletedImageIds.add(image.id)
          for (const image of state.galleryInputDraft?.inputImages ?? []) deletedImageIds.add(image.id)
        }
        set((current) => {
          const agentInputDrafts = { ...current.agentInputDrafts }
          for (const conversationId of deletedConversationIds) delete agentInputDrafts[conversationId]
          const activeConversationDeleted = current.activeAgentConversationId
            ? deletedConversationIds.has(current.activeAgentConversationId)
            : false
          return {
            projects: current.projects.filter((item) => item.id !== id),
            projectCanvasCache: Object.fromEntries(Object.entries(current.projectCanvasCache).filter(([projectId]) => projectId !== id)),
            favoriteCollections: current.favoriteCollections.filter((collection) => isLocalProject ? Boolean(collection.projectId) : collection.projectId !== id),
            tasks: current.tasks.filter((task) => isLocalProject ? Boolean(task.projectId) : task.projectId !== id),
            agentConversations: current.agentConversations.filter((conversation) => !deletedConversationIds.has(conversation.id)),
            agentInputDrafts,
            activeProjectId: current.activeProjectId === id ? null : current.activeProjectId,
            activeAgentConversationId: activeConversationDeleted ? null : current.activeAgentConversationId,
            agentEditingRoundId: activeConversationDeleted ? null : current.agentEditingRoundId,
            agentEditingConversationId: deletedConversationIds.has(current.agentEditingConversationId ?? '') ? null : current.agentEditingConversationId,
            agentGeneratingTitleIds: Object.fromEntries(
              Object.entries(current.agentGeneratingTitleIds).filter(([conversationId]) => !deletedConversationIds.has(conversationId)),
            ),
            selectedTaskIds: [],
            ...(clearActiveInput ? { galleryInputDraft: null, ...clearInputDraftState() } : {}),
            ...(activeConversationDeleted && current.appMode === 'agent' ? clearInputDraftState() : {}),
          }
        })
        await projectPersistenceQueues.get(id)?.catch(() => undefined)
        await dbDeleteProjectWithRecords(id, deletedTaskIds, Array.from(deletedConversationIds))
        await deleteUnreferencedImageIds(deletedImageIds)
      },
      saveLegacyProjectOnline: async () => {
        if (get().legacyProjectSaving) return
        const snapshot = get()
        const legacyTasks = snapshot.tasks.filter((task) => !task.projectId)
        const legacyConversationIds = new Set(snapshot.agentConversations.filter((conversation) => !conversation.projectId).map((conversation) => conversation.id))
        if (legacyTasks.length === 0) {
          snapshot.showToast('没有需要保存的本地数据', 'info')
          return
        }
        if (!isAuthEnabled()) {
          snapshot.showToast('当前部署未启用在线项目', 'error')
          return
        }

        set({ legacyProjectSaving: true })
        try {
          const id = getLegacyProjectUploadId()
          const archive = await buildLegacyProjectArchive(snapshot)
          const response = await uploadOnlineProject(id, '本地数据', archive)
          const project = createOnlineProject(response)
          const projectCollections = getFavoriteCollectionsForProject(get().favoriteCollections)
            .map((collection) => ({ ...collection, projectId: project.id }))
          const defaultFavoriteCollectionId = resolveDefaultFavoriteCollectionId(projectCollections, get().defaultFavoriteCollectionId)
          project.defaultFavoriteCollectionId = defaultFavoriteCollectionId
          const legacyTaskIds = new Set(legacyTasks.map((task) => task.id))
          const latestTasks = get().tasks
          const changedTasks = latestTasks
            .filter((task) => legacyTaskIds.has(task.id) && !task.projectId)
            .map((task) => ({ ...task, projectId: project.id }))
          const changedConversationIds = new Set(
            get().agentConversations
              .filter((conversation) => legacyConversationIds.has(conversation.id) && !conversation.projectId)
              .map((conversation) => conversation.id),
          )
          const changedConversations = get().agentConversations
            .filter((conversation) => changedConversationIds.has(conversation.id))
            .map((conversation) => ({ ...conversation, projectId: project.id }))
          await putProjectWithRecords(project, changedTasks, changedConversations)
          set((state) => ({
            projects: [project, ...state.projects.filter((item) => item.id !== project.id)],
            favoriteCollections: [
              ...state.favoriteCollections.filter((collection) => collection.projectId),
              ...projectCollections,
            ],
            tasks: state.tasks.map((task) =>
              legacyTaskIds.has(task.id) && !task.projectId ? { ...task, projectId: project.id } : task,
            ),
            agentConversations: state.agentConversations.map((conversation) =>
              changedConversationIds.has(conversation.id) && !conversation.projectId ? { ...conversation, projectId: project.id } : conversation,
            ),
            activeProjectId: project.id,
            selectedTaskIds: [],
          }))
          scheduleOnlineProjectSync(project.id, 0)
          clearLegacyProjectUploadId()
          get().showToast('本地数据已保存为在线项目', 'success')
        } catch (err) {
          get().showToast(err instanceof Error ? err.message : String(err), 'error')
        } finally {
          set({ legacyProjectSaving: false })
        }
      },

      // Mode
      appMode: 'gallery',
      setAppMode: (appMode) => {
        if (appMode === 'gallery') {
          const state = get()
          const agentInputDrafts = saveActiveAgentInputDrafts(state)
          const galleryInputDraft = saveGalleryInputDraft(state)
          set((state) => ({
            appMode,
            agentInputDrafts,
            galleryInputDraft,
            agentMobileHeaderVisible: true,
            selectedTaskIds: [],
            selectedFavoriteCollectionIds: [],
            agentEditingRoundId: null,
            ...(state.appMode === 'agent' ? restoreGalleryInputDraftState(galleryInputDraft) : {}),
          }))
          return
        }

        const state = get()
        const galleryInputDraft = saveGalleryInputDraft(state)
        set((state) => ({
          appMode: 'agent',
          galleryInputDraft,
          agentMobileHeaderVisible: false,
          agentSidebarCollapsed: true,
          agentAssetPanelCollapsed: true,
          selectedTaskIds: [],
          selectedFavoriteCollectionIds: [],
          ...restoreAgentInputDraftState(state.agentInputDrafts, state.activeAgentConversationId),
        }))
      },

      // Settings
      settings: { ...DEFAULT_SETTINGS },
      setSettings: (s) => set((st) => {
        const previous = normalizeSettings(st.settings)
        const incoming = s as Partial<AppSettings>
        const hasLegacyOverrides =
          incoming.baseUrl !== undefined ||
          incoming.apiKey !== undefined ||
          incoming.model !== undefined ||
          incoming.timeout !== undefined ||
          incoming.apiMode !== undefined ||
          incoming.codexCli !== undefined ||
          incoming.apiProxy !== undefined ||
          incoming.streamImages !== undefined ||
          incoming.streamPartialImages !== undefined
        const merged = normalizeSettings({ ...previous, ...incoming })
        if (hasLegacyOverrides && incoming.profiles === undefined) {
          merged.profiles = merged.profiles.map((profile) =>
            profile.id === merged.activeProfileId
              ? {
                  ...profile,
                  baseUrl: incoming.baseUrl ?? profile.baseUrl,
                  apiKey: incoming.apiKey ?? profile.apiKey,
                  model: incoming.model ?? profile.model,
                  timeout: incoming.timeout ?? profile.timeout,
                  apiMode: incoming.apiMode === 'images' || incoming.apiMode === 'responses' ? incoming.apiMode : profile.apiMode,
                  codexCli: incoming.codexCli ?? profile.codexCli,
                  apiProxy: incoming.apiProxy ?? profile.apiProxy,
                  streamImages: incoming.streamImages ?? profile.streamImages,
                  streamPartialImages: incoming.streamPartialImages ?? profile.streamPartialImages,
                }
              : profile,
          )
        }
        const settings = normalizeSettings(merged)
        const shouldClearReusedProfile = st.reusedTaskApiProfileId && settings.activeProfileId === st.reusedTaskApiProfileId
        return {
          settings,
          ...(shouldClearReusedProfile
            ? { reusedTaskApiProfileId: null, reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false }
            : {}),
        }
      }),
      oidcApiOverride: null,
      setOidcApiOverride: (apiOverride) => set({
        oidcApiOverride: apiOverride && (apiOverride.apiKey || apiOverride.model)
          ? { ...apiOverride }
          : null,
      }),
      agentOidcApiOverride: null,
      setAgentOidcApiOverride: (apiOverride) => set({
        agentOidcApiOverride: apiOverride && (apiOverride.apiKey || apiOverride.model)
          ? { ...apiOverride }
          : null,
      }),
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),

      // Input
      prompt: '',
      setPrompt: (prompt) => set((s) => syncActiveInputDraft(s, { prompt })),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return syncActiveInputDraft(s, { inputImages: [...s.inputImages, img] })
        }),
      replaceInputImage: (idx, img) => {
        let removedImageId: string | null = null
        set((s) => {
          if (idx < 0 || idx >= s.inputImages.length) return s
          const previous = s.inputImages[idx]
          if (!previous || previous.id === img.id) return s
          if (s.inputImages.some((item, itemIdx) => itemIdx !== idx && item.id === img.id)) return s
          removedImageId = previous.id
          const inputImages = s.inputImages.map((item, itemIdx) => itemIdx === idx ? img : item)
          const shouldClearMask = previous.id === s.maskDraft?.targetImageId
          return syncActiveInputDraft(s, {
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages, { [previous.id]: img.id }),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          })
        })
        if (removedImageId) void deleteImageIfUnreferenced(removedImageId)
      },
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const inputImages = s.inputImages.filter((_, i) => i !== idx)
          const shouldClearMask = removed?.id === s.maskDraft?.targetImageId
          return syncActiveInputDraft(s, {
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          })
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) imageCache.delete(img.id)
          return syncActiveInputDraft(s, {
            inputImages: [],
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, []),
            maskDraft: null,
            maskEditorImageId: null,
          })
        }),
      setInputImages: (imgs, options) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(imgs, s.maskDraft?.targetImageId)
          const shouldClearMask =
            Boolean(s.maskDraft) && !inputImages.some((img) => img.id === s.maskDraft?.targetImageId)
          return syncActiveInputDraft(s, {
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages, options?.equivalentImageIds),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          })
        }),
      moveInputImage: (fromIdx, toIdx) =>
        set((s) => {
          const images = [...s.inputImages]
          if (fromIdx < 0 || fromIdx >= images.length) return s
          const maskTargetImageId = s.maskDraft?.targetImageId
          if (maskTargetImageId && images[fromIdx]?.id === maskTargetImageId) return s
          const minTargetIdx = maskTargetImageId && images.some((img) => img.id === maskTargetImageId) ? 1 : 0
          const targetIdx = Math.max(minTargetIdx, Math.min(images.length, toIdx))
          const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
          if (insertIdx === fromIdx) return s
          const [moved] = images.splice(fromIdx, 1)
          images.splice(insertIdx, 0, moved)
          return syncActiveInputDraft(s, {
            inputImages: images,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, images),
          })
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(s.inputImages, maskDraft?.targetImageId)
          return syncActiveInputDraft(s, {
            maskDraft,
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
          })
        }),
      clearMaskDraft: () => set((s) => syncActiveInputDraft(s, { maskDraft: null })),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => {
        if (maskEditorImageId) dismissAllTooltips()
        set((s) => syncActiveInputDraft(s, { maskEditorImageId }))
      },
      galleryInputDraft: null,

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      setReusedTaskApiProfile: (profileId, missing = false, profileName = null) => set({
        reusedTaskApiProfileId: profileId,
        reusedTaskApiProfileName: profileName,
        reusedTaskApiProfileMissing: missing,
      }),

      // Agent
      agentConversations: [],
      agentConversationsLoaded: false,
      activeAgentConversationId: null,
      agentInputDrafts: {},
      agentSidebarCollapsed: true,
      agentAssetTab: 'outputs',
      agentAssetPanelCollapsed: false,
      agentMobileHeaderVisible: false,
      agentEditingRoundId: null,
      agentEditingConversationId: null,
      agentGeneratingTitleIds: {},
      createAgentConversation: () => {
        const now = Date.now()
        const projectId = getActiveTaskProjectId()
        const scopedConversations = get().agentConversations.filter((conversation) =>
          getAgentConversationProjectId(conversation, get().tasks) === projectId,
        )
        const latestConversation = getLatestAgentConversation(scopedConversations)
        if (latestConversation && isEmptyAgentConversation(latestConversation)) {
          set((state) => {
            const agentInputDrafts = saveActiveAgentInputDrafts(state)
            return {
              agentConversations: state.agentConversations.map((conversation) =>
                conversation.id === latestConversation.id
                  ? { ...conversation, ...(projectId ? { projectId } : {}), createdAt: now, updatedAt: now }
                  : conversation,
              ),
              activeAgentConversationId: latestConversation.id,
              agentInputDrafts,
              agentSidebarCollapsed: true,
              agentEditingRoundId: null,
              ...(state.appMode === 'agent' ? restoreAgentInputDraftState(agentInputDrafts, latestConversation.id) : {}),
            }
          })
          return latestConversation.id
        }

        const conversation = createAgentConversation(now, projectId)
        set((state) => {
          const agentInputDrafts = saveActiveAgentInputDrafts(state)
          return {
            agentConversations: [
              ...state.agentConversations,
              conversation,
            ],
            activeAgentConversationId: conversation.id,
            agentInputDrafts,
            agentSidebarCollapsed: true,
            agentEditingRoundId: null,
            ...(state.appMode === 'agent' ? restoreAgentInputDraftState(agentInputDrafts, conversation.id) : {}),
          }
        })
        return conversation.id
      },
      setActiveAgentConversationId: (id) => set((state) => {
        if (state.activeAgentConversationId === id) {
          return {
            activeAgentConversationId: id,
            agentSidebarCollapsed: true,
            agentAssetPanelCollapsed: true,
            agentEditingRoundId: null,
          }
        }
        const agentInputDrafts = saveActiveAgentInputDrafts(state)
        return {
          activeAgentConversationId: id,
          agentInputDrafts,
          agentSidebarCollapsed: true,
          agentAssetPanelCollapsed: true,
          agentEditingRoundId: null,
          ...(state.appMode === 'agent' ? restoreAgentInputDraftState(agentInputDrafts, id) : {}),
        }
      }),
      setAgentInputPrompt: (conversationId, prompt) => set((state) => {
        const current = state.agentInputDrafts[conversationId] ?? {
          prompt: '',
          inputImages: [],
          maskDraft: null,
          maskEditorImageId: null,
          updatedAt: Date.now(),
        }
        return {
          agentInputDrafts: setAgentInputDraft(state.agentInputDrafts, conversationId, {
            ...current,
            prompt,
            updatedAt: Date.now(),
          }),
        }
      }),
      addAgentInputImage: (conversationId, img) => set((state) => {
        const current = state.agentInputDrafts[conversationId] ?? {
          prompt: '',
          inputImages: [],
          maskDraft: null,
          maskEditorImageId: null,
        }
        if (current.inputImages.some((item) => item.id === img.id)) return state
        const inputImages = [...current.inputImages, img]
        return {
          agentInputDrafts: setAgentInputDraft(state.agentInputDrafts, conversationId, {
            ...current,
            inputImages,
            prompt: remapImageMentionsForOrder(current.prompt, current.inputImages, inputImages),
          }),
        }
      }),
      replaceAgentInputImage: (conversationId, idx, img) => set((state) => {
        const current = state.agentInputDrafts[conversationId]
        if (!current || idx < 0 || idx >= current.inputImages.length) return state
        const previous = current.inputImages[idx]
        if (!previous || previous.id === img.id || current.inputImages.some((item, itemIdx) => itemIdx !== idx && item.id === img.id)) return state
        const inputImages = current.inputImages.map((item, itemIdx) => itemIdx === idx ? img : item)
        const shouldClearMask = previous.id === current.maskDraft?.targetImageId
        return {
          agentInputDrafts: setAgentInputDraft(state.agentInputDrafts, conversationId, {
            ...current,
            inputImages,
            prompt: remapImageMentionsForOrder(current.prompt, current.inputImages, inputImages, { [previous.id]: img.id }),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }),
        }
      }),
      removeAgentInputImage: (conversationId, idx) => set((state) => {
        const current = state.agentInputDrafts[conversationId]
        if (!current) return state
        const removed = current.inputImages[idx]
        const inputImages = current.inputImages.filter((_, itemIdx) => itemIdx !== idx)
        const shouldClearMask = removed?.id === current.maskDraft?.targetImageId
        return {
          agentInputDrafts: setAgentInputDraft(state.agentInputDrafts, conversationId, {
            ...current,
            inputImages,
            prompt: remapImageMentionsForOrder(current.prompt, current.inputImages, inputImages),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }),
        }
      }),
      clearAgentInputImages: (conversationId) => set((state) => {
        const current = state.agentInputDrafts[conversationId]
        if (!current) return state
        return {
          agentInputDrafts: setAgentInputDraft(state.agentInputDrafts, conversationId, {
            ...current,
            inputImages: [],
            prompt: remapImageMentionsForOrder(current.prompt, current.inputImages, []),
            maskDraft: null,
            maskEditorImageId: null,
          }),
        }
      }),
      setAgentInputImages: (conversationId, imgs, options) => set((state) => {
        const current = state.agentInputDrafts[conversationId] ?? {
          prompt: '',
          inputImages: [],
          maskDraft: null,
          maskEditorImageId: null,
        }
        const inputImages = orderImagesWithMaskFirst(imgs, current.maskDraft?.targetImageId)
        const shouldClearMask = Boolean(current.maskDraft) && !inputImages.some((img) => img.id === current.maskDraft?.targetImageId)
        return {
          agentInputDrafts: setAgentInputDraft(state.agentInputDrafts, conversationId, {
            ...current,
            inputImages,
            prompt: remapImageMentionsForOrder(current.prompt, current.inputImages, inputImages, options?.equivalentImageIds),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }),
        }
      }),
      moveAgentInputImage: (conversationId, fromIdx, toIdx) => set((state) => {
        const current = state.agentInputDrafts[conversationId]
        if (!current || fromIdx < 0 || fromIdx >= current.inputImages.length) return state
        const images = [...current.inputImages]
        const maskTargetImageId = current.maskDraft?.targetImageId
        if (maskTargetImageId && images[fromIdx]?.id === maskTargetImageId) return state
        const minTargetIdx = maskTargetImageId && images.some((img) => img.id === maskTargetImageId) ? 1 : 0
        const targetIdx = Math.max(minTargetIdx, Math.min(images.length, toIdx))
        const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
        if (insertIdx === fromIdx) return state
        const [moved] = images.splice(fromIdx, 1)
        images.splice(insertIdx, 0, moved)
        return {
          agentInputDrafts: setAgentInputDraft(state.agentInputDrafts, conversationId, {
            ...current,
            inputImages: images,
            prompt: remapImageMentionsForOrder(current.prompt, current.inputImages, images),
          }),
        }
      }),
      setActiveAgentRoundId: (conversationId, roundId) => set((state) => ({
        agentConversations: state.agentConversations.map((conversation) =>
          conversation.id === conversationId ? { ...conversation, activeRoundId: roundId, updatedAt: Date.now() } : conversation,
        ),
      })),
      renameAgentConversation: (id, title) => set((state) => ({ agentConversations: state.agentConversations.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c)) })),
      deleteAgentConversation: (id) => {
        const state = get()
        const target = state.agentConversations.find((conversation) => conversation.id === id)
        const affectedProjectId = target ? getAgentConversationProjectId(target, state.tasks) : undefined
        set((current) => {
          const agentInputDrafts = { ...current.agentInputDrafts }
          delete agentInputDrafts[id]
          const activeDeleted = current.activeAgentConversationId === id
          return {
            agentConversations: current.agentConversations.filter((conversation) => conversation.id !== id),
            activeAgentConversationId: activeDeleted ? null : current.activeAgentConversationId,
            agentInputDrafts,
            ...(activeDeleted ? clearInputDraftState() : {}),
          }
        })
        if (affectedProjectId) scheduleOnlineProjectSync(affectedProjectId)
      },
      setAgentSidebarCollapsed: (agentSidebarCollapsed) => set({ agentSidebarCollapsed }),
      setAgentAssetTab: (agentAssetTab) => set({ agentAssetTab }),
      setAgentAssetPanelCollapsed: (agentAssetPanelCollapsed) => set({ agentAssetPanelCollapsed }),
      setAgentMobileHeaderVisible: (agentMobileHeaderVisible) => set({ agentMobileHeaderVisible }),
      setAgentEditingRoundId: (agentEditingRoundId) => set({ agentEditingRoundId }),
      setAgentEditingConversationId: (agentEditingConversationId) => set({ agentEditingConversationId }),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set(() => ({
        tasks,
        ...(countSuccessfulOutputImages(tasks) <= SUPPORT_PROMPT_IMAGE_THRESHOLD
          ? { supportPromptSkippedForImportedData: false }
          : {}),
      })),
      favoriteCollections: [createDefaultFavoriteCollection()],
      setFavoriteCollections: (favoriteCollections) => set((state) => {
        const nextCollections = ensureDefaultFavoriteCollection(normalizeFavoriteCollections(favoriteCollections))
        return {
          favoriteCollections: nextCollections,
          defaultFavoriteCollectionId: resolveDefaultFavoriteCollectionId(nextCollections, state.defaultFavoriteCollectionId),
        }
      }),
      defaultFavoriteCollectionId: DEFAULT_FAVORITE_COLLECTION_ID,
      setDefaultFavoriteCollectionId: (defaultFavoriteCollectionId) => {
        const state = get()
        const projectId = getFavoriteScopeProjectId(state.activeProjectId)
        const collections = getFavoriteCollectionsForProject(state.favoriteCollections, projectId)
        if (defaultFavoriteCollectionId !== null && !collections.some((collection) => collection.id === defaultFavoriteCollectionId)) return
        if (!projectId) {
          set({ defaultFavoriteCollectionId })
          return
        }
        set((current) => ({
          projects: current.projects.map((project) => project.id === projectId
            ? { ...project, defaultFavoriteCollectionId }
            : project),
        }))
        touchProject(projectId)
      },
      activeFavoriteCollectionId: null,
      isManageCollectionsModalOpen: false,
      setActiveFavoriteCollectionId: (activeFavoriteCollectionId) => set({ activeFavoriteCollectionId, selectedTaskIds: [], selectedFavoriteCollectionIds: [] }),
      openManageCollectionsModal: () => set({ isManageCollectionsModalOpen: true }),
      closeManageCollectionsModal: () => set({ isManageCollectionsModalOpen: false }),
      favoritePickerTaskIds: null,
      favoritePickerImageIds: null,
      openFavoritePicker: (taskIds) => {
        if (!taskIds.length) return
        dismissAllTooltips()
        set({ favoritePickerTaskIds: Array.from(new Set(taskIds)).filter(Boolean), favoritePickerImageIds: null })
      },
      openImageFavoritePicker: (imageIds) => {
        if (!imageIds.length) return
        dismissAllTooltips()
        set({ favoritePickerImageIds: Array.from(new Set(imageIds)).filter(Boolean), favoritePickerTaskIds: null })
      },
      closeFavoritePicker: () => set({ favoritePickerTaskIds: null, favoritePickerImageIds: null }),
      streamPreviews: {},
      streamPreviewSlots: {},
      setTaskStreamPreview: (taskId, image, requestIndex = 0) => set((s) => {
        if (image) {
          const slotKey = String(requestIndex)
          const currentSlots = s.streamPreviewSlots[taskId] ?? {}
          if (s.streamPreviews[taskId] === image && currentSlots[slotKey] === image) return s
          return {
            streamPreviews: { ...s.streamPreviews, [taskId]: image },
            streamPreviewSlots: {
              ...s.streamPreviewSlots,
              [taskId]: { ...currentSlots, [slotKey]: image },
            },
          }
        }

        if (!(taskId in s.streamPreviews) && !(taskId in s.streamPreviewSlots)) return s
        const next = { ...s.streamPreviews }
        const nextSlots = { ...s.streamPreviewSlots }
        delete next[taskId]
        delete nextSlots[taskId]
        return { streamPreviews: next, streamPreviewSlots: nextSlots }
      }),

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set(filterFavorite ? { filterFavorite, selectedTaskIds: [], selectedFavoriteCollectionIds: [] } : { filterFavorite, activeFavoriteCollectionId: null, selectedTaskIds: [], selectedFavoriteCollectionIds: [] }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),
      selectedFavoriteCollectionIds: [],
      setSelectedFavoriteCollectionIds: (updater) => set((s) => ({
        selectedFavoriteCollectionIds: typeof updater === 'function' ? updater(s.selectedFavoriteCollectionIds) : updater
      })),
      toggleFavoriteCollectionSelection: (id, force) => set((s) => {
        const isSelected = s.selectedFavoriteCollectionIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedFavoriteCollectionIds: shouldSelect
            ? [...s.selectedFavoriteCollectionIds, id]
            : s.selectedFavoriteCollectionIds.filter((x) => x !== id)
        }
      }),
      clearFavoriteCollectionSelection: () => set({ selectedFavoriteCollectionIds: [] }),

      // UI
      detailTaskId: null,
      detailImageId: null,
      setDetailTaskId: (detailTaskId) => {
        if (detailTaskId) dismissAllTooltips()
        set({ detailTaskId, detailImageId: null })
      },
      setDetailImage: (detailTaskId, detailImageId) => {
        dismissAllTooltips()
        set({ detailTaskId, detailImageId })
      },
      lightboxImageId: null,
      lightboxImageList: [],
      setLightboxImageId: (lightboxImageId, list) => {
        if (lightboxImageId) dismissAllTooltips()
        set({ lightboxImageId, lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []) })
      },
      showSettings: false,
      settingsTabRequest: null,
      setShowSettings: (showSettings, settingsTabRequest) => {
        if (showSettings) dismissAllTooltips()
        set({
          showSettings,
          ...(settingsTabRequest ? { settingsTabRequest } : {}),
          ...(!showSettings ? { settingsTabRequest: null } : {}),
        })
      },
      supportPromptOpen: false,
      supportPromptDismissed: false,
      supportPromptSkippedForImportedData: false,
      setSupportPromptOpen: (supportPromptOpen) => set({ supportPromptOpen }),
      dismissSupportPrompt: () => set({ supportPromptOpen: false, supportPromptDismissed: true }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        const toastMessage = getToastMessage(message, type)
        const toast = { message: toastMessage, type }
        set({ toast })
        setTimeout(() => {
          set((s) => (s.toast === toast ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => {
        if (confirmDialog) dismissAllTooltips()
        set({ confirmDialog })
      },
    }),
    {
      name: 'gpt-image-playground',
      version: 2,
      migrate: (persistedState) => migratePersistedState(persistedState),
      partialize: getPersistedState,
      merge: mergePersistedState,
    },
  ),
)

let lastStoredAgentConversations = useStore.getState().agentConversations
let agentConversationPersistRunning = false

let agentConversationPersistQueued = false
async function flushAgentConversationsToIndexedDB() {
  if (agentConversationPersistRunning) {
    agentConversationPersistQueued = true
    return
  }

  agentConversationPersistRunning = true
  try {
    do {
      agentConversationPersistQueued = false
      const conversations = useStore.getState().agentConversations
      await replaceStoredAgentConversations(conversations)
      const previousConversations = lastStoredAgentConversations
      lastStoredAgentConversations = conversations
      const currentState = useStore.getState()
      const affectedProjectIds = getChangedAgentConversationProjectIds(previousConversations, conversations, currentState.tasks)
      if (onlineProjectCacheReady) {
        for (const projectId of affectedProjectIds) scheduleOnlineProjectSync(projectId)
      }
    } while (agentConversationPersistQueued || useStore.getState().agentConversations !== lastStoredAgentConversations)
  } finally {
    agentConversationPersistRunning = false
  }
}

useStore.subscribe((state) => {
  if (state.agentConversations === lastStoredAgentConversations) return
  if (!agentConversationPersistenceReady) {
    agentConversationPersistQueued = true
    return
  }
  void flushAgentConversationsToIndexedDB()
})

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

function getPersistableRawResponsePayload(rawResponsePayload?: string) {
  if (!rawResponsePayload) return rawResponsePayload
  try {
    const payload = JSON.parse(rawResponsePayload) as { output?: unknown }
    if (!Array.isArray(payload.output)) return rawResponsePayload
    const output = payload.output.map((item) =>
      isRecord(item) ? getPersistableResponseOutputItem(item as ResponsesOutputItem) : item,
    )
    return JSON.stringify({ ...payload, output }, null, 2)
  } catch {
    return rawResponsePayload
  }
}

function getPersistableTask(task: TaskRecord): TaskRecord {
  const rawResponsePayload = getPersistableRawResponsePayload(task.rawResponsePayload)
  return rawResponsePayload === task.rawResponsePayload ? task : { ...task, rawResponsePayload }
}

function isBackendManagedGenerationTask(task: TaskRecord, project = task.projectId
  ? useStore.getState().projects.find((item) => item.id === task.projectId)
  : undefined) {
  return Boolean(
    project?.storage === 'online' &&
    project.remoteId &&
    (task.apiProvider ?? 'openai') === 'openai' &&
    task.apiOverride?.apiKey &&
    task.apiOverride?.platform?.trim().toLowerCase() !== 'composite' &&
    !task.transparentOutput,
  )
}

function putTask(task: TaskRecord, syncOnline = true): Promise<IDBValidKey> {
  const persistable = getPersistableTask(task)
  return dbPutTask(persistable).then((key) => {
    if (syncOnline) queueOnlineTaskSync(persistable)
    return key
  })
}

function queueOnlineTaskSync(task: TaskRecord) {
  if (!task.projectId) return
  const project = useStore.getState().projects.find((item) => item.id === task.projectId)
  if (project?.storage !== 'online' || !project.remoteId) return
  const retryTimer = onlineTaskSyncRetryTimers.get(task.id)
  if (retryTimer) clearTimeout(retryTimer)
  onlineTaskSyncRetryTimers.delete(task.id)

  const previous = onlineTaskSyncQueues.get(task.id)
  const syncing = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(async () => {
    const state = useStore.getState()
    const latestTask = state.tasks.find((item) => item.id === task.id) ?? task
    const latestProject = state.projects.find((item) => item.id === latestTask.projectId)
    if (latestProject?.storage !== 'online' || !latestProject.remoteId) return
    const response = await saveOnlineProjectTask(latestProject, getPersistableTask(latestTask))
    const current = useStore.getState().projects.find((item) => item.id === latestProject.id)
    if (!current) return
    const hasArchiveSync = onlineProjectSyncTimers.has(current.id) || onlineProjectSyncQueues.has(current.id)
    const updated: Project = {
      ...current,
      remoteArchiveSha256: response.archive_sha256,
      syncPending: hasArchiveSync ? current.syncPending : false,
    }
    useStore.setState((state) => ({
      projects: state.projects.map((item) => item.id === current.id ? updated : item),
    }))
    queueProjectSave(updated)
    onlineTaskSyncErrors.delete(task.id)
  })
  onlineTaskSyncQueues.set(task.id, syncing)
  void syncing
    .catch((err) => {
      console.error('在线任务记录保存失败：', err)
      if (!onlineTaskSyncErrors.has(task.id)) {
        onlineTaskSyncErrors.add(task.id)
        useStore.getState().showToast('在线任务记录保存失败，将自动重试', 'error')
      }
      if (onlineTaskSyncRetryTimers.has(task.id)) return
      onlineTaskSyncRetryTimers.set(task.id, setTimeout(() => {
        onlineTaskSyncRetryTimers.delete(task.id)
        const latest = useStore.getState().tasks.find((item) => item.id === task.id)
        if (latest) queueOnlineTaskSync(latest)
      }, 5000))
    })
    .finally(() => {
      if (onlineTaskSyncQueues.get(task.id) === syncing) onlineTaskSyncQueues.delete(task.id)
    })
}

async function deleteOnlineTaskRecord(task: TaskRecord) {
  if (!task.projectId) return
  const project = useStore.getState().projects.find((item) => item.id === task.projectId)
  if (project?.storage !== 'online' || !project.remoteId) return
  const retryTimer = onlineTaskSyncRetryTimers.get(task.id)
  if (retryTimer) clearTimeout(retryTimer)
  onlineTaskSyncRetryTimers.delete(task.id)
  await onlineTaskSyncQueues.get(task.id)?.catch(() => undefined)
  const pendingRetry = onlineTaskSyncRetryTimers.get(task.id)
  if (pendingRetry) clearTimeout(pendingRetry)
  onlineTaskSyncRetryTimers.delete(task.id)
  onlineTaskSyncErrors.delete(task.id)
  const response = await deleteOnlineProjectTask(project.remoteId, task.id)
  if (!response) return
  const current = useStore.getState().projects.find((item) => item.id === project.id)
  if (!current) return
  const updated = { ...current, remoteArchiveSha256: response.archive_sha256 }
  useStore.setState((state) => ({
    projects: state.projects.map((item) => item.id === project.id ? updated : item),
  }))
  queueProjectSave(updated)
}

function getActiveTaskProjectId() {
  const id = useStore.getState().activeProjectId
  return id && id !== ALL_PROJECTS_ID && id !== LOCAL_PROJECT_ID ? id : undefined
}

function queueProjectSave(project: Project) {
  const previous = projectPersistenceQueues.get(project.id)
  const saving = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => dbPutProject(project))
  projectPersistenceQueues.set(project.id, saving)
  void saving
    .catch((err) => console.error('项目保存失败：', err))
    .finally(() => {
      if (projectPersistenceQueues.get(project.id) === saving) projectPersistenceQueues.delete(project.id)
  })
}

function queueOnlineProjectCanvasSync(project: Project) {
  const previous = onlineProjectCanvasSyncQueues.get(project.id)
  const syncing = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(async () => {
    const latest = useStore.getState().projects.find((item) => item.id === project.id)
    if (latest?.storage !== 'online' || !latest.remoteId || !latest.canvas) return
    const version = latest.updatedAt
    const response = await saveOnlineProjectCanvas(latest, latest.canvas)
    const current = useStore.getState().projects.find((item) => item.id === latest.id)
    if (!current) return
    const hasArchiveSync = onlineProjectSyncTimers.has(current.id) || onlineProjectSyncQueues.has(current.id)
    const updated = {
      ...current,
      remoteArchiveSha256: response.archive_sha256,
      syncPending: hasArchiveSync || current.updatedAt !== version,
    }
    useStore.setState((state) => ({
      projects: state.projects.map((item) => item.id === current.id ? updated : item),
    }))
    queueProjectSave(updated)
    onlineProjectCanvasSyncErrors.delete(project.id)
  })
  onlineProjectCanvasSyncQueues.set(project.id, syncing)
  void syncing
    .catch((err) => {
      console.error('在线项目画布保存失败：', err)
      if (onlineProjectCanvasSyncErrors.has(project.id)) return
      onlineProjectCanvasSyncErrors.add(project.id)
      useStore.getState().showToast('画布位置保存失败，请稍后重试', 'error')
    })
    .finally(() => {
      if (onlineProjectCanvasSyncQueues.get(project.id) === syncing) onlineProjectCanvasSyncQueues.delete(project.id)
    })
}

function queueOnlineProjectViewportSync(project: Project) {
  const previous = onlineProjectCanvasSyncQueues.get(project.id)
  const syncing = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(async () => {
    const latest = useStore.getState().projects.find((item) => item.id === project.id)
    if (latest?.storage !== 'online' || !latest.remoteId || !latest.canvas) return
    const version = latest.updatedAt
    const response = await saveOnlineProjectViewport(latest, latest.canvas.viewport)
    const current = useStore.getState().projects.find((item) => item.id === latest.id)
    if (!current) return
    const hasArchiveSync = onlineProjectSyncTimers.has(current.id) || onlineProjectSyncQueues.has(current.id)
    const changedWhileSyncing = current.updatedAt !== version
    const updated = {
      ...current,
      remoteArchiveSha256: response.archive_sha256,
      syncPending: hasArchiveSync || current.updatedAt !== version,
      updatedAt: changedWhileSyncing ? current.updatedAt : Date.parse(response.updated_at) || current.updatedAt,
    }
    useStore.setState((state) => ({
      projects: state.projects.map((item) => item.id === current.id ? updated : item),
    }))
    queueProjectSave(updated)
    onlineProjectCanvasSyncErrors.delete(project.id)
  })
  onlineProjectCanvasSyncQueues.set(project.id, syncing)
  void syncing
    .catch((err) => {
      console.error('在线项目视口保存失败：', err)
      if (onlineProjectCanvasSyncErrors.has(project.id)) return
      onlineProjectCanvasSyncErrors.add(project.id)
      useStore.getState().showToast('画布视口保存失败，请稍后重试', 'error')
    })
    .finally(() => {
      if (onlineProjectCanvasSyncQueues.get(project.id) === syncing) onlineProjectCanvasSyncQueues.delete(project.id)
    })
}

function scheduleOnlineProjectSync(projectId: string, delay = 1200) {
  if (!onlineProjectCacheReady) return
  const project = useStore.getState().projects.find((item) => item.id === projectId)
  if (project?.storage !== 'online' || !project.remoteId) return
  if (!project.syncPending) {
    const pending = { ...project, syncPending: true }
    useStore.setState((state) => ({
      projects: state.projects.map((item) => item.id === projectId ? pending : item),
    }))
    queueProjectSave(pending)
  }
  const currentTimer = onlineProjectSyncTimers.get(projectId)
  if (currentTimer) clearTimeout(currentTimer)
  onlineProjectSyncTimers.set(projectId, setTimeout(() => {
    onlineProjectSyncTimers.delete(projectId)
    void syncOnlineProject(projectId)
  }, delay))
}

function syncOnlineProject(projectId: string) {
  const previous = onlineProjectSyncQueues.get(projectId)
  const syncing = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(async () => {
    const snapshot = useStore.getState()
    const project = snapshot.projects.find((item) => item.id === projectId)
    if (project?.storage !== 'online' || !project.remoteId) return
    const version = project.updatedAt
    const archive = await buildOnlineProjectArchive(snapshot, projectId)
    const response = await uploadOnlineProject(project.remoteId, project.title, archive)
    await syncOnlineProjectImages(projectId)
    const current = useStore.getState().projects.find((item) => item.id === projectId)
    if (!current) return
    const changedWhileSyncing = current.updatedAt !== version
    const updated: Project = {
      ...current,
      remoteArchiveSha256: response.archive_sha256,
      syncPending: changedWhileSyncing,
      updatedAt: changedWhileSyncing ? current.updatedAt : Date.parse(response.updated_at) || current.updatedAt,
    }
    useStore.setState((state) => ({
      projects: [updated, ...state.projects.filter((item) => item.id !== projectId)],
    }))
    queueProjectSave(updated)
    onlineProjectSyncErrors.delete(projectId)
    if (changedWhileSyncing) scheduleOnlineProjectSync(projectId)
  })
  onlineProjectSyncQueues.set(projectId, syncing)
  void syncing
    .catch((err) => {
      const project = useStore.getState().projects.find((item) => item.id === projectId)
      if (project && !project.syncPending) {
        const pending = { ...project, syncPending: true }
        useStore.setState((state) => ({
          projects: state.projects.map((item) => item.id === projectId ? pending : item),
        }))
        queueProjectSave(pending)
      }
      console.error('在线项目同步失败：', err)
      if (onlineProjectSyncErrors.has(projectId)) return
      onlineProjectSyncErrors.add(projectId)
      useStore.getState().showToast('在线项目同步失败，数据已保存在本机', 'error')
    })
    .finally(() => {
      if (onlineProjectSyncQueues.get(projectId) === syncing) onlineProjectSyncQueues.delete(projectId)
    })
  return syncing
}

async function syncOnlineProjectImages(projectId: string) {
  const state = useStore.getState()
  const project = state.projects.find((item) => item.id === projectId)
  if (project?.storage !== 'online' || !project.remoteId) return
  const remoteId = project.remoteId

  const taskByImageId = new Map<string, string | undefined>()
  for (const task of state.tasks.filter((item) => item.projectId === projectId)) {
    for (const imageId of getTaskReferencedImageIds(task)) taskByImageId.set(imageId, task.id)
  }
  for (const conversation of state.agentConversations.filter((item) => getAgentConversationProjectId(item, state.tasks) === projectId)) {
    for (const imageId of getAgentConversationReferencedImageIds(conversation)) {
      if (!taskByImageId.has(imageId)) taskByImageId.set(imageId, undefined)
    }
  }

  const remoteImages = await listOnlineProjectImages(remoteId)
  const remoteImageIds = new Set(remoteImages.map((image) => image.image_id))
  for (const [imageId, taskId] of taskByImageId) {
    if (remoteImageIds.has(imageId)) continue
    const image = await getImage(imageId)
    if (image) await uploadOnlineProjectImage(remoteId, taskId, image)
  }
  await Promise.all(remoteImages
    .filter((image) => !taskByImageId.has(image.image_id))
    .map((image) => deleteOnlineProjectImage(remoteId, image.image_id)))
}

async function uploadGeneratedProjectImages(task: TaskRecord, images: StoredImage[]) {
  if (!task.projectId || images.length === 0) return
  const project = useStore.getState().projects.find((item) => item.id === task.projectId)
  if (project?.storage !== 'online' || !project.remoteId) return
  const remoteId = project.remoteId

  try {
    await Promise.all(images.map((image) => uploadOnlineProjectImage(remoteId, task.id, image)))
  } catch (err) {
    console.warn('项目图片即时保存失败，将在项目同步时重试：', err)
    scheduleOnlineProjectSync(project.id)
  }
}

function touchProject(id?: string, syncArchive = true) {
  if (!id) return
  const project = useStore.getState().projects.find((item) => item.id === id)
  if (!project) return
  const updated = {
    ...project,
    ...(project.storage === 'online' && syncArchive ? { syncPending: true } : {}),
    updatedAt: Date.now(),
  }
  useStore.setState((state) => ({
    projects: [updated, ...state.projects.filter((item) => item.id !== id)],
  }))
  queueProjectSave(updated)
  if (syncArchive) scheduleOnlineProjectSync(id)
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  const profile = getActiveApiProfile(settings)
  return `${profile.baseUrl}\n${profile.apiKey}`
}

function isOpenAITask(task: TaskRecord) {
  return (task.apiProvider ?? 'openai') !== 'fal'
}

function isRunningOpenAITask(task: TaskRecord) {
  return task.status === 'running' && isOpenAITask(task)
}

function hasActiveAgentRoundController(task: TaskRecord) {
  if (!isAgentTask(task) || !task.agentConversationId || !task.agentRoundId) return false
  return agentRoundControllers.has(getAgentRoundControllerKey(task.agentConversationId, task.agentRoundId))
}

function hasImageStatusRequestIds(task: TaskRecord) {
  return Boolean(task.imageStatusRequestIds?.length)
}

function isAsyncCustomProviderTask(settings: AppSettings, provider: string, hasInputImages: boolean) {
  const customProvider = getCustomProviderDefinition(settings, provider)
  if (!customProvider) return false
  const poll = hasInputImages && customProvider.editPoll ? customProvider.editPoll : customProvider.poll
  if (!poll) return false
  const submitMapping = hasInputImages && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
  return Boolean(submitMapping.taskIdPath)
}

export function markInterruptedOpenAIRunningTasks(tasks: TaskRecord[], now = Date.now()) {
  const interruptedTasks: TaskRecord[] = []
  const updatedTasks = tasks.map((task) => {
    if (!isRunningOpenAITask(task) || activeTaskExecutions.has(task.id) || hasActiveAgentRoundController(task) || task.customTaskId || task.compositeRequestId || hasImageStatusRequestIds(task)) return task

    const updated: TaskRecord = {
      ...task,
      status: 'error',
      error: OPENAI_INTERRUPTED_ERROR,
      falRecoverable: false,
      imageStatusRecoverable: false,
      finishedAt: now,
      elapsed: Math.max(0, now - task.createdAt),
    }
    interruptedTasks.push(updated)
    return updated
  })

  return { tasks: updatedTasks, interruptedTasks }
}

function clearOpenAIWatchdogTimer(taskId: string) {
  const timer = openAIWatchdogTimers.get(taskId)
  if (timer) clearTimeout(timer)
  openAIWatchdogTimers.delete(taskId)
}

function failOpenAITaskIfStillRunning(taskId: string, error: string, now = Date.now()) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return false

  updateTaskInStore(taskId, {
    status: 'error',
    error,
    falRecoverable: false,
    imageStatusRecoverable: false,
    finishedAt: now,
    elapsed: Math.max(0, now - task.createdAt),
  })
  return true
}

function scheduleOpenAIWatchdog(taskId: string, timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  clearOpenAIWatchdogTimer(taskId)
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return

  const timeoutMs = Math.max(0, timeoutSeconds * 1000)
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - task.createdAt))
  const timer = setTimeout(() => {
    openAIWatchdogTimers.delete(taskId)
    const failed = failOpenAITaskIfStillRunning(taskId, createOpenAITimeoutError(timeoutSeconds, profile))
    if (failed) useStore.getState().showToast('OpenAI 任务请求超时', 'error')
  }, remainingMs)
  openAIWatchdogTimers.set(taskId, timer)
}

function usesConcurrentOpenAIImageRequests(profile: ApiProfile, params: TaskParams) {
  const n = params.n > 0 ? params.n : 1
  if (profile.provider !== 'openai' || n <= 1) return false
  if (profile.apiMode === 'responses') return true
  return profile.apiMode === 'images' && (profile.codexCli || profile.streamImages)
}

function addImageStatusRequestIdToTask(taskId: string, requestId: string, syncOnline = true) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task) return
  const imageStatusRequestIds = task.imageStatusRequestIds?.includes(requestId)
    ? task.imageStatusRequestIds
    : [...(task.imageStatusRequestIds ?? []), requestId]
  updateTaskInStore(taskId, {
    imageStatusRequestIds,
    imageStatusRecoverable: false,
  }, syncOnline)
}

function addImageStatusRequestIdToAgentRound(conversationId: string, roundId: string, requestId: string, profileId?: string) {
  updateAgentConversation(conversationId, (current) => ({
    ...current,
    updatedAt: Date.now(),
    rounds: current.rounds.map((round) => {
      if (round.id !== roundId) return round
      const imageStatusRequestIds = round.imageStatusRequestIds?.includes(requestId)
        ? round.imageStatusRequestIds
        : [...(round.imageStatusRequestIds ?? []), requestId]
      return {
        ...round,
        imageStatusRequestIds,
        imageStatusRecoverable: false,
        ...(profileId ? { imageStatusApiProfileId: profileId } : {}),
      }
    }),
  }))
}

export function taskHasOutputErrors(task: Pick<TaskRecord, 'outputErrors'>) {
  return Boolean(task.outputErrors?.length)
}

export function taskMatchesFilterStatus(task: TaskRecord, filterStatus: AppState['filterStatus']) {
  if (filterStatus === 'all') return true
  if (filterStatus === 'error') return task.status === 'error' || taskHasOutputErrors(task)
  return task.status === filterStatus
}

export function taskMatchesSearchQuery(task: TaskRecord, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const prompt = (task.prompt || '').toLowerCase()
  const paramStr = JSON.stringify(task.params).toLowerCase()
  const errorStr = [task.error, ...(task.outputErrors ?? []).map((item) => item.error)].filter(Boolean).join('\n').toLowerCase()
  return prompt.includes(q) || paramStr.includes(q) || errorStr.includes(q)
}

export function showCodexCliPrompt(force = false, reason = '接口返回的提示词已被改写') {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return
  const promptRewriteGuardMessage = settings.allowPromptRewrite
    ? '当前已允许模型改写优化提示词，因此不会额外加入不改写要求。'
    : '同时，提示词文本开头会加入简短的不改写要求，避免模型重写提示词，偏离原意。'

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message: `${reason}，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。${promptRewriteGuardMessage}`,
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

function getFalRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile?.provider === 'fal') return taskProfile
  return null
}

function getCustomRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const provider = task.apiProvider
  if (!provider || provider === 'openai' || provider === 'fal') return null
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile?.provider === provider) return taskProfile
  return null
}

function getImageStatusRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  if ((task.apiProvider ?? 'openai') === 'fal') return null
  const taskProfile = getTaskApiProfile(settings, task)
  if (!taskProfile) return null
  if (task.apiOverride && (task.apiOverride.apiKey || task.apiOverride.model)) {
    return {
      ...taskProfile,
      ...(task.apiOverride.apiKey ? { apiKey: task.apiOverride.apiKey } : {}),
      ...(task.apiOverride.model ? { model: task.apiOverride.model } : {}),
    }
  }
  return taskProfile
}

export function getTaskApiProfile(settings: AppSettings, task: TaskRecord): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  const provider = task.apiProvider

  if (!task.apiProfileId) return null

  const byId = normalized.profiles.find((profile) => profile.id === task.apiProfileId)
  if (byId && (!provider || byId.provider === provider)) return byId
  return null
}

function createSettingsForApiProfile(settings: AppSettings, profile: ApiProfile): AppSettings {
  const normalized = normalizeSettings(settings)
  return normalizeSettings({
    ...normalized,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    timeout: profile.timeout,
    apiMode: profile.apiMode,
    codexCli: profile.codexCli,
    apiProxy: profile.apiProxy,
    profiles: normalized.profiles.map((item) => item.id === profile.id ? profile : item),
    activeProfileId: profile.id,
  })
}

function getAgentOidcApiOverride() {
  const state = useStore.getState()
  const apiKey = state.agentOidcApiOverride?.apiKey || state.oidcApiOverride?.apiKey
  const model = state.agentOidcApiOverride?.model || state.oidcApiOverride?.model
  return apiKey || model ? { ...(apiKey ? { apiKey } : {}), ...(model ? { model } : {}) } : null
}

function applyAgentOidcOverrideToProfile(profile: ApiProfile): ApiProfile {
  const override = getAgentOidcApiOverride()
  if (!override) return profile
  return {
    ...profile,
    apiKey: override.apiKey || profile.apiKey,
    model: override.model || profile.model,
  }
}

function getAgentProfileValidationError(settings: AppSettings): { profile: ApiProfile | null; message: string } | null {
  const normalized = normalizeSettings(settings)
  const textProfile = getAgentTextApiProfile(normalized)
  if (!textProfile || textProfile.provider !== 'openai') {
    return { profile: textProfile, message: 'Agent 模式需要使用 OpenAI 兼容模型。' }
  }
  const textProfileError = validateApiProfile(applyAgentOidcOverrideToProfile({ ...textProfile, apiMode: 'responses' }))
  if (textProfileError) return { profile: textProfile, message: `文本模型 API 配置不完整：${textProfileError}` }

  if (normalized.agentApiConfigMode === 'hybrid') {
    const imageProfile = getAgentImageApiProfile(normalized)
    if (!imageProfile) return { profile: null, message: '图像模型 API 配置不存在，请在 Agent 配置页选择可用的图像模型配置。' }
    const imageProfileError = validateApiProfile(applyAgentOidcOverrideToProfile(imageProfile))
    if (imageProfileError) return { profile: imageProfile, message: `图像模型 API 配置不完整：${imageProfileError}` }
  }

  return null
}

function getReusedTaskApiProfile(settings: AppSettings, profileId: string | null): ApiProfile | null {
  if (!profileId) return null
  return normalizeSettings(settings).profiles.find((profile) => profile.id === profileId) ?? null
}

function getTaskApiProfileName(task: TaskRecord) {
  return task.apiProfileName || task.apiModel || '未知配置'
}

function isFalConnectionRecoverableError(err: unknown) {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function isApiRequestNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) {
    const message = err.message.toLowerCase()
    return /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(message)
  }
  return false
}

function getApiErrorStatus(err: unknown) {
  if (!err || typeof err !== 'object' || !('status' in err)) return 0
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : 0
}

function getApiModeApiName(apiMode: ApiMode) {
  return apiMode === 'responses' ? 'Responses API' : 'Image API'
}

function getApiRequestNetworkErrorHint(
  err: unknown,
  createdAt: number,
  usesApiProxy: boolean,
  profile?: Pick<ApiProfile, 'provider' | 'apiMode' | 'streamImages' | 'streamPartialImages'> | null,
): string | null {
  if (!isApiRequestNetworkError(err)) return null

  const elapsedSeconds = Math.max(0, (Date.now() - createdAt) / 1000)

  if (elapsedSeconds <= 15) {
    if (usesApiProxy) {
      return '提示：请求立即失败，请检查 API 代理服务是否正常运行。'
    }
    const unsupportedApiHint = profile?.provider === 'openai'
      ? `\n· API 不支持 ${getApiModeApiName(profile.apiMode)}`
      : ''
    return `提示：请求立即失败，可能原因：\n· API 服务器不可达或地址有误，请检查 API URL 是否正确、服务是否正常运行${unsupportedApiHint}\n· 接口不支持浏览器跨域请求，可使用 Docker 部署版或本地运行版并配置 API 代理解决`
  }

  if (elapsedSeconds >= 55 && elapsedSeconds <= 75) {
    return `提示：请求等待约 60 秒后被断开，这通常是 Nginx 等反向代理的默认超时，而非接口本身报错。可调大代理的超时时间（如 proxy_read_timeout），或降低图片尺寸/质量后重试。${getTimeoutStreamingHint(profile)}`
  }

  if (elapsedSeconds >= 110 && elapsedSeconds <= 140) {
    return `提示：请求等待约 120 秒后被断开，这通常是 Cloudflare 等 CDN/网关的超时限制，而非接口本身报错。如果使用 Cloudflare，可考虑升级套餐或使用不经过 CDN 的直连地址。${getTimeoutStreamingHint(profile)}`
  }

  return `提示：请求等待较长时间后被断开，通常是反向代理或网关的超时限制，而非接口本身报错。可检查代理超时设置，或降低图片尺寸/质量后重试。${getTimeoutStreamingHint(profile)}`
}

function getRawErrorPayload(err: unknown): Pick<Partial<TaskRecord>, 'rawImageUrls' | 'rawResponsePayload'> {
  if (!(err instanceof Error)) return {}

  const rawImageUrls = 'rawImageUrls' in err ? (err as { rawImageUrls?: unknown }).rawImageUrls : undefined
  const rawResponsePayload = 'rawResponsePayload' in err ? (err as { rawResponsePayload?: unknown }).rawResponsePayload : undefined
  return {
    rawImageUrls: Array.isArray(rawImageUrls) && rawImageUrls.length ? rawImageUrls.filter((url): url is string => typeof url === 'string') : undefined,
    rawResponsePayload: typeof rawResponsePayload === 'string' ? rawResponsePayload : undefined,
  }
}

function clearFalRecoveryTimer(taskId: string) {
  const timer = falRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  falRecoveryTimers.delete(taskId)
}

function scheduleFalRecovery(taskId: string, delayMs = FAL_RECOVERY_POLL_MS) {
  if (falRecoveryTimers.has(taskId)) return
  const timer = setTimeout(() => {
    falRecoveryTimers.delete(taskId)
    recoverFalTask(taskId)
  }, delayMs)
  falRecoveryTimers.set(taskId, timer)
}

function clearCustomRecoveryTimer(taskId: string) {
  const timer = customRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  customRecoveryTimers.delete(taskId)
}

function scheduleCustomRecovery(taskId: string, delayMs = CUSTOM_RECOVERY_POLL_MS) {
  if (customRecoveryTimers.has(taskId)) return
  const timer = setTimeout(() => {
    customRecoveryTimers.delete(taskId)
    recoverCustomTask(taskId)
  }, delayMs)
  customRecoveryTimers.set(taskId, timer)
}

function clearCompositeRecoveryTimer(taskId: string) {
  const timer = compositeRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  compositeRecoveryTimers.delete(taskId)
}

function scheduleCompositeRecovery(taskId: string, delayMs = COMPOSITE_RECOVERY_POLL_MS) {
  if (compositeRecoveryTimers.has(taskId)) return
  const timer = setTimeout(() => {
    compositeRecoveryTimers.delete(taskId)
    recoverCompositeTask(taskId)
  }, delayMs)
  compositeRecoveryTimers.set(taskId, timer)
}

function clearImageStatusRecoveryTimer(taskId: string) {
  const timer = imageStatusRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  imageStatusRecoveryTimers.delete(taskId)
}

function scheduleImageStatusRecovery(taskId: string, delayMs = IMAGE_STATUS_RECOVERY_POLL_MS) {
  if (imageStatusRecoveryTimers.has(taskId)) return
  const timer = setTimeout(() => {
    imageStatusRecoveryTimers.delete(taskId)
    recoverImageStatusTask(taskId)
  }, delayMs)
  imageStatusRecoveryTimers.set(taskId, timer)
}

function getAgentImageStatusRecoveryKey(conversationId: string, roundId: string) {
  return `${conversationId}:${roundId}`
}

function clearAgentImageStatusRecoveryTimer(conversationId: string, roundId: string) {
  const key = getAgentImageStatusRecoveryKey(conversationId, roundId)
  const timer = agentImageStatusRecoveryTimers.get(key)
  if (timer) clearTimeout(timer)
  agentImageStatusRecoveryTimers.delete(key)
}

function scheduleAgentImageStatusRecovery(conversationId: string, roundId: string, delayMs = IMAGE_STATUS_RECOVERY_POLL_MS) {
  const key = getAgentImageStatusRecoveryKey(conversationId, roundId)
  if (agentImageStatusRecoveryTimers.has(key)) return
  const timer = setTimeout(() => {
    agentImageStatusRecoveryTimers.delete(key)
    recoverAgentRoundImageStatus(conversationId, roundId)
  }, delayMs)
  agentImageStatusRecoveryTimers.set(key, timer)
}

function hasActualParams(params: Partial<TaskParams> | undefined): params is Partial<TaskParams> {
  return Boolean(params && Object.keys(params).length > 0)
}

function firstActualParams(paramsList: Array<Partial<TaskParams> | undefined> | undefined): Partial<TaskParams> | undefined {
  return paramsList?.find(hasActualParams)
}

function mapActualParamsByImage(outputIds: string[], paramsList: Array<Partial<TaskParams> | undefined> | undefined) {
  const mapped = paramsList?.reduce<Record<string, Partial<TaskParams>>>((acc, params, index) => {
    const imgId = outputIds[index]
    if (imgId && hasActualParams(params)) acc[imgId] = params
    return acc
  }, {})
  return mapped && Object.keys(mapped).length > 0 ? mapped : undefined
}

function getImageSizeParam(size: { width?: number; height?: number } | undefined): Partial<TaskParams> | undefined {
  if (!size?.width || !size.height) return undefined
  return { size: `${size.width}x${size.height}` }
}

function hasActualSizeParam(params: Partial<TaskParams> | undefined) {
  return Boolean(params?.size)
}

function addImageSizeParam(
  params: Partial<TaskParams> | undefined,
  size: { width?: number; height?: number } | undefined,
): Partial<TaskParams> | undefined {
  if (hasActualSizeParam(params)) return params
  const sizeParam = getImageSizeParam(size)
  if (!sizeParam) return params
  return { ...(params ?? {}), ...sizeParam }
}

async function readImageSizeParam(dataUrl: string): Promise<Partial<TaskParams> | undefined> {
  if (typeof Image === 'undefined') return undefined

  return new Promise((resolve) => {
    let settled = false
    const image = new Image()
    const finish = (params: Partial<TaskParams> | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(params)
    }
    const timer = setTimeout(() => finish(undefined), 2000)
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
      } else {
        finish(undefined)
      }
    }
    image.onerror = () => finish(undefined)
    image.src = dataUrl
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
    }
  })
}

async function readImageSizeParamsList(images: string[]): Promise<Array<Partial<TaskParams> | undefined>> {
  return Promise.all(images.map((image) => readImageSizeParam(image)))
}

async function resolveImageSizeParamsList(
  images: string[],
  preferred?: Array<Partial<TaskParams> | undefined>,
  sizes?: Array<{ width?: number; height?: number } | undefined>,
): Promise<Array<Partial<TaskParams> | undefined>> {
  const withStoredSizes = images.map((_, index) => addImageSizeParam(preferred?.[index], sizes?.[index]))
  if (withStoredSizes.every(hasActualSizeParam)) {
    return withStoredSizes
  }
  const fallback = await readImageSizeParamsList(images)
  return images.map((_, index) => {
    const params = withStoredSizes[index]
    const fallbackParams = fallback[index]
    if (hasActualSizeParam(params)) return params
    if (fallbackParams?.size) return { ...(params ?? {}), size: fallbackParams.size }
    return hasActualParams(params) ? params : fallbackParams
  })
}

async function completeRecoveredFalTask(task: TaskRecord, result: Awaited<ReturnType<typeof getFalQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return

  const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
  const actualParamsList = await resolveImageSizeParamsList(outputDataUrls, result.actualParamsList, outputImageSizes)

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    transparentOriginalImages: transparentOriginalImageIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    status: 'done',
    error: null,
    falRecoverable: false,
    finishedAt: Date.now(),
    elapsed: Date.now() - task.createdAt,
  })
  useStore.getState().showToast(`fal.ai 任务已恢复，共 ${outputIds.length} 张图片`, 'success')
  if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `fal.ai 任务已恢复，共 ${outputIds.length} 张图片。`)
}

async function recoverFalTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || task.apiProvider !== 'fal' || !task.falRequestId || !task.falEndpoint || task.status === 'done') return
  const requestId = task.requestId ?? createRequestId()
  if (!task.requestId) void updateTaskInStore(taskId, { requestId })

  const profile = getFalRecoveryProfile(settings, task)
  if (!profile) {
    scheduleFalRecovery(taskId)
    return
  }

  try {
    const result = await getFalQueuedImageResult(profile, task.falEndpoint, task.falRequestId, task.params, requestId)
    clearFalRecoveryTimer(taskId)
    await completeRecoveredFalTask(task, result)
    return
  } catch (err) {
    if (isFalConnectionRecoverableError(err)) {
      scheduleFalRecovery(taskId)
      return
    }

    clearFalRecoveryTimer(taskId)
    updateTaskInStore(taskId, {
      status: 'error',
      error: getFalErrorMessage(err) ?? (err instanceof Error ? err.message : String(err)),
      ...getRawErrorPayload(err),
      falRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
  }
}

async function completeRecoveredCompositeTask(task: TaskRecord, result: Awaited<ReturnType<typeof queryBackendCompositeImageTask>>) {
  if (!result) return
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return

  const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
  const actualParamsList = await resolveImageSizeParamsList(outputDataUrls, undefined, outputImageSizes)

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    transparentOriginalImages: transparentOriginalImageIds,
    rawImageUrls: result.rawImageUrls?.length ? result.rawImageUrls : undefined,
    actualParams: {
      ...result.actualParams,
      size: firstActualParams(actualParamsList)?.size ?? result.actualParams?.size,
      n: outputIds.length,
    },
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    ...(result.actualCost !== undefined ? { actualCost: result.actualCost } : {}),
    status: 'done',
    error: null,
    compositeRecoverable: false,
    finishedAt: Date.now(),
    elapsed: Date.now() - task.createdAt,
  })
  useStore.getState().showToast(`Composite 任务已恢复，共 ${outputIds.length} 张图片`, 'success')
  if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `Composite 任务已恢复，共 ${outputIds.length} 张图片。`)
}

async function recoverCompositeTask(taskId: string) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || task.status === 'done' || !task.compositeRequestId) return
  const requestId = task.requestId ?? createRequestId()
  if (!task.requestId) void updateTaskInStore(taskId, { requestId })
  const apiOverride = task.apiOverride
  if (apiOverride?.platform?.trim().toLowerCase() !== 'composite' || !apiOverride.apiKey || !task.apiModel) {
    clearCompositeRecoveryTimer(taskId)
    updateTaskInStore(taskId, {
      status: 'error',
      error: 'Composite 任务缺少恢复所需的 API Key 或模型信息',
      compositeRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    return
  }

  try {
    console.log('[Store] 正在恢复 Composite 任务', {
      taskId,
      requestId: task.compositeRequestId,
      statusUrl: task.compositeStatusUrl,
    })
    const result = await queryBackendCompositeImageTask({
      apiKey: apiOverride.apiKey,
      model: task.apiModel,
      requestId: task.compositeRequestId,
      clientRequestId: requestId,
      params: task.params,
    })
    if (!result) {
      if (Date.now() - task.createdAt >= COMPOSITE_RECOVERY_TIMEOUT_MS) {
        clearCompositeRecoveryTimer(taskId)
        updateTaskInStore(taskId, {
          status: 'error',
          error: 'Composite 异步任务轮询超时',
          compositeRecoverable: false,
          finishedAt: Date.now(),
          elapsed: Date.now() - task.createdAt,
        })
        return
      }
      updateTaskInStore(taskId, {
        status: 'running',
        error: null,
        compositeRecoverable: true,
        finishedAt: null,
        elapsed: null,
      })
      scheduleCompositeRecovery(taskId)
      return
    }

    clearCompositeRecoveryTimer(taskId)
    await completeRecoveredCompositeTask(task, result)
  } catch (err) {
    if (isFalConnectionRecoverableError(err)) {
      updateTaskInStore(taskId, { compositeRecoverable: true })
      scheduleCompositeRecovery(taskId)
      return
    }

    clearCompositeRecoveryTimer(taskId)
    updateTaskInStore(taskId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      compositeRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
  }
}

function getImageStatusUrls(record: ImageStatusRecord) {
  return record.cosUrls?.length ? record.cosUrls : record.urls ?? []
}

function getImageStatusFailureMessage(record: ImageStatusRecord) {
  return record.error || '图像生成失败'
}

function shouldScheduleTaskImageStatusRecovery(task: TaskRecord, agentRoundRequestIds: Set<string>) {
  if (!task.imageStatusRequestIds?.length) return false
  if ((task.apiProvider ?? 'openai') === 'fal') return false
  if (task.status === 'done') return false
  if (task.status === 'error' && task.error === AGENT_STOPPED_MESSAGE) return false
  if (isAgentTask(task) && task.imageStatusRequestIds.some((requestId) => agentRoundRequestIds.has(requestId))) return false
  return canRecoverTaskImageStatus(task)
}

function shouldScheduleAgentRoundImageStatusRecovery(conversationId: string, round: AgentRound, tasks: TaskRecord[]) {
  if (!round.imageStatusRequestIds?.length) return false
  if (round.status === 'error' && round.error === AGENT_STOPPED_MESSAGE) return false
  if (getRecoverableAgentRoundImageStatusRequestIds(conversationId, round, tasks).length === 0) return false
  return canRecoverAgentRoundImageStatus(round)
}

function canRecoverTaskImageStatus(task: TaskRecord) {
  return task.status !== 'done' && (task.status === 'running' || task.imageStatusRecoverable === true)
}

function canRecoverAgentRoundImageStatus(round: AgentRound) {
  return round.status !== 'done' && (round.status === 'running' || round.imageStatusRecoverable === true)
}

function getAgentRoundImageStatusTasks(conversationId: string, round: AgentRound, tasks = useStore.getState().tasks) {
  const requestIds = round.imageStatusRequestIds ?? []
  return tasks.filter((task) =>
    task.agentConversationId === conversationId &&
    task.agentRoundId === round.id &&
    task.imageStatusRequestIds?.some((requestId) => requestIds.includes(requestId)),
  )
}

function getRecoverableAgentRoundImageStatusRequestIds(conversationId: string, round: AgentRound, tasks = useStore.getState().tasks) {
  return (round.imageStatusRequestIds ?? []).filter((requestId) => {
    const matchingTasks = tasks.filter((task) =>
      task.agentConversationId === conversationId &&
      task.agentRoundId === round.id &&
      task.imageStatusRequestIds?.includes(requestId),
    )
    return matchingTasks.length === 0 || matchingTasks.every(canRecoverTaskImageStatus)
  })
}

function getImageStatusTexts(records: ImageStatusRecord[]) {
  return uniqueIds(records.flatMap((record) => record.texts ?? []).map((text) => text.trim()).filter(Boolean))
}

function syncAgentConversationsFromTerminalImageStatusTasks(tasks: TaskRecord[]) {
  for (const task of tasks) {
    if (
      isAgentTask(task) &&
      task.imageStatusRequestIds?.length &&
      !canRecoverTaskImageStatus(task) &&
      (task.status === 'done' || task.status === 'error')
    ) {
      updateAgentRoundFromImageStatus(task, [], task.error ?? undefined)
    }
  }
}

function recoverAgentConversationsForImageStatus(conversations: AgentConversation[], tasks: TaskRecord[]) {
  const recoverableTasks = tasks.filter((task) =>
    isAgentTask(task) &&
    task.agentConversationId &&
    task.agentRoundId &&
    task.imageStatusRequestIds?.length &&
    (task.status === 'running' || task.imageStatusRecoverable),
  )
  if (recoverableTasks.length === 0) return conversations

  let changed = false
  const tasksByRound = new Map<string, TaskRecord[]>()
  for (const task of recoverableTasks) {
    const key = `${task.agentConversationId}:${task.agentRoundId}`
    tasksByRound.set(key, [...(tasksByRound.get(key) ?? []), task])
  }

  const next = conversations.map((conversation) => {
    const roundTasks = conversation.rounds.flatMap((round) => tasksByRound.get(`${conversation.id}:${round.id}`) ?? [])
    if (roundTasks.length === 0) return conversation

    let messages = conversation.messages
    const rounds = conversation.rounds.map((round) => {
      const tasksForRound = tasksByRound.get(`${conversation.id}:${round.id}`) ?? []
      if (tasksForRound.length === 0) return round

      const existingAssistantMessage = round.assistantMessageId
        ? messages.find((message) => message.id === round.assistantMessageId)
        : messages.find((message) => message.roundId === round.id && message.role === 'assistant')
      const assistantMessageId = existingAssistantMessage?.id ?? tasksForRound.find((task) => task.agentMessageId)?.agentMessageId ?? genId()
      if (!existingAssistantMessage) {
        messages = [
          ...messages,
          {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            roundId: round.id,
            outputTaskIds: tasksForRound.map((task) => task.id),
            createdAt: round.createdAt,
          },
        ]
      } else if (!arraysEqual(existingAssistantMessage.outputTaskIds ?? [], uniqueIds([...(existingAssistantMessage.outputTaskIds ?? []), ...tasksForRound.map((task) => task.id)]))) {
        const outputTaskIds = uniqueIds([...(existingAssistantMessage.outputTaskIds ?? []), ...tasksForRound.map((task) => task.id)])
        messages = messages.map((message) => message.id === assistantMessageId ? { ...message, outputTaskIds } : message)
      }

      const outputTaskIds = uniqueIds([...round.outputTaskIds, ...tasksForRound.map((task) => task.id)])
      if (
        round.status !== 'running' ||
        round.error !== null ||
        round.finishedAt !== null ||
        round.assistantMessageId !== assistantMessageId ||
        !arraysEqual(round.outputTaskIds, outputTaskIds)
      ) {
        changed = true
        return {
          ...round,
          assistantMessageId,
          outputTaskIds,
          status: 'running' as const,
          error: null,
          finishedAt: null,
        }
      }
      return round
    })

    if (messages !== conversation.messages || rounds !== conversation.rounds) changed = true
    return {
      ...conversation,
      updatedAt: Date.now(),
      rounds,
      messages,
    }
  })

  return changed ? next : conversations
}

function updateAgentRoundFromImageStatus(task: TaskRecord, records: ImageStatusRecord[], error?: string) {
  if (!task.agentConversationId || !task.agentRoundId) return

  const texts = getImageStatusTexts(records)
  const now = Date.now()
  updateAgentConversation(task.agentConversationId, (current) => {
    const round = current.rounds.find((item) => item.id === task.agentRoundId)
    if (!round) return current

    const roundTaskIds = uniqueIds([...round.outputTaskIds, task.id])
    const roundTasks = roundTaskIds
      .map((taskId) => useStore.getState().tasks.find((item) => item.id === taskId))
      .filter((item): item is TaskRecord => Boolean(item))
    const hasRunningTask = roundTasks.some((item) => item.status === 'running' || item.imageStatusRecoverable)
    const hasRecoveredOutput = roundTasks.some((item) => item.status === 'done' || item.rawImageUrls?.length)
    const existingAssistantMessage = round.assistantMessageId
      ? current.messages.find((message) => message.id === round.assistantMessageId)
      : current.messages.find((message) => message.roundId === round.id && message.role === 'assistant')
    const assistantMessageId = existingAssistantMessage?.id ?? task.agentMessageId ?? genId()
    const existingContent = existingAssistantMessage?.content.trim() ?? ''
    const textContent = texts.join('\n\n').trim()
    const finalContent = textContent || existingContent || (hasRunningTask ? '' : hasRecoveredOutput ? '图像已生成。' : `请求失败：${error ?? roundTasks.find((item) => item.error)?.error ?? '图片状态恢复失败'}`)
    const outputTaskIds = uniqueIds([...(existingAssistantMessage?.outputTaskIds ?? []), ...roundTaskIds])
    const messages = existingAssistantMessage
      ? current.messages.map((message) => message.id === assistantMessageId ? { ...message, content: finalContent, outputTaskIds } : message)
      : [
          ...current.messages,
          {
            id: assistantMessageId,
            role: 'assistant' as const,
            content: finalContent,
            roundId: round.id,
            outputTaskIds,
            createdAt: now,
          },
        ]

    return {
      ...current,
      updatedAt: now,
      rounds: current.rounds.map((item) =>
        item.id === round.id
          ? {
              ...item,
              assistantMessageId,
              outputTaskIds: roundTaskIds,
              status: hasRunningTask ? 'running' : hasRecoveredOutput ? 'done' : 'error',
              error: hasRunningTask || hasRecoveredOutput ? null : error ?? roundTasks.find((task) => task.error)?.error ?? '图片状态恢复失败',
              imageStatusRecoverable: hasRunningTask,
              finishedAt: hasRunningTask ? null : now,
            }
          : item,
      ),
      messages,
    }
  })
}

function getAgentRoundImageStatusRecoveryProfile(settings: AppSettings, round: AgentRound) {
  const normalized = normalizeSettings(settings)
  const profile = round.imageStatusApiProfileId
    ? normalized.profiles.find((item) => item.id === round.imageStatusApiProfileId) ?? null
    : getAgentTextApiProfile(normalized)
  return profile ? applyAgentOidcOverrideToProfile(profile) : null
}

async function ensureAgentRoundImageStatusTask(conversation: AgentConversation, round: AgentRound, profile: ApiProfile, requestIds: string[]) {
  const existingTask = useStore.getState().tasks.find((task) =>
    task.agentConversationId === conversation.id &&
    task.agentRoundId === round.id &&
    task.imageStatusRequestIds?.some((requestId) => requestIds.includes(requestId)),
  )
  if (existingTask) {
    if (!existingTask.requestId && round.requestId) {
      void updateTaskInStore(existingTask.id, { requestId: round.requestId })
      return { ...existingTask, requestId: round.requestId }
    }
    return existingTask
  }

  const params = {
    ...useStore.getState().params,
    n: 1,
    transparent_output: false,
  }
  const projectId = useStore.getState().tasks.find((task) => task.agentConversationId === conversation.id)?.projectId
  const task: TaskRecord = {
    id: genId(),
    requestId: round.requestId,
    ...(projectId ? { projectId } : {}),
    prompt: round.prompt,
    params,
    apiProvider: profile.provider,
    apiProfileId: profile.id,
    apiProfileName: profile.name,
    apiMode: profile.apiMode,
    apiModel: profile.model,
    inputImageIds: round.inputImageIds,
    maskTargetImageId: round.maskTargetImageId ?? null,
    maskImageId: round.maskImageId ?? null,
    imageStatusRequestIds: requestIds,
    imageStatusRecoverable: true,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: round.createdAt,
    finishedAt: null,
    elapsed: null,
    sourceMode: 'agent',
    agentConversationId: conversation.id,
    agentRoundId: round.id,
    agentMessageId: round.assistantMessageId,
    agentToolCallId: requestIds[0],
  }

  useStore.getState().setTasks([task, ...useStore.getState().tasks])
  await putTask(task)
  updateAgentRoundFromImageStatus(task, [])
  return task
}

async function recoverAgentRoundImageStatus(conversationId: string, roundId: string) {
  const { settings, agentConversations } = useStore.getState()
  const conversation = agentConversations.find((item) => item.id === conversationId)
  const round = conversation?.rounds.find((item) => item.id === roundId)
  if (!conversation || !round || round.status === 'done' || !round.imageStatusRequestIds?.length) return
  const requestId = round.requestId ?? createRequestId()
  const requestRound = round.requestId ? round : { ...round, requestId }
  if (!round.requestId) {
    updateAgentConversation(conversationId, (current) => ({
      ...current,
      updatedAt: Date.now(),
      rounds: current.rounds.map((item) => item.id === roundId ? requestRound : item),
    }))
  }
  if (!canRecoverAgentRoundImageStatus(round)) {
    clearAgentImageStatusRecoveryTimer(conversationId, roundId)
    return
  }
  const requestIds = getRecoverableAgentRoundImageStatusRequestIds(conversationId, round)
  if (requestIds.length === 0) {
    clearAgentImageStatusRecoveryTimer(conversationId, roundId)
    const terminalTask = getAgentRoundImageStatusTasks(conversationId, round).find((task) => !canRecoverTaskImageStatus(task))
    if (terminalTask) updateAgentRoundFromImageStatus(terminalTask, [], terminalTask.error ?? undefined)
    return
  }

  const profile = getAgentRoundImageStatusRecoveryProfile(settings, round)
  if (!profile) {
    updateAgentConversation(conversationId, (current) => ({
      ...current,
      updatedAt: Date.now(),
      rounds: current.rounds.map((item) =>
        item.id === roundId
          ? { ...item, status: 'error', error: '找不到此 Agent 请求所使用的 API 配置，无法查询图片状态。', imageStatusRecoverable: false, finishedAt: Date.now() }
          : item,
      ),
    }))
    return
  }

  const timedOut = Date.now() - round.createdAt >= Math.max(0, profile.timeout * 1000)
  try {
    const result = await queryImageStatuses(profile, requestIds, { requestId })
    const latestRound = useStore.getState().agentConversations
      .find((item) => item.id === conversationId)
      ?.rounds.find((item) => item.id === roundId)
    if (!latestRound || !canRecoverAgentRoundImageStatus(latestRound)) {
      clearAgentImageStatusRecoveryTimer(conversationId, roundId)
      return
    }
    const recordsById = new Map(result.records.map((record) => [record.requestId, record]))
    const succeededRecords: ImageStatusRecord[] = []
    const failedRequests: Array<{ requestIndex: number; error: string }> = []
    const pendingRequests: Array<{ requestId: string; requestIndex: number }> = []

    for (let i = 0; i < requestIds.length; i += 1) {
      const requestId = requestIds[i]
      const record = recordsById.get(requestId)
      if (!record) {
        pendingRequests.push({ requestId, requestIndex: i })
        continue
      }
      if (record.status === 'succeeded') {
        succeededRecords.push(record)
        continue
      }
      if (record.status === 'failed') {
        failedRequests.push({ requestIndex: i, error: getImageStatusFailureMessage(record) })
        continue
      }
      pendingRequests.push({ requestId, requestIndex: i })
    }

    if (pendingRequests.length > 0 && !timedOut) {
      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) =>
          item.id === roundId ? { ...item, status: 'running', error: null, imageStatusRecoverable: true, finishedAt: null } : item,
        ),
      }))
      scheduleAgentImageStatusRecovery(conversationId, roundId)
      return
    }

    const timedOutRequests = pendingRequests.map((request) => ({
      requestIndex: request.requestIndex,
      error: timedOut ? '图片状态查询超时' : '图片状态记录不存在或已过期',
    }))
    const allFailedRequests = [...failedRequests, ...timedOutRequests]
    clearAgentImageStatusRecoveryTimer(conversationId, roundId)

    const task = await ensureAgentRoundImageStatusTask(conversation, requestRound, profile, requestIds)
    if (succeededRecords.length > 0) {
      await completeRecoveredImageStatusTask(task, succeededRecords, allFailedRequests)
      return
    }

    const error = allFailedRequests[0]?.error ?? '图片状态恢复失败'
    updateTaskInStore(task.id, {
      status: 'error',
      error,
      outputErrors: allFailedRequests.length ? allFailedRequests : undefined,
      imageStatusRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    updateAgentRoundFromImageStatus(task, result.records, error)
  } catch (err) {
    if (!timedOut && isFalConnectionRecoverableError(err)) {
      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) =>
          item.id === roundId ? { ...item, status: 'running', error: null, imageStatusRecoverable: true, finishedAt: null } : item,
        ),
      }))
      scheduleAgentImageStatusRecovery(conversationId, roundId)
      return
    }

    clearAgentImageStatusRecoveryTimer(conversationId, roundId)
    const error = err instanceof Error ? err.message : String(err)
    const task = await ensureAgentRoundImageStatusTask(conversation, requestRound, profile, requestIds)
    updateTaskInStore(task.id, {
      status: 'error',
      error,
      imageStatusRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    updateAgentRoundFromImageStatus(task, [], error)
  }
}

async function completeRecoveredImageStatusTask(task: TaskRecord, records: ImageStatusRecord[], failedRequests: Array<{ requestIndex: number; error: string }>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return
  if (!canRecoverTaskImageStatus(latest)) return

  const urls = records.flatMap(getImageStatusUrls)
  if (urls.length > 0) updateTaskInStore(task.id, { rawImageUrls: urls })
  const mime = MIME_MAP[task.params.output_format] || 'image/png'
  const images = []
  try {
    for (const url of urls) {
      images.push(await fetchImageUrlAsDataUrl(url, mime))
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    updateTaskInStore(task.id, {
      status: 'error',
      error,
      rawImageUrls: urls.length ? urls : undefined,
      imageStatusRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    updateAgentRoundFromImageStatus(task, records, error)
    return
  }
  if (images.length === 0) {
    const error = failedRequests[0]?.error ?? '图片状态已完成，但没有返回可用图片链接'
    updateTaskInStore(task.id, {
      status: 'error',
      error,
      rawImageUrls: urls.length ? urls : undefined,
      imageStatusRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    updateAgentRoundFromImageStatus(task, records, error)
    return
  }
  const latestAfterDownload = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latestAfterDownload || !canRecoverTaskImageStatus(latestAfterDownload)) return

  const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, images)
  const actualParamsList = await resolveImageSizeParamsList(outputDataUrls, undefined, outputImageSizes)

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    transparentOriginalImages: transparentOriginalImageIds,
    outputErrors: failedRequests.length ? failedRequests : undefined,
    rawImageUrls: urls.length ? urls : undefined,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    status: 'done',
    error: null,
    imageStatusRecoverable: false,
    finishedAt: Date.now(),
    elapsed: Date.now() - task.createdAt,
  })
  updateAgentRoundFromImageStatus(task, records)
  useStore.getState().showToast(`图像任务已恢复，共 ${outputIds.length} 张图片`, failedRequests.length ? 'error' : 'success')
  if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `图像任务已恢复，共 ${outputIds.length} 张图片。`)
}

async function recoverImageStatusTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  const requestIds = task?.imageStatusRequestIds ?? []
  if (!task || task.status === 'done' || (task.apiProvider ?? 'openai') === 'fal' || requestIds.length === 0) return
  const requestId = task.requestId ?? createRequestId()
  if (!task.requestId) void updateTaskInStore(taskId, { requestId })
  if (!canRecoverTaskImageStatus(task)) {
    clearImageStatusRecoveryTimer(taskId)
    return
  }

  const profile = getImageStatusRecoveryProfile(settings, task)
  if (!profile) {
    updateTaskInStore(taskId, {
      status: 'error',
      error: '找不到此任务所使用的 API 配置，无法查询图片状态。',
      imageStatusRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    return
  }

  const timedOut = Date.now() - task.createdAt >= Math.max(0, profile.timeout * 1000)
  try {
    const project = task.projectId
      ? useStore.getState().projects.find((item) => item.id === task.projectId)
      : undefined
    const viaBackend = project?.storage === 'online' && Boolean(project.remoteId) && (task.apiProvider ?? 'openai') === 'openai' && Boolean(task.apiOverride?.apiKey)
    const result = viaBackend
      ? await queryImageStatuses(profile, requestIds, { viaBackend: true, requestId })
      : await queryImageStatuses(profile, requestIds, { requestId })
    const latestTask = useStore.getState().tasks.find((item) => item.id === taskId)
    if (!latestTask || !canRecoverTaskImageStatus(latestTask)) {
      clearImageStatusRecoveryTimer(taskId)
      return
    }
    const recordsById = new Map(result.records.map((record) => [record.requestId, record]))
    const succeededRecords: ImageStatusRecord[] = []
    const failedRequests: Array<{ requestIndex: number; error: string }> = []
    const pendingRequests: Array<{ requestId: string; requestIndex: number }> = []

    for (let i = 0; i < requestIds.length; i += 1) {
      const requestId = requestIds[i]
      const record = recordsById.get(requestId)
      if (!record) {
        pendingRequests.push({ requestId, requestIndex: i })
        continue
      }
      if (record.status === 'succeeded') {
        succeededRecords.push(record)
        continue
      }
      if (record.status === 'failed') {
        failedRequests.push({ requestIndex: i, error: getImageStatusFailureMessage(record) })
        continue
      }
      pendingRequests.push({ requestId, requestIndex: i })
    }

    if (pendingRequests.length > 0 && !timedOut) {
      updateTaskInStore(taskId, { imageStatusRecoverable: true })
      scheduleImageStatusRecovery(taskId)
      return
    }

    const timedOutRequests = pendingRequests.map((request) => ({
      requestIndex: request.requestIndex,
      error: timedOut ? '图片状态查询超时' : '图片状态记录不存在或已过期',
    }))
    const allFailedRequests = [...failedRequests, ...timedOutRequests]
    clearImageStatusRecoveryTimer(taskId)

    if (succeededRecords.length > 0) {
      await completeRecoveredImageStatusTask(task, succeededRecords, allFailedRequests)
      return
    }

    const error = allFailedRequests[0]?.error ?? '图片状态恢复失败'
    updateTaskInStore(taskId, {
      status: 'error',
      error,
      outputErrors: allFailedRequests.length ? allFailedRequests : undefined,
      imageStatusRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    updateAgentRoundFromImageStatus(task, result.records, error)
  } catch (err) {
    if (!timedOut && isFalConnectionRecoverableError(err)) {
      updateTaskInStore(taskId, { imageStatusRecoverable: true })
      scheduleImageStatusRecovery(taskId)
      return
    }

    clearImageStatusRecoveryTimer(taskId)
    const error = err instanceof Error ? err.message : String(err)
    updateTaskInStore(taskId, {
      status: 'error',
      error,
      imageStatusRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    updateAgentRoundFromImageStatus(task, [], error)
  }
}

async function loadOnlineProjectCache(localProjects: Project[], localTasks: TaskRecord[], localConversations: AgentConversation[], localImageIds: string[], activeProjectId: string | null) {
  const responses = await listOnlineProjects()
  console.info('[项目画布] 在线项目列表', {
    activeProjectId,
    count: responses.length,
    projectIds: responses.map((response) => response.id),
  })
  const remoteIds = new Set(responses.map((response) => response.id))
  const retainedProjects = localProjects.filter((project) =>
    project.storage !== 'online' || remoteIds.has(project.remoteId ?? project.id) || (project.syncPending && !project.remoteArchiveSha256),
  )
  const retainedProjectIds = new Set(retainedProjects.map((project) => project.id))
  const projects = [...retainedProjects]
  let tasks = localTasks.filter((task) => !task.projectId || retainedProjectIds.has(task.projectId))
  let agentConversations: AgentConversation[] = localConversations.filter((conversation) => {
    const projectId = getAgentConversationProjectId(conversation, localTasks)
    return !projectId || retainedProjectIds.has(projectId)
  })
  const images: StoredImage[] = []
  const thumbnails: StoredImageThumbnail[] = []
  const availableImageIds = new Set(localImageIds)
  const favoriteCollections: FavoriteCollection[] = []

  for (const response of responses) {
    const cached = localProjects.find((project) => project.id === response.id || project.remoteId === response.id)
    const remote = createOnlineProject(response)
    const shouldLoadContents = activeProjectId === null || activeProjectId === ALL_PROJECTS_ID || activeProjectId === response.id || cached?.id === activeProjectId
    const shouldRefreshArchive = shouldLoadContents && cached?.remoteArchiveSha256 !== response.archive_sha256
    const shouldRefreshCanvas = shouldRefreshArchive && activeProjectId !== null && activeProjectId !== ALL_PROJECTS_ID
    console.info('[项目画布] 本地缓存信息', {
      projectId: response.id,
      localArchiveSha256: cached?.remoteArchiveSha256 ?? null,
      remoteArchiveSha256: response.archive_sha256,
      canvas: cached?.canvas ?? null,
      shouldRefreshArchive,
    })
    let project: Project = {
      ...remote,
      initialPrompt: cached?.initialPrompt ?? '',
      ...(cached?.canvas ? { canvas: cached.canvas } : {}),
      ...(!shouldLoadContents ? { remoteArchiveSha256: cached?.remoteArchiveSha256 } : {}),
    }
    let remoteCanvas: ProjectCanvasState | null = null
    let canvasMigrationNeeded = false
    let shouldLoadArchiveContents = shouldRefreshArchive
    if (cached?.syncPending) {
      project = {
        ...cached,
        storage: 'online',
        remoteId: response.id,
        syncPending: true,
      }
    } else {
      if (shouldRefreshCanvas) {
        try {
          remoteCanvas = await getOnlineProjectCanvas(response.id)
          canvasMigrationNeeded = !remoteCanvas
          shouldLoadArchiveContents = shouldRefreshArchive && (!cached || !remoteCanvas)
          if (remoteCanvas) project = { ...project, canvas: remoteCanvas }
        } catch (err) {
          canvasMigrationNeeded = true
          shouldLoadArchiveContents = shouldRefreshArchive
          console.warn(`在线项目 ${response.id} 画布读取失败，将使用图片列表恢复：`, err)
        }
      }
      if (shouldLoadArchiveContents) {
        try {
          const parsed = readOnlineProjectArchive(await downloadOnlineProject(response.id))
          const archivedProject = normalizeProjects(parsed.project ? [parsed.project] : [])[0]
          if (archivedProject?.canvas) canvasMigrationNeeded = false
          const projectFavoriteCollections = normalizeFavoriteCollections(parsed.favoriteCollections)
            .map((collection) => ({ ...collection, projectId: remote.id }))
          const defaultFavoriteCollectionId = resolveDefaultFavoriteCollectionId(
            projectFavoriteCollections,
            parsed.defaultFavoriteCollectionId,
          )
          project = {
            ...remote,
            initialPrompt: archivedProject?.initialPrompt ?? cached?.initialPrompt ?? '',
            defaultFavoriteCollectionId,
            ...(remoteCanvas ?? cached?.canvas ?? archivedProject?.canvas
              ? { canvas: remoteCanvas ?? cached?.canvas ?? archivedProject?.canvas }
              : {}),
          }
          tasks = [
            ...tasks.filter((task) => task.projectId !== project.id),
            ...parsed.tasks.map((task) => ({ ...task, projectId: project.id })),
          ]
          agentConversations = mergeAgentConversationsForStorage(
            agentConversations.filter((conversation) => conversation.projectId !== project.id),
            normalizeAgentConversations(parsed.agentConversations).map((conversation) => ({ ...conversation, projectId: project.id })),
          )
          images.push(...parsed.images)
          for (const image of parsed.images) availableImageIds.add(image.id)
          thumbnails.push(...parsed.thumbnails)
          favoriteCollections.push(...projectFavoriteCollections)
        } catch (err) {
          console.warn(`在线项目 ${response.id} 内容加载失败：`, err)
          project = {
            ...project,
            remoteArchiveSha256: cached?.remoteArchiveSha256,
          }
        }
      }
    }
    if (shouldLoadContents) {
      try {
        const remoteImages = await listOnlineProjectImages(response.id)
        const projectTasks = tasks.filter((task) => task.projectId === project.id)
        const coverTask = [...projectTasks].sort((a, b) => b.createdAt - a.createdAt)
          .find((task) => task.outputImages.length > 0) ?? projectTasks[0]
        const coverImageId = activeProjectId === null ? coverTask?.outputImages[0] : undefined
        for (const remoteImage of remoteImages) {
          if (coverImageId && activeProjectId === null && remoteImage.image_id !== coverImageId) continue
          try {
            const hasLocalImage = availableImageIds.has(remoteImage.image_id)
            if (remoteImage.image_url && hasLocalImage) continue
            // 本地没有图片时必须下载并转成 Data URL，供 Responses API 使用。
            const image = await downloadOnlineProjectImage(response.id, remoteImage, { forceDataUrl: true })
            if (!hasLocalImage) {
              images.push(image)
            }
            availableImageIds.add(remoteImage.image_id)
          } catch (err) {
            console.warn(`在线项目 ${response.id} 图片 ${remoteImage.image_id} 加载失败：`, err)
          }
        }
        if (canvasMigrationNeeded && shouldRefreshCanvas) {
          const projectTasks = tasks.filter((task) => task.projectId === project.id)
          const imageIds = Array.from(new Set([
            ...projectTasks.flatMap((task) => task.outputImages),
            ...remoteImages.map((image) => image.image_id),
          ]))
          const initializedCanvas = ensureProjectCanvas(undefined, imageIds)
          try {
            const saved = await saveOnlineProjectCanvas(project, initializedCanvas)
            project = {
              ...project,
              canvas: initializedCanvas,
              remoteArchiveSha256: saved.archive_sha256,
              syncPending: false,
            }
            canvasMigrationNeeded = false
          } catch (err) {
            console.warn(`在线项目 ${response.id} 画布迁移保存失败：`, err)
          }
        }
      } catch (err) {
        console.warn(`在线项目 ${response.id} 图片加载失败：`, err)
      }
    }
    const index = projects.findIndex((item) => item.id === project.id || item.remoteId === response.id)
    if (index >= 0) projects.splice(index, 1)
    projects.push(project)
  }

  projects.sort((a, b) => b.updatedAt - a.updatedAt)
  tasks = [...new Map(tasks.map((task) => [task.id, task])).values()]
  return { projects, tasks, agentConversations, images, thumbnails, favoriteCollections }
}

let initStoreInFlight: Promise<void> | null = null

/** 初始化：从 IndexedDB 加载任务，按需恢复输入图片，并清理孤立图片 */
export function initStore() {
  if (initStoreInFlight) return initStoreInFlight

  initStoreInFlight = initializeStore().finally(() => {
    initStoreInFlight = null
  })
  return initStoreInFlight
}

async function initializeStore() {
  onlineProjectCacheReady = false
  const initialTaskState = useStore.getState().tasks
  const legacyAgentConversations = normalizeAgentConversations(useStore.getState().agentConversations)
  const [storedTaskRecords, storedAgentConversationRecords, storedProjectRecords, storedImageIds] = await Promise.all([
    getAllTasks(),
    getAllAgentConversations(),
    getAllProjects(),
    getAllImageIds(),
  ])
  let storedTasks = storedTaskRecords
  let storedAgentConversations = normalizeAgentConversations(storedAgentConversationRecords)
  let projects = normalizeProjects([
    ...useStore.getState().projects,
    ...storedProjectRecords,
  ]).sort((a, b) => b.updatedAt - a.updatedAt)
  const projectCanvasCache = useStore.getState().projectCanvasCache
  console.info('[项目画布] 启动本地缓存', {
    activeProjectId: useStore.getState().activeProjectId,
    localProjectCount: projects.length,
    canvasCacheProjectIds: Object.keys(projectCanvasCache),
  })
  if (Object.keys(projectCanvasCache).length > 0) {
    projects = projects.map((project) => projectCanvasCache[project.id]
      ? { ...project, canvas: projectCanvasCache[project.id] }
      : project)
  }
  let importedFavoriteCollections: FavoriteCollection[] = []
  let importedImages: StoredImage[] = []
  let importedThumbnails: StoredImageThumbnail[] = []
  let onlineListLoaded = false
  useStore.setState({ projects, projectsLoaded: true })
  const publishedProjectState = useStore.getState().projects
  const authEnabled = isAuthEnabled()
  const hasAccessToken = Boolean(getAccessToken())
  console.info('[项目画布] 在线同步条件', { authEnabled, hasAccessToken })
  if (authEnabled && hasAccessToken) {
    try {
      const online = await loadOnlineProjectCache(projects, storedTasks, storedAgentConversations, storedImageIds, useStore.getState().activeProjectId)
      projects = online.projects
      storedTasks = online.tasks
      storedAgentConversations = online.agentConversations
      importedFavoriteCollections = online.favoriteCollections
      importedImages = online.images
      importedThumbnails = online.thumbnails
      onlineListLoaded = true
      for (const image of importedImages) cacheImage(image.id, image.dataUrl)
      for (const thumbnail of importedThumbnails) {
        cacheThumbnail(thumbnail.id, {
          dataUrl: thumbnail.thumbnailDataUrl,
          width: thumbnail.width,
          height: thumbnail.height,
          thumbnailVersion: thumbnail.thumbnailVersion,
        })
      }
    } catch (err) {
      console.warn('在线项目列表加载失败：', err)
    }
  }
  if (useStore.getState().projects !== publishedProjectState) {
    projects = normalizeProjects([...useStore.getState().projects, ...projects]).sort((a, b) => b.updatedAt - a.updatedAt)
  }
  if (useStore.getState().tasks !== initialTaskState) {
    storedTasks = [...new Map([...storedTasks, ...useStore.getState().tasks].map((task) => [task.id, task])).values()]
  }
  storedAgentConversations = mergeAgentConversationsForStorage(storedAgentConversations, normalizeAgentConversations(useStore.getState().agentConversations))
  if (onlineListLoaded) {
    await replaceProjectCache(projects, storedTasks, storedAgentConversations, importedImages, importedThumbnails)
  }
  const preferredProjectId = useStore.getState().activeProjectId
  const hasLegacyTasks = storedTasks.some((task) => !task.projectId)
  const activeProjectId = preferredProjectId === ALL_PROJECTS_ID || (preferredProjectId === LOCAL_PROJECT_ID && hasLegacyTasks) || projects.some((project) => project.id === preferredProjectId)
    ? preferredProjectId
    : null
  const isActiveProjectRecord = (projectId?: string) => {
    if (activeProjectId === null || activeProjectId === ALL_PROJECTS_ID) return true
    if (activeProjectId === LOCAL_PROJECT_ID) return !projectId
    return projectId === activeProjectId
  }
  useStore.setState({ projects, projectsLoaded: true, activeProjectId })
  let loadedAgentConversations = mergeAgentConversationsForStorage(storedAgentConversations, legacyAgentConversations)
  const currentAgentConversations = normalizeAgentConversations(useStore.getState().agentConversations)
  loadedAgentConversations = mergeAgentConversationsForStorage(loadedAgentConversations, currentAgentConversations)
  const activeAgentConversationId = useStore.getState().activeAgentConversationId && loadedAgentConversations.some((conversation) => conversation.id === useStore.getState().activeAgentConversationId)
    ? useStore.getState().activeAgentConversationId
    : loadedAgentConversations[0]?.id ?? null
  if (loadedAgentConversations.length > 0 || legacyAgentConversations.length > 0) {
    useStore.setState((state) => {
      const agentInputDrafts = cleanStaleAgentInputDrafts(
        normalizeAgentInputDrafts(state.agentInputDrafts, loadedAgentConversations),
        activeAgentConversationId,
      )
      return {
        agentConversations: loadedAgentConversations,
        agentConversationsLoaded: true,
        activeAgentConversationId,
        agentInputDrafts,
        ...(state.appMode === 'agent' ? restoreAgentInputDraftState(agentInputDrafts, activeAgentConversationId) : {}),
      }
    })
    await replaceStoredAgentConversations(loadedAgentConversations)
  } else {
    useStore.setState({ agentConversationsLoaded: true })
  }
  const shouldRewritePersistedLocalState = agentConversationMigrationPending
  agentConversationPersistenceReady = true
  agentConversationMigrationPending = false
  if (agentConversationPersistQueued || useStore.getState().agentConversations !== lastStoredAgentConversations) {
    await flushAgentConversationsToIndexedDB()
  }
  if (shouldRewritePersistedLocalState) {
    useStore.setState({})
  }
  const { tasks: markedTasks, interruptedTasks } = markInterruptedOpenAIRunningTasks(storedTasks)
  for (const task of interruptedTasks) {
    console.warn('[Store] 任务被标记为“请求中断”', {
      taskId: task.id,
      apiProvider: task.apiProvider ?? 'openai',
      reason: '应用重新初始化时任务仍处于运行中，但没有可恢复的远程请求标识，前端无法继续等待原请求',
    })
  }
  const interruptedTaskIds = new Set(interruptedTasks.map((task) => task.id))
  const favoriteState = useStore.getState()
  const favoriteCollections = ensureProjectFavoriteCollections(
    ensureDefaultFavoriteCollection(normalizeFavoriteCollections([...importedFavoriteCollections, ...favoriteState.favoriteCollections])),
    projects,
  )
  const defaultFavoriteCollectionId = favoriteState.defaultFavoriteCollectionId
  const projectsWithFavoriteDefaults = projects.map((project) => {
    if (project.defaultFavoriteCollectionId !== undefined) return project
    const id = resolveDefaultFavoriteCollectionId(
      getFavoriteCollectionsForProject(favoriteCollections, project.id),
      defaultFavoriteCollectionId,
    )
    return { ...project, defaultFavoriteCollectionId: id }
  })
  if (projectsWithFavoriteDefaults.some((project, index) => project !== projects[index])) {
    projects = projectsWithFavoriteDefaults
    useStore.setState({ projects })
    for (const project of projects) queueProjectSave(project)
  }
  const normalizedFavorites = normalizeLoadedFavoriteState(markedTasks.map(getPersistableTask), favoriteCollections, defaultFavoriteCollectionId)
  const tasks = normalizedFavorites.tasks
  if (normalizedFavorites.collections !== favoriteState.favoriteCollections) {
    favoriteState.setFavoriteCollections(normalizedFavorites.collections)
  }
  if (normalizedFavorites.defaultFavoriteCollectionId !== favoriteState.defaultFavoriteCollectionId) {
    useStore.getState().setDefaultFavoriteCollectionId(normalizedFavorites.defaultFavoriteCollectionId)
  }
  await Promise.all(tasks
    .filter((task, index) => normalizedFavorites.changed || interruptedTaskIds.has(task.id) || task.rawResponsePayload !== markedTasks[index]?.rawResponsePayload)
    .map((task) => putTask(task)))
  useStore.getState().setTasks(tasks)
  onlineProjectCacheReady = true
  const projectsToSync = new Set([
    ...projects.filter((project) => project.syncPending && isActiveProjectRecord(project.id)).map((project) => project.id),
    ...interruptedTasks.filter((task) => isActiveProjectRecord(task.projectId)).map((task) => task.projectId).filter((id): id is string => Boolean(id)),
  ])
  for (const projectId of projectsToSync) scheduleOnlineProjectSync(projectId, 0)
  const recoveredAgentConversations = recoverAgentConversationsForImageStatus(useStore.getState().agentConversations, tasks)
  if (recoveredAgentConversations !== useStore.getState().agentConversations) {
    useStore.setState({ agentConversations: recoveredAgentConversations })
  }
  syncAgentConversationsFromTerminalImageStatusTasks(tasks)
  showSupportPromptForExistingLocalData(tasks)
  const agentRoundRequestIds = new Set(
    useStore.getState().agentConversations.flatMap((conversation) =>
      conversation.rounds.flatMap((round) => round.imageStatusRequestIds ?? []),
    ),
  )
  for (const task of tasks) {
    if (!isActiveProjectRecord(task.projectId)) continue
    if (
      task.apiProvider === 'fal' &&
      task.falRequestId &&
      task.falEndpoint &&
      (task.status === 'running' || task.falRecoverable)
    ) {
      scheduleFalRecovery(task.id, 0)
    }
    if (
      task.customTaskId &&
      (task.status === 'running' || task.customRecoverable)
    ) {
      scheduleCustomRecovery(task.id, 0)
    }
    if (
      task.compositeRequestId &&
      (task.status === 'running' || task.compositeRecoverable)
    ) {
      scheduleCompositeRecovery(task.id, 0)
    }
    if (
      shouldScheduleTaskImageStatusRecovery(task, agentRoundRequestIds)
    ) {
      scheduleImageStatusRecovery(task.id, 0)
    }
  }
  for (const conversation of useStore.getState().agentConversations) {
    if (!isActiveProjectRecord(conversation.projectId)) continue
    for (const round of conversation.rounds) {
      if (shouldScheduleAgentRoundImageStatusRecovery(conversation.id, round, tasks)) {
        scheduleAgentImageStatusRecovery(conversation.id, round.id, 0)
      }
    }
  }

  // 收集所有任务引用的图片 id
  const referencedIds = new Set<string>()
  const state = useStore.getState()
  const persistedInputImages = state.inputImages
  const galleryInputDraft = state.galleryInputDraft
  const agentConversations = state.agentConversations
  const agentInputDrafts = state.agentInputDrafts
  for (const img of persistedInputImages) referencedIds.add(img.id)
  if (galleryInputDraft) {
    for (const img of galleryInputDraft.inputImages) referencedIds.add(img.id)
  }
  for (const draft of Object.values(agentInputDrafts)) {
    for (const img of draft.inputImages) referencedIds.add(img.id)
  }
  for (const conversation of agentConversations) {
    for (const round of conversation.rounds) {
      for (const id of round.inputImageIds) referencedIds.add(id)
    }
  }
  for (const t of tasks) {
    addTaskReferencedImageIds(referencedIds, t)
  }

  // 只枚举 key 清理孤立图片，避免启动时把所有 4K 原图读进内存。
  const imageIds = await getAllImageIds()
  const referencedImageIds: string[] = []
  for (const imgId of imageIds) {
    if (referencedIds.has(imgId)) {
      referencedImageIds.push(imgId)
    } else {
      await deleteImage(imgId)
    }
  }
  scheduleThumbnailBackfill(referencedImageIds)

  const restoredInputImages: InputImage[] = []
  for (const img of persistedInputImages) {
    if (img.dataUrl) {
      restoredInputImages.push(img)
      cacheImage(img.id, img.dataUrl)
      continue
    }
    const storedImage = await getImage(img.id)
    if (storedImage?.dataUrl) {
      restoredInputImages.push({ ...img, dataUrl: storedImage.dataUrl })
      cacheImage(img.id, storedImage.dataUrl)
    }
  }
  if (restoredInputImages.length !== persistedInputImages.length || restoredInputImages.some((img, index) => img.dataUrl !== persistedInputImages[index]?.dataUrl)) {
    useStore.getState().setInputImages(restoredInputImages)
  }

  if (galleryInputDraft) {
    const restoredGalleryImages: InputImage[] = []
    for (const img of galleryInputDraft.inputImages) {
      if (img.dataUrl) {
        restoredGalleryImages.push(img)
        cacheImage(img.id, img.dataUrl)
        continue
      }
      const storedImage = await getImage(img.id)
      if (storedImage?.dataUrl) {
        restoredGalleryImages.push({ ...img, dataUrl: storedImage.dataUrl })
        cacheImage(img.id, storedImage.dataUrl)
      }
    }
    const shouldClearMask = Boolean(galleryInputDraft.maskDraft) && !restoredGalleryImages.some((img) => img.id === galleryInputDraft.maskDraft?.targetImageId)
    const restoredGalleryDraft: AgentInputDraft = {
      ...galleryInputDraft,
      inputImages: restoredGalleryImages,
      prompt: remapImageMentionsForOrder(galleryInputDraft.prompt, galleryInputDraft.inputImages, restoredGalleryImages),
      ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
    }
    const galleryDraftsChanged =
      restoredGalleryImages.length !== galleryInputDraft.inputImages.length ||
      restoredGalleryImages.some((img, index) => img.dataUrl !== galleryInputDraft.inputImages[index]?.dataUrl) ||
      shouldClearMask
    if (galleryDraftsChanged) {
      const latestState = useStore.getState()
      const nextGalleryInputDraft = isEmptyAgentInputDraft(restoredGalleryDraft) ? null : restoredGalleryDraft
      useStore.setState({
        galleryInputDraft: nextGalleryInputDraft,
        ...(latestState.appMode === 'gallery'
          ? restoreGalleryInputDraftState(nextGalleryInputDraft)
          : {}),
      })
    }
  }

  const restoredAgentInputDrafts: Record<string, AgentInputDraft> = {}
  let agentDraftsChanged = false
  for (const [conversationId, draft] of Object.entries(agentInputDrafts)) {
    const restoredDraftImages: InputImage[] = []
    for (const img of draft.inputImages) {
      if (img.dataUrl) {
        restoredDraftImages.push(img)
        cacheImage(img.id, img.dataUrl)
        continue
      }
      const storedImage = await getImage(img.id)
      if (storedImage?.dataUrl) {
        restoredDraftImages.push({ ...img, dataUrl: storedImage.dataUrl })
        cacheImage(img.id, storedImage.dataUrl)
      }
    }

    const shouldClearMask = Boolean(draft.maskDraft) && !restoredDraftImages.some((img) => img.id === draft.maskDraft?.targetImageId)
    const restoredDraft: AgentInputDraft = {
      ...draft,
      inputImages: restoredDraftImages,
      prompt: remapImageMentionsForOrder(draft.prompt, draft.inputImages, restoredDraftImages),
      ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
    }
    if (!isEmptyAgentInputDraft(restoredDraft)) restoredAgentInputDrafts[conversationId] = restoredDraft
    if (
      restoredDraftImages.length !== draft.inputImages.length ||
      restoredDraftImages.some((img, index) => img.dataUrl !== draft.inputImages[index]?.dataUrl) ||
      shouldClearMask
    ) {
      agentDraftsChanged = true
    }
  }
  if (agentDraftsChanged) {
    const latestState = useStore.getState()
    useStore.setState({
      agentInputDrafts: restoredAgentInputDrafts,
      ...(latestState.appMode === 'agent'
        ? restoreAgentInputDraftState(restoredAgentInputDrafts, latestState.activeAgentConversationId)
        : {}),
    })
  }
}

/** 提交新任务 */
export async function submitTask(options: { allowFullMask?: boolean; useCurrentApiProfileWhenReusedMissing?: boolean; apiOverride?: ApiOverride } = {}) {
  const { settings, prompt, inputImages, maskDraft, params, reusedTaskApiProfileId, reusedTaskApiProfileName, reusedTaskApiProfileMissing, oidcApiOverride, showToast, setConfirmDialog } =
    useStore.getState()
  const apiOverride = options.apiOverride ?? oidcApiOverride ?? undefined

  const normalizedSettings = normalizeSettings(settings)
  let activeProfile = getActiveApiProfile(settings)
  let requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  if (normalizedSettings.reuseTaskApiProfileTemporarily && (reusedTaskApiProfileId || reusedTaskApiProfileMissing)) {
    const reusedProfile = getReusedTaskApiProfile(normalizedSettings, reusedTaskApiProfileId)
    if (!reusedProfile) {
      if (options.useCurrentApiProfileWhenReusedMissing) {
        useStore.getState().setReusedTaskApiProfile(null)
      } else {
        setConfirmDialog({
          title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${reusedTaskApiProfileName || '未知配置'}」，要使用当前的 API 配置「${activeProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ ...options, useCurrentApiProfileWhenReusedMissing: true })
      },
        })
        return
      }
    } else {
      activeProfile = reusedProfile
      requestSettings = createSettingsForApiProfile(normalizedSettings, reusedProfile)
    }
  }

  activeProfile = { ...activeProfile, apiMode: 'images' }
  requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  if (validateApiProfile(activeProfile)) {
    // 若调用方提供了 apiKey/model 覆盖（例如 InputBar 中选择的 OIDC apiKey 与模型），
    // 则在校验时忽略对应字段缺失的问题。
    const validationMsg = validateApiProfile(activeProfile)
    const ignorable = (() => {
      if (!validationMsg) return true
      if (validationMsg === '缺少 API Key' && apiOverride?.apiKey) return true
      if (validationMsg === '缺少模型 ID' && apiOverride?.model) return true
      return false
    })()
    if (!ignorable) {
      showToast(validationMsg === '缺少 API Key' ? '请先选择 API Key' : `请求配置不可用：${validationMsg}`, 'error')
      return
    }
  }

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void submitTask({ allowFullMask: true })
          },
        })
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  // 持久化输入图片到 IndexedDB（此前只在内存缓存中）
  for (const img of orderedInputImages) {
    if (apiOverride?.platform?.trim().toLowerCase() === 'composite' && /^https?:\/\//i.test(img.dataUrl)) {
      await storeImageReference(img.id, img.dataUrl)
      continue
    }
    await storeImage(img.dataUrl, 'upload', { preferredId: img.id })
  }

  const normalizedParams = normalizeParamsForSettings(params, requestSettings, { hasInputImages: orderedInputImages.length > 0 })
  const shouldUseTransparentOutput = normalizedParams.output_format === 'png' && normalizedParams.transparent_output
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const transparentMeta = taskParams.transparent_output
    ? createTransparentOutputMeta(prompt.trim())
    : null
  const normalizedParamPatch = getChangedParams(params, taskParams)
  if (Object.keys(normalizedParamPatch).length) {
    useStore.getState().setParams(normalizedParamPatch)
  }

  const taskId = genId()
  const projectId = getActiveTaskProjectId() ?? useStore.getState().createProject(prompt.trim(), { autoRecord: true })
  const task: TaskRecord = {
    id: taskId,
    requestId: createRequestId(),
    ...(projectId ? { projectId } : {}),
    prompt: prompt.trim(),
    params: taskParams,
    apiProvider: activeProfile.provider,
    apiProfileId: activeProfile.id,
    apiProfileName: activeProfile.name,
    apiMode: activeProfile.apiMode,
    apiModel: apiOverride?.model || activeProfile.model,
    ...(apiOverride && (apiOverride.apiKey || apiOverride.model)
      ? { apiOverride: { ...apiOverride } }
      : {}),
    inputImageIds: orderedInputImages.map((i) => i.id),
    maskTargetImageId,
    maskImageId,
    transparentOutput: transparentMeta?.transparentOutput,
    transparentPrompt: transparentMeta?.effectivePrompt,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([task, ...latestTasks])
  await putTask(task, !isBackendManagedGenerationTask(task))
  touchProject(projectId, false)
  useStore.getState().showToast('任务已提交', 'success')

  if (settings.clearInputAfterSubmit) {
    useStore.getState().setPrompt('')
    useStore.getState().clearInputImages()
  }
  useStore.getState().setReusedTaskApiProfile(null)

  // 异步调用 API
  executeTask(taskId)
}

function getActiveAgentConversation(): AgentConversation {
  const state = useStore.getState()
  const existing = state.agentConversations.find((conversation) => conversation.id === state.activeAgentConversationId)
  if (existing) return existing

  const id = state.createAgentConversation()
  return useStore.getState().agentConversations.find((conversation) => conversation.id === id)!
}

function updateAgentConversation(conversationId: string, updater: (conversation: AgentConversation) => AgentConversation) {
  useStore.setState((state) => ({
    agentConversations: state.agentConversations.map((conversation) =>
      conversation.id === conversationId ? updater(conversation) : conversation,
    ),
  }))
}

function getAgentRoundControllerKey(conversationId: string, roundId: string) {
  return `${conversationId}:${roundId}`
}

function createAgentAbortError() {
  return new DOMException('Agent 请求已停止', 'AbortError')
}

function appendAgentStoppedMessage(content: string) {
  const trimmed = content.trimEnd()
  if (!trimmed) return AGENT_STOPPED_MESSAGE
  if (trimmed.endsWith(AGENT_STOPPED_MESSAGE)) return trimmed
  return `${trimmed}\n\n${AGENT_STOPPED_MESSAGE}`
}

function cancelAgentRoundStatusRecovery(conversationId: string, roundId: string) {
  clearAgentImageStatusRecoveryTimer(conversationId, roundId)
  for (const task of useStore.getState().tasks) {
    if (task.agentConversationId === conversationId && task.agentRoundId === roundId) {
      clearImageStatusRecoveryTimer(task.id)
    }
  }
}

function markAgentRoundTasksStopped(conversationId: string, roundId: string, now = Date.now()) {
  const runningTasks = useStore.getState().tasks.filter((task) =>
    task.status === 'running' &&
    task.agentConversationId === conversationId &&
    task.agentRoundId === roundId,
  )

  for (const task of runningTasks) {
    updateTaskInStore(task.id, {
      status: 'error',
      error: AGENT_STOPPED_MESSAGE,
      falRecoverable: false,
      customRecoverable: false,
      imageStatusRecoverable: false,
      finishedAt: now,
      elapsed: Math.max(0, now - task.createdAt),
    })
  }
  return runningTasks.length > 0
}

function markAgentRoundTasksFailed(
  conversationId: string,
  roundId: string,
  error: string,
  rawResponsePayload?: string,
  shouldFailTask: (task: TaskRecord) => boolean = () => true,
  now = Date.now(),
) {
  const runningTasks = useStore.getState().tasks.filter((task) =>
    task.status === 'running' &&
    task.agentConversationId === conversationId &&
    task.agentRoundId === roundId &&
    shouldFailTask(task),
  )

  for (const task of runningTasks) {
    useStore.getState().setTaskStreamPreview(task.id)
    updateTaskInStore(task.id, {
      status: 'error',
      error,
      ...(rawResponsePayload ? { rawResponsePayload } : {}),
      falRecoverable: false,
      customRecoverable: false,
      imageStatusRecoverable: false,
      finishedAt: now,
      elapsed: Math.max(0, now - task.createdAt),
    })
  }
  return runningTasks.length > 0
}

function markAgentRoundStopped(conversationId: string, roundId: string) {
  const now = Date.now()
  cancelAgentRoundStatusRecovery(conversationId, roundId)
  const stoppedTasks = markAgentRoundTasksStopped(conversationId, roundId, now)
  let stoppedRound = false
  updateAgentConversation(conversationId, (current) => {
    const round = current.rounds.find((item) => item.id === roundId)
    if (!round || round.status !== 'running') return current

    stoppedRound = true
    const existingAssistantMessage = current.messages.find((message) => message.roundId === roundId && message.role === 'assistant')
    const assistantMessageId = existingAssistantMessage?.id ?? genId()
    return {
      ...current,
      updatedAt: now,
      rounds: current.rounds.map((item) =>
        item.id === roundId
          ? {
              ...item,
              ...(assistantMessageId ? { assistantMessageId } : {}),
              status: 'error',
              error: AGENT_STOPPED_MESSAGE,
              imageStatusRecoverable: false,
              finishedAt: now,
            }
          : item,
      ),
      messages: existingAssistantMessage
        ? current.messages.map((message) =>
            message.id === existingAssistantMessage.id
              ? { ...message, content: appendAgentStoppedMessage(message.content) }
              : message,
          )
        : [
            ...current.messages,
            {
              id: assistantMessageId,
              role: 'assistant',
              content: AGENT_STOPPED_MESSAGE,
              roundId,
              createdAt: now,
            },
          ],
    }
  })
  return stoppedRound || stoppedTasks
}

function appendAgentAssistantMessageContent(conversationId: string, messageId: string, delta: string) {
  if (!delta) return
  updateAgentConversation(conversationId, (current) => ({
    ...current,
    updatedAt: Date.now(),
    messages: current.messages.map((message) =>
      message.id === messageId
        ? { ...message, content: `${message.content}${delta}` }
        : message,
    ),
  }))
}

function ensureAgentAssistantMessage(conversationId: string, roundId: string, messageId: string, now = Date.now()) {
  updateAgentConversation(conversationId, (current) => ({
    ...current,
    updatedAt: now,
    rounds: current.rounds.map((round) =>
      round.id === roundId ? { ...round, assistantMessageId: messageId } : round,
    ),
    messages: current.messages.some((message) => message.id === messageId)
      ? current.messages
      : [
          ...current.messages,
          {
            id: messageId,
            role: 'assistant',
            content: '',
            roundId,
            createdAt: now,
          },
        ],
  }))
}

async function generateAgentConversationTitle(
  conversationId: string,
  prompt: string,
  inputImageIds: string[],
  requestSettings: AppSettings,
  activeProfile: ApiProfile,
  fallbackTitle: string,
) {
  useStore.setState((state) => {
    const next = { ...state.agentGeneratingTitleIds, [conversationId]: true as const }
    return { agentGeneratingTitleIds: next }
  })
  try {
    const imageDataUrls = await readAgentImageDataUrls(inputImageIds)
    const title = await callAgentConversationTitleApi({
      settings: requestSettings,
      profile: activeProfile,
      prompt,
      imageDataUrls,
    })
    if (!title || title === fallbackTitle) return

    updateAgentConversation(conversationId, (current) => {
      const firstRound = current.rounds[0]
      if (!firstRound || firstRound.prompt !== prompt || current.title !== fallbackTitle) return current
      return { ...current, title, updatedAt: Date.now() }
    })
  } catch {
    // Title generation is best-effort; keep the local fallback title on failure.
  } finally {
    useStore.setState((state) => {
      const next = { ...state.agentGeneratingTitleIds }
      delete next[conversationId]
      return { agentGeneratingTitleIds: next }
    })
  }
}

export function stopAgentResponse(conversationId = useStore.getState().activeAgentConversationId) {
  if (!conversationId) return
  const conversation = useStore.getState().agentConversations.find((item) => item.id === conversationId)
  if (!conversation) return
  const activeRunningRound = [...getActiveAgentRounds(conversation)].reverse().find((round) => round.status === 'running')
  const runningRound = activeRunningRound ?? conversation.rounds.find((round) => round.status === 'running')
  if (!runningRound) return

  const controller = agentRoundControllers.get(getAgentRoundControllerKey(conversationId, runningRound.id))
  if (controller) {
    controller.abort()
    if (markAgentRoundStopped(conversationId, runningRound.id)) {
      useStore.getState().showToast('已停止生成', 'info')
    }
    return
  }

  markAgentRoundStopped(conversationId, runningRound.id)
  useStore.getState().showToast('已停止生成', 'info')
}

function getAgentRoundChildren(conversation: AgentConversation, parentRoundId: string | null) {
  return conversation.rounds.filter((round) => (round.parentRoundId ?? null) === parentRoundId)
}

function getLatestAgentLeafId(conversation: AgentConversation, startRoundId: string | null = null): string | null {
  let currentId = startRoundId
  if (!currentId) {
    const roots = getAgentRoundChildren(conversation, null)
    currentId = roots[roots.length - 1]?.id ?? null
  }

  while (currentId) {
    const children = getAgentRoundChildren(conversation, currentId)
    const nextId = children[children.length - 1]?.id ?? null
    if (!nextId) return currentId
    currentId = nextId
  }

  return null
}

export function getAgentRoundPath(conversation: AgentConversation, roundId: string | null): AgentRound[] {
  if (!roundId) return []
  const byId = new Map(conversation.rounds.map((round) => [round.id, round]))
  const path: AgentRound[] = []
  const seen = new Set<string>()
  let current = byId.get(roundId) ?? null

  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current)
    current = current.parentRoundId ? byId.get(current.parentRoundId) ?? null : null
  }

  return path
}

export function getActiveAgentRounds(conversation: AgentConversation): AgentRound[] {
  const activeRoundId = conversation.activeRoundId && conversation.rounds.some((round) => round.id === conversation.activeRoundId)
    ? conversation.activeRoundId
    : getLatestAgentLeafId(conversation)
  return getAgentRoundPath(conversation, activeRoundId ?? null)
}

function reindexAgentRounds(conversation: AgentConversation): AgentConversation {
  const indexById = new Map<string, number>()
  const visit = (parentRoundId: string | null, depth: number) => {
    for (const child of getAgentRoundChildren(conversation, parentRoundId)) {
      indexById.set(child.id, depth)
      visit(child.id, depth + 1)
    }
  }
  visit(null, 1)
  return {
    ...conversation,
    rounds: conversation.rounds.map((round) => ({
      ...round,
      index: indexById.get(round.id) ?? round.index,
    })),
  }
}

export function remapAgentRoundMentionsForPathChange(content: string, oldPath: AgentRound[], newPath: AgentRound[]) {
  if (!content || oldPath.length === 0) return content
  const newIndexByRoundId = new Map(newPath.map((round, index) => [round.id, index + 1]))
  return content.replace(AGENT_ROUND_IMAGE_MENTION_RE, (match, roundNumber: string, imageNumber: string) => {
    const oldRound = oldPath[Number(roundNumber) - 1]
    if (!oldRound) return match
    const newRoundIndex = newIndexByRoundId.get(oldRound.id)
    if (!newRoundIndex) return `@已删除轮次图${imageNumber}`
    return `@第${newRoundIndex}轮图${imageNumber}`
  })
}

export function deleteAgentRoundFromConversation(conversation: AgentConversation, roundId: string, now = Date.now()): AgentConversation {
  const targetRound = conversation.rounds.find((round) => round.id === roundId)
  if (!targetRound) return conversation

  const oldPathByRoundId = new Map(conversation.rounds.map((round) => [round.id, getAgentRoundPath(conversation, round.id)]))
  const rounds = conversation.rounds
    .filter((candidate) => candidate.id !== roundId)
    .map((candidate) =>
      candidate.parentRoundId === roundId
        ? { ...candidate, parentRoundId: targetRound.parentRoundId ?? null }
        : candidate,
    )
  const messages = conversation.messages.filter((candidate) => candidate.roundId !== roundId)
  const nextConversation = reindexAgentRounds({
    ...conversation,
    rounds,
    messages,
    activeRoundId: conversation.activeRoundId === roundId ? null : conversation.activeRoundId ?? null,
  })
  const newPathByRoundId = new Map(nextConversation.rounds.map((round) => [round.id, getAgentRoundPath(nextConversation, round.id)]))
  const remappedMessages = nextConversation.messages.map((message) => {
    if (!message.roundId) return message
    const oldPath = oldPathByRoundId.get(message.roundId) ?? []
    const newPath = newPathByRoundId.get(message.roundId) ?? []
    const content = remapAgentRoundMentionsForPathChange(message.content, oldPath, newPath)
    return content === message.content ? message : { ...message, content }
  })
  const withRemappedMessages = { ...nextConversation, messages: remappedMessages }
  const activeRounds = getActiveAgentRounds(withRemappedMessages)
  return {
    ...withRemappedMessages,
    activeRoundId: withRemappedMessages.activeRoundId ?? activeRounds[activeRounds.length - 1]?.id ?? null,
    updatedAt: now,
  }
}

export function getAgentSiblingRounds(conversation: AgentConversation, round: AgentRound) {
  return getAgentRoundChildren(conversation, round.parentRoundId ?? null)
}

export function getAgentBranchLeafId(conversation: AgentConversation, roundId: string) {
  return getLatestAgentLeafId(conversation, roundId) ?? roundId
}

function uniqueIds(ids: string[]) {
  return Array.from(new Set(ids.filter(Boolean)))
}

function arraysEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function addAgentReferencedImageIds(target: Set<string>, conversations = useStore.getState().agentConversations, inputDrafts = useStore.getState().agentInputDrafts) {
  for (const conversation of conversations) {
    for (const round of conversation.rounds) {
      for (const id of round.inputImageIds) target.add(id)
      if (round.maskImageId) target.add(round.maskImageId)
    }
    for (const message of conversation.messages) {
      if (message.maskImageId) target.add(message.maskImageId)
    }
  }
  for (const draft of Object.values(inputDrafts)) {
    for (const img of draft.inputImages) target.add(img.id)
  }
}

function addInputDraftReferencedImageIds(target: Set<string>, draft: AgentInputDraft | null) {
  if (!draft) return
  for (const img of draft.inputImages) target.add(img.id)
}

function addTaskReferencedImageIds(target: Set<string>, task: TaskRecord) {
  for (const id of task.inputImageIds || []) target.add(id)
  if (task.maskImageId) target.add(task.maskImageId)
  for (const id of task.outputImages || []) target.add(id)
  for (const id of task.transparentOriginalImages || []) {
    if (id) target.add(id)
  }
  for (const id of task.streamPartialImageIds || []) target.add(id)
}

async function storeTaskOutputImages(task: TaskRecord, images: string[], options: { alreadyStoredOnline?: boolean } = {}) {
  const outputIds: string[] = []
  const outputDataUrls: string[] = []
  const outputImageSizes: Array<{ width?: number; height?: number }> = []
  const transparentOriginalImageIds: string[] = []
  const storedImageIds: string[] = []
  const storedProjectImages: StoredImage[] = []
  const state = useStore.getState()
  const canvasProjectId = task.projectId ?? LOCAL_PROJECT_ID
  const project = state.projects.find((item) => item.id === canvasProjectId)
  const reservedIds = new Set([
    ...Object.keys(project?.canvas?.items ?? {}),
    ...Object.keys(state.projectCanvasCache[canvasProjectId]?.items ?? {}),
  ])

  try {
    for (const dataUrl of images) {
      let outputDataUrl = dataUrl
      if (task.transparentOutput) {
        const original = await storeImageWithSize(dataUrl, 'generated', { reservedIds })
        reservedIds.add(original.id)
        storedImageIds.push(original.id)
        storedProjectImages.push({ ...original, dataUrl, source: 'generated' })
        cacheImage(original.id, dataUrl)

        try {
          outputDataUrl = await removeKeyedBackgroundFromDataUrl(dataUrl)
          transparentOriginalImageIds.push(original.id)
        } catch (err) {
          console.warn('透明背景后处理失败，已回退为原始输出', err)
          outputIds.push(original.id)
          outputDataUrls.push(dataUrl)
          outputImageSizes.push(original)
          transparentOriginalImageIds.push('')
          continue
        }
      }

      const stored = await storeImageWithSize(outputDataUrl, 'generated', { reservedIds })
      reservedIds.add(stored.id)
      storedImageIds.push(stored.id)
      storedProjectImages.push({ ...stored, dataUrl: outputDataUrl, source: 'generated' })
      cacheImage(stored.id, outputDataUrl)
      outputIds.push(stored.id)
      outputDataUrls.push(outputDataUrl)
      outputImageSizes.push(stored)
    }

    if (!options.alreadyStoredOnline) await uploadGeneratedProjectImages(task, storedProjectImages)
    return {
      outputIds,
      outputDataUrls,
      outputImageSizes,
      transparentOriginalImageIds: transparentOriginalImageIds.length ? transparentOriginalImageIds : undefined,
    }
  } catch (err) {
    await deleteUnreferencedImageIds(storedImageIds)
    throw err
  }
}

async function deleteUnreferencedImageIds(imageIds: Iterable<string>) {
  const candidates = Array.from(new Set(Array.from(imageIds).filter(Boolean)))
  if (candidates.length === 0) return

  const { tasks, inputImages, galleryInputDraft } = useStore.getState()
  const stillUsed = new Set<string>()
  for (const task of tasks) addTaskReferencedImageIds(stillUsed, task)
  addAgentReferencedImageIds(stillUsed)
  addInputDraftReferencedImageIds(stillUsed, galleryInputDraft)
  for (const img of inputImages) stillUsed.add(img.id)

  for (const imgId of candidates) {
    if (stillUsed.has(imgId)) continue
    await deleteImage(imgId)
    imageCache.delete(imgId)
    thumbnailCache.delete(imgId)
  }
}

async function persistTaskStreamPartialImage(taskId: string, dataUrl: string) {
  try {
    const imgId = await storeImage(dataUrl, 'generated')
    cacheImage(imgId, dataUrl)

    const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
    if (!latestTask || latestTask.status === 'done') {
      await deleteUnreferencedImageIds([imgId])
      return
    }

    const currentIds = latestTask.streamPartialImageIds || []
    if (currentIds.includes(imgId)) return
    updateTaskInStore(taskId, { streamPartialImageIds: [...currentIds, imgId] })
    await uploadGeneratedProjectImages(latestTask, [{ id: imgId, dataUrl, source: 'generated' }])
  } catch (err) {
    console.error(err)
  }
}

async function readAgentImageDataUrls(ids: string[]) {
  const dataUrls: string[] = []
  for (const id of ids) {
    const dataUrl = await ensureImageCached(id)
    if (dataUrl) dataUrls.push(dataUrl)
  }
  return dataUrls
}

async function createAgentUserInputItem(conversation: AgentConversation, round: AgentRound, message: AgentMessage, tasks: TaskRecord[]) {
  const imageDataUrls = await readAgentImageDataUrls(round.inputImageIds)
  const rounds = getAgentRoundPath(conversation, round.id)
  const text = replaceAgentPromptImageReferencesForApi(message.content, round, rounds, tasks)
  const referenceText = round.inputImageIds.length > 0
    ? `\n\n<available_refs>${round.inputImageIds.map((_, index) => `\n  <ref id="${getAgentCurrentReferenceId(round, index)}" />`).join('')}\n</available_refs>`
    : ''
  return {
    role: 'user',
    content: [
      { type: 'input_text', text: `${text}${referenceText}` },
      ...imageDataUrls.map((dataUrl) => ({ type: 'input_image', image_url: dataUrl })),
    ],
  }
}

async function createAgentGeneratedImagesInputItem(round: AgentRound, tasks: TaskRecord[]) {
  const contentParts: Array<{ type: string; text?: string; image_url?: string }> = []
  let imageIndex = 0
  for (const taskId of round.outputTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    if (!task) {
      contentParts.push({ type: 'input_text', text: `<removed_ref id="${getAgentGeneratedImageReferenceId(round, imageIndex)}" />` })
      imageIndex += 1
      continue
    }
    for (const imageId of getTaskOutputImageSlots(task)) {
      const refId = getAgentGeneratedImageReferenceId(round, imageIndex)
      if (!imageId) {
        contentParts.push({ type: 'input_text', text: `<removed_ref id="${refId}" />` })
        imageIndex += 1
        continue
      }
      const dataUrl = await ensureImageCached(imageId)
      if (dataUrl) {
        contentParts.push({ type: 'input_image', image_url: dataUrl })
      }
      const prompt = truncateAgentReferencePrompt(task.prompt || '')
      const promptAttribute = prompt ? ` prompt="${escapeXmlAttribute(prompt)}"` : ''
      contentParts.push({ type: 'input_text', text: `<ref id="${refId}"${promptAttribute} />` })
      imageIndex += 1
    }
  }
  if (contentParts.length === 0) return null
  return { role: 'user', content: contentParts }
}

async function createAgentBatchImagesInputItem(round: AgentRound, tasks: TaskRecord[], batchTaskIds: string[]) {
  const contentParts: Array<{ type: string; text?: string; image_url?: string }> = []
  // Count existing images in the round to compute correct imageIndex offset
  let baseImageIndex = 0
  for (const taskId of round.outputTaskIds) {
    if (batchTaskIds.includes(taskId)) break
    const task = tasks.find((item) => item.id === taskId)
    baseImageIndex += task ? getTaskOutputImageSlots(task).length : 1
  }
  let imageIndex = baseImageIndex
  for (const taskId of batchTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    if (!task || task.status !== 'done') continue
    for (const imgId of getTaskOutputImageSlots(task)) {
      const refId = getAgentGeneratedImageReferenceId(round, imageIndex)
      if (!imgId) {
        contentParts.push({ type: 'input_text', text: `<removed_ref id="${refId}" />` })
        imageIndex += 1
        continue
      }
      const dataUrl = await ensureImageCached(imgId)
      if (dataUrl) {
        contentParts.push({ type: 'input_image', image_url: dataUrl })
      }
      const prompt = truncateAgentReferencePrompt(task.prompt || '')
      const promptAttribute = prompt ? ` prompt="${escapeXmlAttribute(prompt)}"` : ''
      contentParts.push({ type: 'input_text', text: `<ref id="${refId}"${promptAttribute} />` })
      imageIndex += 1
    }
  }
  if (contentParts.length === 0) return null
  return { role: 'user', content: contentParts }
}

function escapeXmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function truncateAgentReferencePrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  return normalized.length > 1200 ? `${normalized.slice(0, 1200)}...` : normalized
}

function createAgentAssistantFallbackItem(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  }
}

function parseResponseOutputFromPayload(rawResponsePayload?: string): ResponsesOutputItem[] | null {
  if (!rawResponsePayload) return null
  try {
    const payload = JSON.parse(rawResponsePayload) as { output?: unknown }
    return Array.isArray(payload.output) ? payload.output as ResponsesOutputItem[] : null
  } catch {
    return null
  }
}

function sanitizeResponseOutputItemForInput(item: ResponsesOutputItem): unknown | null {
  if (item.type === 'web_search_call') return null
  if (item.type === 'image_generation_call') return null

  if (item.type === 'message') {
    const content = (item.content ?? [])
      .map((part) => {
        if (typeof part.text !== 'string') return null
        if (part.type === 'output_text' || part.type === 'text') {
          return { type: 'output_text', text: part.text }
        }
        return null
      })
      .filter((part): part is { type: 'output_text'; text: string } => Boolean(part))

    return content.length > 0 ? { role: 'assistant', content } : null
  }

  return item
}

function filterAgentRoundResponseOutputForInput(_round: AgentRound, _tasks: TaskRecord[], output: ResponsesOutputItem[]) {
  // image_generation_call items are now dropped by sanitizeResponseOutputItemForInput;
  // this filter is kept as a structural pass-through for future use.
  return output
}

function scrubResponseOutputForDeletedAgentTasks(round: AgentRound, output: ResponsesOutputItem[], deletedTasks: TaskRecord[]) {
  const deletedTaskIds = new Set(deletedTasks.map((task) => task.id))
  const deletedToolCallIds = new Set(
    deletedTasks
      .filter((task) => task.agentRoundId === round.id && task.agentToolCallId)
      .map((task) => task.agentToolCallId!),
  )
  if (deletedTaskIds.size === 0) return output

  let anonymousImageIndex = 0
  return output.filter((item) => {
    if (item.type !== 'image_generation_call') return true

    if (typeof item.id === 'string' && item.id) {
      return !deletedToolCallIds.has(item.id)
    }

    const taskId = round.outputTaskIds[anonymousImageIndex]
    anonymousImageIndex += 1
    return !deletedTaskIds.has(taskId)
  })
}

function scrubAgentConversationsForDeletedTasks(conversations: AgentConversation[], deletedTasks: TaskRecord[]) {
  if (deletedTasks.length === 0) return conversations

  return conversations.map((conversation) => ({
    ...conversation,
    rounds: conversation.rounds.map((round) => {
      const roundDeletedTasks = deletedTasks.filter((task) => round.outputTaskIds.includes(task.id))
      if (roundDeletedTasks.length === 0 || !round.responseOutput?.length) return round
      return {
        ...round,
        responseOutput: scrubResponseOutputForDeletedAgentTasks(round, round.responseOutput, roundDeletedTasks),
      }
    }),
  }))
}

function scrubTaskRawResponsePayloadForDeletedTasks(task: TaskRecord, conversations: AgentConversation[], deletedTasks: TaskRecord[]) {
  if (!task.rawResponsePayload || !task.agentRoundId) return task

  const round = conversations
    .flatMap((conversation) => conversation.rounds)
    .find((item) => item.id === task.agentRoundId)
  if (!round) return task

  const roundDeletedTasks = deletedTasks.filter((item) => round.outputTaskIds.includes(item.id))
  if (roundDeletedTasks.length === 0) return task

  try {
    const payload = JSON.parse(task.rawResponsePayload) as ResponsesApiResponse
    if (!Array.isArray(payload.output)) return task
    const output = scrubResponseOutputForDeletedAgentTasks(round, payload.output, roundDeletedTasks)
    if (output.length === payload.output.length) return task
    return { ...task, rawResponsePayload: JSON.stringify({ ...payload, output }, null, 2) }
  } catch {
    return task
  }
}

async function scrubAgentOutputPayloadsForDeletedTasks(deletedTasks: TaskRecord[], remainingTasks: TaskRecord[]) {
  if (deletedTasks.length === 0) return remainingTasks

  const conversations = scrubAgentConversationsForDeletedTasks(useStore.getState().agentConversations, deletedTasks)
  const scrubbedTasks = remainingTasks.map((task) => scrubTaskRawResponsePayloadForDeletedTasks(task, conversations, deletedTasks))
  useStore.setState({ agentConversations: conversations })

  for (const task of scrubbedTasks) {
    const previous = remainingTasks.find((item) => item.id === task.id)
    if (previous?.rawResponsePayload !== task.rawResponsePayload) await putTask(task)
  }

  return scrubbedTasks
}

function sanitizeResponseOutputForInput(output: ResponsesOutputItem[], options: { allowPendingFunctionCalls?: boolean } = {}) {
  const items = output
    .map(sanitizeResponseOutputItemForInput)
    .filter((item): item is unknown => item != null)
  if (options.allowPendingFunctionCalls) return items

  const functionCallIds = new Set<string>()
  const functionOutputCallIds = new Set<string>()
  for (const item of items) {
    if (!isRecord(item)) continue
    const callId = typeof item.call_id === 'string' ? item.call_id : ''
    if (!callId) continue
    if (item.type === 'function_call') functionCallIds.add(callId)
    if (item.type === 'function_call_output') functionOutputCallIds.add(callId)
  }

  return items.filter((item) => {
    if (!isRecord(item)) return true
    const callId = typeof item.call_id === 'string' ? item.call_id : ''
    if (item.type === 'function_call') return callId && functionOutputCallIds.has(callId)
    if (item.type === 'function_call_output') return callId && functionCallIds.has(callId)
    return true
  })
}

function mergeResponseOutputItems(previous: ResponsesOutputItem[], next: ResponsesOutputItem[]) {
  const merged = [...previous]
  for (const item of next) {
    const index = item.id ? merged.findIndex((existing) => existing.id === item.id) : -1
    if (index >= 0) merged[index] = item
    else merged.push(item)
  }
  return merged
}

function countResponseToolCalls(output: ResponsesOutputItem[]) {
  return output.filter((item) => item.type === 'image_generation_call').length
}

function createAgentContinuationInputItem(newImageRefs: string[], toolCallsUsed: number, maxToolCalls: number) {
  const lines = [
    '[System] The app has saved your generated outputs and is continuing the same Agent turn.',
  ]
  if (newImageRefs.length > 0) {
    lines.push(
      `The following image ref ids are now available for you to reference in subsequent image_generation prompts: ${newImageRefs.join(', ')}`,
    )
  }
  lines.push(
    'Continue generating. Do NOT repeat what you already said in earlier responses.',
    'If you still need another round after this (e.g. more dependent images), call continue_generation.',
    `Tool-call budget: ${toolCallsUsed}/${maxToolCalls} used.`,
  )
  return {
    role: 'user',
    content: [{
      type: 'input_text',
      text: lines.join('\n'),
    }],
  }
}

function buildAgentContinuationInput(baseInput: unknown[], round: AgentRound, tasks: TaskRecord[], currentRoundOutput: ResponsesOutputItem[], toolCallsUsed: number, maxToolCalls: number) {
  const input = [...baseInput, ...sanitizeResponseOutputForInput(currentRoundOutput, { allowPendingFunctionCalls: true })]
  const newImageRefs = collectAgentRoundOutputImageSlots(round, tasks)
    .map((imageId, index) => imageId ? `<ref id="${getAgentGeneratedImageReferenceId(round, index)}" />` : null)
    .filter((ref): ref is string => Boolean(ref))
  input.push(createAgentContinuationInputItem(newImageRefs, toolCallsUsed, maxToolCalls))
  return input
}

function getAgentRoundResponseOutput(round: AgentRound, tasks: TaskRecord[]): ResponsesOutputItem[] | null {
  if (round.responseOutput?.length) return round.responseOutput

  for (const taskId of round.outputTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    const output = parseResponseOutputFromPayload(task?.rawResponsePayload)
    if (output?.length) return output
  }

  return null
}

async function buildAgentApiInput(conversation: AgentConversation, currentRound: AgentRound, tasks: TaskRecord[]): Promise<unknown[]> {
  const input: unknown[] = []
  const rounds = getAgentRoundPath(conversation, currentRound.id)

  for (const round of rounds) {
    const userMessage = conversation.messages.find((message) => message.id === round.userMessageId)
    if (!userMessage) continue

    input.push(await createAgentUserInputItem(conversation, round, userMessage, tasks))
    if (round.id === currentRound.id) continue

    const output = getAgentRoundResponseOutput(round, tasks)
    if (output?.length) {
      const sanitizedOutput = sanitizeResponseOutputForInput(filterAgentRoundResponseOutputForInput(round, tasks, output))
      if (sanitizedOutput.length > 0) {
        input.push(...sanitizedOutput)
      } else {
        // All output items were filtered (e.g. only image_generation_call); add fallback
        const assistantMessage = round.assistantMessageId
          ? conversation.messages.find((message) => message.id === round.assistantMessageId)
          : null
        input.push(createAgentAssistantFallbackItem(
          assistantMessage?.content || '图像已生成。',
        ))
      }
    } else {
      const assistantMessage = round.assistantMessageId
        ? conversation.messages.find((message) => message.id === round.assistantMessageId)
        : null
      input.push(createAgentAssistantFallbackItem(
        assistantMessage?.content || '[No text response]',
      ))
    }

    // Inject generated images as a separate user message with input_image parts
    if (round.outputTaskIds.length > 0) {
      const imagesItem = await createAgentGeneratedImagesInputItem(round, tasks)
      if (imagesItem) input.push(imagesItem)
    }
  }

  return input
}

export async function submitAgentMessage() {
  const state = useStore.getState()
  const activeAgentDraft = state.appMode !== 'agent' && state.activeAgentConversationId
    ? state.agentInputDrafts[state.activeAgentConversationId]
    : null
  const { settings, params, showToast } = state
  const inputImages = activeAgentDraft?.inputImages ?? state.inputImages
  const maskDraft = activeAgentDraft?.maskDraft ?? state.maskDraft
  const prompt = activeAgentDraft?.prompt ?? state.prompt
  const projectId = getActiveTaskProjectId()
  const normalizedSettings = normalizeSettings(settings)

  const agentValidationError = getAgentProfileValidationError(normalizedSettings)
  if (agentValidationError) {
    showToast(agentValidationError.message.includes('缺少 API Key') ? '请先选择 API Key' : `Agent 请求配置不可用：${agentValidationError.message}`, 'error')
    return
  }

  // 合并 OIDC override，保证 agentApi.ts 里 createHeaders 拿得到 apiKey
  const activeProfile = { ...applyAgentOidcOverrideToProfile(getAgentTextApiProfile(normalizedSettings)!), apiMode: 'responses' as const }
  const imageProfile = applyAgentOidcOverrideToProfile(getAgentImageApiProfile(normalizedSettings)!)

  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) {
    showToast('请输入消息', 'error')
    return
  }

  const conversation = getActiveAgentConversation()
  if (projectId && conversation.projectId !== projectId) {
    updateAgentConversation(conversation.id, (current) => ({ ...current, projectId, updatedAt: Date.now() }))
  }
  if (conversation.rounds.some((round) => round.status === 'running')) {
    showToast('请等待生成完成，或先停止生成', 'info')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        state.clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  const inputImageIds = uniqueIds(orderedInputImages.map((image) => image.id))

  for (const image of orderedInputImages) {
    await storeImage(image.dataUrl, 'upload', { preferredId: image.id })
  }

  const requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  const now = Date.now()
  const editingRound = state.agentEditingRoundId
    ? conversation.rounds.find((item) => item.id === state.agentEditingRoundId) ?? null
    : null
  const editingRoundAssistantMessage = editingRound?.assistantMessageId
    ? conversation.messages.find((message) => message.id === editingRound.assistantMessageId) ?? null
    : conversation.messages.find((message) => message.roundId === editingRound?.id && message.role === 'assistant') ?? null
  const editingRoundHasAssistantMessage = Boolean(editingRoundAssistantMessage)
  const editingRoundHasErrorAssistantMessage = Boolean(
    editingRound?.status === 'error' && editingRoundAssistantMessage?.content.startsWith('请求失败：'),
  )
  const editingRoundHasChildren = editingRound
    ? conversation.rounds.some((round) => (round.parentRoundId ?? null) === editingRound.id)
    : false
  const shouldAppendToEditingRound = Boolean(
    editingRound && !editingRoundHasChildren && (!editingRoundHasAssistantMessage || editingRoundHasErrorAssistantMessage),
  )
  const roundId = shouldAppendToEditingRound && editingRound ? editingRound.id : genId()
  const userMessageId = shouldAppendToEditingRound && editingRound ? editingRound.userMessageId : genId()
  const activeRounds = getActiveAgentRounds(conversation)
  const activeLeafId = activeRounds[activeRounds.length - 1]?.id ?? null
  const parentRoundId = editingRound ? editingRound.parentRoundId ?? null : activeLeafId
  const parentPath = parentRoundId ? getAgentRoundPath(conversation, parentRoundId) : []
  const normalizedParams = {
    ...normalizeParamsForSettings(params, requestSettings, { hasInputImages: inputImageIds.length > 0 }),
    n: DEFAULT_PARAMS.n,
    transparent_output: false,
  }
  const round: AgentRound = {
    id: roundId,
    requestId: createRequestId(),
    index: shouldAppendToEditingRound && editingRound ? editingRound.index : parentPath.length + 1,
    parentRoundId,
    ...(editingRoundHasErrorAssistantMessage && editingRoundAssistantMessage ? { assistantMessageId: editingRoundAssistantMessage.id } : {}),
    userMessageId,
    prompt: trimmedPrompt,
    inputImageIds,
    maskTargetImageId,
    maskImageId,
    outputTaskIds: [],
    status: 'running',
    error: null,
    createdAt: now,
    finishedAt: null,
  }
  const userMessage: AgentMessage = {
    id: userMessageId,
    role: 'user',
    content: trimmedPrompt,
    roundId,
    inputImageIds,
    maskTargetImageId,
    maskImageId,
    createdAt: now,
  }

  let fallbackTitle: string | null = null
  updateAgentConversation(conversation.id, (current) => {
    const nextTitle = current.rounds.length === 0 ? createAgentConversationTitle(trimmedPrompt, current.title) : current.title
    if (current.rounds.length === 0) fallbackTitle = nextTitle
    const messages = shouldAppendToEditingRound
      ? current.messages.some((message) => message.id === userMessageId)
        ? current.messages.map((message) => {
            if (message.id === userMessageId) return userMessage
            if (editingRoundHasErrorAssistantMessage && message.id === editingRoundAssistantMessage?.id) {
              return { ...message, content: '', outputTaskIds: [] }
            }
            return message
          })
        : [...current.messages, userMessage]
      : [...current.messages, userMessage]

    return {
      ...current,
      title: nextTitle,
      activeRoundId: roundId,
      updatedAt: now,
      rounds: shouldAppendToEditingRound
        ? current.rounds.map((item) => item.id === roundId ? round : item)
        : [...current.rounds, round],
      messages,
    }
  })

  if (state.appMode !== 'agent' && conversation.id) {
    state.setAgentInputPrompt(conversation.id, '')
    state.clearAgentInputImages(conversation.id)
  } else {
    state.setPrompt('')
    state.clearInputImages()
    state.clearMaskDraft()
  }
  state.setAgentEditingRoundId(null)

  if (fallbackTitle) {
    void generateAgentConversationTitle(conversation.id, trimmedPrompt, inputImageIds, requestSettings, activeProfile, fallbackTitle)
  }

  void executeAgentRound(conversation.id, roundId, normalizedParams, requestSettings, activeProfile, imageProfile, projectId)
}

export async function regenerateAgentAssistantMessage(conversationId: string, roundId: string) {
  const state = useStore.getState()
  const { settings, params, showToast } = state
  const normalizedSettings = normalizeSettings(settings)

  const agentValidationError = getAgentProfileValidationError(normalizedSettings)
  if (agentValidationError) {
    showToast(agentValidationError.message.includes('缺少 API Key') ? '请先选择 API Key' : `Agent 请求配置不可用：${agentValidationError.message}`, 'error')
    return
  }

  // 合并 OIDC override，保证 agentApi.ts 里 createHeaders 拿得到 apiKey
  const activeProfile = { ...applyAgentOidcOverrideToProfile(getAgentTextApiProfile(normalizedSettings)!), apiMode: 'responses' as const }
  const imageProfile = applyAgentOidcOverrideToProfile(getAgentImageApiProfile(normalizedSettings)!)

  const conversation = state.agentConversations.find((item) => item.id === conversationId)
  const sourceRound = conversation?.rounds.find((item) => item.id === roundId) ?? null
  const sourceUserMessage = sourceRound
    ? conversation?.messages.find((message) => message.id === sourceRound.userMessageId) ?? null
    : null
  if (!conversation || !sourceRound || !sourceUserMessage) {
    showToast('找不到要重新生成的 Agent 消息', 'error')
    return
  }

  if (conversation.rounds.some((round) => round.status === 'running')) {
    showToast('请等待生成完成，或先停止生成', 'info')
    return
  }

  const inputImageIds = uniqueIds(sourceRound.inputImageIds)
  const projectId = sourceRound.outputTaskIds
    .map((taskId) => state.tasks.find((task) => task.id === taskId)?.projectId)
    .find((id): id is string => Boolean(id)) ?? getActiveTaskProjectId()
  const requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  const normalizedParams = {
    ...normalizeParamsForSettings(params, requestSettings, { hasInputImages: inputImageIds.length > 0 }),
    n: DEFAULT_PARAMS.n,
    transparent_output: false,
  }
  const now = Date.now()
  if (sourceRound.status === 'error') {
    const assistantMessageId = sourceRound.assistantMessageId
      ?? conversation.messages.find((message) => message.roundId === sourceRound.id && message.role === 'assistant')?.id
    updateAgentConversation(conversationId, (current) => ({
      ...current,
      activeRoundId: sourceRound.id,
      updatedAt: now,
      rounds: current.rounds.map((round) =>
        round.id === sourceRound.id
          ? {
              ...round,
              requestId: createRequestId(),
              outputTaskIds: [],
              responseId: undefined,
              responseOutput: undefined,
              status: 'running',
              error: null,
              finishedAt: null,
            }
          : round,
      ),
      messages: assistantMessageId
        ? current.messages.map((message) =>
            message.id === assistantMessageId ? { ...message, content: '', outputTaskIds: [] } : message,
          )
        : current.messages,
    }))
    state.setAgentEditingRoundId(null)
    void executeAgentRound(conversationId, sourceRound.id, normalizedParams, requestSettings, activeProfile, imageProfile, projectId)
    return
  }

  const newRoundId = genId()
  const newUserMessageId = genId()
  const newRound: AgentRound = {
    id: newRoundId,
    requestId: createRequestId(),
    index: sourceRound.index,
    parentRoundId: sourceRound.parentRoundId ?? null,
    userMessageId: newUserMessageId,
    prompt: sourceRound.prompt || sourceUserMessage.content.trim(),
    inputImageIds,
    maskTargetImageId: sourceRound.maskTargetImageId ?? sourceUserMessage.maskTargetImageId ?? null,
    maskImageId: sourceRound.maskImageId ?? sourceUserMessage.maskImageId ?? null,
    outputTaskIds: [],
    status: 'running',
    error: null,
    createdAt: now,
    finishedAt: null,
  }
  const newUserMessage: AgentMessage = {
    id: newUserMessageId,
    role: 'user',
    content: sourceUserMessage.content,
    roundId: newRoundId,
    inputImageIds,
    maskTargetImageId: sourceRound.maskTargetImageId ?? sourceUserMessage.maskTargetImageId ?? null,
    maskImageId: sourceRound.maskImageId ?? sourceUserMessage.maskImageId ?? null,
    createdAt: now,
  }

  updateAgentConversation(conversationId, (current) => ({
    ...current,
    activeRoundId: newRoundId,
    updatedAt: now,
    rounds: [...current.rounds, newRound],
    messages: [...current.messages, newUserMessage],
  }))
  state.setAgentEditingRoundId(null)
  void executeAgentRound(conversationId, newRoundId, normalizedParams, requestSettings, activeProfile, imageProfile, projectId)
}

async function executeAgentRound(
  conversationId: string,
  roundId: string,
  params: TaskParams,
  requestSettings: AppSettings,
  activeProfile: ApiProfile,
  imageProfile: ApiProfile,
  projectId?: string,
) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const controllerKey = getAgentRoundControllerKey(conversationId, roundId)
  agentRoundControllers.set(controllerKey, controller)
  try {
    const latestState = useStore.getState()
    const conversation = latestState.agentConversations.find((item) => item.id === conversationId)
    if (!conversation) return
    const round = conversation.rounds.find((item) => item.id === roundId)
    const userMessage = round ? conversation.messages.find((message) => message.id === round.userMessageId) : null
    if (!round || !userMessage) return
    const requestId = round.requestId ?? createRequestId()
    if (!round.requestId) {
      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) => item.id === roundId ? { ...item, requestId } : item),
      }))
    }
    const maskDataUrl = round.maskImageId ? await ensureImageCached(round.maskImageId) : undefined
    if (round.maskImageId && !maskDataUrl) throw new Error('遮罩图片已不存在')

    const apiInput = await buildAgentApiInput(conversation, round, latestState.tasks)
    if (controller.signal.aborted) throw createAgentAbortError()
    const existingAssistantMessage = round.assistantMessageId
      ? conversation.messages.find((message) => message.id === round.assistantMessageId) ?? null
      : conversation.messages.find((message) => message.roundId === roundId && message.role === 'assistant') ?? null
    const assistantMessageId = existingAssistantMessage?.id ?? genId()
    const shouldStreamAssistantMessage = activeProfile.streamImages === true
    const imageRequestSettings = createSettingsForApiProfile(requestSettings, imageProfile)
    const streamingTaskIds: string[] = []
    const taskIdByToolCallId = new Map<string, string>()

    const attachTaskToAgentRound = (taskId: string) => {
      if (streamingTaskIds.includes(taskId)) return
      streamingTaskIds.push(taskId)
      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) =>
          item.id === roundId
            ? { ...item, outputTaskIds: item.outputTaskIds.includes(taskId) ? item.outputTaskIds : [...item.outputTaskIds, taskId] }
            : item,
        ),
        messages: current.messages.map((message) =>
          message.id === assistantMessageId
            ? { ...message, outputTaskIds: [...new Set([...(message.outputTaskIds ?? []), taskId])] }
            : message,
        ),
      }))
    }

    const ensureStreamingAgentTask = async (
      toolCallId: string,
      taskPrompt = '',
      inputImageIds = round.inputImageIds ?? [],
      options: { createdAt?: number; agentBatchCallId?: string; maskTargetImageId?: string | null; maskImageId?: string | null; taskParams?: TaskParams } = {},
    ) => {
      const existingTaskId = taskIdByToolCallId.get(toolCallId)
      if (existingTaskId) return existingTaskId

      const existingTask = useStore.getState().tasks.find((task) => task.agentToolCallId === toolCallId)
      if (existingTask) {
        taskIdByToolCallId.set(toolCallId, existingTask.id)
        attachTaskToAgentRound(existingTask.id)
        return existingTask.id
      }

      const task: TaskRecord = {
        id: genId(),
        requestId,
        ...(projectId ? { projectId } : {}),
        prompt: taskPrompt,
        params: options.taskParams ?? { ...params, n: 1 },
        apiProvider: imageProfile.provider,
        apiProfileId: imageProfile.id,
        apiProfileName: imageProfile.name,
        apiMode: imageProfile.apiMode,
        apiModel: imageProfile.model,
        inputImageIds,
        maskTargetImageId: options.maskTargetImageId !== undefined ? options.maskTargetImageId : round.maskTargetImageId ?? null,
        maskImageId: options.maskImageId !== undefined ? options.maskImageId : round.maskImageId ?? null,
        outputImages: [],
        status: 'running',
        error: null,
        createdAt: options.createdAt ?? Date.now(),
        finishedAt: null,
        elapsed: null,
        sourceMode: 'agent',
        agentConversationId: conversationId,
        agentRoundId: roundId,
        agentMessageId: assistantMessageId,
        agentToolCallId: toolCallId,
        ...(options.agentBatchCallId ? { agentBatchCallId: options.agentBatchCallId } : {}),
      }

      taskIdByToolCallId.set(toolCallId, task.id)
      useStore.getState().setTasks([task, ...useStore.getState().tasks])
      attachTaskToAgentRound(task.id)
      await putTask(task)
      touchProject(projectId, false)
      return task.id
    }

    const completeAgentImageTask = async (image: AgentApiResultImage, rawResponsePayload?: string) => {
      const toolCallId = image.toolCallId ?? genId()
      const taskId = await ensureStreamingAgentTask(toolCallId)
      const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
      if (latestTask?.status === 'done' && latestTask.outputImages.length > 0) return taskId

      const stored = await storeImageWithSize(image.dataUrl, 'generated')
      cacheImage(stored.id, image.dataUrl)
      const actualParams: Partial<TaskParams> = {
        ...(Object.keys(image.actualParams ?? {}).length ? image.actualParams : {}),
        ...(!hasActualSizeParam(image.actualParams) ? getImageSizeParam(stored) ?? {} : {}),
        n: 1,
      }
      updateTaskInStore(taskId, {
        prompt: image.revisedPrompt ?? latestTask?.prompt ?? '',
        outputImages: [stored.id],
        actualParams,
        actualParamsByImage: { [stored.id]: actualParams },
        revisedPromptByImage: image.revisedPrompt ? { [stored.id]: image.revisedPrompt } : undefined,
        rawResponsePayload,
        status: 'done',
        error: null,
        finishedAt: Date.now(),
        elapsed: Date.now() - (latestTask?.createdAt ?? startedAt),
        agentToolAction: image.action,
      })
      const completedTask = useStore.getState().tasks.find((task) => task.id === taskId)
      if (completedTask) {
        await uploadGeneratedProjectImages(completedTask, [{ ...stored, dataUrl: image.dataUrl, source: 'generated' }])
      }
      useStore.getState().setTaskStreamPreview(taskId)
      return taskId
    }

    const failAgentImageTask = (toolCallId: string, error: string, rawResponsePayload?: string) => {
      const taskId = taskIdByToolCallId.get(toolCallId)
      if (!taskId) return
      const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
      if (!latestTask || latestTask.status !== 'running') return

      useStore.getState().setTaskStreamPreview(taskId)
      updateTaskInStore(taskId, {
        status: 'error',
        error,
        rawResponsePayload,
        falRecoverable: false,
        customRecoverable: false,
        imageStatusRecoverable: false,
        finishedAt: Date.now(),
        elapsed: Date.now() - latestTask.createdAt,
      })
    }

    ensureAgentAssistantMessage(conversationId, roundId, assistantMessageId)
    const maxToolCalls = Number.isFinite(requestSettings.agentMaxToolRounds)
      ? Math.max(1, Math.trunc(requestSettings.agentMaxToolRounds))
      : DEFAULT_AGENT_MAX_TOOL_ROUNDS
    let apiInputForTurn = apiInput
    let accumulatedOutputItems: ResponsesOutputItem[] = []
    let accumulatedText = ''
    const textSegments: string[] = []
    let lastResponseId: string | undefined
    let toolCallsUsed = 0
    let reachedToolLimit = false
    let pendingToolTextSeparator = false

    // Helper: resolve reference image ids to data URLs for batch image calls
    const resolveReferenceImages = async (referenceIds: string[]): Promise<{ dataUrls: string[]; imageIds: string[] }> => {
      const dataUrls: string[] = []
      const imageIds: string[] = []
      for (const refId of referenceIds) {
        // Resolve both generated image refs and current/user input refs from XML tags.
        const latestConv = useStore.getState().agentConversations.find((item) => item.id === conversationId)
        if (!latestConv) continue
        for (const r of getAgentRoundPath(latestConv, roundId)) {
          for (let imgIdx = 0; imgIdx < r.inputImageIds.length; imgIdx++) {
            const currentRefId = getAgentCurrentReferenceId(r, imgIdx)
            if (currentRefId === refId) {
              const imageId = r.inputImageIds[imgIdx]
              const dataUrl = await ensureImageCached(imageId)
              if (dataUrl) dataUrls.push(dataUrl)
              imageIds.push(imageId)
            }
          }
          const outputImages = collectAgentRoundOutputImageSlots(r, useStore.getState().tasks)
          for (let imgIdx = 0; imgIdx < outputImages.length; imgIdx++) {
            const generatedRefId = getAgentGeneratedImageReferenceId(r, imgIdx)
            if (generatedRefId === refId) {
              const imageId = outputImages[imgIdx]
              if (!imageId) continue
              const dataUrl = await ensureImageCached(imageId)
              if (dataUrl) dataUrls.push(dataUrl)
              imageIds.push(imageId)
            }
          }
        }
      }
      return { dataUrls, imageIds }
    }

    const parseSingleImageCallArguments = (args: string): { id: string; prompt: string } | null => {
      try {
        const parsed = JSON.parse(args) as Record<string, unknown>
        const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
        if (!prompt) return null
        const id = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : 'image'
        return { id, prompt }
      } catch {
        return null
      }
    }

    const callHybridImageApiSingle = async (opts: {
      prompt: string
      referenceImageDataUrls: string[]
      taskParams: TaskParams
      signal: AbortSignal
      onImageStatusRequestCreated?: (event: { requestId: string }) => void
      onPartialImage?: (event: { image: string; partialImageIndex?: number }) => void | Promise<void>
    }) => {
      const result = await callImageApi({
        settings: imageRequestSettings,
        requestId,
        prompt: replaceImageMentionsForApi(opts.prompt, opts.referenceImageDataUrls.length),
        params: opts.taskParams,
        inputImageDataUrls: opts.referenceImageDataUrls,
        onImageStatusRequestCreated: opts.onImageStatusRequestCreated,
        onPartialImage: opts.onPartialImage
          ? (partial) => {
              void opts.onPartialImage?.({ image: partial.image, partialImageIndex: partial.partialImageIndex ?? partial.requestIndex })
            }
          : undefined,
      })
      if (opts.signal.aborted) throw createAgentAbortError()
      const dataUrl = result.images[0]
      return {
        image: dataUrl ? {
          dataUrl,
          actualParams: result.actualParamsList?.[0] ?? result.actualParams,
          revisedPrompt: result.revisedPrompts?.[0] ?? opts.prompt,
        } satisfies AgentApiResultImage : null,
        error: result.failedRequests?.[0]?.error ?? (dataUrl ? null : '接口未返回图片数据'),
        rawResponsePayload: JSON.stringify({
          imageCount: result.images.length,
          actualParams: result.actualParams,
          actualParamsList: result.actualParamsList,
          revisedPrompts: result.revisedPrompts,
          rawImageUrls: result.rawImageUrls,
          failedRequests: result.failedRequests,
        }, null, 2),
      }
    }

    const executeSingleImageFunctionCall = async (functionCallItem: ResponsesOutputItem): Promise<string> => {
      const callId = functionCallItem.call_id ?? ''
      const item = parseSingleImageCallArguments(functionCallItem.arguments ?? '')
      if (!item) return JSON.stringify({ error: 'Invalid or empty image arguments' })

      const referenceIds = uniqueIds(extractAgentReferenceIds(item.prompt))
      const references = await resolveReferenceImages(referenceIds)
      const toolCallId = callId || genId()
      const taskParams = {
        ...normalizeParamsForSettings(params, imageRequestSettings, { hasInputImages: references.dataUrls.length > 0 }),
        n: 1,
      }

      await ensureStreamingAgentTask(toolCallId, item.prompt, references.imageIds, {
        createdAt: Date.now(),
        taskParams,
        maskTargetImageId: null,
        maskImageId: null,
      })

      try {
        const result = await callHybridImageApiSingle({
          prompt: item.prompt,
          referenceImageDataUrls: references.dataUrls,
          taskParams,
          signal: controller.signal,
          onImageStatusRequestCreated: (request) => {
            const taskId = taskIdByToolCallId.get(toolCallId)
            if (taskId) addImageStatusRequestIdToTask(taskId, request.requestId)
          },
          onPartialImage: async ({ image, partialImageIndex }) => {
            if (controller.signal.aborted) return
            const taskId = taskIdByToolCallId.get(toolCallId)
            if (taskId) {
              useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
              if (partialImageIndex === 0 || partialImageIndex == null) void persistTaskStreamPartialImage(taskId, image)
            }
          },
        })

        if (controller.signal.aborted) throw createAgentAbortError()
        if (result.image) {
          await completeAgentImageTask({ ...result.image, toolCallId }, result.rawResponsePayload)
          toolCallsUsed += 1
          return JSON.stringify({ id: item.id, status: 'done' })
        }

        failAgentImageTask(toolCallId, result.error!, result.rawResponsePayload)
        return JSON.stringify({ id: item.id, status: 'error', error: result.error })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        if (controller.signal.aborted) throw createAgentAbortError()
        failAgentImageTask(toolCallId, error)
        return JSON.stringify({ id: item.id, status: 'error', error })
      }
    }

    // Helper: execute a generate_image_batch function call concurrently
    const executeBatchFunctionCall = async (functionCallItem: ResponsesOutputItem): Promise<string> => {
      const callId = functionCallItem.call_id ?? ''
      const args = functionCallItem.arguments ?? ''
      const batchItems = parseBatchImageCallArguments(args)

      if (!batchItems || batchItems.length === 0) {
        return JSON.stringify({ error: 'Invalid or empty batch arguments' })
      }

      // Create task cards in model-provided order before starting network calls.
      const batchExecutionItems = []
      for (const item of batchItems) {
        const referenceIds = uniqueIds(extractAgentReferenceIds(item.prompt))
        const references = await resolveReferenceImages(referenceIds)
        const batchToolCallId = genId()
        const taskParams = requestSettings.agentApiConfigMode === 'hybrid'
          ? {
              ...normalizeParamsForSettings(params, imageRequestSettings, { hasInputImages: references.dataUrls.length > 0 }),
              n: 1,
            }
          : { ...params, n: 1 }
        await ensureStreamingAgentTask(batchToolCallId, item.prompt, references.imageIds, {
          createdAt: Date.now(),
          taskParams,
          maskTargetImageId: null,
          maskImageId: null,
          ...(callId ? { agentBatchCallId: callId } : {}),
        })
        batchExecutionItems.push({ item, batchToolCallId, references, referenceIds, taskParams })
      }

      // Fire all batch items concurrently after all cards are visible.
      const batchPromises = batchExecutionItems.map(async ({ item, batchToolCallId, references, referenceIds, taskParams }) => {

        const batchResult = requestSettings.agentApiConfigMode === 'hybrid'
          ? {
              batchItemId: item.id,
              ...(await callHybridImageApiSingle({
                prompt: item.prompt,
                referenceImageDataUrls: references.dataUrls,
                taskParams,
                signal: controller.signal,
                onImageStatusRequestCreated: (request) => {
                  const taskId = taskIdByToolCallId.get(batchToolCallId)
                  if (taskId) addImageStatusRequestIdToTask(taskId, request.requestId)
                },
                onPartialImage: async ({ image, partialImageIndex }) => {
                  if (controller.signal.aborted) return
                  const taskId = taskIdByToolCallId.get(batchToolCallId)
                  if (taskId) {
                    useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
                    if (partialImageIndex === 0 || partialImageIndex == null) void persistTaskStreamPartialImage(taskId, image)
                  }
                },
              })),
            }
          : await callBatchImageSingle({
              profile: imageProfile,
              requestId,
              params: taskParams,
              batchItemId: item.id,
              prompt: item.prompt,
              referenceImageDataUrls: references.dataUrls,
              referenceIds,
              allowPromptRewrite: requestSettings.allowPromptRewrite,
              signal: controller.signal,
              onImageStatusRequestCreated: (request) => {
                const taskId = taskIdByToolCallId.get(batchToolCallId)
                if (taskId) addImageStatusRequestIdToTask(taskId, request.requestId)
              },
              onImageToolStarted: shouldStreamAssistantMessage
                ? async () => {
                    if (controller.signal.aborted) return
                  }
                : undefined,
              onPartialImage: shouldStreamAssistantMessage
                ? async ({ image, partialImageIndex }) => {
                    if (controller.signal.aborted) return
                    const taskId = taskIdByToolCallId.get(batchToolCallId)
                    if (taskId) {
                      useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
                      if (partialImageIndex === 0 || partialImageIndex == null) {
                        void persistTaskStreamPartialImage(taskId, image)
                      }
                    }
                  }
                : undefined,
              onImageToolCompleted: shouldStreamAssistantMessage
                ? async (image) => {
                    if (controller.signal.aborted) return
                    await completeAgentImageTask({ ...image, toolCallId: batchToolCallId })
                  }
                : undefined,
            })

        if (controller.signal.aborted) throw createAgentAbortError()
        // If not streaming and we have an image, complete the pre-created task.
        if (batchResult.image && !shouldStreamAssistantMessage) {
          await completeAgentImageTask({ ...batchResult.image, toolCallId: batchToolCallId }, batchResult.rawResponsePayload)
        }

        return batchResult
      })

      const batchResults = await Promise.allSettled(batchPromises)
      if (controller.signal.aborted) throw createAgentAbortError()

      // Build function_call_output
      const outputImages: Array<{ id: string; status: string; error?: string }> = []
      for (let i = 0; i < batchItems.length; i++) {
        const settled = batchResults[i]
        const batchItem = batchItems[i]
        if (settled.status === 'fulfilled') {
          const r = settled.value
          if (!r.image) {
            failAgentImageTask(batchExecutionItems[i].batchToolCallId, r.error!, r.rawResponsePayload)
          }
          outputImages.push({
            id: r.batchItemId,
            status: r.image ? 'done' : 'error',
            ...(r.error ? { error: r.error } : {}),
          })
        } else {
          const error = settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
          failAgentImageTask(batchExecutionItems[i].batchToolCallId, error)
          outputImages.push({
            id: batchItem.id,
            status: 'error',
            error,
          })
        }
      }

      const successCount = outputImages.filter((img) => img.status === 'done').length
      toolCallsUsed += successCount

      return JSON.stringify({ images: outputImages })
    }

    while (true) {
      if (controller.signal.aborted) throw createAgentAbortError()
      const textBeforeResponse = accumulatedText
      let currentResponseOutputItems: ResponsesOutputItem[] = []
      const result = await callAgentResponsesApi({
        settings: requestSettings,
        requestId,
        profile: activeProfile,
        params,
        input: apiInputForTurn,
        maskDataUrl,
        signal: controller.signal,
        forceStream: requestSettings.agentApiConfigMode !== 'hybrid',
        onImageStatusRequestCreated: (request) => {
          addImageStatusRequestIdToAgentRound(conversationId, roundId, request.requestId, activeProfile.id)
        },
        onTextDelta: shouldStreamAssistantMessage
          ? (delta) => {
              if (controller.signal.aborted) return
              if (pendingToolTextSeparator && delta && accumulatedText.trim()) {
                accumulatedText += '\n\n'
                appendAgentAssistantMessageContent(conversationId, assistantMessageId, '\n\n')
              }
              pendingToolTextSeparator = false
              accumulatedText += delta
              appendAgentAssistantMessageContent(conversationId, assistantMessageId, delta)
            }
          : undefined,
        onOutputItems: shouldStreamAssistantMessage
          ? (outputItems) => {
              if (controller.signal.aborted) return
              currentResponseOutputItems = outputItems
              updateAgentConversation(conversationId, (current) => ({
                ...current,
                rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseOutput: mergeResponseOutputItems(accumulatedOutputItems, outputItems) } : item),
              }))
            }
          : undefined,
        onImageToolStarted: async ({ toolCallId }) => {
          if (controller.signal.aborted) return
          await ensureStreamingAgentTask(toolCallId)
        },
        onImagePartialImage: async ({ toolCallId, image, partialImageIndex }) => {
          if (controller.signal.aborted) return
          const taskId = await ensureStreamingAgentTask(toolCallId)
          if (controller.signal.aborted) return
          useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
          if (partialImageIndex === 0 || partialImageIndex == null) {
            void persistTaskStreamPartialImage(taskId, image)
          }
        },
        onImageToolCompleted: async (image) => {
          if (controller.signal.aborted) return
          await completeAgentImageTask(image)
        },
        onImageToolFailed: async ({ toolCallId, error }) => {
          if (controller.signal.aborted) return
          await ensureStreamingAgentTask(toolCallId)
          if (controller.signal.aborted) return
          failAgentImageTask(toolCallId, error)
        },
      })
      if (controller.signal.aborted) throw createAgentAbortError()

      lastResponseId = result.responseId ?? lastResponseId
      currentResponseOutputItems = currentResponseOutputItems.length ? currentResponseOutputItems : result.outputItems ?? []
      accumulatedOutputItems = mergeResponseOutputItems(accumulatedOutputItems, currentResponseOutputItems)

      const responseText = result.text.trim()
      if (responseText && accumulatedText === textBeforeResponse) {
        const textToAppend = accumulatedText ? `\n\n${responseText}` : responseText
        accumulatedText += textToAppend
        if (shouldStreamAssistantMessage) appendAgentAssistantMessageContent(conversationId, assistantMessageId, textToAppend)
      }
      const newTextInThisResponse = accumulatedText.slice(textBeforeResponse.length).trim()
      if (newTextInThisResponse) textSegments.push(newTextInThisResponse)

      // Process built-in image_generation_call results (single images)
      for (const image of result.images) {
        if (image.toolCallId && taskIdByToolCallId.has(image.toolCallId)) {
          const completedTaskId = await completeAgentImageTask(image, result.rawResponsePayload)
          const promptRefIds = uniqueIds(extractAgentReferenceIds(image.revisedPrompt ?? ''))
          if (promptRefIds.length > 0) {
            const promptRefs = await resolveReferenceImages(promptRefIds)
            if (promptRefs.imageIds.length > 0) {
              const latestTask = useStore.getState().tasks.find((t) => t.id === completedTaskId)
              if (latestTask) {
                const mergedInputIds = uniqueIds([...latestTask.inputImageIds, ...promptRefs.imageIds])
                if (mergedInputIds.length !== latestTask.inputImageIds.length) {
                  updateTaskInStore(completedTaskId, { inputImageIds: mergedInputIds })
                }
              }
            }
          }
          continue
        }
        const promptRefIds = uniqueIds(extractAgentReferenceIds(image.revisedPrompt ?? ''))
        const promptRefs = await resolveReferenceImages(promptRefIds)
        const stored = await storeImageWithSize(image.dataUrl, 'generated')
        cacheImage(stored.id, image.dataUrl)
        const actualParams: Partial<TaskParams> = {
          ...(Object.keys(image.actualParams ?? {}).length ? image.actualParams : {}),
          ...(!hasActualSizeParam(image.actualParams) ? getImageSizeParam(stored) ?? {} : {}),
          n: 1,
        }
        const task: TaskRecord = {
          id: genId(),
          requestId,
          ...(projectId ? { projectId } : {}),
          prompt: image.revisedPrompt ?? round?.prompt ?? userMessage.content,
          params,
          apiProvider: imageProfile.provider,
          apiProfileId: imageProfile.id,
          apiProfileName: imageProfile.name,
          apiMode: imageProfile.apiMode,
          apiModel: imageProfile.model,
          inputImageIds: uniqueIds([...(round?.inputImageIds ?? []), ...promptRefs.imageIds]),
          maskTargetImageId: round?.maskTargetImageId ?? null,
          maskImageId: round?.maskImageId ?? null,
          outputImages: [stored.id],
          actualParams,
          actualParamsByImage: { [stored.id]: actualParams },
          revisedPromptByImage: image.revisedPrompt ? { [stored.id]: image.revisedPrompt } : undefined,
          rawResponsePayload: result.rawResponsePayload,
          status: 'done',
          error: null,
          createdAt: startedAt,
          finishedAt: Date.now(),
          elapsed: Date.now() - startedAt,
          sourceMode: 'agent',
          agentConversationId: conversationId,
          agentRoundId: roundId,
          agentMessageId: assistantMessageId,
          agentToolCallId: image.toolCallId,
          agentToolAction: image.action,
        }
        useStore.getState().setTasks([task, ...useStore.getState().tasks])
        playCompletionSound()
        attachTaskToAgentRound(task.id)
        await putTask(task)
        await uploadGeneratedProjectImages(task, [{ ...stored, dataUrl: image.dataUrl, source: 'generated' }])
        touchProject(projectId, false)
      }

      if (result.rawResponsePayload && streamingTaskIds.length > 0) {
        for (const taskId of streamingTaskIds) {
          const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
          if (latestTask && !latestTask.rawResponsePayload) updateTaskInStore(taskId, { rawResponsePayload: result.rawResponsePayload })
        }
      }

      // Check for function calls that require continuation
      const imageFunctionCalls = currentResponseOutputItems.filter(
        (item) => item.type === 'function_call' && item.name === 'generate_image',
      )
      const batchFunctionCalls = currentResponseOutputItems.filter(
        (item) => item.type === 'function_call' && item.name === 'generate_image_batch',
      )
      const continueFunctionCalls = currentResponseOutputItems.filter(
        (item) => item.type === 'function_call' && item.name === 'continue_generation',
      )

      // Count built-in tool calls (image_generation, web_search) for budget tracking
      const responseToolCalls = countResponseToolCalls(currentResponseOutputItems)
      toolCallsUsed += responseToolCalls

      // Collect function_call_output items for all function calls that need responses
      const functionCallOutputs: ResponsesOutputItem[] = []

      if (imageFunctionCalls.length > 0) {
        for (const fc of imageFunctionCalls) {
          const output = await executeSingleImageFunctionCall(fc)
          functionCallOutputs.push({
            type: 'function_call_output',
            call_id: fc.call_id,
            output,
          })
        }
      }

      if (batchFunctionCalls.length > 0) {
        for (const fc of batchFunctionCalls) {
          const output = await executeBatchFunctionCall(fc)
          functionCallOutputs.push({
            type: 'function_call_output',
            call_id: fc.call_id,
            output,
          })
        }
      }

      for (const fc of continueFunctionCalls) {
        functionCallOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: JSON.stringify({ status: 'continued' }),
        })
      }

      // If no function calls need output → model decided the task is done → break
      if (functionCallOutputs.length === 0) {
        updateAgentConversation(conversationId, (current) => ({
          ...current,
          updatedAt: Date.now(),
          rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseId: lastResponseId, responseOutput: accumulatedOutputItems } : item),
        }))
        break
      }

      const accumulatedOutputItemsWithFunctionOutputs = mergeResponseOutputItems(accumulatedOutputItems, functionCallOutputs)

      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseId: lastResponseId, responseOutput: accumulatedOutputItemsWithFunctionOutputs } : item),
      }))

      if (toolCallsUsed >= maxToolCalls) {
        reachedToolLimit = true
        break
      }

      // Build continuation input with function call outputs and available refs
      const latestConversation = useStore.getState().agentConversations.find((item) => item.id === conversationId)
      const latestRound = latestConversation?.rounds.find((item) => item.id === roundId)
      if (!latestRound) break

      const continuationBase = buildAgentContinuationInput(
        apiInput,
        latestRound,
        useStore.getState().tasks,
        accumulatedOutputItems,
        toolCallsUsed,
        maxToolCalls,
      )
      // Insert function_call_output items before the continuation system message
      continuationBase.splice(continuationBase.length - 1, 0, ...functionCallOutputs)
      // Inject batch-generated images as input_image user message for model visibility
      const batchImagesItem = await createAgentBatchImagesInputItem(latestRound, useStore.getState().tasks, streamingTaskIds)
      if (batchImagesItem) continuationBase.splice(continuationBase.length - 1, 0, batchImagesItem)
      apiInputForTurn = continuationBase
      accumulatedOutputItems = accumulatedOutputItemsWithFunctionOutputs
      pendingToolTextSeparator = true
    }

    markAgentRoundTasksFailed(
      conversationId,
      roundId,
      requestSettings.agentApiConfigMode === 'hybrid' ? '自定义图像生成工具未返回图片' : '内置 image_generation 工具未返回图片',
      undefined,
      (task) => Boolean(task.agentToolCallId && !task.agentBatchCallId),
    )

    const taskIds: string[] = [...streamingTaskIds]
    const outputIds = taskIds.flatMap((taskId) => useStore.getState().tasks.find((task) => task.id === taskId)?.outputImages ?? [])
    const limitNotice = reachedToolLimit ? `已达到最大工具调用次数（${maxToolCalls}），已停止自动续跑。` : ''
    const joinedText = textSegments.join('\n\n').trim()
    const finalContent = [joinedText, limitNotice]
      .filter(Boolean)
      .join(joinedText ? '\n\n' : '')
      || (taskIds.length > 0 || outputIds.length > 0 ? '图像已生成。' : '')

    const assistantMessage: AgentMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: finalContent,
      roundId,
      outputTaskIds: taskIds,
      createdAt: Date.now(),
    }

    updateAgentConversation(conversationId, (current) => ({
      ...current,
      updatedAt: Date.now(),
      rounds: current.rounds.map((round) =>
        round.id === roundId
          ? {
              ...round,
              assistantMessageId,
              outputTaskIds: taskIds,
              responseId: lastResponseId,
              responseOutput: accumulatedOutputItems,
              status: 'done',
              error: null,
              finishedAt: Date.now(),
            }
          : round,
      ),
      messages: current.messages.some((message) => message.id === assistantMessageId)
        ? current.messages.map((message) => message.id === assistantMessageId ? assistantMessage : message)
        : [...current.messages, assistantMessage],
    }))

    useStore.getState().showToast(outputIds.length > 0 ? 'Agent 已生成图片' : 'Agent 已回复', 'success')
    showTaskCompletionNotification(
      outputIds.length > 0 ? 'Agent 已生成图片' : 'Agent 已回复',
      outputIds.length > 0 ? `Agent 回复已结束，共生成 ${outputIds.length} 张图片。` : 'Agent 回复已结束。',
    )
  } catch (err) {
    if (controller.signal.aborted) {
      if (markAgentRoundStopped(conversationId, roundId)) {
        useStore.getState().showToast('已停止生成', 'info')
      }
      return
    }

    let message = err instanceof Error ? err.message : String(err)
    const usesApiProxy = activeProfile.apiProxy ?? requestSettings.apiProxy
    const networkErrorHint = getApiRequestNetworkErrorHint(err, startedAt, usesApiProxy, activeProfile)
    if (networkErrorHint && !message.includes(IMAGE_FETCH_CORS_HINT)) {
      message += `\n${networkErrorHint}`
    }

    markAgentRoundTasksFailed(conversationId, roundId, message, getRawErrorPayload(err).rawResponsePayload)

    updateAgentConversation(conversationId, (current) => {
      const failedRound = current.rounds.find((round) => round.id === roundId)
      const existingAssistantMessage = failedRound?.assistantMessageId
        ? current.messages.find((item) => item.id === failedRound.assistantMessageId)
        : current.messages.find((item) => item.roundId === roundId && item.role === 'assistant')
      const errorContent = `请求失败：${message}`

      return {
        ...current,
        title: current.rounds.length === 1 && current.rounds[0].id === roundId ? '新对话' : current.title,
        updatedAt: Date.now(),
        rounds: current.rounds.map((round) =>
          round.id === roundId
            ? {
                ...round,
                ...(existingAssistantMessage ? { assistantMessageId: existingAssistantMessage.id } : {}),
                status: 'error',
                error: message,
                finishedAt: Date.now(),
              }
            : round,
        ),
        messages: existingAssistantMessage
          ? current.messages.map((item) => item.id === existingAssistantMessage.id ? { ...item, content: errorContent } : item)
          : [
              ...current.messages,
              {
                id: genId(),
                role: 'assistant',
                content: errorContent,
                roundId,
                createdAt: Date.now(),
              },
            ],
      }
    })
    useStore.getState().showToast(`Agent 请求失败：${message}`, 'error')
  } finally {
    if (agentRoundControllers.get(controllerKey) === controller) {
      agentRoundControllers.delete(controllerKey)
    }
  }
}

async function executeTask(taskId: string) {
  const { settings } = useStore.getState()
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return
  const taskProfile = getTaskApiProfile(settings, task)
  if (!taskProfile && task.apiProfileId) {
    updateTaskInStore(taskId, {
      status: 'error',
      error: '找不到此任务所使用的 API 配置。',
      falRecoverable: false,
      customRecoverable: false,
      imageStatusRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    return
  }
  activeTaskExecutions.add(taskId)
  const baseProfile = taskProfile ?? getActiveApiProfile(settings)
  const resolvedProfile = task.apiOverride && (task.apiOverride.apiKey || task.apiOverride.model)
    ? {
        ...baseProfile,
        ...(task.apiOverride.apiKey ? { apiKey: task.apiOverride.apiKey } : {}),
        ...(task.apiOverride.model ? { model: task.apiOverride.model } : {}),
      }
    : baseProfile
  const taskProvider = task.apiProvider ?? resolvedProfile.provider
  const isCompositeRequest = task.apiOverride?.platform?.trim().toLowerCase() === 'composite' && Boolean(task.apiOverride.apiKey)
  const taskApiMode = task.sourceMode !== 'agent' && taskProvider === 'openai' && !isCompositeRequest
    ? 'images'
    : task.apiMode ?? 'images'
  const activeProfile = { ...resolvedProfile, apiMode: taskApiMode }
  const requestSettings = createSettingsForApiProfile(settings, activeProfile)
  const project = task.projectId
    ? useStore.getState().projects.find((item) => item.id === task.projectId)
    : undefined
  const backendRequest = project?.storage === 'online' && project.remoteId && taskProvider === 'openai' && task.apiOverride?.apiKey && !isCompositeRequest
    ? { project, apiKey: task.apiOverride.apiKey }
    : null
  const backendManagesTaskRecord = Boolean(backendRequest && !task.transparentOutput)
  const updateExecutingTask = (patch: Partial<TaskRecord>) => updateTaskInStore(taskId, patch, !backendManagesTaskRecord)
  const requestId = task.requestId ?? createRequestId()
  if (!task.requestId) void updateExecutingTask({ requestId })
  let falRequestInfo: { requestId: string; endpoint: string } | null = task.falRequestId && task.falEndpoint
        ? { requestId: task.falRequestId, endpoint: task.falEndpoint }
    : null
  let customTaskInfo: { taskId: string } | null = task.customTaskId
    ? { taskId: task.customTaskId }
    : null
  let compositeRequestInfo: { requestId: string; statusUrl?: string } | null = task.compositeRequestId
    ? { requestId: task.compositeRequestId, statusUrl: task.compositeStatusUrl }
    : null

  if (
    !backendRequest &&
    taskProvider !== 'fal' &&
    !isCompositeRequest &&
    !isAsyncCustomProviderTask(requestSettings, taskProvider, task.inputImageIds.length > 0) &&
    !usesConcurrentOpenAIImageRequests(activeProfile, task.params)
  ) {
    scheduleOpenAIWatchdog(taskId, activeProfile.timeout, activeProfile)
  }

  try {
    // 获取输入图片 data URLs
    const inputDataUrls: string[] = []
    for (const imgId of task.inputImageIds) {
      const dataUrl = await ensureImageCached(imgId)
      if (!dataUrl) throw new Error('输入图片已不存在')
      inputDataUrls.push(dataUrl)
    }
    let maskDataUrl: string | undefined
    if (task.maskImageId) {
      maskDataUrl = await ensureImageCached(task.maskImageId)
      if (!maskDataUrl) throw new Error('遮罩图片已不存在')
    }

    const compositeFileCacheKey = isCompositeRequest
      ? await hashDataUrl(task.apiOverride?.apiKey ?? '')
      : ''
    const compositeInputFileUrls = isCompositeRequest
      ? await Promise.all(task.inputImageIds.map(async (imageId) => (
          (await getImage(imageId))?.compositeFileUrls?.[compositeFileCacheKey]
        )))
      : []
    const compositeMaskFileUrl = isCompositeRequest && task.maskImageId
      ? (await getImage(task.maskImageId))?.compositeFileUrls?.[compositeFileCacheKey]
      : undefined

    const requestPrompt = task.transparentOutput && task.transparentPrompt
      ? task.transparentPrompt
      : task.prompt

    const prompt = replaceImageMentionsForApi(requestPrompt, inputDataUrls.length)
    const result = isCompositeRequest
      ? await callBackendCompositeImageApi({
          apiKey: task.apiOverride?.apiKey ?? '',
          clientRequestId: requestId,
          model: activeProfile.model,
          prompt,
          params: task.params,
          inputImageDataUrls: inputDataUrls,
          inputImageFileUrls: compositeInputFileUrls,
          maskDataUrl,
          maskFileUrl: compositeMaskFileUrl,
          onRequestCreated: async (request) => {
            compositeRequestInfo = request
            await updateExecutingTask({
              compositeRequestId: request.requestId,
              compositeStatusUrl: request.statusUrl,
              compositeRecoverable: false,
            })
            console.log('[Store] 已保存 Composite 任务恢复信息', {
              taskId,
              requestId: request.requestId,
              statusUrl: request.statusUrl,
            })
          },
          onReferenceUploaded: async (reference) => {
            const imageId = reference.source === 'mask'
              ? task.maskImageId
              : task.inputImageIds[reference.index]
            if (!imageId) return
            const image = await getImage(imageId)
            if (!image) return
            await putImage({
              ...image,
              compositeFileUrls: {
                ...image.compositeFileUrls,
                [compositeFileCacheKey]: reference.url,
              },
            })
          },
          onReferenceUploadFailed: (error) => {
            const latestTask = useStore.getState().tasks.find((item) => item.id === taskId)
            if (!latestTask || latestTask.status !== 'running') return
            useStore.getState().setTaskStreamPreview(taskId)
            updateExecutingTask({
              status: 'error',
              error: error.message,
              falRecoverable: false,
              customRecoverable: false,
              imageStatusRecoverable: false,
              finishedAt: Date.now(),
              elapsed: Date.now() - task.createdAt,
            })
            useStore.getState().setDetailTaskId(taskId)
            useStore.getState().showToast(error.message, 'error')
          },
        })
      : backendRequest
      ? await callBackendImageApi({
          project: backendRequest.project,
          task: task.requestId ? task : { ...task, requestId },
          manageTaskRecord: backendManagesTaskRecord,
          apiKey: backendRequest.apiKey,
          provider: 'openai',
          model: activeProfile.model,
          apiMode: activeProfile.apiMode,
          allowPromptRewrite: requestSettings.allowPromptRewrite,
          prompt,
          params: task.params,
          inputImageDataUrls: inputDataUrls,
          maskDataUrl,
          onImageStatusRequestCreated: (request) => {
            addImageStatusRequestIdToTask(taskId, request.requestId, !backendManagesTaskRecord)
          },
        })
      : await callImageApi({
          settings: requestSettings,
          requestId,
          prompt,
          params: task.params,
          inputImageDataUrls: inputDataUrls,
          maskDataUrl,
          onFalRequestEnqueued: (request) => {
            falRequestInfo = request
            updateExecutingTask({
              falRequestId: request.requestId,
              falEndpoint: request.endpoint,
              falRecoverable: false,
            })
          },
          onCustomTaskEnqueued: (request) => {
            customTaskInfo = request
            updateExecutingTask({
              customTaskId: request.taskId,
              customRecoverable: false,
            })
          },
          onImageStatusRequestCreated: (request) => {
            addImageStatusRequestIdToTask(taskId, request.requestId, !backendManagesTaskRecord)
          },
          onPartialImage: (partial) => {
            useStore.getState().setTaskStreamPreview(taskId, partial.image, partial.requestIndex)
            void persistTaskStreamPartialImage(taskId, partial.image)
          },
        })

    const latestBeforeSuccess = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeSuccess || latestBeforeSuccess.status !== 'running') {
      useStore.getState().setTaskStreamPreview(taskId)
      return
    }

    // 存储输出图片
    const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images, {
      alreadyStoredOnline: result.imagesStoredOnline && !task.transparentOutput,
    })
    const isAsyncCustomTask = taskProvider !== 'fal' && taskProvider !== 'openai' && Boolean(customTaskInfo)
    const actualParamsList = await resolveImageSizeParamsList(
      outputDataUrls,
      isAsyncCustomTask || isCompositeRequest ? undefined : result.actualParamsList,
      outputImageSizes,
    )
    const actualParams = (() => {
      if (taskProvider === 'fal') return firstActualParams(actualParamsList)
      if (isAsyncCustomTask) return firstActualParams(actualParamsList)
      const firstParams = firstActualParams(actualParamsList)
      return {
        ...result.actualParams,
        size: isCompositeRequest ? firstParams?.size ?? result.actualParams?.size : result.actualParams?.size ?? firstParams?.size,
        n: outputIds.length,
      }
    })()
    const shouldStoreRevisedPrompts = taskProvider !== 'fal' && !isAsyncCustomTask
    const actualParamsByImage = mapActualParamsByImage(outputIds, actualParamsList)
    const revisedPromptByImage = shouldStoreRevisedPrompts ? result.revisedPrompts?.reduce<Record<string, string>>((acc, revisedPrompt, index) => {
      const imgId = outputIds[index]
      if (imgId && revisedPrompt && revisedPrompt.trim()) acc[imgId] = revisedPrompt
      return acc
    }, {}) : undefined
    const promptWasRevised = shouldStoreRevisedPrompts && result.revisedPrompts?.some(
      (revisedPrompt) => revisedPrompt?.trim() && revisedPrompt.trim() !== requestPrompt.trim(),
    )
    const hasRevisedPromptValue = shouldStoreRevisedPrompts && result.revisedPrompts?.some((revisedPrompt) => revisedPrompt?.trim())
    if (taskProvider === 'openai' && activeProfile.apiMode === 'responses' && !activeProfile.codexCli) {
      if (promptWasRevised) {
        showCodexCliPrompt()
      } else if (!hasRevisedPromptValue) {
        showCodexCliPrompt(false, '接口没有返回官方 API 会返回的部分信息')
      }
    }

    // 更新任务
    const latestBeforeUpdate = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeUpdate || latestBeforeUpdate.status !== 'running') {
      useStore.getState().setTaskStreamPreview(taskId)
      return
    }
    const partialImageIdsToClean = latestBeforeUpdate.streamPartialImageIds || []
    clearOpenAIWatchdogTimer(taskId)
    useStore.getState().setTaskStreamPreview(taskId)
    updateExecutingTask({
      outputImages: outputIds,
      transparentOriginalImages: transparentOriginalImageIds,
      outputErrors: result.failedRequests?.length ? result.failedRequests : undefined,
      streamPartialImageIds: undefined,
      rawImageUrls: result.rawImageUrls?.length ? result.rawImageUrls : undefined,
      actualParams,
      actualParamsByImage,
      revisedPromptByImage: revisedPromptByImage && Object.keys(revisedPromptByImage).length > 0 ? revisedPromptByImage : undefined,
      ...(result.actualCost !== undefined ? { actualCost: result.actualCost } : {}),
      status: 'done',
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
      falRecoverable: false,
      customRecoverable: false,
      compositeRecoverable: false,
      imageStatusRecoverable: false,
    })
    if (backendManagesTaskRecord && result.taskRecordQueued && project?.syncPending) {
      const current = useStore.getState().projects.find((item) => item.id === project.id)
      if (current) {
        const hasArchiveSync = onlineProjectSyncTimers.has(current.id) || onlineProjectSyncQueues.has(current.id)
        const updated = { ...current, syncPending: hasArchiveSync ? current.syncPending : false }
        useStore.setState((state) => ({
          projects: state.projects.map((item) => item.id === current.id ? updated : item),
        }))
        queueProjectSave(updated)
      }
    }
    void deleteUnreferencedImageIds(partialImageIdsToClean)

    const failedCount = result.failedRequests?.length ?? 0
    const completionMessage = failedCount > 0
      ? `生成完成：成功 ${outputIds.length} 张，失败 ${failedCount} 张`
      : `生成完成，共 ${outputIds.length} 张图片`
    useStore.getState().showToast(completionMessage, failedCount > 0 ? 'error' : 'success')
    if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `${completionMessage}。`)
    const currentMask = useStore.getState().maskDraft
    if (
      maskDataUrl &&
      currentMask &&
      currentMask.targetImageId === task.maskTargetImageId &&
      currentMask.maskDataUrl === maskDataUrl
    ) {
      useStore.getState().clearMaskDraft()
    }
  } catch (err) {
    clearOpenAIWatchdogTimer(taskId)
    const latestTask = useStore.getState().tasks.find((t) => t.id === taskId) ?? task
    if (latestTask.status !== 'running') return
    useStore.getState().setTaskStreamPreview(taskId)
    const latestFalRequestInfo = falRequestInfo ?? (latestTask.falRequestId && latestTask.falEndpoint
      ? { requestId: latestTask.falRequestId, endpoint: latestTask.falEndpoint }
      : null)
    const latestCustomTaskInfo = customTaskInfo ?? (latestTask.customTaskId ? { taskId: latestTask.customTaskId } : null)
    const latestCompositeRequestInfo = compositeRequestInfo ?? (latestTask.compositeRequestId
      ? { requestId: latestTask.compositeRequestId, statusUrl: latestTask.compositeStatusUrl }
      : null)
    if (getApiErrorStatus(err) === 524 && latestTask.imageStatusRequestIds?.length && (latestTask.apiProvider ?? 'openai') !== 'fal') {
      updateExecutingTask({
        status: 'running',
        error: null,
        imageStatusRecoverable: true,
        finishedAt: null,
        elapsed: null,
      })
      scheduleImageStatusRecovery(taskId, 0)
    } else if (latestTask.apiProvider === 'fal' && latestFalRequestInfo && isFalConnectionRecoverableError(err)) {
      updateExecutingTask({
        status: 'error',
        error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
        falRequestId: latestFalRequestInfo.requestId,
        falEndpoint: latestFalRequestInfo.endpoint,
        falRecoverable: true,
        finishedAt: Date.now(),
        elapsed: Date.now() - task.createdAt,
      })
      scheduleFalRecovery(taskId)
    } else if ((latestTask.apiProvider ?? 'openai') !== 'fal' && latestTask.imageStatusRequestIds?.length && isFalConnectionRecoverableError(err)) {
      updateExecutingTask({
        status: 'error',
        error: '请求连接已断开，之后会继续查询图片状态。',
        imageStatusRecoverable: true,
        finishedAt: Date.now(),
        elapsed: Date.now() - task.createdAt,
      })
      scheduleImageStatusRecovery(taskId)
    } else if (isCompositeRequest && latestCompositeRequestInfo && isFalConnectionRecoverableError(err)) {
      updateExecutingTask({
        status: 'error',
        error: 'Composite 请求连接已断开，之后会继续查询任务结果。',
        compositeRequestId: latestCompositeRequestInfo.requestId,
        compositeStatusUrl: latestCompositeRequestInfo.statusUrl,
        compositeRecoverable: true,
        finishedAt: Date.now(),
        elapsed: Date.now() - task.createdAt,
      })
      scheduleCompositeRecovery(taskId)
    } else if (latestCustomTaskInfo && isFalConnectionRecoverableError(err)) {
      updateExecutingTask({
        status: 'error',
        error: '与自定义异步任务的连接已断开，之后会继续查询任务结果。',
        customTaskId: latestCustomTaskInfo.taskId,
        customRecoverable: true,
        finishedAt: Date.now(),
        elapsed: Date.now() - task.createdAt,
      })
      scheduleCustomRecovery(taskId)
    } else {
      let errorMessage = err instanceof Error ? err.message : String(err)
      const settings = useStore.getState().settings
      const profile = getTaskApiProfile(settings, latestTask)
      const usesApiProxy = profile?.apiProxy ?? settings.apiProxy
      const activeProfile = getActiveApiProfile(settings)
      const hintProfile = profile ?? {
        provider: latestTask.apiProvider ?? activeProfile.provider,
        apiMode: settings.apiMode,
        streamImages: activeProfile.streamImages,
        streamPartialImages: activeProfile.streamPartialImages,
      }
      const networkErrorHint = getApiRequestNetworkErrorHint(err, latestTask.createdAt, usesApiProxy, hintProfile)
      if (networkErrorHint && !errorMessage.includes(IMAGE_FETCH_CORS_HINT)) {
        errorMessage += `\n${networkErrorHint}`
      }
      updateExecutingTask({
        status: 'error',
        error: errorMessage,
        ...getRawErrorPayload(err),
        falRecoverable: false,
        customRecoverable: false,
        imageStatusRecoverable: false,
        finishedAt: Date.now(),
        elapsed: Date.now() - task.createdAt,
      })
      useStore.getState().setDetailTaskId(taskId)
      useStore.getState().showToast(errorMessage, 'error')
    }
  } finally {
    activeTaskExecutions.delete(taskId)
    touchProject(task.projectId, false)
    // 释放输入图片的内存缓存（已持久化到 IndexedDB，后续按需从 DB 加载）
    for (const imgId of task.inputImageIds) {
      imageCache.delete(imgId)
    }
  }
}

function normalizeFavoritePatch(task: TaskRecord, patch: Partial<TaskRecord>, defaultFavoriteCollectionId: string | null): Partial<TaskRecord> {
  if ('favoriteCollectionIds' in patch) {
    const ids = normalizeFavoriteCollectionIds(patch.favoriteCollectionIds)
    return { ...patch, favoriteCollectionIds: ids, isFavorite: ids.length > 0 }
  }
  if ('isFavorite' in patch) {
    if (patch.isFavorite) {
      const ids = normalizeFavoriteCollectionIds(task.favoriteCollectionIds)
      return { ...patch, favoriteCollectionIds: ids.length ? ids : defaultFavoriteCollectionId ? [defaultFavoriteCollectionId] : [] }
    }
    return { ...patch, favoriteCollectionIds: [] }
  }
  return patch
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>, syncOnline = true) {
  const state = useStore.getState()
  const { tasks, setTasks } = state
  const previousTask = tasks.find((task) => task.id === taskId)
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...normalizeFavoritePatch(t, patch, getFavoriteDefaultForProject(state, t.projectId)) } : t,
  )
  const task = updated.find((t) => t.id === taskId)
  setTasks(updated)
  if (previousTask?.status !== 'done' && task?.status === 'done' && task.outputImages.length > 0) playCompletionSound()
  maybeOpenSupportPrompt(tasks, updated, taskId)
  return task ? putTask(task, syncOnline) : undefined
}

function normalizeFavoriteCollectionIds(ids: unknown) {
  if (!Array.isArray(ids)) return []
  return Array.from(new Set(ids.map(String).filter((id) => id && id !== ALL_FAVORITES_COLLECTION_ID)))
}

function sameFavoriteCollectionIds(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((id) => bSet.has(id))
}

export function getTaskFavoriteCollectionIds(task: TaskRecord) {
  const ids = normalizeFavoriteCollectionIds(task.favoriteCollectionIds)
  if (ids.length > 0) return ids
  const defaultFavoriteCollectionId = getFavoriteDefaultForProject(useStore.getState(), task.projectId)
  return task.isFavorite && defaultFavoriteCollectionId ? [defaultFavoriteCollectionId] : []
}

export function getImageFavoriteCollectionIds(imageId: string, task?: TaskRecord) {
  const state = useStore.getState()
  const owner = task ?? state.tasks.find((item) => item.outputImages.includes(imageId))
  const projectId = owner?.projectId ?? (owner ? LOCAL_PROJECT_ID : undefined)
  const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined
  const ids = project?.canvas?.items[imageId]?.favoriteCollectionIds
  return ids !== undefined ? normalizeFavoriteCollectionIds(ids) : owner ? getTaskFavoriteCollectionIds(owner) : []
}

export function isImageFavorite(imageId: string, task?: TaskRecord) {
  return getImageFavoriteCollectionIds(imageId, task).length > 0
}

function normalizeTaskFavoriteState(task: TaskRecord, collections: FavoriteCollection[]): TaskRecord {
  const scopedCollections = getFavoriteCollectionsForProject(collections, task.projectId)
  const collectionIdSet = new Set(scopedCollections.map((collection) => collection.id))
  const normalizedIds = normalizeFavoriteCollectionIds(task.favoriteCollectionIds).filter((id) => collectionIdSet.has(id))
  // 旧版本只有 isFavorite 没有 favoriteCollectionIds，迁移到"默认"收藏夹
  const defaultId = getDefaultNamedFavoriteCollectionId(scopedCollections) ?? scopedCollections[0]?.id ?? null
  const ids = normalizedIds.length > 0 ? normalizedIds : task.isFavorite && defaultId ? [defaultId] : []
  const isFavorite = ids.length > 0 || Boolean(task.isFavorite)
  if (ids.length === (task.favoriteCollectionIds ?? []).length && ids.every((id, index) => id === task.favoriteCollectionIds?.[index]) && Boolean(task.isFavorite) === isFavorite) {
    return task
  }
  return { ...task, favoriteCollectionIds: ids, isFavorite }
}

function normalizeLoadedFavoriteState(tasks: TaskRecord[], collections: FavoriteCollection[], preferredDefaultFavoriteCollectionId: string | null) {
  let changed = false
  // 确保"默认"收藏夹存在，给孤立收藏任务一个归属
  const normalizedCollections = ensureDefaultNamedCollection(ensureDefaultFavoriteCollection(normalizeFavoriteCollections(collections)))
  const defaultFavoriteCollectionId = resolveDefaultFavoriteCollectionId(normalizedCollections, preferredDefaultFavoriteCollectionId)
  const normalizedTasks = tasks.map((task) => {
    const nextTask = normalizeTaskFavoriteState(task, normalizedCollections)
    if (nextTask !== task) changed = true
    return nextTask
  })
  return { tasks: normalizedTasks, collections: normalizedCollections, defaultFavoriteCollectionId, changed }
}

export function getFavoriteCollectionTitle(collectionId: string | null, collections = useStore.getState().favoriteCollections) {
  if (collectionId === ALL_FAVORITES_COLLECTION_ID) return '全部'
  return collections.find((collection) => collection.id === collectionId)?.name ?? DEFAULT_FAVORITE_COLLECTION_NAME
}

export function createFavoriteCollection(name: string) {
  const normalizedName = normalizeFavoriteCollectionName(name)
  if (!normalizedName) return null
  if (Array.from(normalizedName).length > 60) {
    useStore.getState().showToast('收藏夹名称最多 60 个字符', 'error')
    return null
  }
  const state = useStore.getState()
  const projectId = getFavoriteScopeProjectId(state.activeProjectId)
  const existing = getFavoriteCollectionsForProject(state.favoriteCollections, projectId)
    .find((collection) => collection.name === normalizedName)
  if (existing) return existing
  const now = Date.now()
  const collection: FavoriteCollection = { id: genId(), ...(projectId ? { projectId } : {}), name: normalizedName, createdAt: now, updatedAt: now }
  state.setFavoriteCollections([...state.favoriteCollections, collection])
  touchProject(projectId)
  state.showToast(`已创建收藏夹「${normalizedName}」`, 'success')
  return collection
}

export function replaceActiveFavoriteCollections(collections: FavoriteCollection[]) {
  const state = useStore.getState()
  const projectId = getFavoriteScopeProjectId(state.activeProjectId)
  state.setFavoriteCollections([
    ...state.favoriteCollections.filter((collection) => collection.projectId !== projectId),
    ...collections.map((collection) => ({
      ...collection,
      ...(projectId ? { projectId } : { projectId: undefined }),
    })),
  ])
  touchProject(projectId)
}

export function renameFavoriteCollection(collectionId: string, name: string) {
  const normalizedName = normalizeFavoriteCollectionName(name)
  if (!normalizedName || collectionId === ALL_FAVORITES_COLLECTION_ID) return
  if (Array.from(normalizedName).length > 60) {
    useStore.getState().showToast('收藏夹名称最多 60 个字符', 'error')
    return
  }
  const state = useStore.getState()
  const projectId = getFavoriteScopeProjectId(state.activeProjectId)
  const { favoriteCollections, setFavoriteCollections, showToast } = state
  setFavoriteCollections(favoriteCollections.map((collection) =>
    collection.id === collectionId && collection.projectId === projectId
      ? { ...collection, name: normalizedName, updatedAt: Date.now() }
      : collection,
  ))
  touchProject(projectId)
  showToast('收藏夹名称已更新', 'success')
}

export async function updateTasksFavoriteCollections(taskIds: string[], collectionIds: string[]) {
  const uniqueTaskIds = Array.from(new Set(taskIds)).filter(Boolean)
  if (!uniqueTaskIds.length) return
  const { tasks, setTasks, clearSelection, showToast } = useStore.getState()
  const idSet = new Set(uniqueTaskIds)
  const projectId = tasks.find((task) => idSet.has(task.id))?.projectId
  const validCollectionIds = new Set(getFavoriteCollectionsForProject(useStore.getState().favoriteCollections, projectId).map((collection) => collection.id))
  const ids = normalizeFavoriteCollectionIds(collectionIds).filter((id) => validCollectionIds.has(id))
  const changedTaskIds = new Set<string>()
  const updated = tasks.map((task) => {
    if (!idSet.has(task.id)) return task
    if (sameFavoriteCollectionIds(getTaskFavoriteCollectionIds(task), ids)) return task
    changedTaskIds.add(task.id)
    return { ...task, favoriteCollectionIds: ids, isFavorite: ids.length > 0 }
  })
  if (!changedTaskIds.size) {
    clearSelection()
    return
  }
  setTasks(updated)
  await Promise.all(updated.filter((task) => changedTaskIds.has(task.id)).map((task) => putTask(task)))
  clearSelection()
  showToast(ids.length ? '收藏夹已更新' : '已取消收藏', 'success')
}

export async function updateImagesFavoriteCollections(imageIds: string[], collectionIds: string[]) {
  const ids = Array.from(new Set(imageIds)).filter(Boolean)
  if (!ids.length) return
  const state = useStore.getState()
  const tasks = state.tasks.filter((task) => task.outputImages.some((imageId) => ids.includes(imageId)))
  const ownerProjectId = tasks.find((task) => task.projectId)?.projectId
  const projectId = ownerProjectId ?? (tasks.length ? LOCAL_PROJECT_ID : undefined)
  const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined
  if (!project) return

  const validCollectionIds = new Set(getFavoriteCollectionsForProject(state.favoriteCollections, ownerProjectId).map((collection) => collection.id))
  const favoriteCollectionIds = normalizeFavoriteCollectionIds(collectionIds).filter((id) => validCollectionIds.has(id))
  const projectTasks = state.tasks.filter((task) => projectId === LOCAL_PROJECT_ID ? !task.projectId : task.projectId === projectId)
  const outputImageIds = projectTasks.flatMap((task) => task.outputImages)
  const legacyFavoriteIdsByImage = Object.fromEntries(projectTasks.flatMap((task) =>
    task.outputImages.map((imageId) => [imageId, getTaskFavoriteCollectionIds(task)]),
  ))
  const canvas = ensureProjectCanvas(project.canvas, outputImageIds, legacyFavoriteIdsByImage)
  const items = { ...canvas.items }
  for (const imageId of ids) {
    const item = items[imageId]
    if (item) items[imageId] = { ...item, favoriteCollectionIds }
  }
  state.updateProjectCanvas(project.id, { ...canvas, items })
  state.showToast(favoriteCollectionIds.length ? '收藏夹已更新' : '已取消收藏', 'success')
}

export async function deleteFavoriteCollection(collectionId: string, deleteImages = false) {
  if (!collectionId || collectionId === ALL_FAVORITES_COLLECTION_ID) return
  const state = useStore.getState()
  const projectId = getFavoriteScopeProjectId(state.activeProjectId)
  const canvasProjectId = state.activeProjectId === LOCAL_PROJECT_ID ? LOCAL_PROJECT_ID : projectId
  const scopedCollections = getFavoriteCollectionsForProject(state.favoriteCollections, projectId)
  const collection = scopedCollections.find((item) => item.id === collectionId)
  if (!collection || scopedCollections.length <= 1) return
  const project = canvasProjectId ? state.projects.find((item) => item.id === canvasProjectId) : undefined
  const projectTasks = state.tasks.filter((task) => canvasProjectId === LOCAL_PROJECT_ID ? !task.projectId : task.projectId === canvasProjectId)
  const canvas = project ? ensureProjectCanvas(
    project.canvas,
    projectTasks.flatMap((task) => task.outputImages),
    Object.fromEntries(projectTasks.flatMap((task) =>
      task.outputImages.map((imageId) => [imageId, getTaskFavoriteCollectionIds(task)]),
    )),
  ) : undefined
  const nextCollections = state.favoriteCollections.filter((item) => item.id !== collectionId || item.projectId !== projectId)
  const nextScopedCollections = getFavoriteCollectionsForProject(nextCollections, projectId)
  const nextCollectionIdSet = new Set(nextScopedCollections.map((item) => item.id))
  state.setFavoriteCollections(nextCollections)
  if (getFavoriteDefaultForProject(state, projectId) === collectionId) {
    useStore.getState().setDefaultFavoriteCollectionId(nextScopedCollections[0]?.id ?? null)
  }
  if (state.activeFavoriteCollectionId === collectionId) state.setActiveFavoriteCollectionId(null)
  let imageIdsToDelete: string[] = []
  if (project && canvas) {
    const result = removeCanvasFavoriteCollection(canvas, collectionId, nextCollectionIdSet, deleteImages)
    imageIdsToDelete = result.imageIdsToDelete
    state.updateProjectCanvas(project.id, result.canvas)
  }

  const changedTaskIds = new Set<string>()
  const updatedTasks = useStore.getState().tasks.map((task) => {
    if (task.projectId !== projectId) return task
    const currentIds = getTaskFavoriteCollectionIds(task)
    const favoriteCollectionIds = currentIds.filter((id) => id !== collectionId && nextCollectionIdSet.has(id))
    if (sameFavoriteCollectionIds(currentIds, favoriteCollectionIds)) return task
    changedTaskIds.add(task.id)
    return { ...task, favoriteCollectionIds, isFavorite: favoriteCollectionIds.length > 0 }
  })
  if (changedTaskIds.size) {
    useStore.getState().setTasks(updatedTasks)
    await Promise.all(updatedTasks.filter((task) => changedTaskIds.has(task.id)).map((task) => putTask(task)))
  }

  for (const imageId of imageIdsToDelete) {
    const owner = useStore.getState().tasks.find((task) => task.outputImages.includes(imageId))
    if (owner) await removeOutputImage(owner, imageId)
  }
  useStore.getState().setSelectedFavoriteCollectionIds((ids) => ids.filter((id) => id !== collectionId))
  touchProject(projectId)
  useStore.getState().showToast(`已删除收藏夹「${collection.name}」`, 'success')
}

/** 重试失败的任务：创建新任务并执行 */
export async function retryTask(task: TaskRecord) {
  const { settings, oidcApiOverride } = useStore.getState()
  const baseProfile = getActiveApiProfile(settings)
  const apiOverride = oidcApiOverride?.apiKey
    ? { ...oidcApiOverride }
    : task.apiOverride && (task.apiOverride.apiKey || task.apiOverride.model)
    ? { ...task.apiOverride }
    : undefined
  const isCompositeRetry = apiOverride?.platform?.trim().toLowerCase() === 'composite' && Boolean(apiOverride.apiKey)
  const activeProfile = {
    ...baseProfile,
    ...(!isCompositeRetry && task.sourceMode !== 'agent' && (task.apiProvider === 'openai' || (!task.apiProvider && baseProfile.provider === 'openai')) ? { apiMode: 'images' as const } : {}),
  }
  const requestSettings = createSettingsForApiProfile(settings, {
    ...activeProfile,
    ...(apiOverride?.apiKey ? { apiKey: apiOverride.apiKey } : {}),
    ...(apiOverride?.model ? { model: apiOverride.model } : {}),
  })
  const normalizedParams = normalizeParamsForSettings(task.params, requestSettings, { hasInputImages: task.inputImageIds.length > 0 })
  const shouldUseTransparentOutput = normalizedParams.output_format === 'png' && normalizedParams.transparent_output
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const transparentMeta = taskParams.transparent_output
    ? createTransparentOutputMeta(task.prompt.trim())
    : null
  const taskId = genId()
  const newTask: TaskRecord = {
    id: taskId,
    requestId: createRequestId(),
    ...(task.projectId ? { projectId: task.projectId } : {}),
    prompt: task.prompt,
    params: taskParams,
    apiProvider: activeProfile.provider,
    apiProfileId: activeProfile.id,
    apiProfileName: activeProfile.name,
    apiMode: activeProfile.apiMode,
    apiModel: apiOverride?.model || activeProfile.model,
    ...(apiOverride ? { apiOverride } : {}),
    inputImageIds: [...task.inputImageIds],
    maskTargetImageId: task.maskTargetImageId ?? null,
    maskImageId: task.maskImageId ?? null,
    transparentOutput: transparentMeta?.transparentOutput,
    transparentPrompt: transparentMeta?.effectivePrompt,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([newTask, ...latestTasks])
  await putTask(newTask)
  touchProject(task.projectId, false)

  executeTask(taskId)
}

/** 复用配置 */
export async function reuseConfig(task: TaskRecord) {
  const { settings, setPrompt, setParams, setInputImages, setMaskDraft, clearMaskDraft, showToast, setConfirmDialog, setReusedTaskApiProfile } = useStore.getState()
  const normalizedSettings = normalizeSettings(settings)
  const currentProfile = getActiveApiProfile(settings)
  const matchedProfile = normalizedSettings.reuseTaskApiProfileTemporarily ? getTaskApiProfile(normalizedSettings, task) : null
  const shouldTemporarilyReuseProfile = Boolean(matchedProfile && matchedProfile.id !== currentProfile.id)
  const missingReusedProfile = normalizedSettings.reuseTaskApiProfileTemporarily && !matchedProfile
  const taskProfileName = matchedProfile?.name ?? getTaskApiProfileName(task)
  const paramsSettings = shouldTemporarilyReuseProfile && matchedProfile ? createSettingsForApiProfile(normalizedSettings, matchedProfile) : normalizedSettings

  setParams(normalizeParamsForSettings(task.params, paramsSettings, { hasInputImages: task.inputImageIds.length > 0 }))
  setReusedTaskApiProfile(
    shouldTemporarilyReuseProfile && matchedProfile ? matchedProfile.id : null,
    missingReusedProfile,
    taskProfileName,
  )
  clearMaskDraft()

  // 恢复输入图片
  const imgs: InputImage[] = []
  for (const imgId of task.inputImageIds) {
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      imgs.push({ id: imgId, dataUrl })
    }
  }
  setInputImages(imgs)
  setPrompt(task.prompt)
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  if (missingReusedProfile) {
    setConfirmDialog({
      title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${taskProfileName}」，要使用当前的 API 配置「${currentProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ useCurrentApiProfileWhenReusedMissing: true })
      },
    })
    return
  }

  showToast(
    shouldTemporarilyReuseProfile && matchedProfile
      ? `已临时复用该任务的 API 配置「${matchedProfile.name}」`
      : '已复用配置到输入框',
    'success',
  )
}

/** 编辑输出：将输出图加入输入 */
export async function editOutputs(task: TaskRecord) {
  const { inputImages, addInputImage, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  let added = 0
  for (const imgId of task.outputImages) {
    if (inputImages.find((i) => i.id === imgId)) continue
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      addInputImage({ id: imgId, dataUrl })
      added++
    }
  }
  showToast(`已添加 ${added} 张输出图到输入`, 'success')
}

export async function editOutputImage(task: TaskRecord, imageId: string) {
  const { inputImages, addInputImage, showToast } = useStore.getState()
  if (!task.outputImages.includes(imageId)) return
  if (inputImages.some((image) => image.id === imageId)) {
    showToast('图片已在输入中', 'info')
    return
  }
  if (inputImages.length >= 16) {
    showToast('参考图数量已达上限（16 张）', 'error')
    return
  }
  const dataUrl = await ensureImageCached(imageId)
  if (!dataUrl) {
    showToast('图片已不存在', 'error')
    return
  }
  addInputImage({ id: imageId, dataUrl })
  showToast('已添加当前图片到输入', 'success')
}

export function reuseImageConfig(task: TaskRecord, _imageId?: string) {
  return reuseConfig(task)
}

export function retryImage(task: TaskRecord) {
  return retryTask({ ...task, params: { ...task.params, n: 1 } })
}

export async function removeOutputImage(task: TaskRecord, imageId: string) {
  const result = removeTaskOutputImageRecord(task, imageId)
  if (!result) return
  const state = useStore.getState()
  const tasks = state.tasks.map((item) => item.id === task.id ? result.task : item)
  state.setTasks(tasks)
  await putTask(result.task)

  if (task.projectId) {
    const project = useStore.getState().projects.find((item) => item.id === task.projectId)
    if (project?.canvas) {
      const items = { ...project.canvas.items }
      delete items[imageId]
      useStore.getState().updateProjectCanvas(project.id, { ...project.canvas, items })
    } else {
      touchProject(task.projectId)
    }
  }

  if (state.lightboxImageId === imageId) state.setLightboxImageId(null)
  if (state.detailImageId === imageId) state.setDetailTaskId(null)
  await deleteUnreferencedImageIds(result.removedImageIds)
  if (task.projectId) scheduleOnlineProjectSync(task.projectId, 0)
  state.showToast('已删除当前图片', 'success')
}

/** 删除多条任务 */
export async function removeMultipleTasks(taskIds: string[]) {
  const { tasks, setTasks, inputImages, galleryInputDraft, showToast, selectedTaskIds } = useStore.getState()
  
  if (!taskIds.length) return

  const toDelete = new Set(taskIds)
  const deletedTasks = tasks.filter(t => toDelete.has(t.id))
  const remaining = await scrubAgentOutputPayloadsForDeletedTasks(deletedTasks, tasks.filter(t => !toDelete.has(t.id)))
  await Promise.all(deletedTasks.map((task) => deleteOnlineTaskRecord(task)))

  // 收集所有被删除任务的关联图片
  const deletedImageIds = new Set<string>()
  for (const t of tasks) {
    if (toDelete.has(t.id)) {
      addTaskReferencedImageIds(deletedImageIds, t)
    }
  }

  setTasks(remaining)
  for (const id of taskIds) {
    await dbDeleteTask(id)
  }

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    addTaskReferencedImageIds(stillUsed, t)
  }
  addAgentReferencedImageIds(stillUsed)
  addInputDraftReferencedImageIds(stillUsed, galleryInputDraft)
  for (const img of inputImages) stillUsed.add(img.id)

  // 删除孤立图片
  for (const imgId of deletedImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
      thumbnailCache.delete(imgId)
    }
  }
  for (const projectId of new Set(deletedTasks.map((task) => task.projectId).filter((id): id is string => Boolean(id)))) {
    touchProject(projectId, false)
  }

  // 如果删除的任务在选中列表中，则移除
  const newSelection = selectedTaskIds.filter(id => !toDelete.has(id))
  if (newSelection.length !== selectedTaskIds.length) {
    useStore.getState().setSelectedTaskIds(newSelection)
  }

  showToast(`已删除 ${taskIds.length} 个任务`, 'success')
}

/** 删除所有失败任务 */
export async function clearFailedTasks(taskIds?: string[]) {
  const targetTaskIds = taskIds ? new Set(taskIds) : null
  const failedTasks = useStore.getState().tasks
    .filter((task) => taskMatchesFilterStatus(task, 'error') && (!targetTaskIds || targetTaskIds.has(task.id)))
  const failedTaskIds = failedTasks
    .filter((task) => task.status === 'error')
    .map((task) => task.id)
  const partialFailedTaskIds = new Set(
    failedTasks
      .filter((task) => task.status !== 'error' && taskHasOutputErrors(task))
      .map((task) => task.id),
  )

  if (failedTaskIds.length) await removeMultipleTasks(failedTaskIds)
  if (partialFailedTaskIds.size) {
    const { tasks, setTasks, selectedTaskIds, setSelectedTaskIds, showToast } = useStore.getState()
    const updated = tasks.map((task) => partialFailedTaskIds.has(task.id) ? { ...task, outputErrors: undefined } : task)
    setTasks(updated)
    const nextSelectedTaskIds = selectedTaskIds.filter((id) => !partialFailedTaskIds.has(id))
    if (nextSelectedTaskIds.length !== selectedTaskIds.length) setSelectedTaskIds(nextSelectedTaskIds)
    await Promise.all(updated.filter((task) => partialFailedTaskIds.has(task.id)).map((task) => putTask(task)))
    showToast(`已清除 ${partialFailedTaskIds.size} 条部分失败记录`, 'success')
  }
}

/** 删除单条任务 */
export async function removeTask(task: TaskRecord) {
  const { tasks, setTasks, inputImages, galleryInputDraft, showToast } = useStore.getState()

  // 收集此任务关联的图片
  const taskImageIds = new Set([
    ...(task.inputImageIds || []),
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...(task.outputImages || []),
    ...(task.transparentOriginalImages || []),
    ...(task.streamPartialImageIds || []),
  ])

  // 从列表移除
  const remaining = await scrubAgentOutputPayloadsForDeletedTasks([task], tasks.filter((t) => t.id !== task.id))
  await deleteOnlineTaskRecord(task)
  setTasks(remaining)
  await dbDeleteTask(task.id)

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    addTaskReferencedImageIds(stillUsed, t)
  }
  addAgentReferencedImageIds(stillUsed)
  addInputDraftReferencedImageIds(stillUsed, galleryInputDraft)
  for (const img of inputImages) stillUsed.add(img.id)

  // 删除孤立图片
  for (const imgId of taskImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
      thumbnailCache.delete(imgId)
    }
  }
  if (task.projectId) {
    touchProject(task.projectId, false)
  }

  showToast('任务已删除', 'success')
}

/** 清空数据选项 */
export interface ClearOptions {
  clearConfig?: boolean
  clearTasks?: boolean
}

/** 清空数据 */
export async function clearData(options: ClearOptions = { clearConfig: true, clearTasks: true }) {
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()

  if (options.clearTasks) {
    await dbClearTasks()
    await Promise.allSettled(projectPersistenceQueues.values())
    await dbClearProjects()
    await dbClearAgentConversations()
    await clearImages()
    imageCache.clear()
    thumbnailCache.clear()
    thumbnailBackfillIds.clear()
    setTasks([])
    useStore.setState({
      agentConversations: [],
      activeAgentConversationId: null,
      projects: [],
      activeProjectId: null,
      supportPromptOpen: false,
      supportPromptSkippedForImportedData: false,
    })
    clearInputImages()
    clearMaskDraft()
  }

  if (options.clearConfig) {
    useStore.setState({ dismissedCodexCliPrompts: [], supportPromptDismissed: false })
    setSettings({ ...DEFAULT_SETTINGS })
    setParams({ ...DEFAULT_PARAMS })
  }

  showToast('所选数据已清空', 'success')
}

async function completeRecoveredCustomTask(task: TaskRecord, result: Awaited<ReturnType<typeof getCustomQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return

  const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
  const actualParamsList = await resolveImageSizeParamsList(outputDataUrls, undefined, outputImageSizes)

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    transparentOriginalImages: transparentOriginalImageIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    status: 'done',
    error: null,
    customRecoverable: false,
    finishedAt: Date.now(),
    elapsed: Date.now() - task.createdAt,
  })
  useStore.getState().showToast(`自定义异步任务已恢复，共 ${outputIds.length} 张图片`, 'success')
  if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `自定义异步任务已恢复，共 ${outputIds.length} 张图片。`)
}

async function recoverCustomTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || !task.customTaskId || task.status === 'done') return
  const requestId = task.requestId ?? createRequestId()
  if (!task.requestId) void updateTaskInStore(taskId, { requestId })

  const profile = getCustomRecoveryProfile(settings, task)
  const customProvider = task.apiProvider ? getCustomProviderDefinition(settings, task.apiProvider) : null
  const poll = task.inputImageIds.length > 0 && customProvider?.editPoll ? customProvider.editPoll : customProvider?.poll
  if (!profile || !customProvider || !poll) {
    scheduleCustomRecovery(taskId)
    return
  }

  try {
    const result = await getCustomQueuedImageResult(profile, customProvider, task.customTaskId, task.params, task.inputImageIds.length > 0, requestId)
    clearCustomRecoveryTimer(taskId)
    await completeRecoveredCustomTask(task, result)
  } catch (err) {
    clearCustomRecoveryTimer(taskId)
    updateTaskInStore(taskId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      ...getRawErrorPayload(err),
      customRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
  }
}

/** 导出选项 */
export interface ExportOptions {
  exportConfig?: boolean
  exportTasks?: boolean
}

/** 导出数据为 ZIP */
export async function exportData(options: ExportOptions = { exportConfig: true, exportTasks: true }) {
  try {
    const tasks = options.exportTasks ? await getAllTasks() : []
    const images = options.exportTasks ? await getAllImages() : []
    const { settings, agentConversations, projects, favoriteCollections, defaultFavoriteCollectionId } = useStore.getState()
    const exportedAt = Date.now()
    const thumbnailsByImageId = new Map<string, NonNullable<Awaited<ReturnType<typeof getImageThumbnail>>>>()

    if (options.exportTasks) {
      for (const img of images) {
        const thumbnail = await getImageThumbnail(img.id)
        if (thumbnail?.thumbnailDataUrl) {
          thumbnailsByImageId.set(img.id, thumbnail)
          cacheThumbnail(img.id, {
            dataUrl: thumbnail.thumbnailDataUrl,
            width: thumbnail.width,
            height: thumbnail.height,
            thumbnailVersion: thumbnail.thumbnailVersion,
          })
        }
      }
    }

    const { bytes: zipped } = buildExportZip({
      options,
      exportedAt,
      settings,
      tasks,
      projects,
      images,
      thumbnailsByImageId,
      favoriteCollections,
      defaultFavoriteCollectionId,
      agentConversations: getPersistableAgentConversations(agentConversations),
    })
    const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gpt-image-playground-backup_${formatExportFileTime(new Date(exportedAt))}.zip`
    a.click()
    URL.revokeObjectURL(url)
    useStore.getState().showToast('数据已导出', 'success')
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导出失败：${e instanceof Error ? e.message : String(e)}`,
        'error',
      )
  }
}

/** 导入选项 */
export interface ImportOptions {
  importConfig?: boolean
  importTasks?: boolean
}

/** 导入 ZIP 数据 */
export async function importData(file: File, options: ImportOptions = { importConfig: true, importTasks: true }): Promise<boolean> {
  try {
    const buffer = await file.arrayBuffer()
    const { manifest: data, files } = readExportZip(new Uint8Array(buffer))

    const importedImageIds: string[] = []
    if (options.importTasks && data.tasks && data.imageFiles) {
      // 还原图片
      for (const [id, info] of Object.entries(data.imageFiles)) {
        const dataUrl = readExportZipFileAsDataUrl(files, info.path)
        if (!dataUrl) continue
        await putImage({
          id,
          dataUrl,
          createdAt: info.createdAt,
          source: info.source,
          width: info.width,
          height: info.height,
        })
        cacheImage(id, dataUrl)
        importedImageIds.push(id)
      }

      for (const [id, info] of Object.entries(data.thumbnailFiles ?? {})) {
        const thumbnailDataUrl = readExportZipFileAsDataUrl(files, info.path)
        if (!thumbnailDataUrl) continue
        await putImageThumbnail({
          id,
          thumbnailDataUrl,
          width: info.width,
          height: info.height,
          thumbnailVersion: info.thumbnailVersion,
        })
        cacheThumbnail(id, {
          dataUrl: thumbnailDataUrl,
          width: info.width,
          height: info.height,
          thumbnailVersion: info.thumbnailVersion,
        })
      }

      for (const task of data.tasks) {
        await putTask(task)
      }

      const tasks = await getAllTasks()
      const state = useStore.getState()
      const importedCollections = normalizeFavoriteCollections(data.favoriteCollections)
      const favoriteCollections = importedCollections.length
        ? ensureDefaultFavoriteCollection(normalizeFavoriteCollections([...state.favoriteCollections, ...importedCollections]))
        : state.favoriteCollections
      const defaultFavoriteCollectionId = importedCollections.length
        ? resolveDefaultFavoriteCollectionId(favoriteCollections, data.defaultFavoriteCollectionId)
        : state.defaultFavoriteCollectionId
      const normalizedFavorites = normalizeLoadedFavoriteState(tasks, favoriteCollections, defaultFavoriteCollectionId)
      const importedProjects = normalizeProjects(data.projects)
      const projects = normalizeProjects([...state.projects, ...importedProjects])
      useStore.setState({
        tasks: normalizedFavorites.tasks,
        projects,
        favoriteCollections: normalizedFavorites.collections,
        defaultFavoriteCollectionId: normalizedFavorites.defaultFavoriteCollectionId,
      })
      if (normalizedFavorites.changed) await Promise.all(normalizedFavorites.tasks.map((task) => putTask(task)))
      await Promise.all(importedProjects.map((project) => dbPutProject(project)))
      const importedAgentConversations = normalizeAgentConversations(data.agentConversations)
        .filter((conversation) => !isEmptyAgentConversation(conversation))
      useStore.setState((state) => {
        const agentConversations = mergeImportedAgentConversations(state.agentConversations, importedAgentConversations)
        const activeAgentConversationId = state.activeAgentConversationId && agentConversations.some((conversation) => conversation.id === state.activeAgentConversationId)
          ? state.activeAgentConversationId
          : importedAgentConversations[0]?.id ?? agentConversations[0]?.id ?? null
        return {
          agentConversations,
          activeAgentConversationId,
        }
      })
      await replaceStoredAgentConversations(useStore.getState().agentConversations)
      skipSupportPromptForImportedData(tasks)
      scheduleThumbnailBackfill(importedImageIds)
    }

    if (options.importConfig && data.settings) {
      const state = useStore.getState()
      state.setSettings(mergeImportedSettings(state.settings, data.settings))
    }

    let msg = '数据已成功导入'
    if (options.importTasks && data.tasks) {
      msg = `已导入 ${data.tasks.length} 个任务`
    } else if (options.importConfig && data.settings) {
      msg = '配置已成功导入'
    }

    useStore.getState().showToast(msg, 'success')
    return true
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导入失败：${e instanceof Error ? e.message : String(e)}`,
        'error',
      )
    return false
  }
}

/** 添加图片到输入（文件上传） */
export async function addImageFromFile(file: File): Promise<void> {
  const image = await createInputImageFromFile(file)
  if (!image) return
  useStore.getState().addInputImage(image)
}

export async function createInputImageFromFile(file: File): Promise<InputImage | null> {
  if (!file.type.startsWith('image/')) return null
  const dataUrl = await fileToDataUrl(file)
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  return { id, dataUrl }
}

/** 添加图片到输入（右键菜单）—— 支持 data/blob/http URL */
export async function addImageFromUrl(src: string): Promise<void> {
  const res = await fetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  const dataUrl = await blobToDataUrl(blob)
  const image = await createInputImageFromDataUrl(dataUrl)
  useStore.getState().addInputImage(image)
}

export async function createInputImageFromDataUrl(dataUrl: string): Promise<InputImage> {
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  return { id, dataUrl }
}

export async function createInputImageFromUrl(src: string): Promise<InputImage> {
  const res = await fetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('素材不是有效图片')
  return createInputImageFromDataUrl(await blobToDataUrl(blob))
}
