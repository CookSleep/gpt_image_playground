import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import { getTaskOutputImageSlots, removeTaskOutputImage } from './singleImageOperations'

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'test',
    params: { ...DEFAULT_PARAMS, n: 3 },
    inputImageIds: [],
    outputImages: ['image-a', 'image-b', 'image-c'],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...patch,
  }
}

describe('single image operations', () => {
  it('removes one output while preserving stable Agent slots and siblings', () => {
    const result = removeTaskOutputImage(task({
      transparentOriginalImages: ['original-a', 'original-b', 'original-c'],
      actualParamsByImage: { 'image-a': { size: '1024x1024' }, 'image-b': { size: '1536x1024' } },
      revisedPromptByImage: { 'image-b': 'revised' },
      rawImageUrls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'],
    }), 'image-b')

    expect(result?.task.outputImages).toEqual(['image-a', 'image-c'])
    expect(result?.task.outputImageSlots).toEqual(['image-a', null, 'image-c'])
    expect(result?.task.transparentOriginalImages).toEqual(['original-a', 'original-c'])
    expect(result?.task.actualParamsByImage).toEqual({ 'image-a': { size: '1024x1024' } })
    expect(result?.task.revisedPromptByImage).toBeUndefined()
    expect(result?.task.rawImageUrls).toEqual(['https://example.com/a', 'https://example.com/c'])
    expect(result?.removedImageIds).toEqual(['image-b', 'original-b'])
  })

  it('keeps the parent task when deleting its last output', () => {
    const result = removeTaskOutputImage(task({ outputImages: ['image-a'] }), 'image-a')
    expect(result?.task.outputImages).toEqual([])
    expect(result?.task.outputImageSlots).toEqual([null])
    expect(result?.task.id).toBe('task-a')
  })

  it('reads legacy tasks without stable slots', () => {
    expect(getTaskOutputImageSlots(task())).toEqual(['image-a', 'image-b', 'image-c'])
  })

  it('does not shift failure indexes when persisted slots are malformed', () => {
    const result = removeTaskOutputImage(task({
      outputImageSlots: ['image-a'],
      outputErrors: [{ requestIndex: 2, error: 'failed' }],
    }), 'image-b')

    expect(result?.task.outputErrors).toEqual([{ requestIndex: 2, error: 'failed' }])
  })
})
