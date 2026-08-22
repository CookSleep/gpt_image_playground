import type { ApiMode, ApiProfile, AppSettings } from '../types'
import { normalizeBaseUrl } from './devProxy'
import {
  createDefaultOpenAIProfile,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_RESPONSES_MODEL,
  findEquivalentApiProfile,
  mergeImportedSettings,
  normalizeSettings,
  normalizeReasoningEffort,
  normalizeStreamPartialImages,
} from './apiProfiles'
import { isPresetConfigOnlyEnabled, isPresetConfigParamsLocked, isPresetProfile } from './presetConfig'

const URL_SETTING_KEYS = ['settings', 'profileId', 'apiUrl', 'apiKey', 'codexCli', 'apiMode', 'model', 'profileName', 'reasoningEffort', 'streamImages', 'streamPartialImages', 'transparentBackgroundMethod']

function getProfileDedupKey(profile: Pick<AppSettings['profiles'][number], 'provider' | 'baseUrl' | 'apiKey' | 'model' | 'apiMode' | 'reasoningEffort' | 'codexCli' | 'streamImages' | 'streamPartialImages' | 'transparentBackgroundMethod'>) {
  return JSON.stringify([
    profile.provider,
    profile.baseUrl.trim().toLowerCase(),
    profile.apiKey.trim(),
    profile.model.trim(),
    profile.apiMode,
    profile.reasoningEffort,
    profile.codexCli === true,
    profile.streamImages === true,
    profile.streamPartialImages ?? 0,
    profile.transparentBackgroundMethod,
  ])
}

function createUrlProfileId(usedIds: Set<string>) {
  let id = `openai-url-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  while (usedIds.has(id)) {
    id = `openai-url-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  }
  usedIds.add(id)
  return id
}

function pickUrlSettingsPayload(value: unknown): unknown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return {
    customProviders: record.customProviders,
    profiles: record.profiles,
  }
}

export function getUrlSettingsPayload(searchParams: URLSearchParams): unknown | null {
  const raw = searchParams.get('settings')
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'settings' in parsed) {
      return pickUrlSettingsPayload((parsed as { settings?: unknown }).settings ?? null)
    }
    return pickUrlSettingsPayload(parsed)
  } catch {
    return null
  }
}

export function getExplicitUrlSettingsIds(searchParams: URLSearchParams) {
  const providerIds = new Set<string>()
  const profileIds = new Set<string>()
  const payload = getUrlSettingsPayload(searchParams)
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>
    if (Array.isArray(record.customProviders)) {
      for (const item of record.customProviders) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const id = typeof (item as Record<string, unknown>).id === 'string' ? String((item as Record<string, unknown>).id).trim() : ''
        if (id) providerIds.add(id)
      }
    }
    if (Array.isArray(record.profiles)) {
      for (const item of record.profiles) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const id = typeof (item as Record<string, unknown>).id === 'string' ? String((item as Record<string, unknown>).id).trim() : ''
        if (id) profileIds.add(id)
      }
    }
  }
  const profileId = searchParams.get('profileId')?.trim()
  if (profileId) profileIds.add(profileId)
  return { providerIds: [...providerIds], profileIds: [...profileIds] }
}

function ensureUrlSettingsProfileIds(value: unknown, currentSettings: Partial<AppSettings> | unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.profiles)) return value
  const usedIds = new Set(normalizeSettings(currentSettings).profiles.map((profile) => profile.id))
  const emittedIds = new Set<string>()
  for (const item of record.profiles) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const id = typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id.trim() : ''
    if (id) usedIds.add(id)
  }
  return {
    ...record,
    profiles: record.profiles.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item
      const profile = item as Record<string, unknown>
      if (typeof profile.id === 'string' && profile.id.trim() && !emittedIds.has(profile.id.trim())) {
        emittedIds.add(profile.id.trim())
        return { ...profile, id: profile.id.trim() }
      }
      return { ...profile, id: createUrlProfileId(usedIds) }
    }),
  }
}

export function activateFirstImportedProfile(settings: AppSettings, importedSettings: unknown): AppSettings {
  if (!importedSettings || typeof importedSettings !== 'object' || Array.isArray(importedSettings)) return settings

  const record = importedSettings as Record<string, unknown>
  if (!Array.isArray(record.profiles) || record.profiles.length === 0) return settings

  const imported = normalizeSettings({
    customProviders: record.customProviders,
    profiles: record.profiles,
  })
  const importedProfile = imported.profiles[0]
  const importedById = settings.profiles.find((profile) => profile.id === importedProfile.id)
  if (importedById) return normalizeSettings({ ...settings, activeProfileId: importedById.id })
  const activeProfile = findEquivalentApiProfile(settings, importedProfile, imported.customProviders)

  return activeProfile
    ? normalizeSettings({ ...settings, activeProfileId: activeProfile.id })
    : settings
}

