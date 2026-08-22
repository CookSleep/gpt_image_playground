export const EMBEDDED_CONFIG_PREFIX = 'embedded-config:'

export function isImportableConfigUrl(value: string): boolean {
  const url = value.trim()
  if (!url) return false
  if (url.startsWith(EMBEDDED_CONFIG_PREFIX)) return true

  try {
    const parsed = new URL(url)
    return parsed.searchParams.has('settings') || parsed.pathname.toLowerCase().endsWith('.json')
  } catch {
    return false
  }
}
