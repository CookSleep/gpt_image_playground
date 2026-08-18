import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../types'
import { createLegacyProject } from './legacyProject'

const task = (createdAt: number, finishedAt: number): TaskRecord => ({
  id: String(createdAt),
  prompt: '',
  params: {
    size: 'auto',
    quality: 'auto',
    output_format: 'png',
    output_compression: null,
    moderation: 'auto',
    n: 1,
    transparent_output: false,
  },
  inputImageIds: [],
  outputImages: [],
  status: 'done',
  error: null,
  createdAt,
  finishedAt,
  elapsed: finishedAt - createdAt,
})

describe('createLegacyProject', () => {
  it('uses work creation times instead of recovery completion times', () => {
    const project = createLegacyProject([
      task(1_000, 2_000),
      task(3_000, 10_000),
    ], '__local_project__')

    expect(project).toMatchObject({
      createdAt: 1_000,
      updatedAt: 3_000,
    })
  })

  it('returns null without local work', () => {
    expect(createLegacyProject([], '__local_project__')).toBeNull()
  })
})
