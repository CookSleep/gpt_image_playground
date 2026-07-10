function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function readJson(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

function unwrapSub2api(payload) {
  if (payload && typeof payload === 'object' && 'code' in payload) {
    if (payload.code === 0) return payload.data
    const error = new Error(payload.message || 'sub2api 请求失败')
    error.code = payload.code
    throw error
  }
  return payload
}

function normalizeError(err, fallback) {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

export function createSub2apiClient(config) {
  const timeoutMs = Number(config.timeoutMs || 30000)

  async function request(path, init = {}) {
    const controller = new AbortController()
    const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      const response = await fetch(joinUrl(config.baseUrl, path), {
        ...init,
        signal: controller.signal,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      })
      const payload = await readJson(response)
      if (!response.ok) {
        const message = payload.message || payload.error?.message || `sub2api HTTP ${response.status}`
        const error = new Error(message)
        error.statusCode = response.status
        throw error
      }
      return unwrapSub2api(payload)
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error(`sub2api 请求超时：${Math.round(timeoutMs / 1000)} 秒`)
      throw err
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  function authHeaders(accessToken) {
    return { Authorization: `Bearer ${accessToken}` }
  }

  return {
    async login(email, password) {
      try {
        const data = await request('/api/v1/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        })
        if (data?.requires_2fa) {
          const error = new Error('该 sub2api 账号启用了 2FA，当前图片站暂不支持 2FA 登录')
          error.statusCode = 400
          throw error
        }
        if (!data?.access_token || !data?.user) throw new Error('sub2api 登录响应缺少 access_token 或 user')
        return data
      } catch (err) {
        const error = new Error(normalizeError(err, 'sub2api 登录失败'))
        error.statusCode = err.statusCode || 401
        throw error
      }
    },

    async refresh(refreshToken) {
      try {
        const data = await request('/api/v1/auth/refresh', {
          method: 'POST',
          body: JSON.stringify({ refresh_token: refreshToken }),
        })
        if (!data?.access_token) throw new Error('sub2api 刷新响应缺少 access_token')
        return data
      } catch (err) {
        const error = new Error(normalizeError(err, 'sub2api 登录已过期，请重新登录'))
        error.statusCode = err.statusCode || 401
        throw error
      }
    },

    async me(accessToken) {
      return request('/api/v1/auth/me', { headers: authHeaders(accessToken) })
    },

    async listKeys(accessToken, params = {}) {
      const query = new URLSearchParams({
        page: String(params.page || 1),
        page_size: String(params.pageSize || 100),
        sort_by: 'created_at',
        sort_order: 'desc',
      })
      if (params.status) query.set('status', params.status)
      return request(`/api/v1/keys?${query.toString()}`, { headers: authHeaders(accessToken) })
    },

    async getKey(accessToken, id) {
      return request(`/api/v1/keys/${encodeURIComponent(id)}`, { headers: authHeaders(accessToken) })
    },
  }
}
