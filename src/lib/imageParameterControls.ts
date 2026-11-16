import { GIF_FRAME_COUNT_RANGE, GIF_FRAME_DURATION_RANGE, IMAGE_COMPLEXITIES, type ApiProfile, type AppSettings, type ImageParameterControl, type TaskParams } from '../types'
import { createSettingsForApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { getImageModelFamily, supportsGrokQuality } from './imageModels'
import { getImageModelOptions } from './imageModelParams'
import { resolveCustomProviderModel } from './imageProviderMappings'
import { getImageSearchSupport, getImageThinkingSupport } from './imageSearch'
import { getOutputImageLimitForSettings, getParamDisabledReasons, supportsTransparentOutput } from './paramCompatibility'
import { calculateImageSize, SIZE_TIERS, SIZE_RATIOS, SIZE_LIMIT_TEXT, CODEX_CLI_SIZE_LIMIT_TEXT, SEEDREAM_SIZE_LIMIT_TEXT } from './size'

/** 参数面板和 CLI 共用的选项；上下文只影响查询结果，不修改配置。 */
export function getImageParameterControls(settings: AppSettings, profile: ApiProfile, params: TaskParams, context: { hasInputImages?: boolean; agent?: boolean } = {}) {
  const family = getImageModelFamily(profile)
  const provider = getCustomProviderDefinition(settings, profile.provider)
  const imageSize = provider ? resolveCustomProviderModel(provider, profile.model).imageSize : undefined
  const sizeMode = imageSize?.mode ?? (family === 'seedream' ? 'seedream' : family ? 'aspect-ratio' : 'pixels')
  const modelOptions = getImageModelOptions(profile, imageSize)
  const disabled = getParamDisabledReasons(profile, context)
  const search = getImageSearchSupport(profile, provider)
  const thinking = getImageThinkingSupport(profile, provider)
  const fal = profile.provider === 'fal'
  const transparentReason = context.agent ? 'Agent 模式不提供透明背景选项'
    : params.output_format === 'jpeg' ? 'JPEG 不支持透明背景'
    : !supportsTransparentOutput(settings, profile, params.output_format) ? '当前服务商未映射透明背景参数' : undefined
  const showTransparent = !transparentReason
  const resolutions = imageSize?.mode === 'aspect-ratio' ? imageSize.resolutions
    : family === 'seedream' ? modelOptions.resolutions
    : family === 'grok' ? fal ? ['1K', '1.5K', '2K'] : ['1K', '2K'] : ['512', '1K', '2K', '4K']
  const parameters: Record<keyof TaskParams, ImageParameterControl> = {
    size: {
      type: 'string', visible: sizeMode !== 'aspect-ratio',
      disabledReason: sizeMode === 'aspect-ratio' ? '当前配置使用 aspect_ratio 和 resolution' : undefined,
      options: sizeMode === 'aspect-ratio' ? [] : [
        { label: 'auto', value: 'auto', disabledReason: disabled.autoSize },
        ...(sizeMode === 'seedream' ? modelOptions.resolutions.map((value) => ({ label: value, value }))
          : SIZE_TIERS.filter((tier) => !profile.codexCli || tier === '1K').flatMap((tier) => SIZE_RATIOS.flatMap((ratio) => {
            const value = calculateImageSize(tier, ratio.value)
            return value ? [{ label: `${tier} ${ratio.label}`, value }] : []
          }))),
      ],
      hint: sizeMode === 'aspect-ratio' ? undefined : `可输入具体宽高，例如 1536x1024；options 为常用选项。${sizeMode === 'seedream' ? SEEDREAM_SIZE_LIMIT_TEXT : profile.codexCli ? CODEX_CLI_SIZE_LIMIT_TEXT : SIZE_LIMIT_TEXT}`,
    },
    aspect_ratio: {
      type: 'enum', visible: sizeMode !== 'pixels',
      disabledReason: sizeMode === 'pixels' ? '当前配置使用 size 设置具体宽高' : undefined,
      options: sizeMode === 'pixels' ? [] : modelOptions.ratios.map((value) => ({ label: value, value })),
    },
    resolution: {
      type: 'enum', visible: sizeMode !== 'pixels',
      disabledReason: sizeMode === 'pixels' ? '当前配置使用 size 设置具体宽高' : !modelOptions.resolutions.length ? '当前模型不支持分辨率参数' : undefined,
      options: sizeMode === 'pixels' ? [] : resolutions.map((value) => ({ label: value, value, disabledReason: modelOptions.resolutions.includes(value) ? undefined : '当前模型不支持此分辨率' })),
    },
    quality: {
      type: 'enum', visible: !family || family === 'grok',
      disabledReason: family === 'grok' ? supportsGrokQuality(profile.model) ? undefined : '当前模型不支持质量参数'
        : family ? '当前模型不使用质量参数' : profile.codexCli ? 'Codex CLI 不支持质量参数' : undefined,
      options: family === 'grok' ? ['auto', 'low', 'medium'].map((value) => ({ label: value, value })) : [
        { label: 'auto', value: 'auto', disabledReason: disabled.autoQuality },
        ...['low', 'medium', 'high'].map((value) => ({ label: value, value })),
        ...['xhigh', 'max'].map((value) => ({ label: value, value, disabledReason: disabled.extendedQuality })),
      ],
    },
    output_format: {
      type: 'enum', visible: !family || family === 'seedream',
      disabledReason: family === 'gemini' || family === 'grok' ? '当前模型的输出格式固定为 PNG' : undefined,
      options: family ? (family === 'seedream' ? ['png', 'jpeg'] : ['png']).map((value) => ({ label: value.toUpperCase(), value })) : [
        { label: 'PNG', value: 'png' }, { label: 'JPEG', value: 'jpeg' }, { label: 'WebP', value: 'webp' },
        { label: 'SVG', value: 'svg', disabledReason: disabled.svg }, { label: 'GIF', value: 'gif', disabledReason: disabled.gif },
      ],
    },
    n: { type: 'integer', visible: true, min: 1, max: getOutputImageLimitForSettings(createSettingsForApiProfile(settings, profile), params.output_format), disabledReason: context.agent ? 'Agent 模式下数量由模型根据提示词自动决定' : undefined },
    complexity: { type: 'enum', visible: !family, options: IMAGE_COMPLEXITIES.map((value) => ({ label: value, value })), disabledReason: family ? '当前模型不使用复杂度参数' : disabled.complexity },
    output_compression: {
      type: 'integer', visible: !family && !showTransparent, min: 0, max: 100, nullable: true,
      disabledReason: family ? '当前模型不使用压缩率参数' : fal ? 'fal.ai 不支持压缩率参数' : !['jpeg', 'webp'].includes(params.output_format) ? '仅 JPEG 和 WebP 支持压缩率' : undefined,
    },
    moderation: { type: 'enum', visible: !family, options: ['auto', 'low'].map((value) => ({ label: value, value })), disabledReason: family ? '当前模型不使用审核参数' : fal ? 'fal.ai 不支持审核参数' : undefined },
    transparent_output: { type: 'boolean', visible: family !== 'seedream' && showTransparent, disabledReason: transparentReason, hint: family === 'gemini' || family === 'grok' ? '使用本地后处理生成透明背景' : undefined },
    background: {
      type: 'enum', visible: family === 'seedream' && !context.agent,
      disabledReason: family !== 'seedream' ? '当前配置通过 transparent_output 设置透明背景' : context.agent ? 'Agent 模式不提供背景选项' : undefined,
      options: (['auto', 'transparent', 'opaque'] as const).filter((value) => params.output_format !== 'jpeg' || value !== 'transparent').map((value) => ({ label: value === 'auto' ? '自动' : value === 'transparent' ? '透明' : '不透明', value })),
    },
    watermark: { type: 'boolean', visible: family === 'seedream', disabledReason: family === 'seedream' ? undefined : '当前模型不使用水印参数' },
    google_search: { type: 'boolean', visible: family === 'gemini', disabledReason: search.googleSearch },
    image_search: { type: 'boolean', visible: family === 'gemini', disabledReason: search.imageSearch },
    thinking_level: {
      type: 'enum', visible: family === 'gemini', disabledReason: family !== 'gemini' ? '当前模型不提供思考等级选项' : thinking.reason,
      options: ['auto', 'minimal', 'low', 'medium', 'high'].map((value) => ({ label: value, value, disabledReason: value === 'auto' || thinking.levels.includes(value) ? undefined : '当前模型不支持此思考等级' })),
    },
    frame_count: { type: 'integer', visible: !family && params.output_format === 'gif', ...GIF_FRAME_COUNT_RANGE, disabledReason: params.output_format !== 'gif' || family ? '仅 GIF 输出可设置帧数' : disabled.gif },
    frame_duration_ms: { type: 'integer', visible: !family && params.output_format === 'gif', ...GIF_FRAME_DURATION_RANGE, disabledReason: params.output_format !== 'gif' || family ? '仅 GIF 输出可设置每帧时长' : disabled.gif },
  }
  return { sizeMode, imageSize, disabledReasons: disabled, parameters }
}
