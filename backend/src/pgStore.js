import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pg from 'pg'

const { Pool } = pg

function rowUser(row) {
  if (!row) return null
  return {
    id: String(row.id),
    externalProvider: row.external_provider ?? null,
    externalUserId: row.external_user_id == null ? null : String(row.external_user_id),
    email: row.email ?? row.username,
    username: row.username,
    nickname: row.nickname,
    role: row.role,
    status: row.status,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    sub2apiAccessToken: row.sub2api_access_token,
    sub2apiRefreshToken: row.sub2api_refresh_token,
    sub2apiTokenExpiresAt: row.sub2api_token_expires_at?.toISOString?.() ?? row.sub2api_token_expires_at ?? null,
  }
}

function rowGeneration(row, images = []) {
  if (!row) return null
  return {
    id: String(row.id),
    userId: String(row.user_id),
    apiKeyId: row.api_key_id == null ? null : String(row.api_key_id),
    apiKeyName: row.api_key_name ?? null,
    prompt: row.prompt,
    params: row.params,
    status: row.status,
    model: row.model,
    error: row.error,
    upstream: row.upstream,
    elapsedMs: row.elapsed_ms,
    images,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    finishedAt: row.finished_at?.toISOString?.() ?? row.finished_at,
  }
}

function rowImage(row) {
  if (!row) return null
  return {
    id: String(row.id),
    generationId: String(row.generation_id),
    userId: String(row.user_id),
    objectKey: row.object_key,
    contentType: row.content_type,
    name: row.name,
    folderId: row.folder_id == null ? null : String(row.folder_id),
    revisedPrompt: row.revised_prompt,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  }
}

function rowFolder(row) {
  if (!row) return null
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: row.name,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  }
}

