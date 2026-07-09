import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import pg from 'pg'

const { Pool } = pg
const SALT_ROUNDS = 10

function rowUser(row) {
  if (!row) return null
  return {
    id: String(row.id),
    username: row.username,
    nickname: row.nickname,
    role: row.role,
    status: row.status,
    quotaRemaining: row.quota_remaining,
    quotaUsed: row.quota_used,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  }
}

function rowGeneration(row, images = []) {
  if (!row) return null
  return {
    id: String(row.id),
    userId: String(row.user_id),
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

    async ensureAdmin(admin) {
      const existing = await pool.query('select * from users where role = $1 order by id asc limit 1', ['admin'])
      if (existing.rows[0]) return rowUser(existing.rows[0])

      const passwordHash = await bcrypt.hash(admin.password, SALT_ROUNDS)
      const created = await pool.query(
        `insert into users (username, password_hash, nickname, role, status)
         values ($1, $2, $3, 'admin', 'active')
         on conflict (username) do update set role = 'admin', status = 'active', updated_at = now()
         returning *`,
        [admin.username, passwordHash, '管理员'],
      )
      return rowUser(created.rows[0])
    },

    async createUser(input) {
      const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS)
      try {
        const result = await pool.query(
          `insert into users (username, password_hash, nickname, role, status, quota_remaining, quota_used)
           values ($1, $2, $3, 'user', 'pending', 0, 0)
           returning *`,
          [input.username, passwordHash, input.nickname || input.username],
        )
        return rowUser(result.rows[0])
      } catch (err) {
        if (err.code === '23505') {
          const e = new Error('账号已存在')
          e.statusCode = 409
          throw e
        }
        throw err
      }
    },

    async verifyUser(username, password) {
      const result = await pool.query('select * from users where username = $1', [username])
      const row = result.rows[0]
      if (!row) return null
      if (!(await bcrypt.compare(password, row.password_hash))) return null
      return rowUser(row)
    },

    async updatePassword(userId, password) {
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
      const result = await pool.query(
        'update users set password_hash = $1, updated_at = now() where id = $2 returning *',
        [passwordHash, userId],
      )
      if (!result.rows[0]) {
        const err = new Error('用户不存在')
        err.statusCode = 404
        throw err
      }
      return rowUser(result.rows[0])
    },

    async getUserById(id) {
      const result = await pool.query('select * from users where id = $1', [id])
      return rowUser(result.rows[0])
    },

    async createSession(userId, tokenHash, expiresAt) {
      await pool.query('insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)', [tokenHash, userId, expiresAt])
    },

    async getSessionUser(tokenHash) {
      const result = await pool.query(
        `select users.* from sessions join users on users.id = sessions.user_id
         where sessions.token_hash = $1 and sessions.expires_at > now()`,
        [tokenHash],
      )
      return rowUser(result.rows[0])
    },

    async deleteSession(tokenHash) {
      await pool.query('delete from sessions where token_hash = $1', [tokenHash])
    },

    async listUsers() {
      const result = await pool.query('select * from users order by role asc, id asc')
      return result.rows.map(rowUser)
    },

    async updateUserStatus(userId, status, actorId) {
      const result = await pool.query(
        `update users set status = $1, updated_at = now()
         where id = $2 and role <> 'admin'
         returning *`,
        [status, userId],
      )
      if (!result.rows[0]) {
        const err = new Error('用户不存在')
        err.statusCode = 404
        throw err
      }
      await pool.query('insert into audit_logs (actor_id, action, target_user_id, detail) values ($1, $2, $3, $4)', [actorId, 'update_status', userId, { status }])
      return rowUser(result.rows[0])
    },

    async adjustQuota(userId, delta, reason, actorId) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await client.query(
          `update users set quota_remaining = quota_remaining + $1, updated_at = now()
           where id = $2 and role <> 'admin' and quota_remaining + $1 >= 0
           returning *`,
          [delta, userId],
        )
        if (!result.rows[0]) {
          const err = new Error('用户不存在或剩余额度不能小于 0')
          err.statusCode = 400
          throw err
        }
        await client.query(
          'insert into quota_ledger (user_id, actor_id, delta, reason, balance_after) values ($1, $2, $3, $4, $5)',
          [userId, actorId, delta, reason || '管理员调整', result.rows[0].quota_remaining],
        )
        await client.query('insert into audit_logs (actor_id, action, target_user_id, detail) values ($1, $2, $3, $4)', [actorId, 'adjust_quota', userId, { delta, reason }])
        await client.query('commit')
        return rowUser(result.rows[0])
      } catch (err) {
        await client.query('rollback')
        throw err
      } finally {
        client.release()
      }
    },

    async createGeneration(input) {
      const result = await pool.query(
        `insert into generations (user_id, prompt, params, status, model)
         values ($1, $2, $3, 'running', $4)
         returning *`,
        [input.userId, input.prompt, input.params, input.model],
      )
      return rowGeneration(result.rows[0])
    },

    async finishGenerationSuccess(generationId, outputImages, upstream, elapsedMs) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const generationResult = await client.query('select * from generations where id = $1 for update', [generationId])
        const generation = generationResult.rows[0]
        if (!generation) throw new Error('任务不存在')

        const ownerResult = await client.query('select * from users where id = $1 for update', [generation.user_id])
        const owner = ownerResult.rows[0]
        if (owner?.role === 'admin') {
          const done = await client.query(
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
          return this.getGeneration(done.rows[0].id, generation.user_id)
        }

        const charge = outputImages.length
        const userResult = await client.query(
          `update users set quota_remaining = quota_remaining - $2, quota_used = quota_used + $2, updated_at = now()
           where id = $1 and quota_remaining >= $2
           returning *`,
          [generation.user_id, charge],
        )
        if (!userResult.rows[0]) {
          const failed = await client.query(
            `update generations set status = 'error', error = $2, finished_at = now()
             where id = $1 returning *`,
            [generationId, '额度不足，扣费失败'],
          )
          await client.query('commit')
          return rowGeneration(failed.rows[0], [])
        }

        await client.query(
          'insert into quota_ledger (user_id, actor_id, delta, reason, balance_after) values ($1, null, $2, $3, $4)',
          [generation.user_id, -charge, `生成任务 ${generationId} 成功扣费（${charge} 张图片）`, userResult.rows[0].quota_remaining],
        )
        const done = await client.query(
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
