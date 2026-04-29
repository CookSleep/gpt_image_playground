import { fal } from '@fal-ai/client'
import type { ApiProfile, FalApiResponse, TaskParams } from '../types'
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
} from './apiShared'

function mapFalEndpoint(model: string, isEdit: boolean): string {
  const normalized = model.trim().replace(/^\/+/, '').replace(/\/+$/, '') || 'openai/gpt-image-2'
  return isEdit && !normalized.endsWith('/edit') ? `${normalized}/edit` : normalized
}

async function mapFalImageSize(size: string, isEdit: boolean): Promise<string | { width: number; height: number }> {
  if (isEdit && size === 'auto') return 'auto'
  if (size === '1024x1024') return 'square'
  if (size === '1536x1024') return 'landscape_4_3'
  if (size === '1024x1536') return 'portrait_4_3'
  if (
    size === 'square_hd' ||
    size === 'square' ||
    size === 'portrait_4_3' ||
    size === 'portrait_16_9' ||
    size === 'landscape_4_3' ||
    size === 'landscape_16_9'
  ) {
    return size
  }

  const match = size.match(/^(\d+)x(\d+)$/)
  if (match) {
    return { width: Number(match[1]), height: Number(match[2]) }
  }

  return 'landscape_4_3'
}

function mapFalQuality(quality: TaskParams['quality']): 'low' | 'medium' | 'high' {
  return quality === 'auto' ? 'high' : quality
}

async function createFalRequestInput(opts: CallApiOptions): Promise<Record<string, unknown>> {
  const isEdit = opts.inputImageDataUrls.length > 0
  const input: Record<string, unknown> = {
    prompt: opts.prompt,
    image_size: await mapFalImageSize(opts.params.size, isEdit),
    quality: mapFalQuality(opts.params.quality),
    num_images: Math.max(1, opts.params.n || 1),
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

async function parseFalImages(payload: FalApiResponse, fallbackMime: string, signal: AbortSignal): Promise<string[]> {
  const candidates: unknown[] = []
  if (Array.isArray(payload.images)) candidates.push(...payload.images)
  if (payload.image) candidates.push(payload.image)
  if (payload.url) candidates.push(payload.url)

  const images: string[] = []
  for (const candidate of candidates) {
    const value = readFalImageValue(candidate, fallbackMime)
    if (!value) continue
    images.push(isHttpUrl(value) ? await fetchImageUrlAsDataUrl(value, fallbackMime, signal) : value)
  }

  if (!images.length) throw new Error('fal.ai 未返回可用图片数据')
  return images
}

export async function callFalImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const mime = MIME_MAP[opts.params.output_format] || 'image/png'
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)

  try {
    if (opts.maskDataUrl) {
      assertMaskEditFileSize('遮罩主图文件', getDataUrlDecodedByteSize(opts.inputImageDataUrls[0] ?? ''))
      assertMaskEditFileSize('遮罩文件', getDataUrlDecodedByteSize(opts.maskDataUrl))
    }
    assertImageInputPayloadSize(
      opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
        (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
    )

    // 和 OAI-like 一样使用当前 Provider 保存的 API Key，避免 fal SDK 额外输出前端凭据警告。
    fal.config({
      credentials: profile.apiKey,
      suppressLocalCredentialsWarning: true,
    })

    const isEdit = opts.inputImageDataUrls.length > 0
    const endpoint = mapFalEndpoint(profile.model, isEdit)
    const input = await createFalRequestInput(opts)
    // fal 官方 SDK 已内置 submit/status/result 轮询，这里保留外层超时用于和其他供应商一致。
    const result = await fal.subscribe(endpoint, {
      input,
      logs: true,
      abortSignal: controller.signal,
    })
    const payload = result.data as FalApiResponse
    const images = await parseFalImages(payload, mime, controller.signal)
    const actualFalSize = await mapFalImageSize(opts.params.size, opts.inputImageDataUrls.length > 0)
    const actualParams = mergeActualParams({
      size: typeof actualFalSize === 'string' ? actualFalSize : `${actualFalSize.width}x${actualFalSize.height}`,
      quality: mapFalQuality(opts.params.quality),
      output_format: opts.params.output_format,
      n: images.length,
    })
    return {
      images,
      actualParams,
      actualParamsList: images.map(() => actualParams),
      revisedPrompts: images.map(() => undefined),
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('fal.ai 任务等待被浏览器中断。fal 后台任务可能仍会完成；如果 fal 控制台已有结果，请重新生成或稍后重试。')
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}