function defaultImageName(value, index, count) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(value))
  const part = (type) => parts.find((item) => item.type === type)?.value ?? ''
  const base = `Aurora 图片 ${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
  return count > 1 ? `${base} - ${index + 1}` : base
}

async function migrate(pool) {
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql')
  await pool.query(await fs.readFile(schemaPath, 'utf8'))
}

export async function createPgStore(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl })
  await migrate(pool)

  return {
    pool,

    async close() {
      await pool.end()
    },

    async upsertExternalUser(input) {
      const externalUserId = String(input.id)
      const email = String(input.email ?? '').trim()
      const username = `sub2api:${externalUserId}`
      const nickname = String(input.username || email || `sub2api-${externalUserId}`).trim()
      const role = input.role === 'admin' ? 'admin' : 'user'
      const status = input.status && input.status !== 'active' ? 'disabled' : 'active'
      const result = await pool.query(
        `insert into users (username, email, external_provider, external_user_id, nickname, role, status)
         values ($1, $2, 'sub2api', $3, $4, $5, $6)
         on conflict (external_provider, external_user_id)
         do update set username = excluded.username, email = excluded.email, nickname = excluded.nickname, role = excluded.role, status = excluded.status, updated_at = now()
         returning *`,
        [username, email || null, externalUserId, nickname, role, status],
      )
      return rowUser(result.rows[0])
    },

    async getUserById(id) {
      const result = await pool.query('select * from users where id = $1', [id])
      return rowUser(result.rows[0])
    },

    async createSession(userId, tokenHash, expiresAt, session = {}) {
      await pool.query(
        `insert into sessions (token_hash, user_id, expires_at, sub2api_access_token, sub2api_refresh_token, sub2api_token_expires_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [tokenHash, userId, expiresAt, session.accessToken ?? null, session.refreshToken ?? null, session.tokenExpiresAt ?? null],
      )
    },

    async getSessionUser(tokenHash) {
      const result = await pool.query(
        `select users.*, sessions.sub2api_access_token, sessions.sub2api_refresh_token, sessions.sub2api_token_expires_at
         from sessions join users on users.id = sessions.user_id
         where sessions.token_hash = $1 and sessions.expires_at > now()`,
        [tokenHash],
      )
      return rowUser(result.rows[0])
    },

    async updateSessionTokens(tokenHash, sessionPatch = {}) {
      await pool.query(
        `update sessions
         set sub2api_access_token = coalesce($2, sub2api_access_token),
             sub2api_refresh_token = coalesce($3, sub2api_refresh_token),
             sub2api_token_expires_at = coalesce($4, sub2api_token_expires_at)
         where token_hash = $1`,
        [tokenHash, sessionPatch.accessToken ?? null, sessionPatch.refreshToken ?? null, sessionPatch.tokenExpiresAt ?? null],
      )
    },

    async deleteSession(tokenHash) {
      await pool.query('delete from sessions where token_hash = $1', [tokenHash])
    },

    async getSettings(userId) {
      const result = await pool.query('select image_api_key_id, prompt_api_key_id from user_settings where user_id = $1', [userId])
      return {
        imageApiKeyId: result.rows[0]?.image_api_key_id ?? null,
        promptApiKeyId: result.rows[0]?.prompt_api_key_id ?? null,
      }
    },

    async saveSettings(userId, input) {
      const result = await pool.query(
        `insert into user_settings (user_id, image_api_key_id, prompt_api_key_id)
         values ($1, $2, $3)
         on conflict (user_id) do update
         set image_api_key_id = excluded.image_api_key_id,
             prompt_api_key_id = excluded.prompt_api_key_id,
             updated_at = now()
         returning image_api_key_id, prompt_api_key_id`,
        [userId, input.imageApiKeyId || null, input.promptApiKeyId || null],
      )
      return { imageApiKeyId: result.rows[0].image_api_key_id, promptApiKeyId: result.rows[0].prompt_api_key_id }
    },

    async listFolders(userId) {
      const result = await pool.query('select * from asset_folders where user_id = $1 order by name asc, id asc', [userId])
      return result.rows.map(rowFolder)
    },

    async getFolder(folderId, userId) {
      const result = await pool.query('select * from asset_folders where id = $1 and user_id = $2', [folderId, userId])
      return rowFolder(result.rows[0])
    },

    async createFolder(userId, name) {
      const result = await pool.query('insert into asset_folders (user_id, name) values ($1, $2) returning *', [userId, name])
      return rowFolder(result.rows[0])
    },

    async updateFolder(folderId, userId, name) {
      const result = await pool.query('update asset_folders set name = $3, updated_at = now() where id = $1 and user_id = $2 returning *', [folderId, userId, name])
      return rowFolder(result.rows[0])
    },

    async deleteFolder(folderId, userId) {
      const result = await pool.query('delete from asset_folders where id = $1 and user_id = $2', [folderId, userId])
      return result.rowCount > 0
    },

    async createGeneration(input) {
      const result = await pool.query(
        `insert into generations (user_id, api_key_id, api_key_name, prompt, params, status, model)
         values ($1, $2, $3, $4, $5, 'running', $6)
         returning *`,
        [input.userId, input.apiKeyId ?? null, input.apiKeyName ?? null, input.prompt, input.params, input.model],
      )
      return rowGeneration(result.rows[0])
    },

    async failInterruptedRunningGenerations(error) {
      const result = await pool.query(
        `update generations set status = 'error', error = $1, finished_at = now()
         where status = 'running'`,
        [error],
      )
      return result.rowCount
    },

    async finishGenerationSuccess(generationId, outputImages, upstream, elapsedMs) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const generationResult = await client.query('select * from generations where id = $1 for update', [generationId])
        const generation = generationResult.rows[0]
        if (!generation) throw new Error('任务不存在')

        await client.query(
          `update generations set status = 'done', upstream = $2, elapsed_ms = $3, finished_at = now()
           where id = $1 returning *`,
          [generationId, upstream ?? null, elapsedMs],
        )
        for (let index = 0; index < outputImages.length; index += 1) {
          const image = outputImages[index]
          await client.query(
            `insert into generation_images (generation_id, user_id, object_key, content_type, name, revised_prompt)
             values ($1, $2, $3, $4, $5, $6)`,
            [generationId, generation.user_id, image.objectKey, image.contentType, image.name || defaultImageName(new Date(), index, outputImages.length), image.revisedPrompt ?? null],
          )
        }
        await client.query('commit')
        return this.getGeneration(generationId, generation.user_id)
      } catch (err) {
        await client.query('rollback')
        throw err
      } finally {
        client.release()
      }
    },

    async finishGenerationError(generationId, error) {
      const result = await pool.query(
        `update generations set status = 'error', error = $2, finished_at = now()
         where id = $1 returning *`,
        [generationId, error],
      )
      return this.getGeneration(generationId, result.rows[0]?.user_id)
    },

    async getGeneration(generationId, userId) {
      const params = userId ? [generationId, userId] : [generationId]
      const where = userId ? 'id = $1 and user_id = $2' : 'id = $1'
      const generationResult = await pool.query(`select * from generations where ${where}`, params)
      const generation = generationResult.rows[0]
      if (!generation) return null
      const imageResult = await pool.query('select * from generation_images where generation_id = $1 order by id asc', [generation.id])
      return rowGeneration(generation, imageResult.rows.map(rowImage))
    },

    async listGenerations(userId) {
      const result = await pool.query('select * from generations where user_id = $1 order by created_at desc limit 100', [userId])
      return Promise.all(result.rows.map((row) => this.getGeneration(row.id, userId)))
    },

    async getImage(imageId) {
      const result = await pool.query('select * from generation_images where id = $1', [imageId])
      return rowImage(result.rows[0])
    },

    async getImagesByGeneration(generationId, userId) {
      const result = await pool.query('select * from generation_images where generation_id = $1 and user_id = $2 order by id asc', [generationId, userId])
      return result.rows.map(rowImage)
    },

    async listImagesByFolder(folderId, userId) {
      const result = await pool.query('select * from generation_images where folder_id = $1 and user_id = $2 order by id asc', [folderId, userId])
      return result.rows.map(rowImage)
    },

    async deleteImages(userId, imageIds) {
      if (!imageIds.length) return 0
      const result = await pool.query('delete from generation_images where user_id = $1 and id = any($2::bigint[])', [userId, imageIds])
      return result.rowCount
    },

    async deleteGeneration(generationId, userId) {
      const result = await pool.query('delete from generations where id = $1 and user_id = $2', [generationId, userId])
      return result.rowCount > 0
    },

    async updateImage(imageId, userId, patch) {
      const result = await pool.query(
        `update generation_images
         set name = case when $3::text is null then name else $3 end,
             folder_id = case when $4::boolean then $5::bigint else folder_id end
         where id = $1 and user_id = $2 returning *`,
        [imageId, userId, patch.name ?? null, patch.folderId !== undefined, patch.folderId ?? null],
      )
      return rowImage(result.rows[0])
    },

    async moveImages(userId, imageIds, folderId) {
      if (!imageIds.length) return []
      const result = await pool.query(
        'update generation_images set folder_id = $3 where user_id = $1 and id = any($2::bigint[]) returning *',
        [userId, imageIds, folderId ?? null],
      )
      return result.rows.map(rowImage)
    },

    async listAssets(userId, options = {}) {
      const values = [userId]
      const where = ['generation_images.user_id = $1']
      if (Object.prototype.hasOwnProperty.call(options, 'folderId')) {
        if (options.folderId == null) where.push('generation_images.folder_id is null')
        else {
          values.push(options.folderId)
          where.push(`generation_images.folder_id = $${values.length}`)
        }
      }
      if (options.q) {
        values.push(`%${String(options.q).trim()}%`)
        where.push(`(generation_images.name ilike $${values.length} or generations.prompt ilike $${values.length})`)
      }
      if (options.cursor) {
        values.push(options.cursor)
        where.push(`generation_images.id < $${values.length}`)
      }
      const limit = Math.min(Math.max(Number(options.limit) || 60, 1), 100)
      values.push(limit + 1)
      const result = await pool.query(
        `select generation_images.*, generations.prompt
         from generation_images join generations on generations.id = generation_images.generation_id
         where ${where.join(' and ')}
         order by generation_images.id desc limit $${values.length}`,
        values,
      )
      const rows = result.rows.slice(0, limit)
      return {
        assets: rows.map((row) => ({ ...rowImage(row), prompt: row.prompt })),
        nextCursor: result.rows.length > limit ? String(rows.at(-1).id) : null,
      }
    },
  }
}
