import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACCESS_TOKEN_KEY,
  OIDC_ACCESS_TOKEN_KEY,
  authFetch,
  fetchUser,
  getAuthBaseUrl,
  isAuthEnabled,
  syncOIDCUserProfile,
} from './api'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('isAuthEnabled / getAuthBaseUrl 三态', () => {
  it('未配置（undefined）时默认同源启用', () => {
    vi.stubGlobal('window', { __APP_CONFIG__: {} })
    vi.stubEnv('VITE_AUTH_BACKEND_URL', undefined)
    expect(isAuthEnabled()).toBe(true)
    expect(getAuthBaseUrl()).toBe('')
  })

  it('disabled 时禁用认证', () => {
    vi.stubGlobal('window', { __APP_CONFIG__: { AUTH_BACKEND_URL: 'disabled' } })
    expect(isAuthEnabled()).toBe(false)
    expect(getAuthBaseUrl()).toBe('')
  })

  it('空串时同源启用（enabled，基址为空）', () => {
    vi.stubGlobal('window', { __APP_CONFIG__: { AUTH_BACKEND_URL: '' } })
    expect(isAuthEnabled()).toBe(true)
    expect(getAuthBaseUrl()).toBe('')
  })

  it('URL 时启用并去掉尾部斜杠', () => {
    vi.stubGlobal('window', { __APP_CONFIG__: { AUTH_BACKEND_URL: 'https://api.example.com/' } })
    expect(isAuthEnabled()).toBe(true)
    expect(getAuthBaseUrl()).toBe('https://api.example.com')
  })
})

describe('fetchUser', () => {
  it('复用同 token 的并发 /auth/user 请求', async () => {
    const storage = new Map<string, string>([[ACCESS_TOKEN_KEY, 'token-a']])
    vi.stubGlobal('window', { __APP_CONFIG__: { AUTH_BACKEND_URL: '' } })
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'user-a', oidc_provider: 'oidc' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const [first, second] = await Promise.all([fetchUser(), fetchUser()])

    expect(first?.id).toBe('user-a')
    expect(second?.id).toBe('user-a')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/auth\/user\?_\=\d+$/), expect.objectContaining({
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    }))
  })
})

describe('authFetch', () => {
  it('lets the browser set multipart boundaries for FormData', async () => {
    vi.stubGlobal('window', { __APP_CONFIG__: { AUTH_BACKEND_URL: '' } })
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'token-a') })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const body = new FormData()
    body.set('title', '本地数据')

    await authFetch('/api/v1/projects', { method: 'POST', body })

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer token-a')
    expect(headers.has('Content-Type')).toBe(false)
  })
})

describe('syncOIDCUserProfile', () => {
  it('使用现有 OIDC access token 读取 UserInfo，不调用 refresh', async () => {
    vi.stubGlobal('window', { __APP_CONFIG__: { AUTH_BACKEND_URL: '' } })
    const storage = new Map<string, string>([
      [ACCESS_TOKEN_KEY, 'app-token'],
      [OIDC_ACCESS_TOKEN_KEY, 'oidc-token'],
    ])
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'user-a',
      oidc_provider: 'oidc',
      account_id: 'acct-a',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const profile = await syncOIDCUserProfile()

    expect(profile?.account_id).toBe('acct-a')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/auth/oidc/sync', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ access_token: 'oidc-token' }),
    }))
  })
})
