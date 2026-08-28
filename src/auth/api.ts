/**
 * Auth backend API 客户端
 *
 * 设计要点（AUTH_BACKEND_URL 语义）：
 * - 未设置 / 空 ""：同源启用登录（默认，embed 单镜像与同源反代部署）
 * - "disabled"：显式关闭登录（纯静态无后端部署需手动设置）
 * - "https://..."：跨域调用指定后端（纯静态前端 + 远程后端，或本地分离调试）
 *
 * Token 存储：localStorage，key 见下面常量
 */

import { getAuthRuntimeConfig } from '../lib/runtimeEnv'

export const ACCESS_TOKEN_KEY = 'auth.access_token'
export const REFRESH_TOKEN_KEY = 'auth.refresh_token'
export const OIDC_ACCESS_TOKEN_KEY = 'auth.oidc_access_token'
export const OIDC_REFRESH_TOKEN_KEY = 'auth.oidc_refresh_token'
export const OIDC_ISSUER_KEY = 'auth.oidc_issuer'
export const OIDC_TOKEN_EXPIRY_KEY = 'auth.oidc_access_token_expire_at'

/** 预刷提前量（秒）：距过期还剩不足这么多就算“快过期” */
const OIDC_REFRESH_SKEW_SEC = 60
const FETCH_USER_CACHE_MS = 1000
const AUTH_REQUEST_TIMEOUT_MS = 8000
export const REQUEST_ID_HEADER = 'X-Request-ID'

let fetchUserInFlight: { token: string; promise: Promise<PublicUser | null> } | null = null
let fetchUserCache: { token: string; value: PublicUser | null; expiresAt: number } | null = null

