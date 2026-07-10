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
    revisedPrompt: row.revised_prompt,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  }
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
        for (const image of outputImages) {
          await client.query(
            `insert into generation_images (generation_id, user_id, object_key, content_type, revised_prompt)
             values ($1, $2, $3, $4, $5)`,
            [generationId, generation.user_id, image.objectKey, image.contentType, image.revisedPrompt ?? null],
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
  }
}
