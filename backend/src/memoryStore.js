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
  const objects = new Map()
  let nextUserId = 1
  let nextGenerationId = 1
  let nextImageId = 1

  const publicUser = (user) => ({
    id: String(user.id),
    externalProvider: user.externalProvider ?? null,
    externalUserId: user.externalUserId ?? null,
    email: user.email ?? user.username,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    sub2apiAccessToken: user.sub2apiAccessToken,
    sub2apiRefreshToken: user.sub2apiRefreshToken,
    sub2apiTokenExpiresAt: user.sub2apiTokenExpiresAt ?? null,
  })

  return {
    objects,

    async upsertExternalUser(input) {
      const externalUserId = String(input.id)
      const existing = users.find((user) => user.externalProvider === 'sub2api' && user.externalUserId === externalUserId)
      const createdAt = nowIso()
      const next = existing ?? {
        id: nextUserId++,
        username: `sub2api:${externalUserId}`,
        createdAt,
      }
      next.externalProvider = 'sub2api'
      next.externalUserId = externalUserId
      next.email = input.email ?? ''
      next.nickname = input.username || input.email || `sub2api-${externalUserId}`
      next.role = input.role === 'admin' ? 'admin' : 'user'
      next.status = input.status && input.status !== 'active' ? 'disabled' : 'active'
      next.updatedAt = nowIso()
      if (!existing) users.push(next)
      return publicUser(next)
    },

    async getUserById(id) {
      const user = users.find((item) => String(item.id) === String(id))
      return user ? publicUser(user) : null
    },

    async createSession(userId, tokenHash, expiresAt, session = {}) {
      sessions.set(tokenHash, {
        userId: String(userId),
        expiresAt,
        sub2apiAccessToken: session.accessToken ?? null,
        sub2apiRefreshToken: session.refreshToken ?? null,
        sub2apiTokenExpiresAt: session.tokenExpiresAt ?? null,
      })
    },

    async getSessionUser(tokenHash) {
      const session = sessions.get(tokenHash)
      if (!session) return null
      if (Date.parse(session.expiresAt) <= Date.now()) {
        sessions.delete(tokenHash)
        return null
      }
      const user = await this.getUserById(session.userId)
      return user ? {
        ...user,
        sub2apiAccessToken: session.sub2apiAccessToken,
        sub2apiRefreshToken: session.sub2apiRefreshToken,
        sub2apiTokenExpiresAt: session.sub2apiTokenExpiresAt,
      } : null
    },

    async updateSessionTokens(tokenHash, sessionPatch = {}) {
      const session = sessions.get(tokenHash)
      if (!session) return
      session.sub2apiAccessToken = sessionPatch.accessToken ?? session.sub2apiAccessToken
      session.sub2apiRefreshToken = sessionPatch.refreshToken ?? session.sub2apiRefreshToken
      session.sub2apiTokenExpiresAt = sessionPatch.tokenExpiresAt ?? session.sub2apiTokenExpiresAt
    },

    async deleteSession(tokenHash) {
      sessions.delete(tokenHash)
    },

    async createGeneration(input) {
      const createdAt = nowIso()
      const generation = {
        id: String(nextGenerationId++),
        userId: String(input.userId),
        apiKeyId: input.apiKeyId ?? null,
        apiKeyName: input.apiKeyName ?? null,
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

    async failInterruptedRunningGenerations(error) {
      const finishedAt = nowIso()
      let count = 0
      for (const generation of generations) {
        if (generation.status !== 'running') continue
        generation.status = 'error'
        generation.error = error
        generation.finishedAt = finishedAt
        count += 1
      }
      return count
    },

    async finishGenerationSuccess(generationId, outputImages, upstream, elapsedMs) {
      const generation = generations.find((item) => item.id === String(generationId))
      if (!generation) throw new Error('任务不存在')
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
