import type { ApiMode, ApiProfile, ReasoningEffort } from '../types'
import { DEFAULT_STREAM_PARTIAL_IMAGES, REASONING_EFFORT_VALUES } from '../types'

import { normalizeBaseUrl } from './devProxy'

export function normalizeStreamPartialImages(value: unknown, fallback: number | undefined = DEFAULT_STREAM_PARTIAL_IMAGES): number {
  const fallbackValue = fallback ?? DEFAULT_STREAM_PARTIAL_IMAGES
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallbackValue
  return Math.min(3, Math.max(0, Math.trunc(numeric)))
}

export function normalizeReasoningEffort(value: unknown, fallback?: ReasoningEffort): ReasoningEffort | undefined {
  return typeof value === 'string' && REASONING_EFFORT_VALUES.includes(value as ReasoningEffort)
    ? value as ReasoningEffort
    : fallback
}

export function parseOptionalProfileParams(params: URLSearchParams): Partial<Pick<ApiProfile, 'svgModel' | 'svgReasoningEffort' | 'responseFormatB64Json' | 'timeout'>> {
  const patch: Partial<Pick<ApiProfile, 'svgModel' | 'svgReasoningEffort' | 'responseFormatB64Json' | 'timeout'>> = {}
  const svgModel = params.get('svgModel')
  if (svgModel !== null) patch.svgModel = svgModel.trim() || undefined
  const effort = params.get('svgReasoningEffort')
  const normalizedEffort = normalizeReasoningEffort(effort)
  if (effort === '' || normalizedEffort) patch.svgReasoningEffort = normalizedEffort
  const base64 = params.get('responseFormatB64Json')?.trim().toLowerCase()
  if (base64 === '') patch.responseFormatB64Json = undefined
  else if (base64 === 'true' || base64 === 'false') patch.responseFormatB64Json = base64 === 'true'
  const timeout = params.get('timeout')
  if (timeout?.trim() && Number.isFinite(Number(timeout)) && Number(timeout) > 0) patch.timeout = Number(timeout)
  return patch
}

export interface DefaultApiUrlPatch {
  baseUrl: string
  svgModel?: string
  svgReasoningEffort?: ReasoningEffort
  responseFormatB64Json?: boolean
  timeout?: number
  apiKey?: string
  apiMode?: ApiMode
  model?: string
  imageGenerationModel?: string
  reasoningEffort?: ReasoningEffort
  name?: string
  codexCli?: boolean
  streamImages?: boolean
  streamPartialImages?: number
  transparentBackgroundMethod?: ApiProfile['transparentBackgroundMethod']
}

export function parseDefaultApiUrl(rawUrl: string): DefaultApiUrlPatch {
  const url = rawUrl.trim()
  if (!url) return { baseUrl: '' }

  try {
    const parsed = new URL(url)
    const queryIndex = url.search(/[?#]/)
    const baseUrl = queryIndex >= 0 ? url.slice(0, queryIndex) : url
    const patch: DefaultApiUrlPatch = {
      baseUrl: normalizeBaseUrl(baseUrl),
      ...parseOptionalProfileParams(parsed.searchParams),
    }

    const apiUrlParam = parsed.searchParams.get('apiUrl')
    const apiKeyParam = parsed.searchParams.get('apiKey')
    const apiModeParam = parsed.searchParams.get('apiMode')
    const modelParam = parsed.searchParams.get('model')
    const imageGenerationModelParam = parsed.searchParams.get('imageGenerationModel')
    const reasoningEffortParam = parsed.searchParams.get('reasoningEffort')
    const profileNameParam = parsed.searchParams.get('profileName')
    const codexCliParam = parsed.searchParams.get('codexCli')
    const streamImagesParam = parsed.searchParams.get('streamImages')
    const streamPartialImagesParam = parsed.searchParams.get('streamPartialImages')
    const transparentBackgroundMethodParam = parsed.searchParams.get('transparentBackgroundMethod')

    if (apiUrlParam !== null) patch.baseUrl = normalizeBaseUrl(apiUrlParam.trim())
    if (apiKeyParam !== null) patch.apiKey = apiKeyParam.trim()
    if (apiModeParam === 'images' || apiModeParam === 'responses') patch.apiMode = apiModeParam
    if (modelParam !== null && modelParam.trim()) patch.model = modelParam.trim()
    if (imageGenerationModelParam !== null) patch.imageGenerationModel = imageGenerationModelParam.trim()
    if (reasoningEffortParam !== null) patch.reasoningEffort = normalizeReasoningEffort(reasoningEffortParam)
    if (profileNameParam?.trim()) patch.name = profileNameParam.trim()
    if (codexCliParam !== null) patch.codexCli = codexCliParam.trim().toLowerCase() === 'true'
    if (streamImagesParam !== null) patch.streamImages = streamImagesParam.trim().toLowerCase() === 'true'
    if (streamPartialImagesParam !== null) patch.streamPartialImages = normalizeStreamPartialImages(streamPartialImagesParam)
    if (transparentBackgroundMethodParam === 'api' || transparentBackgroundMethodParam === 'local') {
      patch.transparentBackgroundMethod = transparentBackgroundMethodParam
    }

    return patch
  } catch {
    return { baseUrl: normalizeBaseUrl(url) }
  }
}
