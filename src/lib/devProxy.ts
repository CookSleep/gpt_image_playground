import { isTauri } from './platform'
import { readRuntimeEnv } from './runtimeEnv'

export interface DevProxyConfig {
  enabled: boolean
  prefix: string
  target: string
  changeOrigin: boolean
  secure: boolean
}

const DEFAULT_PROXY_PREFIX = '/api-proxy'

export function normalizeBaseUrl(baseUrl: string, apiVersion = 'v1'): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ''

  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  try {
    const url = new URL(input)
    if (trimmed.endsWith('/')) return `${url.origin}${url.pathname.replace(/\/+$/, '/')}`

    const pathSegments = url.pathname.split('/').filter(Boolean)
    const versionIndex = pathSegments.indexOf(apiVersion)
    const normalizedSegments = versionIndex >= 0
      ? pathSegments.slice(0, versionIndex + 1)
      : pathSegments.length
        ? [...pathSegments, apiVersion]
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
  apiVersion = 'v1',
): string {
  const trimmedBaseUrl = baseUrl.trim()
  const endpointPath = path.replace(/^\/+/, '')

  if (useApiProxy) {
    return `${proxyConfig?.prefix ?? DEFAULT_PROXY_PREFIX}/${endpointPath}`
  }

  const normalizedBaseUrl = normalizeBaseUrl(trimmedBaseUrl, apiVersion)
  if (trimmedBaseUrl.endsWith('/')) {
    return `${normalizedBaseUrl.replace(/\/+$/, '')}/${endpointPath}`
  }

  const apiPath = normalizedBaseUrl.endsWith(`/${apiVersion}`)
    ? endpointPath
    : [apiVersion, endpointPath].join('/')

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

/**
 * 站点部署在登录网关之后时，登录过期后发往 API 代理的请求会被网关重定向到登录页或换成登录网页，
 * 表现为网络错误、JSON 解析失败或报错内容是整页 HTML。此时再请求一次站点首页，
 * 首页也被重定向或返回 401/403 才换成登录过期的提示；模型接口自身的报错不影响首页，保持原样。
 * Service Worker 只接管 GET，用 HEAD 才能拿到网关的响应而不是缓存的页面
 */
export async function describeApiProxyError(err: unknown, apiProxy: boolean): Promise<unknown> {
  if (!shouldUseApiProxy(apiProxy)) return err
  const intercepted = err instanceof TypeError || err instanceof SyntaxError || (err instanceof Error && /^\s*<(!doctype|html)/i.test(err.message))
  if (!intercepted) return err
  try {
    const response = await fetch('./', { method: 'HEAD', redirect: 'manual', cache: 'no-store' })
    if (response.type !== 'opaqueredirect' && response.status !== 401 && response.status !== 403) return err
  } catch {
    return err
  }
  return new Error('登录状态可能已过期，请刷新页面重新登录后重试。')
}
