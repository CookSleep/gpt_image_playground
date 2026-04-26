export interface DevProxyConfig {
  enabled: boolean
  prefix: string
  target: string
  changeOrigin: boolean
  secure: boolean
}

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ''

  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  try {
    const url = new URL(input)
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    return `${url.origin}${pathname}`
  } catch {
    return trimmed.replace(/\/+$/, '')
  }
}

export function normalizeDevProxyConfig(input: unknown): DevProxyConfig | null {
  if (!input || typeof input !== 'object') return null

  const record = input as Record<string, unknown>
  const target = normalizeBaseUrl(typeof record.target === 'string' ? record.target : '')
  if (!target) return null

  const rawPrefix = typeof record.prefix === 'string' ? record.prefix : '/api-proxy'
  const trimmedPrefix = rawPrefix.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  const prefix = trimmedPrefix ? `/${trimmedPrefix}` : '/api-proxy'

  return {
    enabled: Boolean(record.enabled),
    prefix,
    target,
    changeOrigin: record.changeOrigin !== false,
    secure: Boolean(record.secure),
  }
}

export function buildApiUrl(baseUrl: string, path: string, proxyConfig?: DevProxyConfig | null): string {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const apiPath = ['v1', path.replace(/^\/+/, '')].join('/')
  const useProxy =
    Boolean(proxyConfig?.enabled) &&
    Boolean(proxyConfig?.target) &&
    normalizedBaseUrl === proxyConfig?.target

  if (useProxy) {
    return `${proxyConfig!.prefix}/${apiPath}`
  }

  return normalizedBaseUrl ? `${normalizedBaseUrl}/${apiPath}` : `/${apiPath}`
}

export function resolveDevProxyConfig(input: unknown, isDev: boolean): DevProxyConfig | null {
  if (!isDev) return null
  return normalizeDevProxyConfig(input)
}

export function readClientDevProxyConfig(): DevProxyConfig | null {
  return resolveDevProxyConfig(
    typeof __DEV_PROXY_CONFIG__ === 'undefined' ? null : __DEV_PROXY_CONFIG__,
    import.meta.env.DEV,
  )
}
