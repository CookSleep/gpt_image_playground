import crypto from 'node:crypto'
import Fastify from 'fastify'

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

export function buildApp(options) {
  const app = Fastify({ logger: false, bodyLimit: 80 * 1024 * 1024 })
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

  app.post('/api/generations', async (request, reply) => {
    let user = await requireUser(request, reply)
    if (!user) return
    if (user.status !== 'active') return sendError(reply, 403, 'sub2api 账号不可用')

    const prompt = String(request.body?.prompt ?? '').trim()
    if (!prompt) return sendError(reply, 400, '请输入提示词')
    const params = normalizeParams(request.body?.params)
    const apiKeyId = String(request.body?.apiKeyId ?? '').trim()
    if (!apiKeyId) return sendError(reply, 400, '请选择 sub2api API Key')
    let apiKeyName = ''
    try {
      user = await ensureSub2apiAccess(user)
      const selectedKey = await options.sub2apiClient.getKey(user.sub2apiAccessToken, apiKeyId)
      if (!selectedKey?.key || selectedKey.status !== 'active') return sendError(reply, 400, '选择的 sub2api API Key 不可用')
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
