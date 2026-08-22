import type { ApiProfile, CustomProviderDefinition } from '../types'

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
    customProviders: provider ? [provider] : [],
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
