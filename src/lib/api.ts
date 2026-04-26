import type { AppSettings, ImageApiResponse, ResponsesApiResponse, TaskParams } from '../types'
import { buildApiUrl, readClientDevProxyConfig } from './devProxy'

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export { normalizeBaseUrl } from './devProxy'

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

async function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000)
    binary += String.fromCharCode(...chunk)
  }

  return `data:${blob.type || fallbackMime};base64,${btoa(binary)}`
}

async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    cache: 'no-store',
    signal,
  })

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  }

  return blobToDataUrl(await response.blob(), fallbackMime)
}

async function getApiErrorMessage(response: Response): Promise<string> {
  let errorMsg = `HTTP ${response.status}`
  try {
    const errJson = await response.json()
    if (errJson.error?.message) errorMsg = errJson.error.message
    else if (errJson.message) errorMsg = errJson.message
  } catch {
    try {
      errorMsg = await response.text()
    } catch {
      /* ignore */
    }
  }
  return errorMsg
}

function createRequestHeaders(settings: AppSettings): Record<string, string> {
  return {
    Authorization: `Bearer ${settings.apiKey}`,
    'Cache-Control': 'no-store, no-cache, max-age=0',
    Pragma: 'no-cache',
  }
}

function createResponsesImageTool(params: TaskParams, isEdit: boolean): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: isEdit ? 'edit' : 'generate',
    size: params.size,
    quality: params.quality,
    format: params.output_format,
  }

  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.compression = params.output_compression
  }

  return tool
}

function createResponsesInput(prompt: string, inputImageDataUrls: string[]): unknown {
  if (!inputImageDataUrls.length) return prompt

  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: prompt.trim() || 'Edit the provided image.' },
        ...inputImageDataUrls.map((dataUrl) => ({
          type: 'input_image',
          image_url: dataUrl,
        })),
      ],
    },
  ]
}

function parseResponsesImageDataUrls(payload: ResponsesApiResponse, fallbackMime: string): string[] {
  const output = payload.output
  if (!Array.isArray(output) || !output.length) {
    throw new Error('接口未返回图片数据')
  }

  const images: string[] = []

  for (const item of output) {
    if (item?.type !== 'image_generation_call') continue

    const result = item.result
    if (typeof result === 'string' && result.trim()) {
      images.push(normalizeBase64Image(result, fallbackMime))
      continue
    }

    if (result && typeof result === 'object') {
      const b64 =
        typeof result.b64_json === 'string'
          ? result.b64_json
          : typeof result.image === 'string'
            ? result.image
            : typeof result.data === 'string'
              ? result.data
              : null

      if (b64) {
        images.push(normalizeBase64Image(b64, fallbackMime))
      }
    }
  }

  if (!images.length) {
    throw new Error('接口未返回可用图片数据')
  }

  return images
}

export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
}

export interface CallApiResult {
  /** base64 data URL 列表 */
  images: string[]
}

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  return opts.settings.apiMode === 'responses'
    ? callResponsesImageApi(opts)
    : callImagesApi(opts)
}

async function callImagesApi(opts: CallApiOptions): Promise<CallApiResult> {
  const { settings, prompt, params, inputImageDataUrls } = opts
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const requestHeaders = createRequestHeaders(settings)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), settings.timeout * 1000)

  try {
    let response: Response

    if (isEdit) {
      const formData = new FormData()
      formData.append('model', settings.model)
      formData.append('prompt', prompt)
      formData.append('size', params.size)
      formData.append('quality', params.quality)
      formData.append('output_format', params.output_format)
      formData.append('moderation', params.moderation)

      if (params.output_format !== 'png' && params.output_compression != null) {
        formData.append('output_compression', String(params.output_compression))
      }

      for (let i = 0; i < inputImageDataUrls.length; i++) {
        const dataUrl = inputImageDataUrls[i]
        const resp = await fetch(dataUrl)
        const blob = await resp.blob()
        const ext = blob.type.split('/')[1] || 'png'
        formData.append('image[]', blob, `input-${i + 1}.${ext}`)
      }

      response = await fetch(buildApiUrl(settings.baseUrl, 'images/edits', proxyConfig), {
        method: 'POST',
        headers: requestHeaders,
        cache: 'no-store',
        body: formData,
        signal: controller.signal,
      })
    } else {
      const body: Record<string, unknown> = {
        model: settings.model,
        prompt,
        size: params.size,
        quality: params.quality,
        output_format: params.output_format,
        moderation: params.moderation,
      }

      if (params.output_format !== 'png' && params.output_compression != null) {
        body.output_compression = params.output_compression
      }
      if (params.n > 1) {
        body.n = params.n
      }

      response = await fetch(buildApiUrl(settings.baseUrl, 'images/generations', proxyConfig), {
        method: 'POST',
        headers: {
          ...requestHeaders,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    }

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    const payload = await response.json() as ImageApiResponse
    const data = payload.data
    if (!Array.isArray(data) || !data.length) {
      throw new Error('接口未返回图片数据')
    }

    const images: string[] = []
    for (const item of data) {
      const b64 = item.b64_json
      if (b64) {
        images.push(normalizeBase64Image(b64, mime))
        continue
      }

      if (isHttpUrl(item.url)) {
        images.push(await fetchImageUrlAsDataUrl(item.url, mime, controller.signal))
      }
    }

    if (!images.length) {
      throw new Error('接口未返回可用图片数据')
    }

    return { images }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function callResponsesImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const { settings, prompt, params, inputImageDataUrls } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const requestHeaders = createRequestHeaders(settings)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), settings.timeout * 1000)
  const requestCount = Number.isFinite(params.n) ? Math.max(1, Math.floor(params.n)) : 1

  try {
    const images: string[] = []

    for (let i = 0; i < requestCount; i++) {
      const body = {
        model: settings.model,
        input: createResponsesInput(prompt, inputImageDataUrls),
        tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0)],
      }

      const response = await fetch(buildApiUrl(settings.baseUrl, 'responses', proxyConfig), {
        method: 'POST',
        headers: {
          ...requestHeaders,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const payload = await response.json() as ResponsesApiResponse
      images.push(...parseResponsesImageDataUrls(payload, mime))
    }

    return { images }
  } finally {
    clearTimeout(timeoutId)
  }
}
