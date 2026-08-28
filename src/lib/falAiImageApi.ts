import { client } from './opentk_media_sdk'
import type { ApiProfile, FalApiResponse, TaskParams } from '../types'
import { REQUEST_ID_HEADER } from '../auth/api'
import { DEFAULT_FAL_BASE_URL } from './apiProfiles'
import {
  assertImageInputPayloadSize,
  assertMaskEditFileSize,
  type CallApiOptions,
  type CallApiResult,
  fetchImageUrlAsDataUrl,
  getDataUrlDecodedByteSize,
  getDataUrlEncodedByteSize,
  isDataUrl,
  isHttpUrl,
  mergeActualParams,
  MIME_MAP,
  normalizeBase64Image,
} from './imageApiShared'

const DEFAULT_FAL_IMAGE_SIZE = { width: 1360, height: 1024 }

function mapFalEndpoint(model: string, isEdit: boolean): string {
  const normalized = model.trim().replace(/^\/+/, '').replace(/\/+$/, '') || 'openai/gpt-image-2'
  return isEdit && !normalized.endsWith('/edit') ? `${normalized}/edit` : normalized
}

async function mapFalImageSize(size: string): Promise<{ width: number; height: number }> {
  const match = size.match(/^(\d+)x(\d+)$/)
  if (match) {
    return { width: Number(match[1]), height: Number(match[2]) }
  }

  return DEFAULT_FAL_IMAGE_SIZE
}

function mapFalQuality(quality: TaskParams['quality']): 'low' | 'medium' | 'high' {
  return quality === 'auto' ? 'high' : quality
}

function configureFal(profile: ApiProfile) {
  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, '') || DEFAULT_FAL_BASE_URL
  const config: Parameters<typeof client.config>[0] = {
    credentials: profile.apiKey,
    suppressLocalCredentialsWarning: true,
  }
  if (baseUrl !== DEFAULT_FAL_BASE_URL) config.proxyUrl = baseUrl
  client.config(config)
}

async function createFalRequestInput(opts: CallApiOptions): Promise<Record<string, unknown>> {
  const isEdit = opts.inputImageDataUrls.length > 0
  const input: Record<string, unknown> = {
    prompt: opts.prompt,
    image_size: isEdit && opts.params.size === 'auto' ? 'auto' : await mapFalImageSize(opts.params.size),
    quality: mapFalQuality(opts.params.quality),
    num_images: Math.min(4, Math.max(1, opts.params.n || 1)),
    output_format: opts.params.output_format,
  }

  if (isEdit) {
    input.image_urls = opts.inputImageDataUrls
  }

  if (opts.maskDataUrl) {
    input.mask_url = opts.maskDataUrl
  }

  return input
}

function readFalImageValue(value: unknown, fallbackMime: string): string | null {
  if (typeof value === 'string') {
    if (isHttpUrl(value) || isDataUrl(value)) return value
    return normalizeBase64Image(value, fallbackMime)
  }
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  if (isHttpUrl(record.url) || isDataUrl(record.url)) return record.url
  if (typeof record.b64_json === 'string') return normalizeBase64Image(record.b64_json, fallbackMime)
  if (typeof record.base64 === 'string') return normalizeBase64Image(record.base64, fallbackMime)
  if (typeof record.data === 'string') return normalizeBase64Image(record.data, fallbackMime)
  return null
}

function readFalImageSize(value: unknown): Partial<TaskParams> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const width = typeof record.width === 'number' ? record.width : null
  const height = typeof record.height === 'number' ? record.height : null
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return undefined
  return { size: `${Math.round(width)}x${Math.round(height)}` }
}