/**
 * 仅展示预置配置模式：从 URL 参数中提取可覆盖的字段，patch 到当前活跃配置上。
 * 不新建配置、不导入自定义服务商、不切换 provider。
 */
function buildPresetConfigOnlySettingsFromUrlParams(currentSettings: Partial<AppSettings> | unknown, searchParams: URLSearchParams, apiKeyOnly = false): Partial<AppSettings> {
  const settings = normalizeSettings(currentSettings)
  const requestedProfileId = searchParams.get('profileId')?.trim() ?? ''
  const requestedProfile = requestedProfileId && isPresetProfile(requestedProfileId)
    ? settings.profiles.find((profile) => profile.id === requestedProfileId)
    : undefined
  if (requestedProfileId && !requestedProfile) return {}
  const targetProfile = requestedProfile ?? settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings.profiles[0]
  if (!targetProfile) return {}

  const isOpenAI = targetProfile.provider === 'openai'
  const patch: Partial<typeof targetProfile> = {}

  // 从 ?settings= JSON 中提取同 provider 的 profile 字段
  const importedSettings = ensureUrlSettingsProfileIds(getUrlSettingsPayload(searchParams), currentSettings)
  if (importedSettings && typeof importedSettings === 'object' && !Array.isArray(importedSettings)) {
    const profiles = (importedSettings as Record<string, unknown>).profiles
    if (Array.isArray(profiles)) {
      const matched = (requestedProfile ? profiles.find((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false
        const profile = item as Record<string, unknown>
        return profile.id === requestedProfile.id && (profile.provider === undefined || profile.provider === targetProfile.provider)
      }) : profiles.find((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false
        const provider = (item as Record<string, unknown>).provider
        return provider === undefined || provider === targetProfile.provider
      })) as Record<string, unknown> | undefined
      if (matched) {
        if (typeof matched.apiKey === 'string') patch.apiKey = matched.apiKey
        if (!apiKeyOnly) {
          if (typeof matched.name === 'string' && matched.name.trim()) patch.name = matched.name.trim()
          if (typeof matched.baseUrl === 'string') patch.baseUrl = matched.baseUrl
          if (typeof matched.model === 'string' && matched.model.trim()) patch.model = matched.model.trim()
          if (typeof matched.timeout === 'number' && Number.isFinite(matched.timeout)) patch.timeout = matched.timeout
          if (typeof matched.apiProxy === 'boolean') patch.apiProxy = matched.apiProxy
          if (matched.responseFormatB64Json === true) patch.responseFormatB64Json = true
          if (matched.transparentBackgroundMethod === 'api' || matched.transparentBackgroundMethod === 'local') {
            patch.transparentBackgroundMethod = matched.transparentBackgroundMethod
          }
          if (targetProfile.provider !== 'fal' && typeof matched.codexCli === 'boolean') patch.codexCli = matched.codexCli
          if (isOpenAI) {
            if (matched.apiMode === 'images' || matched.apiMode === 'responses') patch.apiMode = matched.apiMode
            if (matched.reasoningEffort !== undefined) patch.reasoningEffort = normalizeReasoningEffort(matched.reasoningEffort)
            if (typeof matched.streamImages === 'boolean') patch.streamImages = matched.streamImages
            if (matched.streamPartialImages !== undefined) patch.streamPartialImages = normalizeStreamPartialImages(matched.streamPartialImages)
          }
        }
      }
    }
  }

  // 查询参数覆盖（优先级高于 settings JSON）
  const apiUrlParam = searchParams.get('apiUrl')
  const apiKeyParam = searchParams.get('apiKey')
  const modelParam = searchParams.get('model')
  const profileNameParam = searchParams.get('profileName')
  const transparentBackgroundMethodParam = searchParams.get('transparentBackgroundMethod')
  if (apiKeyParam !== null) patch.apiKey = apiKeyParam.trim()
  if (!apiKeyOnly) {
    if (profileNameParam?.trim()) patch.name = profileNameParam.trim()
    if (apiUrlParam !== null) patch.baseUrl = normalizeBaseUrl(apiUrlParam.trim())
    if (modelParam !== null && modelParam.trim()) patch.model = modelParam.trim()
    if (transparentBackgroundMethodParam === 'api' || transparentBackgroundMethodParam === 'local') {
      patch.transparentBackgroundMethod = transparentBackgroundMethodParam
    }
  }
  if (targetProfile.provider !== 'fal' && !apiKeyOnly) {
    const codexCliParam = searchParams.get('codexCli')
    if (codexCliParam !== null) patch.codexCli = codexCliParam.trim().toLowerCase() === 'true'
  }
  if (isOpenAI && !apiKeyOnly) {
    const apiModeParam = searchParams.get('apiMode')
    const reasoningEffortParam = searchParams.get('reasoningEffort')
    const streamImagesParam = searchParams.get('streamImages')
    const streamPartialImagesParam = searchParams.get('streamPartialImages')
    if (apiModeParam === 'images' || apiModeParam === 'responses') patch.apiMode = apiModeParam
    if (reasoningEffortParam !== null) patch.reasoningEffort = normalizeReasoningEffort(reasoningEffortParam)
    if (streamImagesParam !== null) patch.streamImages = streamImagesParam.trim().toLowerCase() === 'true'
    if (streamPartialImagesParam !== null) patch.streamPartialImages = normalizeStreamPartialImages(streamPartialImagesParam)
  }

  if (Object.keys(patch).length === 0 && !requestedProfile) return {}

  return normalizeSettings({
    ...settings,
    profiles: settings.profiles.map((profile) =>
      profile.id === targetProfile.id ? { ...profile, ...patch, provider: profile.provider } : profile,
    ),
    activeProfileId: requestedProfile?.id ?? settings.activeProfileId,
  })
}

