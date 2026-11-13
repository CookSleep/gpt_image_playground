import type { ApiProfile, CustomProviderDefinition } from '../types'
import { DEFAULT_SETTINGS, normalizeStreamPartialImages } from './apiProfiles'
import { normalizeBaseUrl } from './devProxy'
import { getDefaultModelForMode } from './settingsActions'

interface ProfileImportUrlOptions {
  includeApiKey: boolean
  useNewApiAddress: boolean
  useNewApiKey: boolean
  useNewApiModel: boolean
}

export function createCustomProfileImportUrl(
  baseUrl: string,
  profile: ApiProfile,
  provider: CustomProviderDefinition | undefined,
  options: ProfileImportUrlOptions,
) {
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = ''
  const importProfile: Partial<ApiProfile> = {
    ...profile,
    id: undefined,
    isDefault: undefined,
    apiKey: options.includeApiKey ? profile.apiKey : '',
  }
  if (!options.includeApiKey) {
    if (options.useNewApiAddress) importProfile.baseUrl = '{address}'
    if (options.useNewApiKey) importProfile.apiKey = '{key}'
    if (options.useNewApiModel) importProfile.model = '{model}'
  }
  url.searchParams.set('settings', JSON.stringify({
    ...(provider ? { customProviders: [provider] } : {}),
    profiles: [importProfile],
  }))

  let result = url.toString()
  if (!options.includeApiKey) {
    if (options.useNewApiAddress) result = result.replace(/%7Baddress%7D/g, '{address}')
    if (options.useNewApiKey) result = result.replace(/%7Bkey%7D/g, '{key}')
    if (options.useNewApiModel) result = result.replace(/%7Bmodel%7D/g, '{model}')
  }
  return result
}

export function createOpenAIProfileImportUrl(pageUrl: string, profile: ApiProfile, options: ProfileImportUrlOptions) {
  const url = new URL(pageUrl)
  url.search = ''
  url.hash = ''

  const baseUrl = profile.baseUrl.trim() || DEFAULT_SETTINGS.baseUrl
  url.searchParams.set('apiUrl', options.useNewApiAddress && !options.includeApiKey ? '{address}' : normalizeBaseUrl(baseUrl))
  if (options.includeApiKey && profile.apiKey.trim()) {
    url.searchParams.set('apiKey', profile.apiKey.trim())
  } else if (!options.includeApiKey && options.useNewApiKey) {
    url.searchParams.set('apiKey', '{key}')
  }
  url.searchParams.set('apiMode', profile.apiMode)
  const model = profile.model.trim() || getDefaultModelForMode(profile.apiMode)
  url.searchParams.set('model', !options.includeApiKey && options.useNewApiModel ? '{model}' : model)
  if (profile.apiMode === 'responses') url.searchParams.set('imageGenerationModel', profile.imageGenerationModel?.trim() ?? '')
  if (profile.name.trim()) url.searchParams.set('profileName', profile.name.trim())
  url.searchParams.set('reasoningEffort', profile.reasoningEffort ?? '')
  url.searchParams.set('svgModel', profile.svgModel?.trim() ?? '')
  url.searchParams.set('svgReasoningEffort', profile.svgReasoningEffort ?? '')
  url.searchParams.set('responseFormatB64Json', profile.responseFormatB64Json === undefined ? '' : String(profile.responseFormatB64Json))
  url.searchParams.set('timeout', String(profile.timeout))
  url.searchParams.set('codexCli', String(profile.codexCli))
  url.searchParams.set('streamImages', String(Boolean(profile.streamImages)))
  url.searchParams.set('streamPartialImages', String(normalizeStreamPartialImages(profile.streamPartialImages)))
  url.searchParams.set('transparentBackgroundMethod', profile.transparentBackgroundMethod)

  let result = url.toString()
  if (!options.includeApiKey) {
    if (options.useNewApiAddress) result = result.replace('%7Baddress%7D', '{address}')
    if (options.useNewApiKey) result = result.replace('%7Bkey%7D', '{key}')
    if (options.useNewApiModel) result = result.replace('%7Bmodel%7D', '{model}')
  }
  return result
}