export function createRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '')
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`
}

export type Provider = {
  name: string
  display_name: string
}

export type PublicUser = {
  id: string
  oidc_provider: string
  account_id?: string
  email?: string
  name?: string
  picture_url?: string
  /** 后端根据 admin.emails 配置判定；仅管理员可见的入口/提示以此为准 */
  is_admin?: boolean
  claims?: Record<string, any>
}

export type TokenPair = {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type?: string
}

/** 是否启用认证：仅显式 disabled 时关闭；未配置/空串默认同源启用 */
export function isAuthEnabled(): boolean {
  return getAuthRuntimeConfig() !== 'disabled'
}

/** 取后端基址，优先注入/env，缺省同源 */
export function getAuthBaseUrl(): string {
  const v = getAuthRuntimeConfig()
  if (!v || v === 'disabled') return ''
  return v.replace(/\/+$/, '')
}

function url(path: string): string {
  const base = getAuthBaseUrl()
  if (!path.startsWith('/')) path = '/' + path
  return base + path
}

export function getAccessToken(): string | null {
  try {
    return localStorage.getItem(ACCESS_TOKEN_KEY)
  } catch {
    return null
  }
}

export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY)
  } catch {
    return null
  }
}

export function saveTokens(pair: TokenPair) {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, pair.access_token)
    localStorage.setItem(REFRESH_TOKEN_KEY, pair.refresh_token)
  } catch {
    /* ignore quota errors */
  }
}

export function clearTokens() {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY)
    localStorage.removeItem(REFRESH_TOKEN_KEY)
    localStorage.removeItem(OIDC_ACCESS_TOKEN_KEY)
    localStorage.removeItem(OIDC_REFRESH_TOKEN_KEY)
    localStorage.removeItem(OIDC_ISSUER_KEY)
    localStorage.removeItem(OIDC_TOKEN_EXPIRY_KEY)
  } catch {
    /* ignore */
  }
}

/** 取 OIDC 提供商的原始 access_token，用于经应用后台代理 OIDC 资源端点 */
export function getOIDCAccessToken(): string | null {
  try {
    return localStorage.getItem(OIDC_ACCESS_TOKEN_KEY)
  } catch {
    return null
  }
}

/** 取 OIDC issuer URL，用于拼接仍由浏览器直连的计价端点。 */
export function getOIDCIssuer(): string | null {
  try {
    return localStorage.getItem(OIDC_ISSUER_KEY)
  } catch {
    return null
  }
}

/** 取 OIDC 提供商的 refresh_token，用于过期后刷新 oidc_access_token */
export function getOIDCRefreshToken(): string | null {
  try {
    return localStorage.getItem(OIDC_REFRESH_TOKEN_KEY)
  } catch {
    return null
  }
}

/** 读取 OIDC access_token 的到期时间戳（ms），未记录则返回 0 */
export function getOIDCAccessTokenExpireAt(): number {
  try {
    const v = localStorage.getItem(OIDC_TOKEN_EXPIRY_KEY)
    return v ? Number(v) || 0 : 0
  } catch {
    return 0
  }
}

/** 保存 OIDC access_token 及其 expires_in（可选）；expires_in <=0 时不写到期时间 */
export function saveOIDCAccessToken(token: string, expiresInSec?: number) {
  try {
    localStorage.setItem(OIDC_ACCESS_TOKEN_KEY, token)
    if (typeof expiresInSec === 'number' && expiresInSec > 0) {
      const expireAt = Date.now() + expiresInSec * 1000
      localStorage.setItem(OIDC_TOKEN_EXPIRY_KEY, String(expireAt))
    }
  } catch {
    /* ignore quota errors */
  }
}

/** OIDC access_token 是否快过期（默认 60s 预刷）。未记录到期时间时返回 false，交给 401 被动刷 */
export function isOIDCTokenExpiringSoon(skewSec = OIDC_REFRESH_SKEW_SEC): boolean {
  const expireAt = getOIDCAccessTokenExpireAt()
  if (!expireAt) return false
  return Date.now() >= expireAt - skewSec * 1000
}

/**
 * 调用 provider 资源端点前调一次：快过期就主动刷。
 * 返回当前可用的 oidc_access_token。刷失败且没可用 token 时返回 null。
 */
export async function ensureOIDCToken(): Promise<string | null> {
  if (isOIDCTokenExpiringSoon()) {
    const fresh = await refreshOIDCToken()
    if (fresh) return fresh
  }
  return getOIDCAccessToken()
}

/**
 * 用 OIDC refresh token 刷新 oidc_access_token。
 * 走后端 /auth/oidc/refresh（authFetch 会附带应用 JWT 并在其过期时自动刷新），
 * 成功后回写新的 oidc_access_token（及轮转后的 refresh token），返回新的 access token。
 */
export async function refreshOIDCToken(): Promise<string | null> {
  const refresh = getOIDCRefreshToken()
  if (!refresh) return null
  try {
    const resp = await authFetch('/auth/oidc/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refresh }),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as {
      oidc_access_token?: string
      oidc_refresh_token?: string
      expires_in?: number
    }
    if (!data.oidc_access_token) return null
    saveOIDCAccessToken(data.oidc_access_token, data.expires_in)
    if (data.oidc_refresh_token) {
      try {
        localStorage.setItem(OIDC_REFRESH_TOKEN_KEY, data.oidc_refresh_token)
      } catch {
        /* ignore quota errors */
      }
    }
    return data.oidc_access_token
  } catch {
    return null
  }
}

/** 使用当前 OIDC access token 重新读取 UserInfo，并让后台回填本地 claims，不触发 refresh。 */
export async function syncOIDCUserProfile(): Promise<PublicUser | null> {
  const accessToken = getOIDCAccessToken()
  if (!accessToken) return null
  try {
    const resp = await authFetch('/auth/oidc/sync', {
      method: 'POST',
      body: JSON.stringify({ access_token: accessToken }),
    })
    if (!resp.ok) return null
    return await resp.json() as PublicUser
  } catch {
    return null
  }
}

/** 一个轻量包装，附带 Authorization 头并在 401 时尝试 refresh 一次 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = getAccessToken()
  const headers = new Headers(init.headers || {})
  const callerHeaderNames = init.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers)
    ? Object.keys(init.headers as Record<string, string>)
    : []
  const exposeCallerHeaders = () => {
    // 保留调用方传入的大小写属性，兼容少数把 RequestInit headers 当普通对象读取的调用方。
    for (const name of callerHeaderNames) {
      const value = headers.get(name)
      if (value == null) continue
      Object.defineProperty(headers, name, { configurable: true, value })
    }
  }
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  if (!headers.has(REQUEST_ID_HEADER)) headers.set(REQUEST_ID_HEADER, createRequestId())
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData
  if (init.body && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  exposeCallerHeaders()
  let resp = await fetch(url(input), { ...init, headers })
  if (resp.status !== 401) return resp

  // 尝试 refresh
  const refreshed = await refreshTokens(init.signal ?? undefined, headers.get(REQUEST_ID_HEADER) ?? undefined)
  if (!refreshed) return resp

  const retryHeaders = new Headers(headers)
  retryHeaders.set('Authorization', `Bearer ${refreshed.access_token}`)
  if (init.body && !isFormData && !retryHeaders.has('Content-Type')) {
    retryHeaders.set('Content-Type', 'application/json')
  }
  resp = await fetch(url(input), { ...init, headers: retryHeaders })
  return resp
}

/** 列出可用的 OIDC 提供商 */
export async function listProviders(): Promise<Provider[]> {
  const resp = await fetch(url('/auth/providers'), {
    headers: { [REQUEST_ID_HEADER]: createRequestId() },
    signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
  })
  if (!resp.ok) throw new Error(`list providers: ${resp.status}`)
  const data = (await resp.json()) as { providers: Provider[] }
  return data.providers || []
}

/** 跳转到 OIDC 登录（让浏览器导航过去） */
export function startLogin(providerName: string) {
  window.location.href = url(`/auth/login/${encodeURIComponent(providerName)}`)
}

/** 取当前用户资料 */
export async function fetchUser(): Promise<PublicUser | null> {
  const token = getAccessToken() ?? ''
  if (token && fetchUserCache?.token === token && fetchUserCache.expiresAt > Date.now()) {
    return fetchUserCache.value
  }
  if (token && fetchUserInFlight?.token === token) return fetchUserInFlight.promise

  const promise = (async () => {
    // 查询参数绕过仍在控制当前页面的旧版 Service Worker 缓存；新版本身不会缓存 API。
    const resp = await authFetch(`/auth/user?_=${Date.now()}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    })
    if (resp.status === 401 || resp.status === 404) return null
    if (!resp.ok) throw new Error(`fetch user: ${resp.status}`)
    return (await resp.json()) as PublicUser
  })()

  if (token) fetchUserInFlight = { token, promise }
  try {
    const value = await promise
    const latestToken = getAccessToken() ?? token
    if (latestToken) {
      fetchUserCache = {
        token: latestToken,
        value,
        expiresAt: Date.now() + FETCH_USER_CACHE_MS,
      }
    }
    return value
  } finally {
    if (fetchUserInFlight?.promise === promise) fetchUserInFlight = null
  }
}