async function parseFalImageResults(payload: FalApiResponse, fallbackMime: string, customBaseUrlLabel: string | null, signal?: AbortSignal): Promise<Array<{
  image: string
  actualParams?: Partial<TaskParams>
  rawImageUrl?: string
}>> {
  const candidates: unknown[] = []
  if (Array.isArray(payload.images)) candidates.push(...payload.images)
  if (payload.image) candidates.push(payload.image)
  if (payload.url) candidates.push(payload.url)

  const results: Array<{ image: string; actualParams?: Partial<TaskParams>; rawImageUrl?: string }> = []
  const rawImageUrls: string[] = []
  try {
    for (const candidate of candidates) {
      const value = readFalImageValue(candidate, fallbackMime)
      if (!value) continue
      if (isHttpUrl(value)) rawImageUrls.push(value)
      results.push({
        image: isHttpUrl(value) ? await fetchImageUrlAsDataUrl(value, fallbackMime, signal) : value,
        actualParams: readFalImageSize(candidate),
        rawImageUrl: isHttpUrl(value) ? value : undefined,
      })
    }
  } catch (err) {
    if (rawImageUrls.length > 0 && err instanceof Error) {
      (err as any).rawImageUrls = rawImageUrls
    }
    throw err
  }

  if (!results.length) {
    const err = new Error(
      customBaseUrlLabel
        ? `${customBaseUrlLabel} 没有返回可识别的图片数据，请查看原始响应内容确认实际返回的数据结构。如果当前接口与 fal.ai 格式不兼容，建议创建并使用「自定义服务商」配置。`
        : 'fal.ai 未返回可用图片数据',
    )
    if (customBaseUrlLabel) {
      ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    }
    throw err
  }
  return results
}

async function parseFalResult(payload: FalApiResponse, params: TaskParams, customBaseUrlLabel: string | null, signal?: AbortSignal): Promise<CallApiResult> {
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const imageResults = await parseFalImageResults(payload, mime, customBaseUrlLabel, signal)
  const actualParams = mergeActualParams(imageResults[0]?.actualParams)
  const rawImageUrls = imageResults.map((r) => r.rawImageUrl).filter((u): u is string => Boolean(u))
  return {
    images: imageResults.map((result) => result.image),
    actualParams,
    actualParamsList: imageResults.map((result) => result.actualParams),
    revisedPrompts: imageResults.map(() => undefined),
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

export function getFalErrorMessage(err: unknown): string | null {
  const body = err && typeof err === 'object' && 'body' in err ? (err as { body?: unknown }).body : null
  if (!body || typeof body !== 'object') return null

  const detail = (body as Record<string, unknown>).detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>
          if (typeof record.msg === 'string' && record.msg.trim()) return record.msg
          if (typeof record.message === 'string' && record.message.trim()) return record.message
        }
        return null
      })
      .filter((message): message is string => Boolean(message))
    if (messages.length) return messages.join('\n')
  }

  const message = (body as Record<string, unknown>).message
  return typeof message === 'string' && message.trim() ? message : null
}

function getFalCustomBaseUrlLabel(profile: ApiProfile): string | null {
  const base = profile.baseUrl.trim().replace(/\/+$/, '')
  if (!base || base === DEFAULT_FAL_BASE_URL) return null
  return base.replace(/^https?:\/\//, '')
}

export async function getFalQueuedImageResult(
  profile: ApiProfile,
  endpoint: string,
  requestId: string,
  params: TaskParams,
  clientRequestId?: string,
): Promise<CallApiResult> {
  configureFal(profile)
  const headers = clientRequestId ? { [REQUEST_ID_HEADER]: clientRequestId } : undefined
  await client.queue.subscribeToStatus(endpoint, { requestId, headers, logs: true })
  const result = await client.queue.result(endpoint, { requestId, headers })
  return parseFalResult(result.data as FalApiResponse, params, getFalCustomBaseUrlLabel(profile))
}

export async function callFalAiImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  try {
    if (opts.maskDataUrl) {
      assertMaskEditFileSize('遮罩主图文件', getDataUrlDecodedByteSize(opts.inputImageDataUrls[0] ?? ''))
      assertMaskEditFileSize('遮罩文件', getDataUrlDecodedByteSize(opts.maskDataUrl))
    }
    assertImageInputPayloadSize(
      opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
        (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
    )

    // 使用当前配置保存的 API Key，避免 fal SDK 额外输出前端凭据警告。
    configureFal(profile)

    const isEdit = opts.inputImageDataUrls.length > 0
    const endpoint = mapFalEndpoint(profile.model, isEdit)
    const input = await createFalRequestInput(opts)
    const result = await client.subscribe(endpoint, {
      input,
      headers: opts.requestId ? { [REQUEST_ID_HEADER]: opts.requestId } : undefined,
      logs: true,
      onEnqueue: (requestId) => {
        opts.onFalRequestEnqueued?.({ requestId, endpoint })
      },
    })
    const payload = result.data as FalApiResponse
    opts.onFalRequestEnqueued?.({ requestId: result.requestId, endpoint })
    return parseFalResult(payload, opts.params, getFalCustomBaseUrlLabel(profile))
  } catch (err) {
    const falMessage = getFalErrorMessage(err)
    if (falMessage) throw new Error(falMessage)
    throw err
  }
}
