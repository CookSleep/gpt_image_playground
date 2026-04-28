import type { AppSettings, ImageApiResponse, ResponsesApiResponse, TaskParams } from '../types'
import { dataUrlToBlob, imageDataUrlToPngBlob, maskDataUrlToPngBlob } from './canvasImage'
import { buildApiUrl, readClientDevProxyConfig } from './devProxy'

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

const MAX_MASK_EDIT_FILE_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_INPUT_PAYLOAD_BYTES = 512 * 1024 * 1024

export { normalizeBaseUrl } from './devProxy'

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function getDataUrlEncodedByteSize(dataUrl: string): number {
  return dataUrl.length
}

function getDataUrlDecodedByteSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return dataUrl.length

  const meta = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  if (!/;base64/i.test(meta)) return decodeURIComponent(payload).length

  const normalized = payload.replace(/\s/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

function assertMaxBytes(label: string, bytes: number, maxBytes: number) {
  if (bytes > maxBytes) {
    throw new Error(`${label}过大：${formatMiB(bytes)}，上限为 ${formatMiB(maxBytes)}`)
  }
}

function assertImageInputPayloadSize(bytes: number) {
  assertMaxBytes('图像输入有效负载总大小', bytes, MAX_IMAGE_INPUT_PAYLOAD_BYTES)
}

function assertMaskEditFileSize(label: string, bytes: number) {
  assertMaxBytes(label, bytes, MAX_MASK_EDIT_FILE_BYTES)
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

function createResponsesImageTool(
  params: TaskParams,
  isEdit: boolean,
  settings: AppSettings,
  maskDataUrl?: string,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: isEdit ? 'edit' : 'generate',
    size: params.size,
    output_format: params.output_format,
  }

  if (!settings.codexCli) {
    tool.quality = params.quality
  }

  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }

  if (maskDataUrl) {
    tool.input_image_mask = {
      image_url: maskDataUrl,
    }
  }

  return tool
}

function createResponsesInput(prompt: string, inputImageDataUrls: string[]): unknown {
  const text = `Use the following text as the complete prompt. Do not rewrite it:\n${prompt}`
  if (!inputImageDataUrls.length) return text

  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...inputImageDataUrls.map((dataUrl) => ({
          type: 'input_image',
          image_url: dataUrl,
        })),
      ],
    },
  ]
}

export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
  maskDataUrl?: string
}

export interface CallApiResult {
  /** base64 data URL 列表 */
  images: string[]
  /** API 返回的实际生效参数 */
  actualParams?: Partial<TaskParams>
  /** 每张图片对应的实际生效参数 */
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  /** 每张图片对应的 API 改写提示词 */
  revisedPrompts?: Array<string | undefined>
}

function parseResponsesImageResults(payload: ResponsesApiResponse, fallbackMime: string): Array<{
  image: string
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
}> {
  const output = payload.output
  if (!Array.isArray(output) || !output.length) {
    throw new Error('接口未返回图片数据')
  }

  const results: Array<{ image: string; actualParams?: Partial<TaskParams>; revisedPrompt?: string }> = []

  for (const item of output) {
    if (item?.type !== 'image_generation_call') continue

    const result = item.result
    if (typeof result === 'string' && result.trim()) {
      results.push({
        image: normalizeBase64Image(result, fallbackMime),
        actualParams: mergeActualParams(pickActualParams(item)),
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      })
    }
  }

  if (!results.length) {
    throw new Error('接口未返回可用图片数据')
  }

  return results
}

function pickActualParams(source: unknown): Partial<TaskParams> {
  if (!source || typeof source !== 'object') return {}
  const record = source as Record<string, unknown>
  const actualParams: Partial<TaskParams> = {}

  if (typeof record.size === 'string') actualParams.size = record.size
  if (record.quality === 'auto' || record.quality === 'low' || record.quality === 'medium' || record.quality === 'high') {
    actualParams.quality = record.quality
  }
  if (record.output_format === 'png' || record.output_format === 'jpeg' || record.output_format === 'webp') {
    actualParams.output_format = record.output_format
  }
  if (typeof record.output_compression === 'number') actualParams.output_compression = record.output_compression
  if (record.moderation === 'auto' || record.moderation === 'low') actualParams.moderation = record.moderation
  if (typeof record.n === 'number') actualParams.n = record.n

  return actualParams
}

