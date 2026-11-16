import { describe, expect, it } from 'vitest'
import type { AgentConversation, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { createPrivacyModeState, getPrivacySnapshotImageIds, isPrivacyHiddenConversation, isPrivacyHiddenTask, restorePrivacyInputState } from './privacyMode'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return { id: 'c', title: '新对话', activeRoundId: null, createdAt: 1, updatedAt: 1, rounds: [], messages: [], ...overrides }
}

function sourceState() {
  return {
    appMode: 'gallery' as const,
    prompt: 'secret',
    inputImages: [imageA],
    maskDraft: null,
    maskEditorImageId: 'image-a',
    galleryInputDraft: null,
    agentInputDrafts: { 'c-old': { prompt: 'agent', inputImages: [imageB], maskDraft: null, maskEditorImageId: null, updatedAt: 1 } },
    activeAgentConversationId: 'c-old',
    reusedTaskApiProfileId: 'profile',
    reusedTaskApiProfileName: '配置',
    reusedTaskApiProfileMissing: false,
    reusedTaskApiModel: null,
    tasks: [task({ id: 'old', createdAt: 100 })],
    batchProgress: { total: 5, started: 2, finished: 1 },
    agentConversations: [
      conversation({ id: 'c-old', createdAt: 50, messages: [{ id: 'm', role: 'user', content: 'hi', roundId: 'r', createdAt: 50 }] }),
      conversation({ id: 'c-empty', createdAt: 60 }),
    ],
  }
}

describe('privacy mode visibility', () => {
  const privacy = createPrivacyModeState(sourceState(), 100)

  it('快照保留当前输入和草稿中的标注图引用', () => {
    const source = sourceState()
    const snapshot = createPrivacyModeState({
      ...source,
      inputImages: [{ ...imageA, markupImageId: 'markup-a' }],
      agentInputDrafts: { 'c-old': { ...source.agentInputDrafts['c-old'], inputImages: [{ ...imageB, markupImageId: 'markup-b' }] } },
    }, 100)
    expect(getPrivacySnapshotImageIds(snapshot)).toEqual(['image-a', 'markup-a', 'image-b', 'markup-b'])
  })

  it('hides nothing when privacy mode is off', () => {
    expect(isPrivacyHiddenTask(null, task())).toBe(false)
    expect(isPrivacyHiddenConversation(null, conversation())).toBe(false)
  })

  it('hides tasks created before entry and tasks of conversations that had content', () => {
    const visible = [
      task({ id: 'old', createdAt: 100 }),
      task({ id: 'imported', createdAt: 10 }),
      task({ id: 'new', createdAt: 200 }),
      task({ id: 'old-round', createdAt: 200, agentConversationId: 'c-old' }),
      task({ id: 'new-round', createdAt: 200, agentConversationId: 'c-new' }),
    ].filter((item) => !isPrivacyHiddenTask(privacy, item))
    expect(visible.map((item) => item.id)).toEqual(['new', 'new-round'])
  })

  it('hides old conversations but shows an empty one once it is reused with a new creation time', () => {
    const visible = [
      conversation({ id: 'c-old', createdAt: 50 }),
      conversation({ id: 'c-empty', createdAt: 60 }),
      conversation({ id: 'c-reused', createdAt: 150 }),
    ].filter((item) => !isPrivacyHiddenConversation(privacy, item))
    expect(visible.map((item) => item.id)).toEqual(['c-reused'])
    expect(privacy.hiddenConversationIds.has('c-empty')).toBe(false)
  })

  it('records the batch prompts that were not submitted', () => {
    expect(privacy.stoppedBatchPrompts).toBe(3)
  })

  it('keeps snapshot images referenced', () => {
    expect(getPrivacySnapshotImageIds(privacy)).toEqual(['image-a', 'image-b'])
    expect(getPrivacySnapshotImageIds(null)).toEqual([])
  })
})

describe('restorePrivacyInputState', () => {
  const privacy = createPrivacyModeState(sourceState(), 100)

  it('restores the gallery input without reopening the mask editor', () => {
    const restored = restorePrivacyInputState(privacy.inputSnapshot, { appMode: 'gallery', activeAgentConversationId: 'c-new' })
    expect(restored).toMatchObject({
      prompt: 'secret',
      inputImages: [imageA],
      maskEditorImageId: null,
      reusedTaskApiProfileId: 'profile',
    })
    expect(restored.galleryInputDraft?.prompt).toBe('secret')
    expect(Object.keys(restored.agentInputDrafts)).toEqual(['c-old'])
  })

  it('shows the draft of the current agent conversation when exiting in agent mode', () => {
    const restored = restorePrivacyInputState(privacy.inputSnapshot, { appMode: 'agent', activeAgentConversationId: 'c-new' })
    expect(restored.prompt).toBe('')
    expect(restored.galleryInputDraft?.prompt).toBe('secret')
  })
})
