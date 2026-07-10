import { describe, expect, test } from 'vitest'
import { buildApp } from '../src/app.js'
import { createMemoryStore } from '../src/memoryStore.js'

function getCookie(response) {
  const header = response.headers['set-cookie']
  return Array.isArray(header) ? header[0].split(';')[0] : String(header).split(';')[0]
}

function createSub2apiMock(overrides = {}) {
  const keys = overrides.keys ?? [
    {
      id: 101,
      name: 'codex仅生图-gpt-image-2',
      status: 'active',
      key: 'sk-sub2api-hidden',
      quota: 100,
      quota_used: 8,
      group: { id: 7, name: '按次(图片)' },
    },
  ]
  return {
    async login(email, password) {
      if (password === 'bad-pass') {
        const error = new Error('邮箱或密码错误')
        error.statusCode = 401
        throw error
      }
      return {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        user: {
          id: 42,
          email,
          username: 'wxppppppp',
          role: overrides.role ?? 'user',
          status: overrides.userStatus ?? 'active',
        },
      }
    },
    async listKeys() {
      return { items: keys }
    },
    async getKey(_accessToken, id) {
      const found = keys.find((item) => String(item.id) === String(id))
      if (!found) {
        const error = new Error('API Key 不存在')
        error.statusCode = 404
        throw error
      }
      return found
    },
    async refresh() {
      return {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      }
    },
  }
}

function createHarness(overrides = {}) {
  const store = overrides.store ?? createMemoryStore()
  const storage = overrides.storage ?? {
    async putObject(key, body, contentType) {
      store.objects.set(key, { body, contentType })
    },
    async getObject(key) {
      return store.objects.get(key) ?? null
    },
  }
  const imageClient = overrides.imageClient ?? {
    async generate(input) {
      expect(input.apiKey).toBe('sk-sub2api-hidden')
      return {
        images: [{
          bytes: Buffer.from('generated-image'),
          contentType: 'image/png',
          revisedPrompt: 'revised prompt',
        }],
        upstream: { id: 'mock-response' },
      }
    },
  }
  const app = buildApp({
    store,
    storage,
    imageClient,
    sub2apiClient: overrides.sub2apiClient ?? createSub2apiMock(overrides.sub2api ?? {}),
    sessionSecret: 'test-secret',
    defaultModel: 'gpt-image-2',
    runJobsInline: true,
  })
  return { app, store }
}

async function login(app, email = 'user@example.com', password = 'secret123') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  })
  return { response, cookie: getCookie(response) }
}

describe('sub2api 账号登录', () => {
  test('登录后创建本地会话，但响应不暴露 sub2api token', async () => {
    const { app } = createHarness()

    const { response } = await login(app, 'wxpppp.wzx@gmail.com')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      user: {
        email: 'wxpppp.wzx@gmail.com',
        nickname: 'wxppppppp',
        role: 'user',
        status: 'active',
      },
    })
    expect(JSON.stringify(response.json())).not.toContain('access-token')
    expect(JSON.stringify(response.json())).not.toContain('refresh-token')
  })

  test('登录失败时返回 sub2api 错误', async () => {
    const { app } = createHarness()

    const { response } = await login(app, 'wxpppp.wzx@gmail.com', 'bad-pass')

    expect(response.statusCode).toBe(401)
    expect(response.json().message).toContain('邮箱或密码错误')
  })

  test('退出后当前会话不可继续访问', async () => {
    const { app } = createHarness()
    const { cookie } = await login(app)

    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })

    expect(logout.statusCode).toBe(200)
    expect(me.statusCode).toBe(401)
  })
})