function mergeActualParams(...sources: Array<Partial<TaskParams>>): Partial<TaskParams> | undefined {
  const merged = Object.assign({}, ...sources.filter((source) => Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  return opts.settings.apiMode === 'responses'
    ? callResponsesImageApi(opts)
    : callImagesApi(opts)
}

async function callImagesApi(opts: CallApiOptions): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if (opts.settings.codexCli && n > 1) {
    return callImagesApiConcurrent(opts, n)
  }

  return callImagesApiSingle(opts)
}

async function callImagesApiConcurrent(opts: CallApiOptions, n: number): Promise<CallApiResult> {
  const singleOpts = { ...opts, params: { ...opts.params, n: 1, quality: 'auto' as const } }
  const results = await Promise.allSettled(
    Array.from({ length: n }).map(() => callImagesApiSingle(singleOpts)),
  )

  const successfulResults = results
    .filter((r): r is PromiseFulfilledResult<CallApiResult> => r.status === 'fulfilled')
    .map((r) => r.value)

  if (successfulResults.length === 0) {
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (firstError) throw firstError.reason
    throw new Error('所有并发请求均失败')
  }

  const images = successfulResults.flatMap((r) => r.images)
  const actualParamsList = successfulResults.flatMap((r) =>
    r.actualParamsList?.length ? r.actualParamsList : r.images.map(() => r.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((r) =>
    r.revisedPrompts?.length ? r.revisedPrompts : r.images.map(() => undefined),
  )
  const actualParams = mergeActualParams(
    successfulResults[0]?.actualParams ?? {},
    { n: images.length },
  )

  return { images, actualParams, actualParamsList, revisedPrompts }
}

async function callImagesApiSingle(opts: CallApiOptions): Promise<CallApiResult> {
  const { settings, prompt: originalPrompt, params, inputImageDataUrls } = opts
  const prompt = settings.codexCli
    ? `Use the following text as the complete prompt. Do not rewrite it:\n${originalPrompt}`
    : originalPrompt
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
      formData.append('output_format', params.output_format)
      formData.append('moderation', params.moderation)

      if (!settings.codexCli) {
        formData.append('quality', params.quality)
      }

      if (params.output_format !== 'png' && params.output_compression != null) {
        formData.append('output_compression', String(params.output_compression))
      }
      if (params.n > 1) {
        formData.append('n', String(params.n))
      }

      const imageBlobs: Blob[] = []
      for (let i = 0; i < inputImageDataUrls.length; i++) {
        const dataUrl = inputImageDataUrls[i]
        const blob = opts.maskDataUrl && i === 0
          ? await imageDataUrlToPngBlob(dataUrl)
          : await dataUrlToBlob(dataUrl)
        imageBlobs.push(blob)
      }

      const maskBlob = opts.maskDataUrl ? await maskDataUrlToPngBlob(opts.maskDataUrl) : null
      if (opts.maskDataUrl) {
        assertMaskEditFileSize('遮罩主图文件', imageBlobs[0]?.size ?? 0)
        assertMaskEditFileSize('遮罩文件', maskBlob?.size ?? 0)
      }
      assertImageInputPayloadSize(
        imageBlobs.reduce((sum, blob) => sum + blob.size, 0) + (maskBlob?.size ?? 0),
      )

      for (let i = 0; i < imageBlobs.length; i++) {
        const blob = imageBlobs[i]
        const ext = blob.type.split('/')[1] || 'png'
        formData.append('image[]', blob, `input-${i + 1}.${ext}`)
      }

      if (maskBlob) {
        formData.append('mask', maskBlob, 'mask.png')
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
        output_format: params.output_format,
        moderation: params.moderation,
      }

      if (!settings.codexCli) {
        body.quality = params.quality
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
    const revisedPrompts: Array<string | undefined> = []
    for (const item of data) {
      const b64 = item.b64_json
      if (b64) {
        images.push(normalizeBase64Image(b64, mime))
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
        continue
      }

      if (isHttpUrl(item.url)) {
        images.push(await fetchImageUrlAsDataUrl(item.url, mime, controller.signal))
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
      }
    }

    if (!images.length) {
      throw new Error('接口未返回可用图片数据')
    }

    const actualParams = mergeActualParams(
      pickActualParams(payload),
    )
    return {
      images,
      actualParams,
      actualParamsList: images.map(() => actualParams),
      revisedPrompts,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function callResponsesImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if (n === 1) {
    return callResponsesImageApiSingle(opts)
  }

  const promises = Array.from({ length: n }).map(() => callResponsesImageApiSingle(opts))
  const results = await Promise.allSettled(promises)
  
  const successfulResults = results
    .filter((r): r is PromiseFulfilledResult<CallApiResult> => r.status === 'fulfilled')
    .map((r) => r.value)

  if (successfulResults.length === 0) {
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (firstError) throw firstError.reason
    throw new Error('所有并发请求均失败')
  }

  const images = successfulResults.flatMap((r) => r.images)
  const actualParamsList = successfulResults.flatMap((r) =>
    r.actualParamsList?.length ? r.actualParamsList : r.images.map(() => r.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((r) =>
    r.revisedPrompts?.length ? r.revisedPrompts : r.images.map(() => undefined),
  )
  const actualParams = mergeActualParams(
    successfulResults[0]?.actualParams ?? {},
    images.length === opts.params.n ? { n: opts.params.n } : { n: images.length },
  )

  return { images, actualParams, actualParamsList, revisedPrompts }
}

async function callResponsesImageApiSingle(opts: CallApiOptions): Promise<CallApiResult> {
  const { settings, prompt, params, inputImageDataUrls } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const requestHeaders = createRequestHeaders(settings)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), settings.timeout * 1000)

  try {
    if (opts.maskDataUrl) {
      assertMaskEditFileSize('遮罩主图文件', getDataUrlDecodedByteSize(inputImageDataUrls[0] ?? ''))
      assertMaskEditFileSize('遮罩文件', getDataUrlDecodedByteSize(opts.maskDataUrl))
    }
    assertImageInputPayloadSize(
      inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
        (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
    )

    const body = {
      model: settings.model,
      input: createResponsesInput(prompt, inputImageDataUrls),
      tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0, settings, opts.maskDataUrl)],
      tool_choice: 'required',
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
    const imageResults = parseResponsesImageResults(payload, mime)
    const actualParams = mergeActualParams(
      imageResults[0]?.actualParams ?? {},
    )
    return {
      images: imageResults.map((result) => result.image),
      actualParams,
      actualParamsList: imageResults.map((result) =>
        mergeActualParams(result.actualParams ?? {}),
      ),
      revisedPrompts: imageResults.map((result) => result.revisedPrompt),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
