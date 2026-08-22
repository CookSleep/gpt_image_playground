import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import type { TaskParams, TaskRecord } from '../types'
import {
  addImageSizeParam,
  createTaskDonePatch,
  createTaskErrorPatch,
  deriveAgentImageActualParams,
  deriveGalleryActualParams,
  firstActualParams,
  mapActualParamsByImage,
  mapRevisedPromptsByImage,
  markInterruptedOpenAIRunningTasks,
} from './taskState'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

describe('task lifecycle patches', () => {
  it('derives done and error terminal fields from the caller time', () => {
    const source = task({ createdAt: 1_000 })

    expect(createTaskDonePatch(source, 4_000)).toEqual({
      status: 'done',
      error: null,
      finishedAt: 4_000,
      elapsed: 3_000,
    })
    expect(createTaskErrorPatch(source, '失败', 4_000)).toEqual({
      status: 'error',
      error: '失败',
      finishedAt: 4_000,
      elapsed: 3_000,
    })
  })

  it('marks legacy and OpenAI running tasks as interrupted', () => {
    const now = 10_000
    const legacyRunning = task({ id: 'legacy-running', status: 'running', createdAt: 1_000, finishedAt: null, elapsed: null })
    const openAIRunning = task({ id: 'openai-running', apiProvider: 'openai', status: 'running', createdAt: 2_000, finishedAt: null, elapsed: null })
    const falRunning = task({ id: 'fal-running', apiProvider: 'fal', status: 'running', createdAt: 3_000, finishedAt: null, elapsed: null })
    const customAsyncRunning = task({ id: 'custom-running', apiProvider: 'custom-provider', customTaskId: 'task-1', status: 'running', createdAt: 4_000, finishedAt: null, elapsed: null })
    const customSyncRunning = task({ id: 'custom-sync-running', apiProvider: 'custom-provider', status: 'running', createdAt: 5_000, finishedAt: null, elapsed: null })
    const doneTask = task({ id: 'done-task', apiProvider: 'openai', status: 'done' })

    const result = markInterruptedOpenAIRunningTasks([legacyRunning, openAIRunning, falRunning, customAsyncRunning, customSyncRunning, doneTask], now)

    expect(result.interruptedTasks.map((item) => item.id)).toEqual(['legacy-running', 'openai-running', 'custom-sync-running'])
    expect(result.tasks.find((item) => item.id === 'legacy-running')).toMatchObject({
      status: 'error',
      error: '请求中断',
      finishedAt: now,
      elapsed: 9_000,
    })
    expect(result.tasks.find((item) => item.id === 'openai-running')).toMatchObject({
      status: 'error',
      error: '请求中断',
      finishedAt: now,
      elapsed: 8_000,
    })
    expect(result.tasks.find((item) => item.id === 'fal-running')).toEqual(falRunning)
    expect(result.tasks.find((item) => item.id === 'custom-running')).toEqual(customAsyncRunning)
    expect(result.tasks.find((item) => item.id === 'custom-sync-running')).toMatchObject({ status: 'error', error: '请求中断' })
    expect(result.tasks.find((item) => item.id === 'done-task')).toEqual(doneTask)
  })
})

describe('task actual params', () => {
  it('fills missing sizes without overriding API-returned sizes', () => {
    expect(addImageSizeParam({ output_format: 'png' }, { width: 1254, height: 1254 })).toEqual({
      output_format: 'png',
      size: '1254x1254',
    })
    expect(addImageSizeParam({ size: '1024x1024' }, { width: 1254, height: 1254 })).toEqual({ size: '1024x1024' })
    expect(addImageSizeParam(undefined, { width: 0, height: 1254 })).toBeUndefined()
  })

  it('maps only non-empty actual params to matching output ids', () => {
    const paramsList: Array<Partial<TaskParams> | undefined> = [undefined, {}, { size: '1024x1024' }, { output_format: 'webp' }]

    expect(firstActualParams(paramsList)).toEqual({ size: '1024x1024' })
    expect(mapActualParamsByImage(['image-a', 'image-b', 'image-c'], paramsList)).toEqual({
      'image-c': { size: '1024x1024' },
    })
  })

  it('derives Agent single-image params with a fixed output count', () => {
    expect(deriveAgentImageActualParams({ output_format: 'webp' }, { width: 1536, height: 1024 })).toEqual({
      output_format: 'webp',
      size: '1536x1024',
      n: 1,
    })
    expect(deriveAgentImageActualParams({ size: '1024x1024' }, { width: 1536, height: 1024 })).toEqual({
      size: '1024x1024',
      n: 1,
    })
  })

  it('keeps fal and async custom params per image while deriving gallery totals for other providers', () => {
    const paramsList: Array<Partial<TaskParams>> = [{ output_format: 'png', size: '1254x1254' }]

    expect(deriveGalleryActualParams('fal', false, { n: 8 }, paramsList, 1)).toEqual(paramsList[0])
    expect(deriveGalleryActualParams('custom-provider', true, { n: 8 }, paramsList, 1)).toEqual(paramsList[0])
    expect(deriveGalleryActualParams('openai', false, { output_format: 'png' }, paramsList, 2)).toEqual({
      output_format: 'png',
      size: '1254x1254',
      n: 2,
    })
  })

  it('maps only non-blank revised prompts without trimming stored values', () => {
    expect(mapRevisedPromptsByImage(['image-a', 'image-b', 'image-c'], [' revised ', ' ', undefined])).toEqual({
      'image-a': ' revised ',
    })
    expect(mapRevisedPromptsByImage(['image-a'], [])).toBeUndefined()
  })
})
