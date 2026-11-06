import { DEFAULT_PARAMS, type ApiProfile, type AppSettings, type ParamDisabledReasons, type TaskParams } from '../types'
import { getActiveApiProfile, getCustomProviderDefinition, isOpenAICompatibleProvider } from './apiProfiles'
import { customProviderSupportsNativeTransparentBackground } from './customProviderCapabilities'
import { getImageModelFamily, isGptImage26PlusModel, isVectorOrAnimatedFormat, supportsExtendedQuality, supportsGptImage26Params } from './imageModels'
import { getImageModelParams } from './imageModelParams'
import { getImageSearchSupport, getImageThinkingSupport } from './imageSearch'
import { normalizeCodexCliImageSize, normalizeImageSize } from './size'

export const DEFAULT_FAL_IMAGE_SIZE = '1360x1024'
export const MAX_FAL_OUTPUT_IMAGES = 4
export const MAX_OPENAI_OUTPUT_IMAGES = 10

export function getTaskParamSupport(settings: AppSettings, profile: ApiProfile) {
  const provider = getCustomProviderDefinition(settings, profile.provider)
  return {
    thinking: getImageThinkingSupport(profile, provider).levels.length > 0,
    complexity: !getImageModelFamily(profile) && supportsGptImage26Params(profile),
  }
}

export function getOutputImageLimitForSettings(settings: AppSettings) {
  const profile = getActiveApiProfile(settings)
  return profile.provider === 'fal' ? MAX_FAL_OUTPUT_IMAGES : MAX_OPENAI_OUTPUT_IMAGES
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
    aspect_ratio: undefined,
    resolution: undefined,
    google_search: undefined,
    image_search: undefined,
    thinking_level: undefined,
    n: Math.min(outputImageLimit, Math.max(1, params.n || DEFAULT_PARAMS.n)),
  }

  if (getImageModelFamily(activeProfile)) {
    const modelParams = getImageModelParams(activeProfile, params)
    const search = getImageSearchSupport(activeProfile, getCustomProviderDefinition(settings, activeProfile.provider))
    const thinking = getImageThinkingSupport(activeProfile, getCustomProviderDefinition(settings, activeProfile.provider))
    return {
      ...nextParams, ...modelParams,
      google_search: search.googleSearch ? undefined : params.google_search,
      image_search: search.imageSearch ? undefined : params.image_search,
      thinking_level: thinking.levels.includes(params.thinking_level ?? '') ? params.thinking_level : undefined,
      size: 'auto', quality: modelParams.quality ?? 'auto', output_format: 'png', output_compression: null, moderation: 'auto', complexity: 'auto',
    }
  }

  if (isOpenAICompatibleProvider(settings, activeProfile.provider) && activeProfile.codexCli) {
    nextParams.size = normalizeCodexCliImageSize(nextParams.size)
    nextParams.quality = DEFAULT_PARAMS.quality
  }

  if (activeProfile.provider === 'fal') {
    nextParams.moderation = DEFAULT_PARAMS.moderation
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  const disabled = getParamDisabledReasons(activeProfile, options)
  if (disabled.autoSize && nextParams.size === 'auto') nextParams.size = DEFAULT_FAL_IMAGE_SIZE
  if (disabled.autoQuality && nextParams.quality === 'auto') nextParams.quality = 'high'
  if (disabled.extendedQuality && (nextParams.quality === 'xhigh' || nextParams.quality === 'max')) nextParams.quality = 'high'
  if (disabled.complexity) nextParams.complexity = DEFAULT_PARAMS.complexity
  const format = nextParams.output_format
  if ((format === 'svg' || format === 'gif') && disabled[format]) nextParams.output_format = DEFAULT_PARAMS.output_format

  // fal.ai 生成 SVG 时只能一张，且只有一个队列请求，无法像 OpenAI 那样拆成并发单张
  // if (activeProfile.provider === 'fal' && nextParams.output_format === 'svg') nextParams.n = 1

  if (nextParams.output_format === 'png' || isVectorOrAnimatedFormat(nextParams.output_format)) {
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  return nextParams
}

/** 参数面板中不可选的项及原因；normalizeParamsForSettings 按同一结果清洗参数 */
export function getParamDisabledReasons(profile: ApiProfile, options: { hasInputImages?: boolean; agent?: boolean } = {}): ParamDisabledReasons {
  const isFal = profile.provider === 'fal'
  // Responses API 的能力取决于 image_generation 工具的图像模型，而不是首页选择的文本模型
  const isResponses = profile.provider === 'openai' && profile.apiMode === 'responses'
  const gptImage26 = supportsGptImage26Params(profile)
  const gif = options.agent
    // Agent 的图片会进入对话上下文继续编辑，只用位图格式
    ? 'Agent 模式只能输出位图格式'
    : gptImage26 ? undefined
    : isResponses ? '当前图像模型不支持此格式' : '当前模型不支持此格式'
  return {
    complexity: gptImage26 ? undefined
      : isResponses ? '当前图像模型不支持复杂度参数' : '当前模型不支持复杂度参数',
    gif,
    // fal.ai 的 SVG 暂不开放，原因见 falAiImageApi 中的说明
    svg: gif ?? (isFal ? 'fal.ai 暂不支持此格式' : undefined),
    autoQuality: isFal ? 'fal.ai 不支持 auto 质量参数' : undefined,
    extendedQuality: supportsExtendedQuality(profile) ? undefined
      : isFal && isGptImage26PlusModel(profile.model) ? 'fal.ai 的 GPT Image 2.6 最高只支持 high'
      : isResponses ? '当前图像模型不支持此质量' : '当前模型不支持此质量',
    autoSize: isFal && !options.hasInputImages ? 'fal.ai 的文生图模式不支持自动尺寸' : undefined,
  }
}

/** 透明背景：JPEG 不支持；SVG 和 GIF 无法本地抠图，需要接口原生透明背景，未映射 $params.background 的自定义服务商不可用 */
export function supportsTransparentOutput(settings: AppSettings, profile: ApiProfile, format: TaskParams['output_format']) {
  if (format === 'jpeg') return false
  if (!isVectorOrAnimatedFormat(format)) return true
  const customProvider = getCustomProviderDefinition(settings, profile.provider)
  return !customProvider || customProviderSupportsNativeTransparentBackground(customProvider, profile.model)
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
