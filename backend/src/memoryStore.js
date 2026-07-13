function nowIso() {
  return new Date().toISOString()
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function defaultImageName(value, index, count) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(value))
  const part = (type) => parts.find((item) => item.type === type)?.value ?? ''
  const base = `Aurora 图片 ${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
  return count > 1 ? `${base} - ${index + 1}` : base
}

export function createMemoryStore() {
  const users = []
  const sessions = new Map()
  const generations = []
  const images = []
  const folders = []
  const settings = new Map()
  const objects = new Map()
  let nextUserId = 1
  let nextGenerationId = 1
  let nextImageId = 1
  let nextFolderId = 1

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

    async getSettings(userId) {
      return clone(settings.get(String(userId)) ?? { imageApiKeyId: null, promptApiKeyId: null })
    },

    async saveSettings(userId, input) {
      const value = {
        imageApiKeyId: input.imageApiKeyId || null,
        promptApiKeyId: input.promptApiKeyId || null,
      }
      settings.set(String(userId), value)
      return clone(value)
    },

    async listFolders(userId) {
      return clone(folders.filter((folder) => folder.userId === String(userId)))
    },

    async getFolder(folderId, userId) {
      const folder = folders.find((item) => item.id === String(folderId) && item.userId === String(userId))
      return folder ? clone(folder) : null
    },

    async createFolder(userId, name) {
      const now = nowIso()
      const folder = {
        id: String(nextFolderId++),
        userId: String(userId),
        name,
        createdAt: now,
        updatedAt: now,
      }
      folders.push(folder)
      return clone(folder)
    },

    async updateFolder(folderId, userId, name) {
      const folder = folders.find((item) => item.id === String(folderId) && item.userId === String(userId))
      if (!folder) return null
      folder.name = name
      folder.updatedAt = nowIso()
      return clone(folder)
    },

    async deleteFolder(folderId, userId) {
      const index = folders.findIndex((item) => item.id === String(folderId) && item.userId === String(userId))
      if (index < 0) return false
      folders.splice(index, 1)
      return true
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
      for (let index = 0; index < outputImages.length; index += 1) {
        const image = outputImages[index]
        images.push({
          id: String(nextImageId++),
          generationId: generation.id,
          userId: generation.userId,
          objectKey: image.objectKey,
          contentType: image.contentType,
          name: image.name || defaultImageName(generation.finishedAt, index, outputImages.length),
          folderId: null,
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
        .map((image) => ({ id: image.id, name: image.name, folderId: image.folderId, contentType: image.contentType, revisedPrompt: image.revisedPrompt }))
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

    async getImagesByGeneration(generationId, userId) {
      return clone(images.filter((image) => image.generationId === String(generationId) && image.userId === String(userId)))
    },

    async listImagesByFolder(folderId, userId) {
      return clone(images.filter((image) => image.folderId === String(folderId) && image.userId === String(userId)))
    },

    async deleteImages(userId, imageIds) {
      const ids = new Set(imageIds.map(String))
      let count = 0
      for (let index = images.length - 1; index >= 0; index -= 1) {
        if (images[index].userId !== String(userId) || !ids.has(images[index].id)) continue
        images.splice(index, 1)
        count += 1
      }
      return count
    },

    async deleteGeneration(generationId, userId) {
      const index = generations.findIndex((item) => item.id === String(generationId) && item.userId === String(userId))
      if (index < 0) return false
      generations.splice(index, 1)
      return true
    },

    async updateImage(imageId, userId, patch) {
      const image = images.find((item) => item.id === String(imageId) && item.userId === String(userId))
      if (!image) return null
      if (patch.name !== undefined) image.name = patch.name
      if (patch.folderId !== undefined) image.folderId = patch.folderId == null ? null : String(patch.folderId)
      return clone(image)
    },

    async moveImages(userId, imageIds, folderId) {
      const targetFolderId = folderId == null ? null : String(folderId)
      if (targetFolderId && !folders.some((folder) => folder.id === targetFolderId && folder.userId === String(userId))) return []
      const ids = new Set(imageIds.map(String))
      const moved = []
      for (const image of images) {
        if (image.userId !== String(userId) || !ids.has(image.id)) continue
        image.folderId = targetFolderId
        moved.push(clone(image))
      }
      return moved
    },

    async listAssets(userId, options = {}) {
      const q = String(options.q ?? '').trim().toLowerCase()
      const hasFolderFilter = Object.prototype.hasOwnProperty.call(options, 'folderId')
      const folderId = options.folderId == null ? null : String(options.folderId)
      const generationById = new Map(generations.map((generation) => [generation.id, generation]))
      const list = images
        .filter((image) => image.userId === String(userId))
        .filter((image) => !hasFolderFilter || image.folderId === folderId)
        .map((image) => ({ ...image, prompt: generationById.get(image.generationId)?.prompt ?? '' }))
        .filter((image) => !q || image.name.toLowerCase().includes(q) || image.prompt.toLowerCase().includes(q))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || Number(b.id) - Number(a.id))
      const start = options.cursor ? Math.max(0, list.findIndex((image) => image.id === String(options.cursor)) + 1) : 0
      const limit = Math.min(Math.max(Number(options.limit) || 60, 1), 100)
      const page = list.slice(start, start + limit)
      return {
        assets: clone(page),
        nextCursor: start + limit < list.length ? page.at(-1)?.id ?? null : null,
      }
    },
  }
}
