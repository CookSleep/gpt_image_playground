import type { ApiProfile, TaskParams } from '../types'

export const DEFAULT_GROK_BASE_URL = 'https://grok.aisenno.com/v1'
export const DEFAULT_GROK_MODEL = 'grok-imagine-image-2.0'

export function isGrokImageProfile(profile: ApiProfile) {
  return profile.provider === 'grok' || (profile.provider === 'openai' && profile.apiMode === 'images' && /^grok-imagine-image(?:-|$)/i.test(profile.model.trim()))
}

export function normalizeGrokQuality(quality: TaskParams['quality']) {
  return quality === 'low' ? 'low' : 'medium'
}
