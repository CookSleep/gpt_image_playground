import type { TaskParams } from '../types'
import { authFetch, syncOIDCUserProfile } from '../auth/api'
import { dataUrlToBlob } from './canvasImage'
import { fetchImageUrlAsDataUrl, isHttpUrl, MIME_MAP, type CallApiResult } from './imageApiShared'

interface CompositeSubmitResponse {
  request_id?: unknown
}

interface CompositeStatusResponse {
  status?: unknown
  message?: unknown
  error?: unknown
}

interface CompositeResultResponse {
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

async function requestJson(path: string, apiKey: string, init: RequestInit = {}) {
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

async function uploadMaterial(dataUrl: string, name: string, allowSync = true): Promise<string> {
  if (isHttpUrl(dataUrl)) return dataUrl
  const blob = await dataUrlToBlob(dataUrl)
  const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'
  const fileName = `${name}.${extension}`
  const formData = new FormData()
  formData.append('file', blob, fileName)
  console.log('[BackendCompositeImageApi] 素材上传请求', {
    endpoint: '/api/v1/materials',
    fileName,
    contentType: blob.type,
    size: blob.size,
  })
  const response = await authFetch('/api/v1/materials', {
    method: 'POST',
    body: formData,
  })
  const data = await response.json().catch(() => null) as { file_url?: unknown; code?: unknown; message?: unknown } | null
  console.log('[BackendCompositeImageApi] 素材上传回包', {
    status: response.status,
    data: formatLogValue(data),
  })
  if (!response.ok) {
    if (allowSync && response.status === 409 && data?.code === 'account_id_required') {
      const profile = await syncOIDCUserProfile()
      if (profile?.account_id) return uploadMaterial(dataUrl, name, false)
    }
    throw new Error(errorMessage(data, `素材上传失败：HTTP ${response.status}`))
  }
  const url = typeof data?.file_url === 'string' ? data.file_url.trim() : ''
  if (!url) throw new Error('素材上传接口未返回 file_url')
  return url
}

export async function callBackendCompositeImageApi(options: {
  apiKey: string
  model: string
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
  onRequestCreated?: (requestId: string) => void
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
  if (isEdit) {
    const [imageUrls, maskUrl] = await Promise.all([
      Promise.all(options.inputImageDataUrls.map((dataUrl, index) => uploadMaterial(dataUrl, `reference-${index + 1}`))),
      options.maskDataUrl ? uploadMaterial(options.maskDataUrl, 'mask') : Promise.resolve(undefined),
    ])
    payload.platform = 'composite'
    payload.image_urls = imageUrls
    if (maskUrl) payload.mask_url = maskUrl
  }

  const startedAt = Date.now()
  const submitted = await requestJson(requestPath, options.apiKey, {
    method: 'POST',
    body: JSON.stringify(payload),
  }) as CompositeSubmitResponse
  const requestId = typeof submitted.request_id === 'string' ? submitted.request_id.trim() : ''
  if (!requestId) throw new Error('Composite 上游未返回 request_id')
  options.onRequestCreated?.(requestId)

  const resultPath = `${requestPath}/requests/${encodeURIComponent(requestId)}`
  let intervalMs = 2000
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const status = await requestJson(`${resultPath}/status`, options.apiKey) as CompositeStatusResponse
    const statusText = typeof status.status === 'string' ? status.status.trim().toUpperCase() : ''
    if (!statusText) throw new Error('Composite 上游返回了无效的任务状态')
    if (statusText === 'FAILED' || statusText === 'CANCELED') throw new Error(getFailureMessage(status))
    if (statusText === 'COMPLETED') {
      const result = await requestJson(resultPath, options.apiKey) as CompositeResultResponse
      const items = Array.isArray(result.images) ? result.images : []
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
      }
    }
    await sleep(intervalMs)
    intervalMs = Math.min(intervalMs * 2, 15000)
  }

  throw new Error('Composite 异步任务轮询超时')
}
