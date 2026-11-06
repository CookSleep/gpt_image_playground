import type { ApiProfile } from '../types'

export const DEFAULT_IMAGES_MODEL = 'gpt-image-2.6-sunburst'
/** Images API 生成 SVG 时必填的 svg.model（负责编写 SVG 的文本模型） */
export const DEFAULT_SVG_MODEL = 'gpt-6.1-sol'

export function getImageModelFamily(profile: Pick<ApiProfile, 'provider' | 'apiMode' | 'model'>): 'gemini' | 'grok' | null {
  if (profile.provider === 'openai' && profile.apiMode === 'responses') return null
  if (profile.provider === 'google') return 'gemini'
  if (profile.provider === 'xai') return 'grok'
  const model = profile.model.trim().toLowerCase()
  if (/(?:^|\/)gemini-[^/]*image|(?:^|\/)(?:gemini-)?nano[-_]?banana/.test(model)) return 'gemini'
  if (/(?:^|\/)grok-[^/]*image|(?:^|\/)grok-imagine-\d/.test(model)) return 'grok'
  return null
}

export function supportsGrokQuality(model: string) {
  return /grok-imagine-image-2[.-]0(?:$|[-/])/.test(model.toLowerCase())
}

export function usesGrokSizeParams(profile: ApiProfile) {
  return profile.provider === 'openai' && /(?:^|\/)grok-imagine-1\.5-(?:apimart|ext)$/i.test(profile.model)
}

export function getImageGenerationModel(profile: ApiProfile) {
  return profile.provider === 'openai' && profile.apiMode === 'responses'
    ? profile.imageGenerationModel?.trim() ?? ''
    : profile.model
}

/** 从 `gpt-image-2.6-flare`、`openai/gpt-image-2.5/sunburst` 等 ID 中解析主次版本号，无法识别时返回 null */
function parseGptImageVersion(model: string) {
  const match = model.trim().toLowerCase().match(/gpt-image-(\d+)(?:\.(\d+))?/)
  return match ? { major: Number(match[1]), minor: Number(match[2] ?? 0) } : null
}

function isGptImageModelAtLeast(model: string, major: number, minor: number) {
  const version = parseGptImageVersion(model)
  if (!version) return false
  return version.major > major || (version.major === major && version.minor >= minor)
}

/** xhigh / max 质量和 markup 标注编辑 */
export function isGptImage25PlusModel(model: string) {
  return isGptImageModelAtLeast(model, 2, 5)
}

/** complexity、SVG 和 GIF 输出；实测 2.5 会拒绝这些参数 */
export function isGptImage26PlusModel(model: string) {
  return isGptImageModelAtLeast(model, 2, 6)
}

/** xhigh / max 质量；fal.ai 的 2.6 端点质量只到 high */
export function supportsExtendedQuality(profile: ApiProfile) {
  const model = getImageGenerationModel(profile)
  if (profile.provider === 'fal' && isGptImage26PlusModel(model)) return false
  return isGptImage25PlusModel(model)
}

/** complexity、SVG 和 GIF：OpenAI 的 Images API、Responses 图像工具（含 Codex CLI）、fal.ai 的 2.6 端点和自定义服务商（由模板决定发送哪些）都支持 */
export function supportsGptImage26Params(profile: ApiProfile) {
  return isGptImage26PlusModel(getImageGenerationModel(profile))
}

/** markup：OpenAI 只有 Images API 的编辑接口支持，Responses 图像工具不接受；fal.ai 从 2.6 端点开始提供 */
export function supportsImageMarkup(profile: ApiProfile) {
  if (profile.provider === 'fal') return isGptImage26PlusModel(profile.model)
  return profile.provider === 'openai' && profile.apiMode === 'images' && !profile.codexCli && isGptImage25PlusModel(profile.model)
}

export function isVectorOrAnimatedFormat(format: string | undefined) {
  return format === 'svg' || format === 'gif'
}
