import crypto from 'node:crypto'
import Fastify from 'fastify'
import { validateReferenceImages } from './referenceImages.js'

const COOKIE_NAME = 'sid'
const SESSION_DAYS = 14

function hashToken(token, secret) {
  return crypto.createHash('sha256').update(`${token}:${secret}`).digest('hex')
}

function parseCookies(header) {
  if (!header) return {}
  return Object.fromEntries(String(header).split(';').map((part) => {
    const idx = part.indexOf('=')
    if (idx < 0) return [part.trim(), '']
    return [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())]
  }))
}

function createToken() {
  return crypto.randomBytes(32).toString('base64url')
}

function createExpiresAt() {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

function sendError(reply, statusCode, message) {
  return reply.code(statusCode).send({ message })
}

function normalizeParams(params = {}) {
  return {
    size: typeof params.size === 'string' ? params.size : '1024x1024',
    quality: ['auto', 'low', 'medium', 'high'].includes(params.quality) ? params.quality : 'auto',
    output_format: ['png', 'jpeg', 'webp'].includes(params.output_format) ? params.output_format : 'png',
    n: Number.isInteger(params.n) && params.n > 0 ? Math.min(params.n, 4) : 1,
  }
}

function publicGeneration(generation) {
  return {
    id: generation.id,
    apiKeyId: generation.apiKeyId ?? null,
    apiKeyName: generation.apiKeyName ?? null,
    prompt: generation.prompt,
    params: generation.params,
    status: generation.status,
    model: generation.model,
    error: generation.error,
    elapsedMs: generation.elapsedMs,
    images: generation.images ?? [],
    createdAt: generation.createdAt,
    finishedAt: generation.finishedAt,
  }
}

function publicUser(user) {
  if (!user) return null
  return {
    id: user.id,
    email: user.email ?? user.username,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

function publicApiKey(key) {
  return {
    id: String(key.id),
    name: key.name,
    status: key.status,
    groupId: key.group_id == null ? null : String(key.group_id),
    groupName: key.group?.name ?? null,
    quota: key.quota ?? 0,
    quotaUsed: key.quota_used ?? 0,
    expiresAt: key.expires_at ?? null,
    lastUsedAt: key.last_used_at ?? null,
  }
}

function publicAsset(image) {
  return {
    id: image.id,
    generationId: image.generationId,
    name: image.name,
    folderId: image.folderId ?? null,
    contentType: image.contentType,
    revisedPrompt: image.revisedPrompt ?? null,
    prompt: image.prompt ?? '',
    createdAt: image.createdAt,
  }
}

function cleanName(value, label) {
  const name = String(value ?? '').trim()
  if (!name) throw new Error(`${label}不能为空`)
  if (name.length > 80) throw new Error(`${label}不能超过 80 个字符`)
  return name
}

export function buildApp(options) {
  const app = Fastify({ logger: false, bodyLimit: 92 * 1024 * 1024 })
  const ready = (async () => {
    await options.store.failInterruptedRunningGenerations?.('服务重启，生成任务已中断，请重新生成')
  })()

  async function getCurrentUser(request) {
    await ready
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME]
    if (!token) return null
    const sessionTokenHash = hashToken(token, options.sessionSecret)
    const user = await options.store.getSessionUser(sessionTokenHash)
    return user ? { ...user, sessionTokenHash } : null
  }

  async function requireUser(request, reply) {
    const user = await getCurrentUser(request)
    if (!user) {
      sendError(reply, 401, '请先登录')
      return null
    }
    return user
  }

  async function ensureSub2apiAccess(user) {
    if (!user.sub2apiAccessToken) {
      const error = new Error('sub2api 登录已过期，请重新登录')
      error.statusCode = 401
      throw error
    }
    const expiresAt = Date.parse(user.sub2apiTokenExpiresAt || '')
    if (!Number.isFinite(expiresAt) || expiresAt - Date.now() > 120 * 1000) return user
    if (!user.sub2apiRefreshToken) {
      const error = new Error('sub2api 登录已过期，请重新登录')
      error.statusCode = 401
      throw error
    }
    const refreshed = await options.sub2apiClient.refresh(user.sub2apiRefreshToken)
    const tokenExpiresAt = refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : null
    await options.store.updateSessionTokens?.(user.sessionTokenHash, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      tokenExpiresAt,
    })
    return {
      ...user,
      sub2apiAccessToken: refreshed.access_token,
      sub2apiRefreshToken: refreshed.refresh_token ?? user.sub2apiRefreshToken,
      sub2apiTokenExpiresAt: tokenExpiresAt,
    }
  }

  async function processGeneration(generation, payload) {
    const startedAt = Date.now()
    try {
      const selectedKey = await options.sub2apiClient.getKey(generation.sub2apiAccessToken, generation.apiKeyId)
      if (!selectedKey?.key) throw new Error('选择的 sub2api API Key 不存在或不可用')
      const result = await options.imageClient.generate({
        prompt: generation.prompt,
        params: generation.params,
        inputImages: payload.inputImages ?? [],
        model: options.defaultModel,
        apiKey: selectedKey.key,
      })
      const outputImages = []
      for (let idx = 0; idx < result.images.length; idx += 1) {
        const image = result.images[idx]
        const ext = image.contentType === 'image/jpeg' ? 'jpg' : image.contentType === 'image/webp' ? 'webp' : 'png'
        const objectKey = `generations/${generation.id}/${idx}.${ext}`
        await options.storage.putObject(objectKey, image.bytes, image.contentType)
        outputImages.push({ objectKey, contentType: image.contentType, revisedPrompt: image.revisedPrompt })
      }
      return options.store.finishGenerationSuccess(generation.id, outputImages, result.upstream, Date.now() - startedAt)
    } catch (err) {
      return options.store.finishGenerationError(generation.id, err instanceof Error ? err.message : String(err))
    }
  }

  async function deleteStoredImages(images) {
    for (const image of images) await options.storage.deleteObject(image.objectKey)
  }

  app.get('/api/health', async () => ({ ok: true }))

  app.post('/api/auth/login', async (request, reply) => {
    await ready
    const body = request.body ?? {}
    const email = String(body.email ?? body.username ?? '').trim()
    const password = String(body.password ?? '')
    if (!email || !password) return sendError(reply, 400, '请输入 sub2api 邮箱和密码')
    try {
      const auth = await options.sub2apiClient.login(email, password)
      const user = await options.store.upsertExternalUser(auth.user)
      const token = createToken()
      await options.store.createSession(user.id, hashToken(token, options.sessionSecret), createExpiresAt(), {
        accessToken: auth.access_token,
        refreshToken: auth.refresh_token,
        tokenExpiresAt: auth.expires_in ? new Date(Date.now() + auth.expires_in * 1000).toISOString() : null,
      })
      reply.header('set-cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`)
      return { user: publicUser(user) }
    } catch (err) {
      return sendError(reply, err.statusCode ?? 401, err.message || 'sub2api 登录失败')
    }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME]
    if (token) await options.store.deleteSession(hashToken(token, options.sessionSecret))
    reply.header('set-cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`)
    return { ok: true }
  })

  app.get('/api/me', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    try {
      const authedUser = await ensureSub2apiAccess(user)
      return { user: publicUser(authedUser) }
    } catch (err) {
      return sendError(reply, err.statusCode ?? 401, err.message || 'sub2api 登录已过期，请重新登录')
    }
  })

  app.get('/api/sub2api/keys', async (request, reply) => {
    let user = await requireUser(request, reply)
    if (!user) return
    try {
      user = await ensureSub2apiAccess(user)
      const data = await options.sub2apiClient.listKeys(user.sub2apiAccessToken, { status: 'active' })
      const items = Array.isArray(data?.items) ? data.items : []
      return { keys: items.map(publicApiKey) }
    } catch (err) {
      return sendError(reply, err.statusCode ?? 502, err.message || '读取 sub2api API Key 失败')
    }
  })

  app.get('/api/settings', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    return { settings: await options.store.getSettings(user.id) }
  })

  app.put('/api/settings', async (request, reply) => {
    let user = await requireUser(request, reply)
    if (!user) return
    const imageApiKeyId = String(request.body?.imageApiKeyId ?? '').trim()
    const promptApiKeyId = String(request.body?.promptApiKeyId ?? '').trim()
    if (!imageApiKeyId || !promptApiKeyId) return sendError(reply, 400, '请选择图片生成和提示词优化两个 API Key')
    try {
      user = await ensureSub2apiAccess(user)
      const [imageKey, promptKey] = await Promise.all([
        options.sub2apiClient.getKey(user.sub2apiAccessToken, imageApiKeyId),
        options.sub2apiClient.getKey(user.sub2apiAccessToken, promptApiKeyId),
      ])
      if (!imageKey?.key || imageKey.status !== 'active') return sendError(reply, 400, '图片生成 API Key 不存在或不可用')
      if (!promptKey?.key || promptKey.status !== 'active') return sendError(reply, 400, '提示词优化 API Key 不存在或不可用')
      const settings = await options.store.saveSettings(user.id, { imageApiKeyId, promptApiKeyId })
      return { settings }
    } catch (err) {
      return sendError(reply, err.statusCode === 401 ? 401 : 400, err.message || '保存 API Key 设置失败')
    }
  })

  app.post('/api/prompts/optimize', async (request, reply) => {
    let user = await requireUser(request, reply)
    if (!user) return
    const prompt = String(request.body?.prompt ?? '').trim()
    if (!prompt) return sendError(reply, 400, '请输入需要优化的提示词')
    const settings = await options.store.getSettings(user.id)
    if (!settings.imageApiKeyId || !settings.promptApiKeyId) return sendError(reply, 409, '请先在设置中心配置图片生成和提示词优化 API Key')
    try {
      user = await ensureSub2apiAccess(user)
      const selectedKey = await options.sub2apiClient.getKey(user.sub2apiAccessToken, settings.promptApiKeyId)
      if (!selectedKey?.key || selectedKey.status !== 'active') return sendError(reply, 400, '提示词优化 API Key 不可用，请更新设置')
      const optimizedPrompt = await options.textClient.optimize({
        prompt,
        apiKey: selectedKey.key,
        model: options.defaultTextModel,
      })
      return { optimizedPrompt }
    } catch (err) {
      return sendError(reply, err.statusCode === 401 ? 401 : 502, err.message || '提示词优化失败')
    }
  })

  app.post('/api/generations', async (request, reply) => {
    let user = await requireUser(request, reply)
    if (!user) return
    if (user.status !== 'active') return sendError(reply, 403, 'sub2api 账号不可用')

    const prompt = String(request.body?.prompt ?? '').trim()
    if (!prompt) return sendError(reply, 400, '请输入提示词')
    try {
      validateReferenceImages(request.body?.inputImages)
    } catch (err) {
      return sendError(reply, 400, err.message || '参考图不合法')
    }
    const params = normalizeParams(request.body?.params)
    const settings = await options.store.getSettings(user.id)
    if (!settings.imageApiKeyId || !settings.promptApiKeyId) return sendError(reply, 409, '请先在设置中心配置图片生成和提示词优化 API Key')
    const apiKeyId = settings.imageApiKeyId
    let apiKeyName = ''
    try {
      user = await ensureSub2apiAccess(user)
      const [selectedKey, promptKey] = await Promise.all([
        options.sub2apiClient.getKey(user.sub2apiAccessToken, apiKeyId),
        options.sub2apiClient.getKey(user.sub2apiAccessToken, settings.promptApiKeyId),
      ])
      if (!selectedKey?.key || selectedKey.status !== 'active') return sendError(reply, 400, '选择的 sub2api API Key 不可用')
      if (!promptKey?.key || promptKey.status !== 'active') return sendError(reply, 400, '提示词优化 API Key 不可用，请更新设置')
      apiKeyName = selectedKey.name || `API Key ${apiKeyId}`
    } catch (err) {
      return sendError(reply, err.statusCode ?? 400, err.message || '选择的 sub2api API Key 不可用')
    }
    const generation = await options.store.createGeneration({
      userId: user.id,
      apiKeyId,
      apiKeyName,
      prompt,
      params,
      model: options.defaultModel,
    })
    generation.sub2apiAccessToken = user.sub2apiAccessToken

    if (options.runJobsInline) {
      const done = await processGeneration(generation, request.body ?? {})
      return reply.code(202).send({ generation: publicGeneration(done) })
    }

    void processGeneration(generation, request.body ?? {})
    return reply.code(202).send({ generation: publicGeneration({ ...generation, images: [] }) })
  })

  app.get('/api/generations', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const generations = await options.store.listGenerations(user.id)
    return { generations: generations.map(publicGeneration) }
  })

  app.get('/api/generations/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const generation = await options.store.getGeneration(request.params.id, user.id)
    if (!generation) return sendError(reply, 404, '任务不存在')
    return { generation: publicGeneration(generation) }
  })

  app.get('/api/generations/:id/events', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const generation = await options.store.getGeneration(request.params.id, user.id)
    if (!generation) return sendError(reply, 404, '任务不存在')
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    reply.raw.write(`data: ${JSON.stringify({ generation: publicGeneration(generation) })}\n\n`)
    reply.raw.end()
  })

  app.get('/api/folders', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    return { folders: await options.store.listFolders(user.id) }
  })

  app.post('/api/folders', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    try {
      const name = cleanName(request.body?.name, '文件夹名称')
      const folders = await options.store.listFolders(user.id)
      if (folders.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) return sendError(reply, 409, '已存在同名文件夹')
      const folder = await options.store.createFolder(user.id, name)
      return reply.code(201).send({ folder })
    } catch (err) {
      return sendError(reply, err.code === '23505' ? 409 : 400, err.code === '23505' ? '已存在同名文件夹' : err.message)
    }
  })

  app.patch('/api/folders/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    try {
      const name = cleanName(request.body?.name, '文件夹名称')
      const folder = await options.store.getFolder(request.params.id, user.id)
      if (!folder) return sendError(reply, 404, '文件夹不存在')
      const folders = await options.store.listFolders(user.id)
      if (folders.some((item) => item.id !== folder.id && item.name.toLowerCase() === name.toLowerCase())) return sendError(reply, 409, '已存在同名文件夹')
      return { folder: await options.store.updateFolder(folder.id, user.id, name) }
    } catch (err) {
      return sendError(reply, err.code === '23505' ? 409 : 400, err.code === '23505' ? '已存在同名文件夹' : err.message)
    }
  })

  app.delete('/api/folders/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const folder = await options.store.getFolder(request.params.id, user.id)
    if (!folder) return sendError(reply, 404, '文件夹不存在')
    const images = await options.store.listImagesByFolder(folder.id, user.id)
    const deleteImages = String(request.query?.deleteImages ?? 'false') === 'true'
    try {
      if (deleteImages) {
        await deleteStoredImages(images)
        await options.store.deleteImages(user.id, images.map((image) => image.id))
      } else {
        await options.store.moveImages(user.id, images.map((image) => image.id), null)
      }
      await options.store.deleteFolder(folder.id, user.id)
      return { ok: true, deletedImages: deleteImages ? images.length : 0 }
    } catch (err) {
      return sendError(reply, 502, `删除对象存储文件失败：${err.message}`)
    }
  })

  app.get('/api/assets', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const queryOptions = {
      q: String(request.query?.q ?? '').trim(),
      cursor: String(request.query?.cursor ?? '').trim() || null,
      limit: Number(request.query?.limit) || 60,
    }
    if (request.query?.folderId === 'uncategorized') queryOptions.folderId = null
    else if (request.query?.folderId) queryOptions.folderId = String(request.query.folderId)
    const result = await options.store.listAssets(user.id, queryOptions)
    return { assets: result.assets.map(publicAsset), nextCursor: result.nextCursor }
  })

  app.patch('/api/images/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const image = await options.store.getImage(request.params.id)
    if (!image || image.userId !== user.id) return sendError(reply, 404, '图片不存在')
    try {
      const name = cleanName(request.body?.name, '图片名称')
      return { image: publicAsset(await options.store.updateImage(image.id, user.id, { name })) }
    } catch (err) {
      return sendError(reply, 400, err.message)
    }
  })

  app.post('/api/images/move', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const imageIds = Array.isArray(request.body?.imageIds) ? [...new Set(request.body.imageIds.map(String))].slice(0, 100) : []
    if (!imageIds.length) return sendError(reply, 400, '请选择需要移动的图片')
    const folderId = request.body?.folderId == null || request.body.folderId === '' ? null : String(request.body.folderId)
    if (folderId && !await options.store.getFolder(folderId, user.id)) return sendError(reply, 404, '目标文件夹不存在')
    const owned = await Promise.all(imageIds.map((id) => options.store.getImage(id)))
    if (owned.some((image) => !image || image.userId !== user.id)) return sendError(reply, 404, '部分图片不存在')
    const images = await options.store.moveImages(user.id, imageIds, folderId)
    return { images: images.map(publicAsset) }
  })

  app.delete('/api/images/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const image = await options.store.getImage(request.params.id)
    if (!image || image.userId !== user.id) return sendError(reply, 404, '图片不存在')
    try {
      await options.storage.deleteObject(image.objectKey)
      await options.store.deleteImages(user.id, [image.id])
      return { ok: true }
    } catch (err) {
      return sendError(reply, 502, `删除对象存储文件失败：${err.message}`)
    }
  })

  app.delete('/api/generations/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const generation = await options.store.getGeneration(request.params.id, user.id)
    if (!generation) return sendError(reply, 404, '任务不存在')
    if (generation.status === 'running') return sendError(reply, 409, '生成中的任务暂不可删除')
    const images = await options.store.getImagesByGeneration(generation.id, user.id)
    try {
      await deleteStoredImages(images)
      await options.store.deleteGeneration(generation.id, user.id)
      return { ok: true }
    } catch (err) {
      return sendError(reply, 502, `删除对象存储文件失败：${err.message}`)
    }
  })

  app.get('/api/images/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const image = await options.store.getImage(request.params.id)
    if (!image) return sendError(reply, 404, '图片不存在')
    if (image.userId !== user.id) return sendError(reply, 403, '无权访问图片')
    const object = await options.storage.getObject(image.objectKey)
    if (!object) return sendError(reply, 404, '图片文件不存在')
    reply.type(object.contentType)
    return reply.send(object.body)
  })

  return app
}
