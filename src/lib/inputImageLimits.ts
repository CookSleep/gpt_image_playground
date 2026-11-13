import { MAX_INPUT_IMAGES, type ApiProfile, type AppMode, type AppSettings } from '../types'
import { getActiveApiProfile, getAgentImageApiProfile, getCustomProviderDefinition, resolveApiProfileModel } from './apiProfiles'
import { getImageModelFamily, supportsGrokQuality } from './imageModels'

export function getInputImageLimit(profile: ApiProfile) {
  const family = getImageModelFamily(profile)
  const model = profile.model.trim().toLowerCase()
  if (family === 'seedream') return 10
  if (family === 'grok') return profile.provider === 'fal' && !supportsGrokQuality(model) ? 3 : 5
  if (family === 'gemini') {
    if (/gemini-3(?:\.\d+)?-.*image|nano[-_]?banana-(?:pro|2)(?:$|[./-])/.test(model)) return 14
    // Gemini 2.5 的 3 张是效果建议，未公布硬上限时沿用应用上限。
  }
  return MAX_INPUT_IMAGES
}

export function getInputImageLimitError(profile: ApiProfile, count: number) {
  const limit = getInputImageLimit(profile)
  return count > limit ? `当前模型最多支持 ${limit} 张参考图，请移除超限图片或切换模型` : null
}

export function assertInputImageLimit(profile: ApiProfile, count: number) {
  const error = getInputImageLimitError(profile, count)
  if (error) throw new Error(error)
}

export function getInputImageProfile(state: {
  settings: AppSettings
  appMode: AppMode
  reusedTaskApiProfileId: string | null
  reusedTaskApiModel: string | null
}) {
  if (state.appMode === 'agent') return getAgentImageApiProfile(state.settings) ?? getActiveApiProfile(state.settings)
  const reused = state.settings.reuseTaskApiProfileTemporarily && state.reusedTaskApiProfileId
    ? state.settings.profiles.find((profile) => profile.id === state.reusedTaskApiProfileId)
    : undefined
  return reused
    ? resolveApiProfileModel(reused, state.reusedTaskApiModel ?? undefined, getCustomProviderDefinition(state.settings, reused.provider))
    : getActiveApiProfile(state.settings)
}
