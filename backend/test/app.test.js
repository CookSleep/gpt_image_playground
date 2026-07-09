import { describe, expect, test } from 'vitest'
import { buildApp } from '../src/app.js'
import { createMemoryStore } from '../src/memoryStore.js'

function getCookie(response) {
  const header = response.headers['set-cookie']
  return Array.isArray(header) ? header[0].split(';')[0] : String(header).split(';')[0]
}

function createHarness(overrides = {}) {
  const store = createMemoryStore()
  const storage = overrides.storage ?? {
    async putObject(key, body, contentType) {
      store.objects.set(key, { body, contentType })
    },
    async getObject(key) {
      return store.objects.get(key) ?? null
    },
  }
  const imageClient = overrides.imageClient ?? {
    async generate() {
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
    sessionSecret: 'test-secret',
    defaultModel: 'gpt-image-2',
    admin: { username: 'admin', password: 'admin-pass' },
    runJobsInline: true,
  })
  return { app, store }
}

async function login(app, username, password) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  })
  return { response, cookie: getCookie(response) }
}

describe('认证与审核', () => {
  test('注册用户默认待审核且额度为 0', async () => {
    const { app } = createHarness()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'zhangsan', password: 'secret123', nickname: '张三' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      user: { username: 'zhangsan', nickname: '张三', role: 'user', status: 'pending', quotaRemaining: 0, quotaUsed: 0 },
    })

    const loginResult = await login(app, 'zhangsan', 'secret123')
    expect(loginResult.response.statusCode).toBe(200)
    expect(loginResult.response.json().user.status).toBe('pending')
  })

  test('禁用用户不可登录', async () => {
    const { app } = createHarness()
    const admin = await login(app, 'admin', 'admin-pass')

    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'lisi', password: 'secret123', nickname: '李四' },
    })
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/users/2/status',
      headers: { cookie: admin.cookie },
      payload: { status: 'disabled' },
    })

    const response = await login(app, 'lisi', 'secret123')
    expect(response.response.statusCode).toBe(403)
    expect(response.response.json().message).toContain('禁用')
  })

  test('登录用户可以修改自己的密码', async () => {
    const { app } = createHarness()
    const admin = await login(app, 'admin', 'admin-pass')

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: admin.cookie },
      payload: { currentPassword: 'admin-pass', newPassword: 'new-admin-pass' },
    })

    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({ ok: true })

    const oldLogin = await login(app, 'admin', 'admin-pass')
    expect(oldLogin.response.statusCode).toBe(401)

    const newLogin = await login(app, 'admin', 'new-admin-pass')
    expect(newLogin.response.statusCode).toBe(200)
  })

  test('旧密码错误时不能修改密码', async () => {
    const { app } = createHarness()
    const admin = await login(app, 'admin', 'admin-pass')

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: admin.cookie },
      payload: { currentPassword: 'wrong-pass', newPassword: 'new-admin-pass' },
    })

    expect(changed.statusCode).toBe(400)
    expect(changed.json().message).toContain('当前密码')

    const oldLogin = await login(app, 'admin', 'admin-pass')
    expect(oldLogin.response.statusCode).toBe(200)
  })
})

describe('管理员额度与生成', () => {
  test('管理员启用用户并分配额度后，生成成功扣 1 次并可代理下载图片', async () => {
    const { app } = createHarness()
    const admin = await login(app, 'admin', 'admin-pass')

    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'user1', password: 'secret123', nickname: '用户一' },
    })
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/users/2/status',
      headers: { cookie: admin.cookie },
      payload: { status: 'active' },
    })
    await app.inject({
      method: 'POST',
      url: '/api/admin/users/2/quota',
      headers: { cookie: admin.cookie },
      payload: { delta: 2, reason: '测试分配' },
    })

    const user = await login(app, 'user1', 'secret123')
    const created = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { cookie: user.cookie },
      payload: {
        prompt: '白色陶瓷杯，极简产品摄影',
        params: { size: '1024x1024', quality: 'high', output_format: 'png', n: 1 },
      },
    })

    expect(created.statusCode).toBe(202)
    expect(created.json()).toMatchObject({ generation: { status: 'done', prompt: '白色陶瓷杯，极简产品摄影' } })

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: user.cookie } })
    expect(me.json().user).toMatchObject({ quotaRemaining: 1, quotaUsed: 1 })

    const list = await app.inject({ method: 'GET', url: '/api/generations', headers: { cookie: user.cookie } })
    const firstImageId = list.json().generations[0].images[0].id
    const image = await app.inject({ method: 'GET', url: `/api/images/${firstImageId}`, headers: { cookie: user.cookie } })
    expect(image.statusCode).toBe(200)
    expect(image.headers['content-type']).toContain('image/png')
    expect(image.body).toBe('generated-image')
  })

  test('上游生成失败不扣额度', async () => {
    const { app } = createHarness({
      imageClient: {
        async generate() {
          throw new Error('upstream failed')
        },
      },
    })
    const admin = await login(app, 'admin', 'admin-pass')

    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'user2', password: 'secret123', nickname: '用户二' } })
    await app.inject({ method: 'PATCH', url: '/api/admin/users/2/status', headers: { cookie: admin.cookie }, payload: { status: 'active' } })
    await app.inject({ method: 'POST', url: '/api/admin/users/2/quota', headers: { cookie: admin.cookie }, payload: { delta: 1, reason: '测试分配' } })

    const user = await login(app, 'user2', 'secret123')
    const created = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { cookie: user.cookie },
      payload: { prompt: '失败测试', params: { size: '1024x1024', quality: 'high', output_format: 'png', n: 1 } },
    })

    expect(created.statusCode).toBe(202)
    expect(created.json().generation.status).toBe('error')
    expect(created.json().generation.error).toContain('upstream failed')

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: user.cookie } })
    expect(me.json().user).toMatchObject({ quotaRemaining: 1, quotaUsed: 0 })
  })
})
