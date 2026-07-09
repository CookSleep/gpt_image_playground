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

export function buildApp(options) {
  const app = Fastify({ logger: false, bodyLimit: 80 * 1024 * 1024 })
  const ready = options.store.ensureAdmin(options.admin)

  async function getCurrentUser(request) {
    await ready
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME]
    if (!token) return null
    return options.store.getSessionUser(hashToken(token, options.sessionSecret))
  }

  async function requireUser(request, reply) {
    const user = await getCurrentUser(request)
    if (!user) {
      sendError(reply, 401, '请先登录')
      return null
    }
    return user
  }

  async function requireAdmin(request, reply) {
    const user = await requireUser(request, reply)
    if (!user) return null
    if (user.role !== 'admin') {
      sendError(reply, 403, '需要管理员权限')
      return null
    }
    return user
  }

  async function processGeneration(generation, payload) {
    const startedAt = Date.now()
    try {
      const result = await options.imageClient.generate({
        prompt: generation.prompt,
        params: generation.params,
        inputImages: payload.inputImages ?? [],
        model: options.defaultModel,
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

  app.post('/api/auth/register', async (request, reply) => {
    const body = request.body ?? {}
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')
    const nickname = String(body.nickname ?? '').trim()
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) return sendError(reply, 400, '账号需为 3-32 位字母、数字或下划线')
    if (password.length < 6) return sendError(reply, 400, '密码至少 6 位')

    try {
      const user = await options.store.createUser({ username, password, nickname })
      return reply.code(201).send({ user })
    } catch (err) {
      return sendError(reply, err.statusCode ?? 500, err.message)
    }
  })

  app.post('/api/auth/login', async (request, reply) => {
    await ready
    const body = request.body ?? {}
    const user = await options.store.verifyUser(String(body.username ?? '').trim(), String(body.password ?? ''))
    if (!user) return sendError(reply, 401, '账号或密码错误')
    if (user.status === 'disabled') return sendError(reply, 403, '账号已禁用')

    const token = createToken()
    await options.store.createSession(user.id, hashToken(token, options.sessionSecret), createExpiresAt())
    reply.header('set-cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`)
    return { user }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME]
    if (token) await options.store.deleteSession(hashToken(token, options.sessionSecret))
    reply.header('set-cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`)
    return { ok: true }
  })

  app.post('/api/auth/change-password', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const currentPassword = String(request.body?.currentPassword ?? '')
    const newPassword = String(request.body?.newPassword ?? '')
    if (newPassword.length < 6) return sendError(reply, 400, '新密码至少 6 位')

    const verified = await options.store.verifyUser(user.username, currentPassword)
    if (!verified) return sendError(reply, 400, '当前密码不正确')

    await options.store.updatePassword(user.id, newPassword)
    return { ok: true }
  })

  app.get('/api/me', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    return { user }
  })

  app.get('/api/admin/users', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return
    return { users: await options.store.listUsers() }
  })

  app.patch('/api/admin/users/:id/status', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return
    const status = request.body?.status
    if (!['pending', 'active', 'disabled'].includes(status)) return sendError(reply, 400, '状态不合法')
    try {
      return { user: await options.store.updateUserStatus(request.params.id, status, admin.id) }
    } catch (err) {
      return sendError(reply, err.statusCode ?? 500, err.message)
    }
  })

  app.post('/api/admin/users/:id/quota', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return
    const delta = Number(request.body?.delta)
    if (!Number.isInteger(delta) || delta === 0) return sendError(reply, 400, '额度调整值必须为非 0 整数')
    try {
      return { user: await options.store.adjustQuota(request.params.id, delta, request.body?.reason, admin.id) }
    } catch (err) {
      return sendError(reply, err.statusCode ?? 500, err.message)
    }
  })

  app.post('/api/generations', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    if (user.status !== 'active') return sendError(reply, 403, '账号待审核或已禁用')

    const prompt = String(request.body?.prompt ?? '').trim()
    if (!prompt) return sendError(reply, 400, '请输入提示词')
    const params = normalizeParams(request.body?.params)
    if (user.role !== 'admin' && user.quotaRemaining < params.n) return sendError(reply, 403, `可用额度不足，本次需要 ${params.n} 次`)
    const generation = await options.store.createGeneration({
      userId: user.id,
      prompt,
      params,
      model: options.defaultModel,
    })

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
    const generation = await options.store.getGeneration(request.params.id, user.role === 'admin' ? null : user.id)
    if (!generation) return sendError(reply, 404, '任务不存在')
    return { generation: publicGeneration(generation) }
  })

  app.get('/api/generations/:id/events', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const generation = await options.store.getGeneration(request.params.id, user.role === 'admin' ? null : user.id)
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
    if (user.role !== 'admin' && image.userId !== user.id) return sendError(reply, 403, '无权访问图片')
    const object = await options.storage.getObject(image.objectKey)
    if (!object) return sendError(reply, 404, '图片文件不存在')
    reply.type(object.contentType)
    return reply.send(object.body)
  })

  return app
}
