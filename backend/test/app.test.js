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
    {
      id: 202,
      name: '提示词优化-gpt-5.5',
      status: 'active',
      key: 'sk-sub2api-text-hidden',
      quota: 100,
      quota_used: 3,
      group: { id: 8, name: '文本模型' },
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
    async deleteObject(key) {
      store.objects.delete(key)
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
  const textClient = overrides.textClient ?? {
    async optimize(input) {
      expect(input.apiKey).toBe('sk-sub2api-text-hidden')
      expect(input.model).toBe('gpt-5.5')
      return `优化：${input.prompt}`
    },
  }
  const app = buildApp({
    store,
    storage,
    imageClient,
    textClient,
    sub2apiClient: overrides.sub2apiClient ?? createSub2apiMock(overrides.sub2api ?? {}),
    sessionSecret: 'test-secret',
    defaultModel: 'gpt-image-2',
    defaultTextModel: 'gpt-5.5',
    runJobsInline: true,
  })
  return { app, store, storage }
}

async function login(app, email = 'user@example.com', password = 'secret123') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  })
  return { response, cookie: getCookie(response) }
}

async function saveSettings(app, cookie, settings = { imageApiKeyId: '101', promptApiKeyId: '202' }) {
  return app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: settings })
}

async function generateImage(app, cookie, input = {}) {
  await saveSettings(app, cookie)
  return app.inject({
    method: 'POST',
    url: '/api/generations',
    headers: { cookie },
    payload: {
      prompt: input.prompt ?? '白色陶瓷杯，极简产品摄影',
      params: input.params ?? { size: '1024x1024', quality: 'high', output_format: 'png', n: 1 },
    },
  })
}

