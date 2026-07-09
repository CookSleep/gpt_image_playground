import bcrypt from 'bcryptjs'

function nowIso() {
  return new Date().toISOString()
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function createMemoryStore() {
  const users = []
  const sessions = new Map()
  const generations = []
  const images = []
  const quotaLedger = []
  const auditLogs = []
  const objects = new Map()
  let nextUserId = 1
  let nextGenerationId = 1
  let nextImageId = 1

  const publicUser = (user) => ({
    id: String(user.id),
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    quotaRemaining: user.quotaRemaining,
    quotaUsed: user.quotaUsed,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  })

  return {
    objects,

    async ensureAdmin(admin) {
      const existing = users.find((user) => user.role === 'admin')
      if (existing) return publicUser(existing)

      const createdAt = nowIso()
      const user = {
        id: nextUserId++,
        username: admin.username,
        passwordHash: bcrypt.hashSync(admin.password, 4),
        nickname: '管理员',
        role: 'admin',
        status: 'active',
        quotaRemaining: 0,
        quotaUsed: 0,
        createdAt,
        updatedAt: createdAt,
      }
      users.push(user)
      return publicUser(user)
    },

    async createUser(input) {
      if (users.some((user) => user.username === input.username)) {
        const err = new Error('账号已存在')
        err.statusCode = 409
        throw err
      }
      const createdAt = nowIso()
      const user = {
        id: nextUserId++,
        username: input.username,
        passwordHash: bcrypt.hashSync(input.password, 4),
        nickname: input.nickname || input.username,
        role: 'user',
        status: 'pending',
        quotaRemaining: 0,
        quotaUsed: 0,
        createdAt,
        updatedAt: createdAt,
      }
      users.push(user)
      return publicUser(user)
    },

    async verifyUser(username, password) {
      const user = users.find((item) => item.username === username)
      if (!user) return null
      if (!bcrypt.compareSync(password, user.passwordHash)) return null
      return publicUser(user)
    },

    async updatePassword(userId, password) {
      const user = users.find((item) => String(item.id) === String(userId))
      if (!user) {
        const err = new Error('用户不存在')
        err.statusCode = 404
        throw err
      }
      user.passwordHash = bcrypt.hashSync(password, 4)
      user.updatedAt = nowIso()
      return publicUser(user)
    },

    async getUserById(id) {
      const user = users.find((item) => String(item.id) === String(id))
      return user ? publicUser(user) : null
    },

    async createSession(userId, tokenHash, expiresAt) {
      sessions.set(tokenHash, { userId: String(userId), expiresAt })
    },

    async getSessionUser(tokenHash) {
      const session = sessions.get(tokenHash)
      if (!session) return null
      if (Date.parse(session.expiresAt) <= Date.now()) {
        sessions.delete(tokenHash)
        return null
      }
      return this.getUserById(session.userId)
    },

    async deleteSession(tokenHash) {
      sessions.delete(tokenHash)
    },

    async listUsers() {
      return users.map(publicUser)
    },

    async updateUserStatus(userId, status, actorId) {
      const user = users.find((item) => String(item.id) === String(userId))
      if (!user || user.role === 'admin') {
        const err = new Error('用户不存在')
        err.statusCode = 404
        throw err
      }
      user.status = status
      user.updatedAt = nowIso()
      auditLogs.push({ id: auditLogs.length + 1, actorId, action: 'update_status', targetUserId: String(user.id), detail: { status }, createdAt: nowIso() })
      return publicUser(user)
    },

    async adjustQuota(userId, delta, reason, actorId) {
      const user = users.find((item) => String(item.id) === String(userId))
      if (!user || user.role === 'admin') {
        const err = new Error('用户不存在')
        err.statusCode = 404
        throw err
      }
      const nextQuota = user.quotaRemaining + delta
      if (nextQuota < 0) {
        const err = new Error('剩余额度不能小于 0')
        err.statusCode = 400
        throw err
      }
      user.quotaRemaining = nextQuota
      user.updatedAt = nowIso()
      quotaLedger.push({
        id: quotaLedger.length + 1,
        userId: String(user.id),
        actorId,
        delta,
        reason: reason || '管理员调整',
        balanceAfter: user.quotaRemaining,
        createdAt: nowIso(),
      })
      auditLogs.push({ id: auditLogs.length + 1, actorId, action: 'adjust_quota', targetUserId: String(user.id), detail: { delta, reason }, createdAt: nowIso() })
      return publicUser(user)
    },

    async createGeneration(input) {
      const createdAt = nowIso()
      const generation = {
        id: String(nextGenerationId++),
        userId: String(input.userId),
        prompt: input.prompt,
        params: clone(input.params),
        status: 'running',
        model: input.model,
        error: null,
        upstream: null,
        elapsedMs: null,
        createdAt,
        finishedAt: null,
      }
      generations.unshift(generation)
      return clone(generation)
    },

    async finishGenerationSuccess(generationId, outputImages, upstream, elapsedMs) {
      const generation = generations.find((item) => item.id === String(generationId))
      if (!generation) throw new Error('任务不存在')
      const user = users.find((item) => String(item.id) === generation.userId)
      if (user?.role === 'admin') {
        generation.status = 'done'
        generation.upstream = upstream
        generation.elapsedMs = elapsedMs
        generation.finishedAt = nowIso()
        for (const image of outputImages) {
          images.push({
            id: String(nextImageId++),
            generationId: generation.id,
            userId: generation.userId,
            objectKey: image.objectKey,
            contentType: image.contentType,
            revisedPrompt: image.revisedPrompt ?? null,
            createdAt: nowIso(),
          })
        }
        return this.getGeneration(generation.id, generation.userId)
      }
      if (!user || user.quotaRemaining <= 0) {
        generation.status = 'error'
        generation.error = '额度不足，扣费失败'
        generation.finishedAt = nowIso()
        return this.getGeneration(generationId, generation.userId)
      }

      user.quotaRemaining -= 1
      user.quotaUsed += 1
      user.updatedAt = nowIso()
      quotaLedger.push({
        id: quotaLedger.length + 1,
        userId: String(user.id),
        actorId: null,
        delta: -1,
        reason: `生成任务 ${generation.id} 成功扣费`,
        balanceAfter: user.quotaRemaining,
        createdAt: nowIso(),
      })

      generation.status = 'done'
      generation.upstream = upstream ?? null
      generation.elapsedMs = elapsedMs
      generation.finishedAt = nowIso()
      for (const image of outputImages) {
        images.push({
          id: String(nextImageId++),
          generationId: generation.id,
          userId: generation.userId,
          objectKey: image.objectKey,
          contentType: image.contentType,
          revisedPrompt: image.revisedPrompt ?? null,
          createdAt: nowIso(),
        })
      }
      return this.getGeneration(generationId, generation.userId)
    },

    async finishGenerationError(generationId, error) {
      const generation = generations.find((item) => item.id === String(generationId))
      if (!generation) throw new Error('任务不存在')
      generation.status = 'error'
      generation.error = error
      generation.finishedAt = nowIso()
      return this.getGeneration(generation.id, generation.userId)
    },

    async getGeneration(generationId, userId) {
      const generation = generations.find((item) => item.id === String(generationId) && (!userId || item.userId === String(userId)))
      if (!generation) return null
      const outputImages = images
        .filter((image) => image.generationId === generation.id)
        .map((image) => ({ id: image.id, contentType: image.contentType, revisedPrompt: image.revisedPrompt }))
      return { ...clone(generation), images: outputImages }
    },

    async listGenerations(userId) {
      const list = generations.filter((item) => item.userId === String(userId))
      return Promise.all(list.map((item) => this.getGeneration(item.id, userId)))
    },

    async getImage(imageId) {
      const image = images.find((item) => item.id === String(imageId))
      return image ? clone(image) : null
    },
  }
}
