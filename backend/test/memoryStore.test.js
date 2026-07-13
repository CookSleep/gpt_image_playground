import { describe, expect, test } from 'vitest'
import { createMemoryStore } from '../src/memoryStore.js'

async function createUser(store, id = 42) {
  return store.upsertExternalUser({
    id,
    email: `user-${id}@example.com`,
    username: `user-${id}`,
    role: 'user',
    status: 'active',
  })
}

async function createDoneGeneration(store, userId, images = 1) {
  const generation = await store.createGeneration({
    userId,
    apiKeyId: 'image-key',
    apiKeyName: '图片 Key',
    prompt: '一座雨夜中的未来城市',
    params: { size: '1024x1024', quality: 'high', output_format: 'png', n: images },
    model: 'gpt-image-2',
  })
  return store.finishGenerationSuccess(
    generation.id,
    Array.from({ length: images }, (_, index) => ({
      objectKey: `generations/${generation.id}/${index}.png`,
      contentType: 'image/png',
      name: `Aurora 图片 2026-07-11 12:00${images > 1 ? ` - ${index + 1}` : ''}`,
    })),
    null,
    100,
  )
}

describe('memory store asset model', () => {
  test('persists only selected image and prompt key ids per user', async () => {
    const store = createMemoryStore()
    const user = await createUser(store)

    expect(await store.getSettings(user.id)).toEqual({ imageApiKeyId: null, promptApiKeyId: null })

    await store.saveSettings(user.id, { imageApiKeyId: '101', promptApiKeyId: '202' })

    expect(await store.getSettings(user.id)).toEqual({ imageApiKeyId: '101', promptApiKeyId: '202' })
    expect(JSON.stringify(await store.getSettings(user.id))).not.toContain('sk-')
  })

  test('creates folders and moves named images between a folder and uncategorized', async () => {
    const store = createMemoryStore()
    const user = await createUser(store)
    const generation = await createDoneGeneration(store, user.id, 2)
    const folder = await store.createFolder(user.id, '项目灵感')

    await store.moveImages(user.id, generation.images.map((image) => image.id), folder.id)
    const inFolder = await store.listAssets(user.id, { folderId: folder.id, limit: 60 })

    expect(inFolder.assets).toHaveLength(2)
    expect(inFolder.assets[0]).toMatchObject({
      folderId: folder.id,
      prompt: '一座雨夜中的未来城市',
    })
    expect(inFolder.assets[0].name).toMatch(/^Aurora 图片/)

    await store.updateImage(generation.images[0].id, user.id, { name: '霓虹雨城' })
    await store.moveImages(user.id, [generation.images[0].id], null)
    const uncategorized = await store.listAssets(user.id, { folderId: null, limit: 60 })

    expect(uncategorized.assets).toContainEqual(expect.objectContaining({ name: '霓虹雨城', folderId: null }))
  })

  test('searches assets by image name or original prompt but not folder name', async () => {
    const store = createMemoryStore()
    const user = await createUser(store)
    const generation = await createDoneGeneration(store, user.id)
    const folder = await store.createFolder(user.id, '不会命中的目录词')
    await store.moveImages(user.id, [generation.images[0].id], folder.id)
    await store.updateImage(generation.images[0].id, user.id, { name: '霓虹雨城' })

    expect((await store.listAssets(user.id, { q: '霓虹', limit: 60 })).assets).toHaveLength(1)
    expect((await store.listAssets(user.id, { q: '未来城市', limit: 60 })).assets).toHaveLength(1)
    expect((await store.listAssets(user.id, { q: '目录词', limit: 60 })).assets).toHaveLength(0)
  })
})
