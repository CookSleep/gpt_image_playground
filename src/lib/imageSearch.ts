import type { ApiProfile, CustomProviderDefinition, ImageSearchGrounding } from '../types'
import { getImageModelFamily } from './imageModels'
import { resolveCustomProviderModel } from './imageProviderMappings'

function hasParam(value: unknown, param: string): boolean {
  if (value === param) return true
  if (Array.isArray(value)) return value.some((item) => hasParam(item, param))
  return Boolean(value) && typeof value === 'object' && Object.values(value as Record<string, unknown>).some((item) => hasParam(item, param))
}

/** undefined 表示可用，否则为参数占位的说明。 */
export function getImageSearchSupport(profile: ApiProfile, provider?: CustomProviderDefinition | null) {
  if (getImageModelFamily(profile) !== 'gemini') return { googleSearch: '当前模型不支持 Google Search', imageSearch: '当前模型不支持 Image Search' }
  if (provider) {
    const mapping = resolveCustomProviderModel(provider, profile.model)
    const supports = (param: string) => [mapping.submit, ...(mapping.editSubmit ? [mapping.editSubmit] : [])]
      .every((submit) => hasParam(submit.body, param) || hasParam(submit.query, param))
    return {
      googleSearch: supports('$params.google_search') ? undefined : '当前服务商未映射 Google Search 参数',
      imageSearch: supports('$params.image_search') ? undefined : '当前服务商未映射 Image Search 参数',
    }
  }
  if (profile.provider === 'fal') {
    return {
      googleSearch: /nano-banana-(?:pro|2)(?:$|[./])/.test(profile.model) ? undefined : '当前模型不支持 Google Search',
      imageSearch: /nano-banana-2(?:$|\/)/.test(profile.model) ? undefined : '当前接口不支持 Image Search',
    }
  }
  if (profile.provider !== 'google') {
    const reason = '当前接口不支持搜索参数'
    return { googleSearch: reason, imageSearch: reason }
  }
  const imageSearch = /gemini-3\.1-flash-image|nano[-_]?banana-2(?:$|[-.])/i.test(profile.model)
  const googleSearch = imageSearch || /gemini-3-pro-image|nano[-_]?banana-pro/i.test(profile.model)
  return {
    googleSearch: googleSearch ? undefined : '当前模型不支持 Google Search',
    imageSearch: imageSearch ? undefined : '当前模型不支持 Image Search',
  }
}

export function getImageThinkingSupport(profile: ApiProfile, provider?: CustomProviderDefinition | null): { levels: string[]; reason?: string } {
  if (profile.provider === 'fal') {
    const levels = /nano-banana-2\.1(?:$|\/)/.test(profile.model) ? ['minimal', 'medium', 'high']
      : /nano-banana-2(?:$|\/)/.test(profile.model) ? ['minimal', 'high'] : []
    return { levels, ...(levels.length ? {} : { reason: '当前模型不支持调整思考等级' }) }
  }
  const levels = /nano[-_]?banana-2[.-]1/i.test(profile.model) ? ['minimal', 'medium', 'high']
    : /gemini-3\.1-flash-(?:lite-)?image|nano[-_]?banana-2(?:$|-)/i.test(profile.model) ? ['minimal', 'high'] : []
  if (provider && getImageModelFamily(profile) === 'gemini') {
    const mapping = resolveCustomProviderModel(provider, profile.model)
    if ([mapping.submit, ...(mapping.editSubmit ? [mapping.editSubmit] : [])].every((submit) => hasParam(submit.body, '$params.thinking_level') || hasParam(submit.query, '$params.thinking_level'))) {
      return { levels: levels.length ? levels : ['minimal', 'low', 'medium', 'high'] }
    }
    return { levels: [], reason: '当前服务商未映射思考等级参数' }
  }
  if (profile.provider !== 'google') return { levels: [], reason: '当前接口不支持思考等级参数' }
  if (!levels.length) return { levels, reason: '当前模型不支持调整思考等级' }
  return { levels }
}

export function parseImageSearchGrounding(value: unknown): ImageSearchGrounding | undefined {
  if (!value || typeof value !== 'object') return undefined
  const metadata = value as Record<string, unknown>
  const entry = (metadata.searchEntryPoint ?? metadata.search_entry_point) as { renderedContent?: unknown; rendered_content?: unknown } | undefined
  const content = entry?.renderedContent ?? entry?.rendered_content
  const renderedContent = typeof content === 'string' ? content : undefined
  const sources: ImageSearchGrounding['sources'] = []
  const chunks = metadata.groundingChunks ?? metadata.grounding_chunks
  for (const item of Array.isArray(chunks) ? chunks : []) {
    const source = item?.image ?? item?.web
    const uri = source?.sourceUri ?? source?.source_uri ?? source?.uri
    if (typeof uri !== 'string' || !/^https?:\/\//i.test(uri) || sources.some((item) => item.uri === uri)) continue
    // 只保留 https 图片，避免 https 页面加载 http 资源被拦截
    const image = source.imageUri ?? source.image_uri
    const imageUri = typeof image === 'string' && /^https:\/\//i.test(image) ? image : undefined
    const domain = typeof source.domain === 'string' && source.domain ? source.domain : undefined
    sources.push({
      uri,
      title: typeof source.title === 'string' && source.title ? source.title : uri,
      ...(imageUri ? { imageUri } : {}),
      ...(domain ? { domain } : {}),
    })
  }
  return renderedContent || sources.length ? { renderedContent, sources } : undefined
}
