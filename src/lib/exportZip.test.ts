import { describe, expect, it } from 'vitest'

import type { AppSettings, StoredImage, StoredImageThumbnail, TaskParams, TaskRecord } from '../types'
import { buildExportZip, getExportImageEstimatedBytes, getExportZipPlan, readExportZip, readExportZipFileAsDataUrl } from './exportZip'

describe('exportZip', () => {
  it('builds and reads backup zip entries without changing manifest shape', async () => {
    const task: TaskRecord = {
      id: 'task-1',
      prompt: '提示词',
      params: {} as TaskParams,
      inputImageIds: ['img-1'],
      outputImages: ['img-2'],
      streamPartialImageIds: ['img-3'],
      status: 'done',
      error: null,
      createdAt: 1700000000000,
      finishedAt: 1700000000200,
      elapsed: 200,
    }
    const images: StoredImage[] = [{
      id: 'img-1',
      dataUrl: 'data:image/png;base64,AAECAw==',
      source: 'generated',
    }, {
      id: 'img-2',
      dataUrl: 'data:image/png;base64,BAUGBw==',
      source: 'generated',
    }, {
      id: 'img-3',
      dataUrl: 'data:image/png;base64,CAkKCw==',
      source: 'generated',
    }]
    const thumbnail: StoredImageThumbnail = {
      id: 'img-1',
      thumbnailDataUrl: 'data:image/jpeg;base64,BAUG',
      width: 32,
      height: 24,
      thumbnailVersion: 2,
    }

    const { manifest, bytes } = await buildExportZip({
      options: { exportConfig: true, exportTasks: true },
      exportedAt: 1700000001000,
      settings: {} as AppSettings,
      tasks: [task],
      images,
      thumbnailsByImageId: new Map([[thumbnail.id, thumbnail]]),
      favoriteCollections: [],
      defaultFavoriteCollectionId: null,
      agentConversations: [],
    })
    const parsed = await readExportZip(bytes)

    expect(parsed.manifest).toEqual(manifest)
    expect(parsed.manifest.version).toBe(3)
    expect(parsed.manifest.exportedAt).toBe(new Date(1700000001000).toISOString())
    expect(parsed.manifest.imageFiles?.['img-1']).toEqual({
      path: 'images/task-task-1-input.png',
      createdAt: 1700000000000,
      source: 'generated',
      width: 32,
      height: 24,
    })
    expect(parsed.manifest.imageFiles?.['img-2']?.path).toBe('images/task-task-1.png')
    expect(parsed.manifest.imageFiles?.['img-3']?.path).toBe('images/task-task-1-partial.png')
    expect(parsed.manifest.thumbnailFiles?.['img-1']).toEqual({
      path: 'thumbnails/task-task-1-input.jpeg',
      width: 32,
      height: 24,
      thumbnailVersion: 2,
    })
    expect(readExportZipFileAsDataUrl(parsed.files, 'images/task-task-1-input.png')).toBe(images[0].dataUrl)
    expect(readExportZipFileAsDataUrl(parsed.files, 'images/task-task-1.png')).toBe(images[1].dataUrl)
    expect(readExportZipFileAsDataUrl(parsed.files, 'images/task-task-1-partial.png')).toBe(images[2].dataUrl)
    expect(readExportZipFileAsDataUrl(parsed.files, 'thumbnails/task-task-1-input.jpeg')).toBe(thumbnail.thumbnailDataUrl)
  })

  it('splits all stored images without dropping images that are not referenced by tasks', async () => {
    const task: TaskRecord = {
      id: 'task-1',
      prompt: '提示词',
      params: {} as TaskParams,
      inputImageIds: [],
      outputImages: ['img-1'],
      status: 'done',
      error: null,
      createdAt: 1700000000000,
      finishedAt: 1700000000001,
      elapsed: 1,
    }
    const images: StoredImage[] = [
      { id: 'img-1', dataUrl: `data:image/png;base64,${'A'.repeat(600_000)}` },
      { id: 'agent-only-image', dataUrl: `data:image/png;base64,${'A'.repeat(600_000)}` },
    ]
    const params = {
      options: { exportConfig: true, exportTasks: true },
      exportedAt: 1700000001000,
      settings: {} as AppSettings,
      tasks: [task],
      images,
      thumbnailsByImageId: new Map(),
      favoriteCollections: [],
      defaultFavoriteCollectionId: null,
      agentConversations: [],
    }
    const plan = getExportZipPlan(
      params,
      images.map((image) => ({ id: image.id, bytes: getExportImageEstimatedBytes(image) })),
      { maxBytes: 1_800_000, partBytes: 1_400_000 },
    )

    expect(plan.length).toBeGreaterThan(1)
    const manifests = await Promise.all(plan.map(async (part, index) => {
      const imageIds = new Set(part.imageIds)
      return (await buildExportZip({
        ...params,
        tasks: part.tasks,
        agentConversations: part.agentConversations,
        imageTasks: [task],
        images: images.filter((image) => imageIds.has(image.id)),
        includeManifestData: part.includeBaseData,
        backupPart: { id: '1700000001000', index: index + 1, total: plan.length },
      })).manifest
    }))
    expect(manifests[0].backupPart).toEqual({ id: '1700000001000', index: 1, total: plan.length })
    expect(manifests[0].tasks).toEqual([task])
    expect(manifests[1].tasks).toBeUndefined()
    expect(manifests.flatMap((manifest) => Object.keys(manifest.imageFiles ?? {})).sort()).toEqual(['agent-only-image', 'img-1'])
    expect(manifests.find((manifest) => manifest.imageFiles?.['img-1'])?.imageFiles?.['img-1']).toMatchObject({
      path: 'images/task-task-1.png',
      createdAt: 1700000000000,
    })
  })

  it('splits task metadata across parts instead of requiring it to fit in the first part', () => {
    const tasks = ['task-1', 'task-2'].map((id, index): TaskRecord => ({
      id,
      prompt: '提示词',
      params: {} as TaskParams,
      inputImageIds: [],
      outputImages: [],
      rawResponsePayload: 'x'.repeat(600_000),
      status: 'error',
      error: '失败',
      createdAt: 1700000000000 + index,
      finishedAt: 1700000000001 + index,
      elapsed: 1,
    }))
    const params = {
      options: { exportConfig: true, exportTasks: true },
      exportedAt: 1700000001000,
      settings: {} as AppSettings,
      tasks,
      images: [],
      thumbnailsByImageId: new Map(),
      favoriteCollections: [],
      defaultFavoriteCollectionId: null,
      agentConversations: [],
    }
    const plan = getExportZipPlan(params, [], { maxBytes: 1_800_000, partBytes: 1_400_000 })

    expect(plan.length).toBeGreaterThan(1)
    expect(plan.flatMap((part) => part.tasks).map((task) => task.id)).toEqual(['task-1', 'task-2'])
  })

  it('always keeps config-only exports in one part', () => {
    const plan = getExportZipPlan({
      options: { exportConfig: true, exportTasks: false },
      exportedAt: 1700000001000,
      settings: { largeConfig: 'x'.repeat(600_000) } as unknown as AppSettings,
      tasks: [{
        id: 'ignored-task',
        prompt: 'prompt',
        params: {} as TaskParams,
        inputImageIds: [],
        outputImages: [],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
        elapsed: 1,
      }],
      favoriteCollections: [],
      defaultFavoriteCollectionId: null,
      agentConversations: [{
        id: 'ignored-conversation',
        title: 'x'.repeat(600_000),
        createdAt: 1,
        updatedAt: 1,
        rounds: [],
        messages: [],
      }],
    }, [{ id: 'ignored-image', bytes: 2_000_000 }], { maxBytes: 1_800_000, partBytes: 1_400_000 })

    expect(plan).toEqual([{ imageIds: [], tasks: [], agentConversations: [], includeBaseData: true }])
  })

})