/** 刷新 token，失败返回 null 并清掉本地 token */
export async function refreshTokens(signal?: AbortSignal, requestId = createRequestId()): Promise<TokenPair | null> {
  const refresh = getRefreshToken()
  if (!refresh) return null
  try {
    const resp = await fetch(url('/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [REQUEST_ID_HEADER]: requestId },
      body: JSON.stringify({ refresh_token: refresh }),
      signal,
    })
    if (!resp.ok) {
      clearTokens()
      return null
    }
    const pair = (await resp.json()) as TokenPair
    saveTokens(pair)
    return pair
  } catch {
    return null
  }
}

/** 退出登录：调用后端，本地清 token */
export async function logout(): Promise<void> {
  try {
    await authFetch('/auth/logout', { method: 'POST' })
  } catch {
    /* ignore */
  } finally {
    clearTokens()
  }
}

/**
 * 解析 OIDC 回调 fragment：
 * 后端在 callback 成功后会 302 到 /#access_token=...&refresh_token=...
 * 这个函数负责把 token 从 hash 中取出并保存，然后清掉 URL hash。
 */
export function consumeAuthHash(): boolean {
  if (!window.location.hash) return false
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash
  if (!hash.includes('access_token=')) return false

  const params = new URLSearchParams(hash)
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  if (!accessToken || !refreshToken) return false

  saveTokens({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 0,
    token_type: params.get('token_type') || 'Bearer',
  })

  // 额外保存 OIDC access_token 与 issuer，供资源代理及仍需直连的 usage、计价接口使用
  try {
    const oidcAccessToken = params.get('oidc_access_token')
    const oidcRefreshToken = params.get('oidc_refresh_token')
    const oidcIssuer = params.get('oidc_issuer')
    const oidcExpiresInRaw = params.get('oidc_expires_in')
    const oidcExpiresIn = oidcExpiresInRaw ? Number(oidcExpiresInRaw) : undefined
    if (oidcAccessToken) saveOIDCAccessToken(oidcAccessToken, oidcExpiresIn)
    if (oidcRefreshToken) localStorage.setItem(OIDC_REFRESH_TOKEN_KEY, oidcRefreshToken)
    if (oidcIssuer) localStorage.setItem(OIDC_ISSUER_KEY, oidcIssuer)
  } catch {
    /* ignore quota errors */
  }

  // 清掉 hash，避免 token 残留在地址栏
  const cleanUrl = window.location.pathname + window.location.search
  window.history.replaceState(null, '', cleanUrl)
  return true
}
