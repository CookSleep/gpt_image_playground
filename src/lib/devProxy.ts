import { isTauri } from './platform'
import { readRuntimeEnv } from './runtimeEnv'
import { DEFAULT_GROK_BASE_URL } from './grok'

export interface DevProxyConfig {
  enabled: boolean
  prefix: string
  target: string
  changeOrigin: boolean
  secure: boolean
}

const DEFAULT_PROXY_PREFIX = '/api-proxy'

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ''

  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  try {
    const url = new URL(input)
    if (trimmed.endsWith('/')) return `${url.origin}${url.pathname.replace(/\/+$/, '/')}`

    const pathSegments = url.pathname.split('/').filter(Boolean)
    const v1Index = pathSegments.indexOf('v1')
    const normalizedSegments = v1Index >= 0
      ? pathSegments.slice(0, v1Index + 1)
      : pathSegments.length
        ? [...pathSegments, 'v1']
        : []
    const pathname = normalizedSegments.length ? `/${normalizedSegments.join('/')}` : ''
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

  const rawPrefix = typeof record.prefix === 'string' ? record.prefix : DEFAULT_PROXY_PREFIX
  const trimmedPrefix = rawPrefix.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  const prefix = trimmedPrefix ? `/${trimmedPrefix}` : DEFAULT_PROXY_PREFIX

  return {
    enabled: Boolean(record.enabled),
    prefix,
    target,
    changeOrigin: record.changeOrigin !== false,
    secure: Boolean(record.secure),
  }
}

export function buildApiUrl(
  baseUrl: string,
  path: string,
  proxyConfig?: DevProxyConfig | null,
  useApiProxy = false,
): string {
  const trimmedBaseUrl = baseUrl.trim()
  const endpointPath = path.replace(/^\/+/, '')

  if (useApiProxy) {
    return `${proxyConfig?.prefix ?? DEFAULT_PROXY_PREFIX}/${endpointPath}`
  }

  const normalizedBaseUrl = normalizeBaseUrl(trimmedBaseUrl)
  if (!isTauri && (import.meta.env.DEV || import.meta.env.VITE_GROK_PROXY_AVAILABLE === 'true') && normalizedBaseUrl.replace(/\/+$/, '') === DEFAULT_GROK_BASE_URL) {
    return `/grok-api/${endpointPath}`
  }
  if (trimmedBaseUrl.endsWith('/')) {
    return `${normalizedBaseUrl.replace(/\/+$/, '')}/${endpointPath}`
  }

  const apiPath = normalizedBaseUrl.endsWith('/v1')
    ? endpointPath
    : ['v1', endpointPath].join('/')

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

export function isApiProxyAvailable(proxyConfig: DevProxyConfig | null = readClientDevProxyConfig()): boolean {
  // 客户端不受跨域限制，代理选项隐藏且不生效；已保存的代理设置保持不变，导回网页版时仍然有效
  if (isTauri) return false
  return readRuntimeEnv(import.meta.env.VITE_API_PROXY_AVAILABLE) === 'true' || Boolean(proxyConfig?.enabled)
}

export function isApiProxyLocked(proxyConfig: DevProxyConfig | null = readClientDevProxyConfig()): boolean {
  return readRuntimeEnv(import.meta.env.VITE_API_PROXY_LOCKED) === 'true' && isApiProxyAvailable(proxyConfig)
}

export function shouldUseApiProxy(apiProxy: boolean, proxyConfig: DevProxyConfig | null = readClientDevProxyConfig()): boolean {
  return isApiProxyAvailable(proxyConfig) && (apiProxy || isApiProxyLocked(proxyConfig))
}
