import type { TaskParams } from '../types'
import { authFetch, REQUEST_ID_HEADER } from '../auth/api'
import { dataUrlToBlob } from './canvasImage'
import { fetchImageUrlAsDataUrl, isHttpUrl, MIME_MAP, type CallApiResult } from './imageApiShared'

interface CompositeSubmitResponse {
  request_id?: unknown
  status_url?: unknown
}

interface CompositeStatusResponse {
  status?: unknown
  message?: unknown
  error?: unknown
  actual_cost?: unknown
  images?: unknown
}

const COMPOSITE_API_KEY_HEADER = 'X-Upstream-API-Key'
const POLL_TIMEOUT_MS = 10 * 60 * 1000
const MAX_RETRIES = 3

function encodePath(value: string) {
  const parts = value.trim().split('/').filter(Boolean)
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error('Composite 模型名称不能为空')
  }
  return parts.map((part) => encodeURIComponent(part)).join('/')
}

function normalizeCompositeModelPath(value: string) {
  const path = encodePath(value)
  return path.endsWith('/edit') ? path.slice(0, -'/edit'.length) : path
}

function formatLogValue(value: unknown, key = ''): unknown {
  const lowerKey = key.toLowerCase()
  if (typeof value === 'string') {
    if (lowerKey.includes('key') || lowerKey === 'authorization') return '***'
    if (value.startsWith('data:')) return `[data URL: length=${value.length}]`
    return value
  }
  if (Array.isArray(value)) return value.map((item) => formatLogValue(item, key))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([itemKey, item]) => [itemKey, formatLogValue(item, itemKey)]))
  }
  return value
}

function errorMessage(value: unknown, fallback: string) {
  if (!value || typeof value !== 'object') return fallback
  const data = value as Record<string, unknown>
  if (typeof data.message === 'string' && data.message.trim()) return data.message
  if (typeof data.detail === 'string' && data.detail.trim()) return data.detail
  if (typeof data.error === 'string' && data.error.trim()) return data.error
  if (data.error && typeof data.error === 'object') {
    const message = (data.error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestJson(path: string, apiKey: string, clientRequestId?: string, init: RequestInit = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      console.log('[BackendCompositeImageApi] 请求内容', {
        method: init.method ?? 'GET',
        endpoint: path,
        attempt: attempt + 1,
        body: typeof init.body === 'string' ? formatLogValue(JSON.parse(init.body)) : undefined,
      })
      const response = await authFetch(path, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          [COMPOSITE_API_KEY_HEADER]: apiKey,
          ...(clientRequestId ? { [REQUEST_ID_HEADER]: clientRequestId } : {}),
        },
        cache: 'no-store',
      })
      const data = await response.json().catch(() => null) as unknown
      console.log('[BackendCompositeImageApi] 回包内容', {
        endpoint: path,
        status: response.status,
        data: formatLogValue(data),
      })
      if (response.ok) return data
      if (response.status < 500 || attempt >= MAX_RETRIES) {
        throw Object.assign(new Error(errorMessage(data, `Composite 请求失败：HTTP ${response.status}`)), { retryable: false })
      }
    } catch (err) {
      if (err instanceof Error && (err as Error & { retryable?: boolean }).retryable === false) throw err
      if (attempt >= MAX_RETRIES) throw err
    }
    await sleep(1000 * 2 ** attempt)
  }
}

function getFailureMessage(status: CompositeStatusResponse) {
  if (typeof status.message === 'string' && status.message.trim()) return status.message
  if (typeof status.error === 'string' && status.error.trim()) return status.error
  if (status.error && typeof status.error === 'object') {
    const message = (status.error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return 'Composite 异步任务失败'
}

function getActualCost(value: unknown) {
  const cost = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(cost) && cost >= 0 ? cost : undefined
}

async function readCompositeTaskResult(options: {
  apiKey: string
  model: string
  requestId: string
  clientRequestId?: string
  params: TaskParams
}): Promise<CallApiResult | null> {
  const modelPath = normalizeCompositeModelPath(options.model)
  const resultPath = `/api/v1/model/${modelPath}/requests/${encodeURIComponent(options.requestId)}`
  const status = await requestJson(resultPath, options.apiKey, options.clientRequestId) as CompositeStatusResponse
  const statusText = typeof status.status === 'string' ? status.status.trim().toUpperCase() : ''
  if (!statusText) throw new Error('Composite 上游返回了无效的任务状态')
  switch (statusText) {
    case 'IN_QUEUE':
    case 'IN_PROGRESS':
      return null
    case 'FAILED':
    case 'CANCELED':
      throw new Error(getFailureMessage(status))
    case 'COMPLETED':
      break
    default:
      throw new Error(`Composite 上游返回了未知的任务状态：${statusText}`)
  }

  const actualCost = getActualCost(status.actual_cost)
  const items = Array.isArray(status.images) ? status.images : []
  const urls = items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const url = (item as Record<string, unknown>).url
    return typeof url === 'string' && url.trim() ? [url] : []
  })
  if (urls.length === 0) throw new Error('Composite 上游没有返回图片')
  const mime = MIME_MAP[options.params.output_format] ?? 'image/png'
  const images = await Promise.all(urls.map((url) => fetchImageUrlAsDataUrl(url, mime)))
  return {
    images,
    rawImageUrls: urls,
    actualParams: { ...options.params, n: images.length },
    actualParamsList: images.map(() => ({ ...options.params, n: images.length })),
    revisedPrompts: images.map(() => undefined),
    imagesStoredOnline: false,
    ...(actualCost !== undefined ? { actualCost } : {}),
  }
}

