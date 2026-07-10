import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('database schema migrations', () => {
  test('recreates external identity unique index so ON CONFLICT can target it', async () => {
    const schema = await fs.readFile(path.join(__dirname, '../src/schema.sql'), 'utf8')
    const dropIndex = schema.indexOf('drop index if exists users_external_identity_idx')
    const createIndex = schema.indexOf(
      'create unique index users_external_identity_idx on users(external_provider, external_user_id)',
    )

    expect(dropIndex).toBeGreaterThanOrEqual(0)
    expect(createIndex).toBeGreaterThan(dropIndex)
  })
})