function referenceImageDataUrl(byteLength) {
  return `data:image/png;base64,${Buffer.alloc(byteLength, 1).toString('base64')}`
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
    expect(response.json().keys).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '101', name: 'codex仅生图-gpt-image-2', groupName: '按次(图片)' }),
      expect.objectContaining({ id: '202', name: '提示词优化-gpt-5.5', groupName: '文本模型' }),
    ]))
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

  test('读取和保存双 Key 设置时不暴露 API Key 明文', async () => {
    const { app } = createHarness()
    const { cookie } = await login(app)

    const initial = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })
    const saved = await saveSettings(app, cookie)
    const current = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })

    expect(initial.statusCode).toBe(200)
    expect(initial.json().settings).toEqual({ imageApiKeyId: null, promptApiKeyId: null })
    expect(saved.statusCode).toBe(200)
    expect(current.json().settings).toEqual({ imageApiKeyId: '101', promptApiKeyId: '202' })
    expect(JSON.stringify(current.json())).not.toContain('sk-sub2api')
  })

  test('保存设置要求两个 Key 都属于当前账号且为 active', async () => {
    const { app } = createHarness()
    const { cookie } = await login(app)

    const incomplete = await saveSettings(app, cookie, { imageApiKeyId: '101', promptApiKeyId: '' })
    const missing = await saveSettings(app, cookie, { imageApiKeyId: '101', promptApiKeyId: '999' })

    expect(incomplete.statusCode).toBe(400)
    expect(incomplete.json().message).toContain('两个 API Key')
    expect(missing.statusCode).toBe(400)
    expect(missing.json().message).toContain('不存在')
  })

  test('创建生成任务前必须在设置中心保存两个 API Key', async () => {
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

    expect(created.statusCode).toBe(409)
    expect(created.json().message).toContain('设置中心')
  })

  test('生成成功时后端使用设置中的图片 Key，忽略客户端传入 Key', async () => {
    const { app } = createHarness()
    const { cookie } = await login(app)
    expect((await saveSettings(app, cookie)).statusCode).toBe(200)

    const created = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { cookie },
      payload: {
        apiKeyId: '202',
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

  test('参考图最多接受 16 张且允许单张恰好 4 MiB', async () => {
    let receivedInputImages = []
    const { app } = createHarness({
      imageClient: {
        async generate(input) {
          receivedInputImages = input.inputImages
          return {
            images: [{ bytes: Buffer.from('generated-image'), contentType: 'image/png' }],
            upstream: { id: 'mock-response' },
          }
        },
      },
    })
    const { cookie } = await login(app)
    await saveSettings(app, cookie)
    const inputImages = [referenceImageDataUrl(4 * 1024 * 1024), ...Array.from({ length: 15 }, () => referenceImageDataUrl(1))]

    const response = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { cookie },
      payload: { prompt: '多参考图测试', inputImages },
    })

    expect(response.statusCode).toBe(202)
    expect(receivedInputImages).toHaveLength(16)
  })

  test('超过 16 张参考图时拒绝请求且不创建任务', async () => {
    let generationCalls = 0
    const { app } = createHarness({
      imageClient: { async generate() { generationCalls += 1; throw new Error('不应调用上游') } },
    })
    const { cookie } = await login(app)
    await saveSettings(app, cookie)

    const response = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { cookie },
      payload: { prompt: '数量超限', inputImages: Array.from({ length: 17 }, () => referenceImageDataUrl(1)) },
    })
    const list = await app.inject({ method: 'GET', url: '/api/generations', headers: { cookie } })

    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('最多 16 张')
    expect(generationCalls).toBe(0)
    expect(list.json().generations).toHaveLength(0)
  })

  test('拒绝超过 4 MiB 或格式非法的参考图', async () => {
    const { app } = createHarness()
    const { cookie } = await login(app)
    await saveSettings(app, cookie)

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { cookie },
      payload: { prompt: '大小超限', inputImages: [referenceImageDataUrl(4 * 1024 * 1024 + 1)] },
    })
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { cookie },
      payload: { prompt: '格式非法', inputImages: ['not-a-data-url'] },
    })

    expect(oversized.statusCode).toBe(400)
    expect(oversized.json().message).toContain('单张不能超过 4MB')
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().message).toContain('格式不合法')
  })

  test('提示词优化使用设置中的独立 Key 和 gpt-5.5', async () => {
    const { app } = createHarness()
    const { cookie } = await login(app)
    await saveSettings(app, cookie)

    const response = await app.inject({
      method: 'POST',
      url: '/api/prompts/optimize',
      headers: { cookie },
      payload: { prompt: '未来城市' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ optimizedPrompt: '优化：未来城市' })
    expect(JSON.stringify(response.json())).not.toContain('sk-sub2api')
  })

  test('提示词优化拒绝空提示词和未配置账号', async () => {
    const { app } = createHarness()
    const { cookie } = await login(app)

    const empty = await app.inject({ method: 'POST', url: '/api/prompts/optimize', headers: { cookie }, payload: { prompt: ' ' } })
    const missing = await app.inject({ method: 'POST', url: '/api/prompts/optimize', headers: { cookie }, payload: { prompt: '测试' } })

    expect(empty.statusCode).toBe(400)
    expect(missing.statusCode).toBe(409)
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
    expect((await saveSettings(app, cookie)).statusCode).toBe(200)

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

describe('图片资产、文件夹与删除', () => {
  test('创建文件夹后可重命名图片、移动、搜索并移回未分类', async () => {
    const { app } = createHarness()
    const { cookie } = await login(app)
    const generated = await generateImage(app, cookie, { prompt: '雨夜未来城市' })
    const imageId = generated.json().generation.images[0].id

    const createdFolder = await app.inject({ method: 'POST', url: '/api/folders', headers: { cookie }, payload: { name: '项目灵感' } })
    const folderId = createdFolder.json().folder.id
    const renamedImage = await app.inject({ method: 'PATCH', url: `/api/images/${imageId}`, headers: { cookie }, payload: { name: '霓虹雨城' } })
    const moved = await app.inject({ method: 'POST', url: '/api/images/move', headers: { cookie }, payload: { imageIds: [imageId], folderId } })
    const byName = await app.inject({ method: 'GET', url: `/api/assets?q=${encodeURIComponent('霓虹')}&folderId=${folderId}`, headers: { cookie } })
    const byPrompt = await app.inject({ method: 'GET', url: `/api/assets?q=${encodeURIComponent('未来城市')}`, headers: { cookie } })
    const byFolderName = await app.inject({ method: 'GET', url: `/api/assets?q=${encodeURIComponent('项目灵感')}`, headers: { cookie } })
    const renamedFolder = await app.inject({ method: 'PATCH', url: `/api/folders/${folderId}`, headers: { cookie }, payload: { name: '成片精选' } })
    const deletedFolder = await app.inject({ method: 'DELETE', url: `/api/folders/${folderId}?deleteImages=false`, headers: { cookie } })
    const uncategorized = await app.inject({ method: 'GET', url: '/api/assets?folderId=uncategorized', headers: { cookie } })

    expect(createdFolder.statusCode).toBe(201)
    expect(renamedImage.json().image.name).toBe('霓虹雨城')
    expect(moved.json().images).toHaveLength(1)
    expect(byName.json().assets).toHaveLength(1)
    expect(byPrompt.json().assets).toHaveLength(1)
    expect(byFolderName.json().assets).toHaveLength(0)
    expect(renamedFolder.json().folder.name).toBe('成片精选')
    expect(deletedFolder.statusCode).toBe(200)
    expect(uncategorized.json().assets).toContainEqual(expect.objectContaining({ id: imageId, folderId: null }))
  })

  test('删除单张图片会同步删除对象但保留任务', async () => {
    const { app, store } = createHarness()
    const { cookie } = await login(app)
    const generated = await generateImage(app, cookie)
    const generationId = generated.json().generation.id
    const imageId = generated.json().generation.images[0].id
    const image = await store.getImage(imageId)

    const deleted = await app.inject({ method: 'DELETE', url: `/api/images/${imageId}`, headers: { cookie } })
    const task = await app.inject({ method: 'GET', url: `/api/generations/${generationId}`, headers: { cookie } })

    expect(deleted.statusCode).toBe(200)
    expect(store.objects.has(image.objectKey)).toBe(false)
    expect(task.statusCode).toBe(200)
    expect(task.json().generation.images).toHaveLength(0)
  })

  test('删除任务会清理全部对象，生成中的任务不可删除', async () => {
    const store = createMemoryStore()
    const { app } = createHarness({
      store,
      imageClient: {
        async generate() {
          return {
            images: [0, 1].map((index) => ({ bytes: Buffer.from(`image-${index}`), contentType: 'image/png' })),
            upstream: null,
          }
        },
      },
    })
    const { cookie } = await login(app)
    const generated = await generateImage(app, cookie, { params: { size: '1024x1024', quality: 'high', output_format: 'png', n: 2 } })
    const generationId = generated.json().generation.id
    const objectKeys = await Promise.all(generated.json().generation.images.map(async (image) => (await store.getImage(image.id)).objectKey))

    const deleted = await app.inject({ method: 'DELETE', url: `/api/generations/${generationId}`, headers: { cookie } })
    const user = await store.upsertExternalUser({ id: 42, email: 'user@example.com', username: 'user', status: 'active' })
    const running = await store.createGeneration({ userId: user.id, prompt: '仍在生成', params: {}, model: 'gpt-image-2' })
    const refused = await app.inject({ method: 'DELETE', url: `/api/generations/${running.id}`, headers: { cookie } })

    expect(deleted.statusCode).toBe(200)
    expect(objectKeys.every((key) => !store.objects.has(key))).toBe(true)
    expect(refused.statusCode).toBe(409)
  })

  test('对象删除失败时保留图片数据库记录', async () => {
    const store = createMemoryStore()
    const { app } = createHarness({
      store,
      storage: {
        async putObject(key, body, contentType) { store.objects.set(key, { body, contentType }) },
        async getObject(key) { return store.objects.get(key) ?? null },
        async deleteObject() { throw new Error('S3 unavailable') },
      },
    })
    const { cookie } = await login(app)
    const generated = await generateImage(app, cookie)
    const imageId = generated.json().generation.images[0].id

    const deleted = await app.inject({ method: 'DELETE', url: `/api/images/${imageId}`, headers: { cookie } })

    expect(deleted.statusCode).toBe(502)
    expect(await store.getImage(imageId)).not.toBeNull()
  })
})
