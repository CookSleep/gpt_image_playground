import { describe, expect, it } from 'vitest'
import type { AgentRound, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { getSelectedImageMentionLabel, getSelectedTextMentionLabel } from './promptImageMentions'
import { extractAgentReferenceIds, replaceAgentPromptImageReferencesForApi, resolveAgentPromptImageReferences } from './agentImageReferences'

const round = (patch: Partial<AgentRound>): AgentRound => ({
  id: patch.id ?? `round-${patch.index ?? 1}`,
  index: patch.index ?? 1,
  parentRoundId: patch.parentRoundId ?? null,
  userMessageId: patch.userMessageId ?? `user-${patch.index ?? 1}`,
  prompt: patch.prompt ?? '',
  inputImageIds: patch.inputImageIds ?? [],
  outputTaskIds: patch.outputTaskIds ?? [],
  status: patch.status ?? 'done',
  error: patch.error ?? null,
  createdAt: patch.createdAt ?? 1,
  finishedAt: patch.finishedAt ?? 2,
  ...(patch.assistantMessageId ? { assistantMessageId: patch.assistantMessageId } : {}),
})

const task = (id: string, outputImages: string[], outputImageSlots?: Array<string | null>): TaskRecord => ({
  id,
  prompt: 'prompt',
  params: { ...DEFAULT_PARAMS },
  inputImageIds: [],
  maskTargetImageId: null,
  maskImageId: null,
  outputImages,
  ...(outputImageSlots ? { outputImageSlots } : {}),
  status: 'done',
  error: null,
  createdAt: 1,
  finishedAt: 2,
  elapsed: 1,
})

describe('agent image references', () => {
  it('extracts generated and current input XML reference ids', () => {
    expect(extractAgentReferenceIds('参考 <ref id="round-1-image-2" /> 和 <ref id="round-3-reference-1" />')).toEqual([
      'round-1-image-2',
      'round-3-reference-1',
    ])
  })

  it('resolves previous round image references from visible text', () => {
    const rounds = [
      round({ index: 1, outputTaskIds: ['task-a'] }),
      round({ index: 2, outputTaskIds: ['task-b'] }),
    ]

    expect(resolveAgentPromptImageReferences('参考 @第1轮图2 和 @2轮图1', rounds, [
      task('task-a', ['image-a1', 'image-a2']),
      task('task-b', ['image-b1']),
    ])).toEqual(['image-a2', 'image-b1'])
  })

  it('keeps previous round image numbering stable after a task is removed', () => {
    const rounds = [round({ index: 1, outputTaskIds: ['task-deleted', 'task-live'] })]

    expect(resolveAgentPromptImageReferences('参考 @第1轮图1 和 @第1轮图2', rounds, [
      task('task-live', ['image-live']),
    ])).toEqual(['image-live'])
  })

  it('replaces current hidden mentions with current round reference tags', () => {
    const currentRound = round({ index: 3, inputImageIds: ['image-a', 'image-b'] })

    expect(replaceAgentPromptImageReferencesForApi(
      `把 ${getSelectedImageMentionLabel(1)} 变蓝`,
      currentRound,
      [currentRound],
      [],
    )).toBe('把 <ref id="round-3-reference-2" /> 变蓝')
  })

  it('replaces copied previous round references with current round reference tags', () => {
    const firstRound = round({ index: 1, outputTaskIds: ['task-a'] })
    const currentRound = round({ index: 2, inputImageIds: ['image-a2'] })

    expect(replaceAgentPromptImageReferencesForApi(
      '参考 @第1轮图2 生成',
      currentRound,
      [firstRound, currentRound],
      [task('task-a', ['image-a1', 'image-a2'])],
    )).toBe('参考 <ref id="round-2-reference-1" /> 生成')
  })

  it('replaces selected previous round reference capsules without leaking markers', () => {
    const firstRound = round({ index: 1, outputTaskIds: ['task-a'] })
    const currentRound = round({ index: 2, inputImageIds: ['image-a2'] })

    expect(replaceAgentPromptImageReferencesForApi(
      `参考 ${getSelectedTextMentionLabel('@第1轮图2')} 生成`,
      currentRound,
      [firstRound, currentRound],
      [task('task-a', ['image-a1', 'image-a2'])],
    )).toBe('参考 <ref id="round-2-reference-1" /> 生成')
  })

  it('falls back to generated round tags when previous images were not copied', () => {
    const firstRound = round({ index: 1, outputTaskIds: ['task-a'] })
    const currentRound = round({ index: 2, inputImageIds: [] })

    expect(replaceAgentPromptImageReferencesForApi(
      '参考 @1轮图1 生成',
      currentRound,
      [firstRound, currentRound],
      [task('task-a', ['image-a1'])],
    )).toBe('参考 <ref id="round-1-image-1" /> 生成')
  })

  it('replaces removed previous round references with removed_ref tags', () => {
    const firstRound = round({ index: 1, outputTaskIds: ['task-deleted', 'task-live'] })
    const currentRound = round({ index: 2, inputImageIds: [] })

    expect(replaceAgentPromptImageReferencesForApi(
      '参考 @1轮图1 和 @1轮图2 生成',
      currentRound,
      [firstRound, currentRound],
      [task('task-live', ['image-live'])],
    )).toBe('参考 <removed_ref id="round-1-image-1" /> 和 <ref id="round-1-image-2" /> 生成')
  })

  it('keeps later image references stable after deleting one output from a task', () => {
    const firstRound = round({ index: 1, outputTaskIds: ['task-a'] })
    const currentRound = round({ index: 2, inputImageIds: [] })
    const tasks = [task('task-a', ['image-a1', 'image-a3'], ['image-a1', null, 'image-a3'])]

    expect(resolveAgentPromptImageReferences('参考 @第1轮图2 和 @第1轮图3', [firstRound], tasks)).toEqual(['image-a3'])
    expect(replaceAgentPromptImageReferencesForApi(
      '参考 @第1轮图2 和 @第1轮图3 生成',
      currentRound,
      [firstRound, currentRound],
      tasks,
    )).toBe('参考 <removed_ref id="round-1-image-2" /> 和 <ref id="round-1-image-3" /> 生成')
  })
})
