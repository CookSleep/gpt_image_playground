import { DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type AppSettings, type CustomProviderDefinition } from '../types'
import { normalizeBaseUrl } from './api'
import {
  DEFAULT_FAL_BASE_URL,
  DEFAULT_FAL_MODEL,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_RESPONSES_MODEL,
  DEFAULT_SETTINGS,
  createDefaultOpenAIProfile,
  getCustomProviderDefinition,
  getDefaultApiProfileId,
  isOpenAICompatibleProvider,
  normalizeCustomProviderDefinition,
  normalizeSettings,
  normalizeStreamPartialImages,
  switchApiProfileProvider,
} from './apiProfiles'
import { isApiProxyAvailable, isApiProxyLocked, readClientDevProxyConfig } from './devProxy'
import { isTauri } from './platform'
import { DEFAULT_GROK_BASE_URL, DEFAULT_GROK_MODEL } from './grok'
import {
  getDefaultPresetBaseUrl,
  getDefaultPresetProfileId,
  getPresetProfileIds,
  isPresetConfigDeletionPrevented,
  isPresetConfigOnlyEnabled,
  isPresetProviderDeletionPrevented,
} from './presetConfig'

// 设置页与命令行共用的设置修改，结果都交给 store 的 setSettings 保存

export function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function isAsyncCustomProvider(provider: CustomProviderDefinition | null | undefined) {
  return Boolean(provider?.poll || provider?.submit.taskIdPath || provider?.editSubmit?.taskIdPath)
}

export function isProfileApiProxyEligible(settings: AppSettings, profile: ApiProfile) {
  if (!isOpenAICompatibleProvider(settings, profile.provider)) return false
  const customProvider = getCustomProviderDefinition(settings, profile.provider)
  return !isAsyncCustomProvider(customProvider)
}

export function getDefaultModelForMode(apiMode: AppSettings['apiMode']) {
  return apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL
}

/** 保存前整理各 API 配置：补齐空的名称、地址、模型和超时，按服务商清理不适用的选项 */
export function prepareSettingsForCommit(draft: AppSettings): AppSettings {
  const proxyConfig = readClientDevProxyConfig()
  const apiProxyAvailable = isApiProxyAvailable(proxyConfig)
  const apiProxyLocked = isApiProxyLocked(proxyConfig)
  const defaultProfileId = getDefaultPresetProfileId() ?? getDefaultApiProfileId(draft)
  const profiles = draft.profiles.map((profile) => {
    const nextApiProxy = isProfileApiProxyEligible(draft, profile) && apiProxyAvailable ? (apiProxyLocked || profile.apiProxy) : false
    const shouldKeepEmptyBaseUrl = profile.provider !== 'fal' && nextApiProxy && !profile.baseUrl.trim()
    const emptyBaseUrlFallback = profile.id === defaultProfileId
      ? getDefaultPresetBaseUrl()
      : profile.provider === 'grok' ? DEFAULT_GROK_BASE_URL : DEFAULT_SETTINGS.baseUrl
    const baseUrl = profile.provider === 'fal'
      ? profile.baseUrl.trim().replace(/\/+$/, '') || (profile.id === defaultProfileId ? '' : DEFAULT_FAL_BASE_URL)
      : shouldKeepEmptyBaseUrl ? '' : normalizeBaseUrl(profile.baseUrl.trim() || emptyBaseUrlFallback)
    const defaultModel = profile.provider === 'fal' ? DEFAULT_FAL_MODEL : profile.provider === 'grok' ? DEFAULT_GROK_MODEL : getDefaultModelForMode(profile.apiMode)
    return {
      ...profile,
      name: profile.name.trim() || (profile.id === defaultProfileId ? '默认' : '新配置'),
      baseUrl,
      model: profile.model.trim() || defaultModel,
      timeout: Number(profile.timeout) || DEFAULT_SETTINGS.timeout,
      apiProxy: isTauri ? profile.apiProxy : nextApiProxy,
      codexCli: isOpenAICompatibleProvider(draft, profile.provider) ? profile.codexCli : false,
      streamImages: profile.provider === 'openai' ? profile.streamImages : false,
      streamPartialImages: profile.provider === 'openai' ? normalizeStreamPartialImages(profile.streamPartialImages) : DEFAULT_STREAM_PARTIAL_IMAGES,
    }
  })
  const fallbackProfile = createDefaultOpenAIProfile({ id: newId('openai') })
  return normalizeSettings({
    ...draft,
    profiles: profiles.length ? profiles : [fallbackProfile],
    activeProfileId: profiles.some((profile) => profile.id === draft.activeProfileId)
      ? draft.activeProfileId
      : (profiles[0]?.id ?? fallbackProfile.id),
  })
}

/** 不能删除这个 API 配置的原因；可以删除时为 null */
export function getApiProfileDeleteBlock(settings: AppSettings, id: string) {
  const preset = getPresetProfileIds().has(id)
  const defaultProfileId = getDefaultPresetProfileId() ?? getDefaultApiProfileId(settings)
  if (!settings.profiles.some((item) => item.id === id)) return '找不到这个 API 配置'
  if (isPresetConfigOnlyEnabled()) return '应用只允许使用预置的 API 配置，不能删除'
  if (settings.profiles.length <= 1) return '至少要保留一个 API 配置'
  if (preset && isPresetConfigDeletionPrevented()) return '预置的 API 配置不能删除'
  if (!preset && id === defaultProfileId) return '默认 API 配置不能删除'
  return null
}

/** 删除 API 配置；删除的是启用中的配置时改为启用第一个。调用方先用 getApiProfileDeleteBlock 检查 */
export function removeApiProfile(settings: AppSettings, id: string) {
  const profiles = settings.profiles.filter((item) => item.id !== id)
  return normalizeSettings({
    ...settings,
    profiles,
    activeProfileId: settings.activeProfileId === id ? profiles[0].id : settings.activeProfileId,
  })
}

/** 不能删除这个自定义服务商的原因；可以删除时为 null */
export function getCustomProviderDeleteBlock(settings: AppSettings, id: string) {
  if (!settings.customProviders.some((item) => item.id === id)) return '找不到这个自定义服务商'
  if (isPresetConfigOnlyEnabled() || isPresetProviderDeletionPrevented(id, settings.profiles)) return '预置的服务商不能删除'
  return null
}

/** 删除自定义服务商，使用它的配置切回 OpenAI 兼容接口 */
export function removeCustomProvider(settings: AppSettings, id: string) {
  return normalizeSettings({
    ...settings,
    customProviders: settings.customProviders.filter((provider) => provider.id !== id),
    profiles: settings.profiles.map((profile) =>
      profile.provider === id ? switchApiProfileProvider(profile, 'openai') : profile,
    ),
  })
}

/** 由服务商 JSON 生成自定义服务商；editingId 为要替换的服务商，新建时 id 不与已有的重复。无效时抛出错误 */
export function buildCustomProvider(input: unknown, existing: CustomProviderDefinition[], editingId: string | null) {
  const usedIds = new Set(existing.filter((item) => item.id !== editingId).map((item) => item.id))
  const provider = normalizeCustomProviderDefinition(
    editingId && input && typeof input === 'object' ? { ...input, id: editingId } : input,
    usedIds,
  )
  if (!provider) throw new Error('自定义服务商配置无效')
  return provider
}