export async function queryBackendCompositeImageTask(options: {
  apiKey: string
  model: string
  requestId: string
  clientRequestId?: string
  params: TaskParams
}): Promise<CallApiResult | null> {
  return readCompositeTaskResult(options)
}

async function uploadReferenceFile(dataUrl: string, name: string, clientRequestId?: string): Promise<{ url: string; uploaded: boolean }> {
  if (isHttpUrl(dataUrl)) return { url: dataUrl, uploaded: false }
  const blob = await dataUrlToBlob(dataUrl)
  const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'
  const fileName = `${name}.${extension}`
  const formData = new FormData()
  formData.append('file', blob, fileName)
  console.log('[BackendCompositeImageApi] 参考文件上传请求', {
    endpoint: '/api/v1/files',
    fileName,
    contentType: blob.type,
    size: blob.size,
  })
  const response = await authFetch('/api/v1/files', {
    method: 'POST',
    headers: clientRequestId ? { [REQUEST_ID_HEADER]: clientRequestId } : undefined,
    body: formData,
  })
  const data = await response.json().catch(() => null) as { data?: { url?: unknown }; code?: unknown; message?: unknown } | null
  console.log('[BackendCompositeImageApi] 参考文件上传回包', {
    status: response.status,
    data: formatLogValue(data),
  })
  if (!response.ok) throw new Error(errorMessage(data, `参考图上传失败：HTTP ${response.status}`))
  const url = typeof data?.data?.url === 'string' ? data.data.url.trim() : ''
  if (!url) throw new Error('File API 未返回 data.url')
  return { url, uploaded: true }
}

export async function callBackendCompositeImageApi(options: {
  apiKey: string
  clientRequestId?: string
  model: string
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  inputImageFileUrls?: Array<string | undefined>
  maskDataUrl?: string
  maskFileUrl?: string
  onRequestCreated?: (request: { requestId: string; statusUrl?: string }) => void | Promise<void>
  onReferenceUploaded?: (reference: { source: 'inputImage' | 'mask'; index: number; url: string }) => void | Promise<void>
  onReferenceUploadFailed?: (error: Error) => void
}): Promise<CallApiResult> {
  const modelPath = normalizeCompositeModelPath(options.model)
  const isEdit = options.inputImageDataUrls.length > 0 || Boolean(options.maskDataUrl)
  // Composite 的生成和编辑共用 model 根路径，编辑信息通过请求体传递。
  const requestPath = `/api/v1/model/${modelPath}`
  const [width, height] = options.params.size.split('x').map(Number)
  const payload: Record<string, unknown> = {
    prompt: options.prompt,
    image_size: {
      width: Number.isFinite(width) && width > 0 ? width : 1024,
      height: Number.isFinite(height) && height > 0 ? height : 1024,
    },
    quality: options.params.quality,
    num_images: options.params.n,
    output_format: options.params.output_format,
  }
  let uploadFailureReported = false
  if (isEdit) {
    const upload = async (dataUrl: string, name: string, source: 'inputImage' | 'mask', index: number) => {
      try {
        const result = await uploadReferenceFile(dataUrl, name, options.clientRequestId)
        if (result.uploaded) await options.onReferenceUploaded?.({ source, index, url: result.url })
        return result.url
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        if (!uploadFailureReported) {
          uploadFailureReported = true
          options.onReferenceUploadFailed?.(error)
        }
        throw error
      }
    }
    const imageUrls: string[] = []
    for (let index = 0; index < options.inputImageDataUrls.length; index += 1) {
      const dataUrl = options.inputImageFileUrls?.[index] || options.inputImageDataUrls[index]
      imageUrls.push(await upload(dataUrl, `reference-${index + 1}`, 'inputImage', index))
    }
    const maskDataUrl = options.maskFileUrl || options.maskDataUrl
    const maskUrl = maskDataUrl ? await upload(maskDataUrl, 'mask', 'mask', 0) : undefined
    payload.platform = 'composite'
    payload.image_urls = imageUrls
    if (maskUrl) payload.mask_url = maskUrl
  }

  const startedAt = Date.now()
  const submitted = await requestJson(requestPath, options.apiKey, options.clientRequestId, {
    method: 'POST',
    body: JSON.stringify(payload),
  }) as CompositeSubmitResponse
  const requestId = typeof submitted.request_id === 'string' ? submitted.request_id.trim() : ''
  if (!requestId) throw new Error('Composite 上游未返回 request_id')
  const statusUrl = typeof submitted.status_url === 'string' ? submitted.status_url.trim() : ''
  await options.onRequestCreated?.({
    requestId,
    ...(statusUrl ? { statusUrl } : {}),
  })

  let intervalMs = 2000
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const result = await readCompositeTaskResult({
      apiKey: options.apiKey,
      model: options.model,
      requestId,
      clientRequestId: options.clientRequestId,
      params: options.params,
    })
    if (result) return result
    await sleep(intervalMs)
    intervalMs = Math.min(intervalMs * 2, 15000)
  }

  throw new Error('Composite 异步任务轮询超时')
}
