import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import type { TaskParams, TaskRecord } from '../types'
import {
  normalizeActualParams,
  normalizeTaskImageMetadata,
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

  it('measures a retried attempt from its latest start without changing creation time', () => {
    const source = task({ createdAt: 1_000, startedAt: 7_000 })
    expect(createTaskDonePatch(source, 10_000).elapsed).toBe(3_000)
    expect(createTaskErrorPatch(source, '失败', 10_000).elapsed).toBe(3_000)
    expect(markInterruptedOpenAIRunningTasks([{ ...source, status: 'running' }], 10_000).tasks[0].elapsed).toBe(3_000)
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
  it('清理尺寸类响应字段，保留请求参数和其他响应属性', () => {
    const source = task({
      outputImages: ['a', 'b'],
      actualParams: { size: '2K', aspect_ratio: '1:1', resolution: '2K', quality: 'high' },
      actualParamsByImage: { a: { size: '1024x1024' }, b: { resolution: '1K', output_format: 'png' } },
    })
    const result = normalizeTaskImageMetadata(source)
    expect(result.actualParams).toEqual({ quality: 'high' })
    expect(result.actualParamsByImage).toEqual({ b: { output_format: 'png' } })
    expect(result.params).toBe(source.params)
    expect(source.actualParams?.size).toBe('2K')
    expect(normalizeTaskImageMetadata(result)).toBe(result)
    expect(normalizeActualParams({ size: '2K' })).toBeUndefined()
  })

  it('清理不属于剩余输出的逐图参数和提示词，保留同图的其他槽位', () => {
    const source = task({
      outputImages: ['a', 'a'],
      actualParamsByImage: { a: { quality: 'high' }, deleted: { quality: 'low' } },
      revisedPromptByImage: { a: 'A', deleted: 'Deleted' },
    })
    const result = normalizeTaskImageMetadata(source)
    expect(result.actualParamsByImage).toEqual({ a: { quality: 'high' } })
    expect(result.revisedPromptByImage).toEqual({ a: 'A' })
    expect(normalizeTaskImageMetadata(result)).toBe(result)
    expect(source.revisedPromptByImage?.deleted).toBe('Deleted')
  })

  it('maps only non-empty actual params to matching output ids', () => {
    const paramsList: Array<Partial<TaskParams> | undefined> = [undefined, {}, { size: '1024x1024', quality: 'high' }, { output_format: 'webp' }]

    expect(firstActualParams(paramsList)).toEqual({ quality: 'high' })
    expect(mapActualParamsByImage(['image-a', 'image-b', 'image-c'], paramsList)).toEqual({
      'image-c': { quality: 'high' },
    })
  })

  it('derives Agent single-image params with a fixed output count', () => {
    expect(deriveAgentImageActualParams({ output_format: 'webp' })).toEqual({
      output_format: 'webp',
      n: 1,
    })
    expect(deriveAgentImageActualParams({ size: '1024x1024' })).toEqual({
      n: 1,
    })
  })

  it('keeps fal and async custom params per image while deriving gallery totals for other providers', () => {
    const paramsList: Array<Partial<TaskParams>> = [{ output_format: 'png', size: '1254x1254' }]

    expect(deriveGalleryActualParams('fal', false, { n: 8 }, paramsList, 1)).toEqual({ output_format: 'png' })
    expect(deriveGalleryActualParams('custom-provider', true, { n: 8 }, paramsList, 1)).toEqual({ output_format: 'png' })
    expect(deriveGalleryActualParams('openai', false, { output_format: 'png' }, paramsList, 2)).toEqual({
      output_format: 'png',
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
