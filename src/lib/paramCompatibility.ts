import { DEFAULT_PARAMS, type ApiProfile, type AppSettings, type TaskParams } from '../types'
import { getActiveApiProfile, getCustomProviderDefinition, isOpenAICompatibleProvider } from './apiProfiles'
import { customProviderSupportsNativeTransparentBackground } from './customProviderCapabilities'
import { isVectorOrAnimatedFormat, supportsExtendedQuality, supportsGptImage26Params } from './imageModels'
import { normalizeCodexCliImageSize, normalizeImageSize } from './size'

export const DEFAULT_FAL_IMAGE_SIZE = '1360x1024'
export const MAX_FAL_OUTPUT_IMAGES = 4
export const MAX_OPENAI_OUTPUT_IMAGES = 10

export function getOutputImageLimitForSettings(settings: AppSettings) {
  return getActiveApiProfile(settings).provider === 'fal' ? MAX_FAL_OUTPUT_IMAGES : MAX_OPENAI_OUTPUT_IMAGES
}

export function normalizeParamsForSettings(
  params: TaskParams,
  settings: AppSettings,
  options: { hasInputImages?: boolean; agent?: boolean } = {},
): TaskParams {
  const activeProfile = getActiveApiProfile(settings)
  const outputImageLimit = getOutputImageLimitForSettings(settings)
  const nextParams: TaskParams = {
    ...params,
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    n: Math.min(outputImageLimit, Math.max(1, params.n || DEFAULT_PARAMS.n)),
  }

  if (isOpenAICompatibleProvider(settings, activeProfile.provider) && activeProfile.codexCli) {
    nextParams.size = normalizeCodexCliImageSize(nextParams.size)
    nextParams.quality = DEFAULT_PARAMS.quality
  }

  if (activeProfile.provider === 'fal') {
    if (!options.hasInputImages && nextParams.size === 'auto') nextParams.size = DEFAULT_FAL_IMAGE_SIZE
    if (nextParams.quality === 'auto') nextParams.quality = 'high'
    nextParams.moderation = DEFAULT_PARAMS.moderation
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  if ((nextParams.quality === 'xhigh' || nextParams.quality === 'max') && !supportsExtendedQuality(activeProfile)) {
    nextParams.quality = 'high'
  }

  const supports26Params = supportsGptImage26Params(activeProfile)
  if (!supports26Params) nextParams.complexity = DEFAULT_PARAMS.complexity
  // Agent 的图片会进入对话上下文继续编辑，只用位图格式
  if (isVectorOrAnimatedFormat(nextParams.output_format) && (!supports26Params || options.agent)) {
    nextParams.output_format = DEFAULT_PARAMS.output_format
  }

  // fal.ai 的 SVG 暂不开放，原因见 falAiImageApi 中的说明
  if (activeProfile.provider === 'fal' && nextParams.output_format === 'svg') nextParams.output_format = DEFAULT_PARAMS.output_format
  // fal.ai 生成 SVG 时只能一张，且只有一个队列请求，无法像 OpenAI 那样拆成并发单张
  // if (activeProfile.provider === 'fal' && nextParams.output_format === 'svg') nextParams.n = 1

  if (nextParams.output_format === 'png' || isVectorOrAnimatedFormat(nextParams.output_format)) {
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  return nextParams
}

/** 透明背景：JPEG 不支持；SVG 和 GIF 无法本地抠图，需要接口原生透明背景，未映射 $params.background 的自定义服务商不可用 */
export function supportsTransparentOutput(settings: AppSettings, profile: ApiProfile, format: TaskParams['output_format']) {
  if (format === 'jpeg') return false
  if (!isVectorOrAnimatedFormat(format)) return true
  const customProvider = getCustomProviderDefinition(settings, profile.provider)
  return !customProvider || customProviderSupportsNativeTransparentBackground(customProvider)
}

export function getChangedParams(current: TaskParams, next: TaskParams): Partial<TaskParams> {
  const patch: Partial<TaskParams> = {}
  for (const key of Object.keys(next) as Array<keyof TaskParams>) {
    if (current[key] !== next[key]) {
      ;(patch as Record<keyof TaskParams, TaskParams[keyof TaskParams]>)[key] = next[key]
    }
  }
  return patch
}