export function hasUrlSettingParams(searchParams: URLSearchParams) {
  return URL_SETTING_KEYS.some((key) => searchParams.has(key))
}

export function clearUrlSettingParams(searchParams: URLSearchParams) {
  for (const key of URL_SETTING_KEYS) searchParams.delete(key)
}

function buildRegularSettingsFromUrlParams(currentSettings: Partial<AppSettings> | unknown, searchParams: URLSearchParams): Partial<AppSettings> {
  const importedSettings = ensureUrlSettingsProfileIds(getUrlSettingsPayload(searchParams), currentSettings)
  const profileIdParam = searchParams.get('profileId')
  const apiUrlParam = searchParams.get('apiUrl')
  const apiKeyParam = searchParams.get('apiKey')
  const codexCliParam = searchParams.get('codexCli')
  const apiModeParam = searchParams.get('apiMode')
  const modelParam = searchParams.get('model')
  const reasoningEffortParam = searchParams.get('reasoningEffort')
  const profileNameParam = searchParams.get('profileName')
  const profileName = profileNameParam?.trim() ?? ''
  const streamImagesParam = searchParams.get('streamImages')
  const streamPartialImagesParam = searchParams.get('streamPartialImages')
  const transparentBackgroundMethodParam = searchParams.get('transparentBackgroundMethod')
  const transparentBackgroundMethod: ApiProfile['transparentBackgroundMethod'] | undefined = transparentBackgroundMethodParam === 'api' || transparentBackgroundMethodParam === 'local'
    ? transparentBackgroundMethodParam
    : undefined
  const apiMode: ApiMode | undefined = apiModeParam === 'images' || apiModeParam === 'responses' ? apiModeParam : undefined

  const hasLegacyOpenAIParams = apiUrlParam !== null || apiKeyParam !== null || codexCliParam !== null || apiMode !== undefined || modelParam !== null || profileNameParam !== null || reasoningEffortParam !== null || streamImagesParam !== null || streamPartialImagesParam !== null
  const settings = importedSettings == null
    ? normalizeSettings(currentSettings)
    : activateFirstImportedProfile(mergeImportedSettings(currentSettings, importedSettings), importedSettings)

  const requestedProfileId = profileIdParam?.trim() ?? ''
  const requestedNonOpenAIProfile = requestedProfileId
    ? settings.profiles.find((item) => item.id === requestedProfileId && item.provider !== 'openai')
    : undefined
  if (requestedNonOpenAIProfile && (transparentBackgroundMethod !== undefined || (requestedNonOpenAIProfile.provider !== 'fal' && codexCliParam !== null))) {
    return normalizeSettings({
      ...settings,
      profiles: settings.profiles.map((item) => item.id === requestedProfileId
        ? {
            ...item,
            ...(requestedNonOpenAIProfile.provider !== 'fal' && codexCliParam !== null ? { codexCli: codexCliParam.trim().toLowerCase() === 'true' } : {}),
            ...(transparentBackgroundMethod ? { transparentBackgroundMethod } : {}),
          }
        : item),
      activeProfileId: requestedProfileId,
    })
  }

  if (!requestedProfileId && transparentBackgroundMethod !== undefined && !hasLegacyOpenAIParams) {
    return normalizeSettings({
      ...settings,
      profiles: settings.profiles.map((item) => item.id === settings.activeProfileId ? { ...item, transparentBackgroundMethod } : item),
    })
  }

  if (hasLegacyOpenAIParams || transparentBackgroundMethod !== undefined) {
    const existingById = requestedProfileId
      ? settings.profiles.find((item) => item.id === requestedProfileId && item.provider === 'openai')
      : undefined
    if (existingById) {
      const patch: Partial<typeof existingById> = {}
      if (apiUrlParam !== null) patch.baseUrl = normalizeBaseUrl(apiUrlParam.trim())
      if (apiKeyParam !== null) patch.apiKey = apiKeyParam.trim()
      if (apiMode !== undefined) patch.apiMode = apiMode
      if (modelParam !== null && modelParam.trim()) patch.model = modelParam.trim()
      if (reasoningEffortParam !== null) patch.reasoningEffort = normalizeReasoningEffort(reasoningEffortParam)
      if (profileName) patch.name = profileName
      if (codexCliParam !== null) patch.codexCli = codexCliParam.trim().toLowerCase() === 'true'
      if (streamImagesParam !== null) patch.streamImages = streamImagesParam.trim().toLowerCase() === 'true'
      if (streamPartialImagesParam !== null) patch.streamPartialImages = normalizeStreamPartialImages(streamPartialImagesParam)
      if (transparentBackgroundMethod !== undefined) patch.transparentBackgroundMethod = transparentBackgroundMethod

      return normalizeSettings({
        ...settings,
        profiles: settings.profiles.map((item) => item.id === requestedProfileId ? { ...item, ...patch } : item),
        activeProfileId: requestedProfileId,
      })
    }

    const profileApiMode = apiMode ?? 'images'
    const profile = createDefaultOpenAIProfile({
      id: requestedProfileId || createUrlProfileId(new Set(settings.profiles.map((item) => item.id))),
      name: 'URL 参数配置',
      apiMode: profileApiMode,
      model: profileApiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL,
    })
    if (apiUrlParam !== null) profile.baseUrl = normalizeBaseUrl(apiUrlParam.trim())
    if (apiKeyParam !== null) profile.apiKey = apiKeyParam.trim()
    if (modelParam !== null && modelParam.trim()) profile.model = modelParam.trim()
    if (reasoningEffortParam !== null) profile.reasoningEffort = normalizeReasoningEffort(reasoningEffortParam)
    if (profileName) profile.name = profileName
    if (codexCliParam !== null) profile.codexCli = codexCliParam.trim().toLowerCase() === 'true'
    if (streamImagesParam !== null) profile.streamImages = streamImagesParam.trim().toLowerCase() === 'true'
    if (streamPartialImagesParam !== null) profile.streamPartialImages = normalizeStreamPartialImages(streamPartialImagesParam)
    if (transparentBackgroundMethod !== undefined) profile.transparentBackgroundMethod = transparentBackgroundMethod

    const conflictingById = requestedProfileId ? settings.profiles.find((item) => item.id === requestedProfileId) : null
    if (conflictingById) {
      return normalizeSettings({
        ...settings,
        profiles: settings.profiles.map((item) => item.id === requestedProfileId ? { ...profile, isDefault: item.isDefault } : item),
        activeProfileId: requestedProfileId,
      })
    }

    const existingProfile = settings.profiles.find((item) =>
      getProfileDedupKey(item) === getProfileDedupKey(profile) &&
      (!profileName || item.name.trim() === profileName)
    )
    if (existingProfile) {
      return normalizeSettings({ ...settings, activeProfileId: existingProfile.id })
    }

    return normalizeSettings({
      ...settings,
      profiles: [...settings.profiles, profile],
      activeProfileId: profile.id,
    })
  }

  return importedSettings == null ? {} : settings
}

export function buildSettingsFromUrlParams(currentSettings: Partial<AppSettings> | unknown, searchParams: URLSearchParams): Partial<AppSettings> {
  const result = isPresetConfigOnlyEnabled()
    ? buildPresetConfigOnlySettingsFromUrlParams(currentSettings, searchParams, isPresetConfigParamsLocked())
    : buildRegularSettingsFromUrlParams(currentSettings, searchParams)
  return result
}
