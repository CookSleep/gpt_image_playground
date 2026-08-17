/**
 * 直接调用 OIDC Provider 资源端点的客户端封装
 *
 * 设计：
 * - 用 OIDC 颁发的 access_token 直接 Bearer 调 {issuer}/oidc/resource/api-keys
 * - 用户选定某个 api_key 后，可继续用该 api_key 调 {issuer}/v1/usage 和 {issuer}/v1/models
 * - 调用方需保证 provider 已开启 CORS
 */

import { clearTokens, ensureOIDCToken, getOIDCAccessToken, getOIDCIssuer, refreshOIDCToken } from './api'

export type ApiKeyItem = {
  key: string
  name?: string
  groupName?: string
}

export type ApiKeysResponse = {
  sub2api_apikeys: string[]
  sub2api_apikey_count: number
  items: ApiKeyItem[]
}

export type UsageResponse = {
  // 后端实际字段未必如此，前端尽量宽松解析
  total_balance?: number | string
  balance?: number | string
  remaining?: number | string
  [k: string]: unknown
}

export type ModelInfo = {
  id: string
  object?: string
  owned_by?: string
  [k: string]: unknown
}

export type ModelsResponse = {
  data: ModelInfo[]
  object?: string
}

export type EstimatePricingResponse = {
  endpoint: string
  billing_mode?: string
  pricing_source?: string
  tier?: string
  resolution?: { width: number; height: number }
  image_count?: number
  unit_price?: number
  total_cost?: number
  rate_multiplier?: number
  estimated_price?: number
  [k: string]: unknown
}

const usageInFlight = new Map<string, Promise<UsageResponse>>()

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : '/' + path
  return b + p
}

function requireIssuer(): string {
  const issuer = getOIDCIssuer()
  if (!issuer) throw new Error('OIDC issuer 未保存，请重新登录')
  return issuer
}

function requireOIDCToken(): string {
  const tok = getOIDCAccessToken()
  if (!tok) throw new Error('OIDC access_token 未保存，请重新登录')
  return tok
}

/** OIDC 会话不可恢复时：清 token 并跳回首页走重登 */
function handleOIDCSessionLost(): never {
  clearTokens()
  if (typeof window !== 'undefined') {
    window.location.href = '/'
  }
  throw new Error('OIDC session expired, please re-login')
}

/** 在调用前拿到一个可用的 oidc_access_token，快过期会主动刷 */
async function getActiveOIDCToken(): Promise<string> {
  const tok = await ensureOIDCToken()
  if (!tok) handleOIDCSessionLost()
  return tok as string
}

// 模块级 Promise 缓存：解决 React StrictMode 下 useEffect 双执行导致的重复请求
// 同步立即赋值 Promise，第二次调用直接复用同一个 Promise
let apiKeysPromise: Promise<ApiKeysResponse> | null = null

/** 清空 api-keys 缓存（登出、切换用户、失败重试时调用） */
export function invalidateApiKeysCache(): void {
  apiKeysPromise = null
}

/** GET {issuer}/oidc/resource/api-keys?status=active —— 仅返回启用的 key（带模块级缓存） */
export function fetchApiKeys(): Promise<ApiKeysResponse> {
  if (apiKeysPromise) return apiKeysPromise
  apiKeysPromise = _fetchApiKeys().catch((err) => {
    // 失败清空缓存，允许下次重试
    apiKeysPromise = null
    throw err
  })
  return apiKeysPromise
}

