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

  test('adds user settings, asset folders, and image organization fields', async () => {
    const schema = await fs.readFile(path.join(__dirname, '../src/schema.sql'), 'utf8')

    expect(schema).toContain('create table if not exists user_settings')
    expect(schema).toContain('image_api_key_id text')
    expect(schema).toContain('prompt_api_key_id text')
    expect(schema).toContain('create table if not exists asset_folders')
    expect(schema).toContain('alter table generation_images add column if not exists name text')
    expect(schema).toContain('alter table generation_images add column if not exists folder_id bigint')
    expect(schema).toContain('references asset_folders(id) on delete set null')
    expect(schema).toContain('create unique index if not exists asset_folders_user_name_idx')
    expect(schema).toContain("update generation_images set name = 'Aurora 图片 '")
  })

  test('adds image organization columns before creating indexes that use them', async () => {
    const schema = await fs.readFile(path.join(__dirname, '../src/schema.sql'), 'utf8')
    const addFolderColumn = schema.indexOf('alter table generation_images add column if not exists folder_id bigint')
    const createFolderIndex = schema.indexOf('create index if not exists generation_images_folder_idx')

    expect(addFolderColumn).toBeGreaterThanOrEqual(0)
    expect(createFolderIndex).toBeGreaterThan(addFolderColumn)
  })
})
