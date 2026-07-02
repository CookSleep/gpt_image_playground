import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAuthBaseUrl, isAuthEnabled } from './api'

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