async function _fetchApiKeys(): Promise<ApiKeysResponse> {
  const issuer = requireIssuer()
  const apiKeysUrl = joinUrl(issuer, '/oidc/resource/api-keys') + '?status=active'
  const doFetch = (token: string) =>
    fetch(apiKeysUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    })

  let resp = await doFetch(await getActiveOIDCToken())
  // oidc_access_token 过期：用 refresh token 换新的再重试一次
  if (resp.status === 401) {
    const refreshed = await refreshOIDCToken()
    if (!refreshed) handleOIDCSessionLost()
    resp = await doFetch(refreshed as string)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`fetch api-keys failed: ${resp.status} ${text}`)
  }
  const raw = (await resp.json()) as Record<string, unknown>
  // 调试日志：打印原始返回结构，便于核对字段名
  // eslint-disable-next-line no-console
  console.log('[oidcResource] /oidc/resource/api-keys raw response:', raw)
  // 额外打印 items[0] 以便确认对象字段命名
  try {
    const innerForLog = (raw['data'] as Record<string, unknown> | undefined) ?? raw
    const itemsForLog = innerForLog?.['items'] ?? innerForLog?.['list'] ?? innerForLog?.['data']
    if (Array.isArray(itemsForLog) && itemsForLog.length > 0) {
      // eslint-disable-next-line no-console
      console.log('[oidcResource] api-keys items[0]:', itemsForLog[0])
    }
  } catch {
    /* ignore */
  }

  // 如果是 { code, message, data: {...} } 这种包装，取 data 作为有效负载
  let payload: Record<string, unknown> = raw
  const inner = raw['data']
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    payload = inner as Record<string, unknown>
  }

  // 兼容多种可能的字段命名（包含分页风格的 items）
  const keysCandidate =
    payload['sub2api_apikeys'] ??
    payload['sub2api:apikeys'] ??
    payload['sub2api_api_keys'] ??
    payload['apikeys'] ??
    payload['api_keys'] ??
    payload['keys'] ??
    payload['items'] ??
    payload['list'] ??
    payload['data']

  let keys: string[] = []
  const items: ApiKeyItem[] = []
  if (Array.isArray(keysCandidate)) {
    for (const item of keysCandidate) {
      if (typeof item === 'string') {
        if (item) {
          keys.push(item)
          items.push({ key: item })
        }
        continue
      }
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        // 兼容 sub2api 的列表对象字段：api_key / sub2api_apikey 等
        const v =
          obj['key'] ??
          obj['api_key'] ??
          obj['apikey'] ??
          obj['sub2api_apikey'] ??
          obj['sub2api:apikey'] ??
          obj['secret'] ??
          obj['token'] ??
          obj['value'] ??
          obj['id']
        const keyStr = typeof v === 'string' ? v : ''
        if (!keyStr) continue

        const nameRaw =
          obj['name'] ??
          obj['display_name'] ??
          obj['alias'] ??
          obj['title']
        const name = typeof nameRaw === 'string' && nameRaw ? nameRaw : undefined

        // group 可能是 { name: '...' } 对象，也可能是字符串；兼容 group_name
        let groupName: string | undefined
        const groupRaw = obj['group']
        if (groupRaw && typeof groupRaw === 'object') {
          const gn = (groupRaw as Record<string, unknown>)['name']
          if (typeof gn === 'string' && gn) groupName = gn
        } else if (typeof groupRaw === 'string' && groupRaw) {
          groupName = groupRaw
        }
        if (!groupName) {
          const gn2 = obj['group_name'] ?? obj['groupName']
          if (typeof gn2 === 'string' && gn2) groupName = gn2
        }

        keys.push(keyStr)
        items.push({ key: keyStr, name, groupName })
      }
    }
  }

  const countCandidate =
    payload['sub2api_apikey_count'] ??
    payload['sub2api:apikey_count'] ??
    payload['apikey_count'] ??
    payload['count'] ??
    payload['total']
  const count =
    typeof countCandidate === 'number'
      ? countCandidate
      : typeof countCandidate === 'string'
        ? Number(countCandidate) || keys.length
        : keys.length

  return {
    sub2api_apikeys: keys,
    sub2api_apikey_count: count,
    items,
  }
}

/** GET {issuer}/v1/usage —— 用所选 api_key 作 Bearer */
export async function fetchUsage(apiKey: string, options?: { signal?: AbortSignal }): Promise<UsageResponse> {
  if (!apiKey) throw new Error('apiKey 不能为空')
  const issuer = requireIssuer()
  const cacheKey = `${issuer}:${apiKey}`
  const existing = usageInFlight.get(cacheKey)
  if (existing) return existing

  const promise = (async () => {
    const resp = await fetch(joinUrl(issuer, '/v1/usage'), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: options?.signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`fetch usage failed: ${resp.status} ${text}`)
    }
    return (await resp.json()) as UsageResponse
  })()
  usageInFlight.set(cacheKey, promise)
  try {
    return await promise
  } finally {
    usageInFlight.delete(cacheKey)
  }
}

/** GET {issuer}/v1/models —— 用所选 api_key 作 Bearer */
export async function fetchModels(apiKey: string, options?: { signal?: AbortSignal }): Promise<ModelsResponse> {
  if (!apiKey) throw new Error('apiKey 不能为空')
  const issuer = requireIssuer()
  const resp = await fetch(joinUrl(issuer, '/v1/models'), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal: options?.signal,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`fetch models failed: ${resp.status} ${text}`)
  }
  const data = (await resp.json()) as ModelsResponse
  return {
    data: Array.isArray(data?.data) ? data.data : [],
    object: data?.object,
  }
}


function encodeEndpointPath(endpoint: string): string {
  return endpoint.split('/').map((part) => encodeURIComponent(part)).join('/')
}

/** POST {issuer}/api/v1/model/{endpoint}/estimate_pricing —— 用所选 api_key 作 Bearer */
export async function estimateModelPricing(
  apiKey: string,
  endpoint: string,
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<EstimatePricingResponse> {
  if (!apiKey) throw new Error('apiKey 不能为空')
  if (!endpoint) throw new Error('endpoint 不能为空')
  const issuer = requireIssuer()
  const resp = await fetch(joinUrl(issuer, `/api/v1/model/${encodeEndpointPath(endpoint)}/estimate_pricing`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: options?.signal,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`estimate pricing failed: ${resp.status} ${text}`)
  }
  return (await resp.json()) as EstimatePricingResponse
}

/** 在 UsageResponse 里尽量提取一个可读的 balance 数值/字符串 */
export function extractBalance(usage: UsageResponse | null | undefined): string {
  if (!usage) return ''
  const candidates = [
    usage.total_balance,
    usage.balance,
    usage.remaining,
    (usage as Record<string, unknown>)['total_available'],
    (usage as Record<string, unknown>)['available'],
  ]
  for (const v of candidates) {
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v)
      if (Number.isFinite(n)) {
        // 最多保留 4 位小数，去掉多余的尾随零
        return String(Number(n.toFixed(4)))
      }
      return String(v)
    }
  }
  return ''
}