describe('sub2api API Key 与生成', () => {
  test('API Key 列表会脱敏，不把真实 key 给前端', async () => {
    const { app } = createHarness()
    const { cookie } = await login(app)

    const response = await app.inject({ method: 'GET', url: '/api/sub2api/keys', headers: { cookie } })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      keys: [{ id: '101', name: 'codex仅生图-gpt-image-2', groupName: '按次(图片)' }],
    })
    expect(JSON.stringify(response.json())).not.toContain('sk-sub2api-hidden')
  })

  test('sub2api access token 过期时会用 refresh token 自动续期', async () => {
    const calls = []
    const { app } = createHarness({
      sub2apiClient: {
        async login(email) {
          return {
            access_token: 'expired-token',
            refresh_token: 'refresh-token',
            expires_in: -10,
            user: { id: 42, email, username: 'wxppppppp', role: 'user', status: 'active' },
          }
        },
        async refresh(refreshToken) {
          expect(refreshToken).toBe('refresh-token')
          return { access_token: 'fresh-token', refresh_token: 'fresh-refresh-token', expires_in: 3600 }
        },
        async listKeys(accessToken) {
          calls.push(accessToken)
          return {
            items: [{
              id: 101,
              name: 'codex仅生图-gpt-image-2',
              status: 'active',
              key: 'sk-sub2api-hidden',
            }],
          }
        },
        async getKey() {
          throw new Error('not needed')
        },
      },
    })
    const { cookie } = await login(app)

    const response = await app.inject({ method: 'GET', url: '/api/sub2api/keys', headers: { cookie } })

    expect(response.statusCode).toBe(200)
    expect(calls).toEqual(['fresh-token'])
  })

  test('创建生成任务必须选择 sub2api API Key', async () => {
    const { app } = createHarness()
    const { cookie } = await login(app)

    const created = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { cookie },
      payload: {
        prompt: '浅蓝背景上的极简产品图',
        params: { size: '1024x1024', quality: 'high', output_format: 'png', n: 1 },
      },
    })

    expect(created.statusCode).toBe(400)
    expect(created.json().message).toContain('请选择 sub2api API Key')
  })

  test('生成成功时后端使用所选 sub2api key 明文，前端只看到 key 名称和历史图片', async () => {
    const { app } = createHarness()
    const { cookie } = await login(app)

    const created = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { cookie },
      payload: {
        apiKeyId: '101',
        prompt: '白色陶瓷杯，极简产品摄影',
        params: { size: '1024x1024', quality: 'high', output_format: 'png', n: 1 },
      },
    })

    expect(created.statusCode).toBe(202)
    expect(created.json()).toMatchObject({
      generation: {
        status: 'done',
        apiKeyId: '101',
        apiKeyName: 'codex仅生图-gpt-image-2',
        prompt: '白色陶瓷杯，极简产品摄影',
      },
    })
    expect(JSON.stringify(created.json())).not.toContain('sk-sub2api-hidden')

    const list = await app.inject({ method: 'GET', url: '/api/generations', headers: { cookie } })
    const firstImageId = list.json().generations[0].images[0].id
    const image = await app.inject({ method: 'GET', url: `/api/images/${firstImageId}`, headers: { cookie } })
    expect(image.statusCode).toBe(200)
    expect(image.headers['content-type']).toContain('image/png')
    expect(image.body).toBe('generated-image')
  })

  test('上游失败只记录失败任务，不产生图片', async () => {
    const { app } = createHarness({
      imageClient: {
        async generate(input) {
          expect(input.apiKey).toBe('sk-sub2api-hidden')
          throw new Error('upstream failed')
        },
      },
    })
    const { cookie } = await login(app)

    const created = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { cookie },
      payload: {
        apiKeyId: '101',
        prompt: '失败测试',
        params: { size: '1024x1024', quality: 'high', output_format: 'png', n: 1 },
      },
    })

    expect(created.statusCode).toBe(202)
    expect(created.json().generation.status).toBe('error')
    expect(created.json().generation.error).toContain('upstream failed')
    expect(created.json().generation.images).toHaveLength(0)
  })

  test('服务启动时会把遗留生成中任务标记为失败', async () => {
    const store = createMemoryStore()
    const user = await store.upsertExternalUser({ id: 42, email: 'user@example.com', username: 'user', status: 'active' })
    await store.createGeneration({
      userId: user.id,
      apiKeyId: '101',
      apiKeyName: 'codex仅生图-gpt-image-2',
      prompt: '部署前还在生成的任务',
      params: { size: '1024x1024', quality: 'high', output_format: 'png', n: 1 },
      model: 'gpt-image-2',
    })
    const { app } = createHarness({ store })
    const { cookie } = await login(app)

    const list = await app.inject({ method: 'GET', url: '/api/generations', headers: { cookie } })

    expect(list.json().generations[0]).toMatchObject({
      status: 'error',
      error: '服务重启，生成任务已中断，请重新生成',
    })
  })
})
