import type { Project, TaskParams, TaskRecord } from '../types'
import { authFetch, REQUEST_ID_HEADER } from '../auth/api'
import { createImageStatusRequestId, type CallApiResult } from './imageApiShared'
import { getOnlineProjectRecord } from './onlineProjects'

interface BackendGenerationResponse {
  images?: unknown
  image_ids?: unknown
  actual_params?: unknown
  actual_params_list?: unknown
  revised_prompts?: unknown
  task_record_queued?: unknown
}

const IMAGE_LOG_PREVIEW_CHARS = 120

function truncateImageLogString(value: string) {
  if (value.length <= IMAGE_LOG_PREVIEW_CHARS) return value
  return value.slice(0, IMAGE_LOG_PREVIEW_CHARS) + '... [已截断，原长度 ' + value.length + ']'
}

function formatSecretLogString(value: string) {
  if (value === '') return value
  if (value.length <= 12) return '***'
  return value.slice(0, 6) + '...' + value.slice(-4)
}

function formatImageApiLogValue(value: unknown, key = ''): unknown {
  const lowerKey = key.toLowerCase()
  const isImageField = lowerKey === 'mask' || lowerKey.includes('image') || lowerKey.includes('b64')
  const isSecretField = lowerKey === 'api_key' || lowerKey === 'apikey' || lowerKey === 'api-key' || lowerKey === 'authorization'

  if (typeof value === 'string') {
    if (isSecretField) return formatSecretLogString(value)
    if (value.startsWith('data:image/') || (isImageField && value.length > IMAGE_LOG_PREVIEW_CHARS)) {
      return truncateImageLogString(value)
    }
    return value
  }
  if (Array.isArray(value)) return value.map((item) => formatImageApiLogValue(item, key))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, item]) => [
        entryKey,
        formatImageApiLogValue(item, entryKey),
      ]),
    )
  }
  return value
}

export async function callBackendImageApi(options: {
  project: Project
  task: TaskRecord
  manageTaskRecord?: boolean
  apiKey: string
  provider: 'openai'
  model: string
  apiMode: 'images' | 'responses'
  allowPromptRewrite: boolean
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
  onImageStatusRequestCreated?: (request: { requestId: string; requestIndex?: number }) => void
}): Promise<CallApiResult> {
  const requestCount = options.apiMode === 'responses' ? 1 : Math.max(1, options.params.n)
  const requestIds = Array.from({ length: requestCount }, (_, requestIndex) => {
    const requestId = createImageStatusRequestId()
    options.onImageStatusRequestCreated?.({
      requestId,
      ...(requestCount > 1 ? { requestIndex } : {}),
    })
    return requestId
  })
  const isEdit = options.inputImageDataUrls.length > 0 || Boolean(options.maskDataUrl)
  const endpointType = isEdit ? 'edits' : 'generations'
  const upstreamPath = options.apiMode === 'responses'
    ? '/v1/responses'
    : isEdit
    ? '/v1/images/edits'
    : '/v1/images/generations'
  const requestBody = {
    task_id: options.task.id,
    project_title: options.project.title,
    ...(options.manageTaskRecord ? {
      project: getOnlineProjectRecord(options.project),
      task: {
        ...options.task,
        imageStatusRequestIds: requestIds,
        imageStatusRecoverable: false,
      },
    } : {}),
    api_key: options.apiKey,
    provider: options.provider,
    model: options.model,
    api_mode: options.apiMode,
    allow_prompt_rewrite: options.allowPromptRewrite,
    request_ids: requestIds,
    prompt: options.prompt,
    params: options.params,
    input_images: options.inputImageDataUrls,
    mask: options.maskDataUrl,
  }
  console.log('[BackendImageApi] 请求内容', {
    endpoint: `/api/v1/projects/${encodeURIComponent(options.project.remoteId ?? options.project.id)}/${endpointType}`,
    upstreamPath,
    body: formatImageApiLogValue(requestBody),
  })
  const resp = await authFetch(`/api/v1/projects/${encodeURIComponent(options.project.remoteId ?? options.project.id)}/${endpointType}`, {
    method: 'POST',
    headers: options.task.requestId ? { [REQUEST_ID_HEADER]: options.task.requestId } : undefined,
    body: JSON.stringify(requestBody),
  })
  const data = await resp.json().catch(() => null) as BackendGenerationResponse & { message?: string } | null
  console.log('[BackendImageApi] 回包内容', {
    ok: resp.ok,
    status: resp.status,
    data: formatImageApiLogValue(data),
  })
  if (!resp.ok) {
    const error = Object.assign(new Error(data?.message || `后端生图失败：HTTP ${resp.status}`), {
      status: resp.status,
      rawResponsePayload: data ? JSON.stringify(data) : undefined,
    })
    throw error
  }

  const images = Array.isArray(data?.images) ? data.images.filter((item): item is string => typeof item === 'string' && item.startsWith('data:image/')) : []
  if (images.length === 0) throw new Error('后端生图接口没有返回图片')

  const actualParams = data?.actual_params && typeof data.actual_params === 'object'
    ? data.actual_params as Partial<TaskParams>
    : undefined
  const actualParamsList = Array.isArray(data?.actual_params_list)
    ? data.actual_params_list.map((item) => item && typeof item === 'object' ? item as Partial<TaskParams> : undefined)
    : images.map(() => actualParams)
  const revisedPrompts = Array.isArray(data?.revised_prompts)
    ? data.revised_prompts.map((item) => typeof item === 'string' ? item : undefined)
    : undefined
  const imageIds = Array.isArray(data?.image_ids)
    ? data.image_ids.filter((item): item is string => typeof item === 'string')
    : undefined

  return {
    images,
    actualParams,
    actualParamsList,
    revisedPrompts,
    imagesStoredOnline: true,
    imageIds,
    taskRecordQueued: data?.task_record_queued === true,
  }
}
