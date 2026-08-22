import type { ImportedProviderSettings } from './apiProfiles'
import { importCustomProviderSettingsFromJson } from './apiProfiles'
import { EMBEDDED_CONFIG_PREFIX, isImportableConfigUrl } from './importableConfigUrl'
import { readRuntimeEnv } from './runtimeEnv'

const DEFAULT_API_URL = readRuntimeEnv(import.meta.env.VITE_DEFAULT_API_URL)
export { isImportableConfigUrl } from './importableConfigUrl'

export function getCustomProviderConfigUrl(defaultApiUrl = DEFAULT_API_URL): string {
  const url = defaultApiUrl.trim()
  if (hasEmbeddedDefaultConfig(url)) return ''
  try {
    return new URL(url).searchParams.has('settings') ? url : ''
  } catch {
    return ''
  }
}

export function hasEmbeddedDefaultConfig(
  defaultApiUrl = DEFAULT_API_URL,
): boolean {
  const value = defaultApiUrl.trim()
  return value.startsWith(EMBEDDED_CONFIG_PREFIX)
}

export function loadEmbeddedDefaultConfig(
  defaultApiUrl = DEFAULT_API_URL,
): ImportedProviderSettings | null {
  const value = defaultApiUrl.trim()
  if (!value.startsWith(EMBEDDED_CONFIG_PREFIX)) return null

  const bytes = Uint8Array.from(atob(value.slice(EMBEDDED_CONFIG_PREFIX.length)), (char) => char.charCodeAt(0))
  return importCustomProviderSettingsFromJson(new TextDecoder().decode(bytes), [], { deploymentConfig: true })
}

function getSettingsJsonTextFromUrl(value: string): string | null {
  try {
    const raw = new URL(value).searchParams.get('settings')
    if (!raw) return null

    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'settings' in parsed) {
      return JSON.stringify((parsed as { settings?: unknown }).settings ?? null)
    }
    return raw
  } catch {
    return null
  }
}

export async function loadCustomProviderSettingsFromUrl(configUrl: string): Promise<ImportedProviderSettings | null> {
  const url = configUrl.trim()
  if (!url) return null

  const settingsJsonText = getSettingsJsonTextFromUrl(url)
  if (settingsJsonText) return importCustomProviderSettingsFromJson(settingsJsonText, [], { deploymentConfig: true })
  return null
}
