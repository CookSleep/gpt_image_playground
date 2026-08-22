import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInputDraft, AgentRound } from '../types'
import { getSelectedImageMentionLabel } from './promptImageMentions'
import {
  cleanStaleAgentInputDrafts,
  getPersistableAgentInputDrafts,
  normalizeAgentInputDraft,
  normalizeAgentInputDrafts,
  normalizeAgentInputDraftsByKey,
  remapAgentInputDraftMentionsForPathChange,
  restoreAgentInputDraftState,
  restoreGalleryInputDraftState,
  saveActiveAgentInputDrafts,
  saveGalleryInputDraft,
  syncActiveInputDraft,
  updateInputDraftImages,
} from './inputDraftState'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('input draft normalization', () => {
  it('normalizes old external data and rejects invalid image and mask fields', () => {
    vi.spyOn(Date, 'now').mockReturnValue(90)

    expect(normalizeAgentInputDraft({
      prompt: 123,
      inputImages: [
        imageA,
        { id: 'image-b', dataUrl: 123 },
        { id: 123, dataUrl: 'invalid' },
        null,
      ],
      maskDraft: { targetImageId: 'image-a', maskDataUrl: 123, updatedAt: 5 },
      maskEditorImageId: 123,
      updatedAt: Number.NaN,
    }, 50)).toEqual({
      prompt: '',
      inputImages: [imageA, { id: 'image-b', dataUrl: '' }],
      maskDraft: null,
      maskEditorImageId: null,
      updatedAt: 50,
    })

    expect(normalizeAgentInputDraft({
      prompt: '旧草稿',
      maskDraft: { targetImageId: 'image-a', maskDataUrl: 'data:image/png;base64,mask' },
    }, 50)).toMatchObject({
      prompt: '旧草稿',
      maskDraft: {
        targetImageId: 'image-a',
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 90,
      },
      updatedAt: 50,
    })
  })

  it('filters drafts by known conversations while retaining keyed legacy drafts when conversations are external', () => {
    const value = {
      known: { prompt: '保留', inputImages: [], updatedAt: 1 },
      missing: { prompt: '仅旧数据路径保留', inputImages: [], updatedAt: 2 },
      empty: { prompt: '', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: 3 },
    }

    expect(Object.keys(normalizeAgentInputDrafts(value, [{ id: 'known' }, { id: 'empty' }]))).toEqual(['known'])
    expect(Object.keys(normalizeAgentInputDraftsByKey(value))).toEqual(['known', 'missing'])
  })

  it('normalizes legacy top-level input used by the Agent draft fallback', () => {
    expect(normalizeAgentInputDraft({
      prompt: '旧版 Agent 顶层草稿',
      inputImages: [{ id: imageA.id, dataUrl: '' }],
      maskDraft: null,
      maskEditorImageId: null,
    }, 50)).toEqual({
      prompt: '旧版 Agent 顶层草稿',
      inputImages: [{ id: imageA.id, dataUrl: '' }],
      maskDraft: null,
      maskEditorImageId: null,
      updatedAt: 50,
    })
  })
})

describe('input draft mode and conversation transforms', () => {
  it('keeps gallery and agent drafts isolated across mode saves and restores', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const galleryDraft = saveGalleryInputDraft({
      appMode: 'gallery',
      galleryInputDraft: null,
      prompt: '画廊草稿',
      inputImages: [imageA],
      maskDraft: null,
      maskEditorImageId: null,
    })
    const existingAgentDraft: AgentInputDraft = {
      prompt: 'Agent 草稿',
      inputImages: [imageB],
      maskDraft: null,
      maskEditorImageId: null,
      updatedAt: 20,
    }
    const agentDrafts = saveActiveAgentInputDrafts({
      appMode: 'agent',
      activeAgentConversationId: 'conversation-a',
      agentInputDrafts: { 'conversation-b': existingAgentDraft },
      prompt: '当前 Agent 草稿',
      inputImages: [imageA],
      maskDraft: null,
      maskEditorImageId: imageA.id,
    })

    expect(galleryDraft).toMatchObject({ prompt: '画廊草稿', inputImages: [imageA], updatedAt: 100 })
    expect(agentDrafts['conversation-a']).toMatchObject({
      prompt: '当前 Agent 草稿',
      inputImages: [imageA],
      maskEditorImageId: imageA.id,
      updatedAt: 100,
    })
    expect(agentDrafts['conversation-b']).toBe(existingAgentDraft)
    expect(restoreGalleryInputDraftState(galleryDraft)).toMatchObject({ prompt: '画廊草稿', inputImages: [imageA] })
    expect(restoreAgentInputDraftState(agentDrafts, 'conversation-b')).toMatchObject({ prompt: 'Agent 草稿', inputImages: [imageB] })
    expect(restoreAgentInputDraftState(agentDrafts, null)).toEqual({
      prompt: '',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
    })
  })

  it('syncs only the draft belonging to the active mode', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const base = {
      activeAgentConversationId: 'conversation-a',
      agentInputDrafts: {},
      galleryInputDraft: null,
      prompt: '',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
    }

    const gallery = syncActiveInputDraft({ ...base, appMode: 'gallery' }, { prompt: '画廊' })
    const agent = syncActiveInputDraft({ ...base, appMode: 'agent' }, { prompt: 'Agent' })

    expect(gallery.galleryInputDraft).toMatchObject({ prompt: '画廊', updatedAt: 100 })
    expect(gallery).not.toHaveProperty('agentInputDrafts')
    expect(agent.agentInputDrafts?.['conversation-a']).toMatchObject({ prompt: 'Agent', updatedAt: 100 })
    expect(agent).not.toHaveProperty('galleryInputDraft')
  })
})

describe('input draft image and mention transforms', () => {
  it('renumbers retained image mentions and clears a mask whose target was removed', () => {
    const draft: AgentInputDraft = {
      prompt: `保留 ${getSelectedImageMentionLabel(1)}，删除 ${getSelectedImageMentionLabel(0)}`,
      inputImages: [imageA, imageB],
      maskDraft: {
        targetImageId: imageA.id,
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
      maskEditorImageId: imageA.id,
      updatedAt: 2,
    }

    expect({ ...draft, ...updateInputDraftImages(draft, [imageB]) }).toEqual({
      prompt: `保留 ${getSelectedImageMentionLabel(0)}，删除 @已移除图片`,
      inputImages: [imageB],
      maskDraft: null,
      maskEditorImageId: null,
      updatedAt: 2,
    })
  })

  it('preserves mention position when an image id is replaced by an equivalent image', () => {
    const draft: AgentInputDraft = {
      prompt: `修改 ${getSelectedImageMentionLabel(0)}`,
      inputImages: [imageA],
      maskDraft: null,
      maskEditorImageId: null,
    }

    expect(updateInputDraftImages(draft, [imageB], { equivalentImageIds: { [imageA.id]: imageB.id } })).toMatchObject({
      prompt: `修改 ${getSelectedImageMentionLabel(0)}`,
      inputImages: [imageB],
    })
  })

  it('cleans deleted-round mentions without changing draft metadata', () => {
    const roundA = { id: 'round-a', index: 1 } as AgentRound
    const roundB = { id: 'round-b', index: 2 } as AgentRound
    const draft: AgentInputDraft = {
      prompt: '参考 @第1轮图1 和 @第2轮图1',
      inputImages: [imageA],
      maskDraft: null,
      maskEditorImageId: null,
      updatedAt: 20,
    }

    const drafts = remapAgentInputDraftMentionsForPathChange(
      { 'conversation-a': draft },
      'conversation-a',
      [roundA, roundB],
      [roundB],
    )

    expect(drafts['conversation-a']).toEqual({
      ...draft,
      prompt: '参考 @已删除轮次图1 和 @第1轮图1',
    })
  })
})

describe('input draft persistence transforms', () => {
  it('filters stale drafts but always retains the active conversation', () => {
    const now = 10 * 24 * 60 * 60 * 1000
    const cutoff = now - 3 * 24 * 60 * 60 * 1000
    const activeDraft = { prompt: 'active', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: cutoff - 1 }
    const staleDraft = { prompt: 'stale', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: cutoff - 1 }
    const recentDraft = { prompt: 'recent', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: cutoff }

    expect(cleanStaleAgentInputDrafts({ active: activeDraft, stale: staleDraft, recent: recentDraft }, 'active', now)).toEqual({
      active: activeDraft,
      recent: recentDraft,
    })
  })

  it('keeps known non-empty drafts and strips image payloads from persisted data', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const persisted = getPersistableAgentInputDrafts({
      appMode: 'agent',
      activeAgentConversationId: 'active',
      agentConversations: [{ id: 'active' }, { id: 'saved' }, { id: 'empty' }],
      agentInputDrafts: {
        saved: {
          prompt: '已保存',
          inputImages: [imageB],
          maskDraft: null,
          maskEditorImageId: null,
          updatedAt: 20,
        },
        orphan: {
          prompt: '孤立',
          inputImages: [imageA],
          maskDraft: null,
          maskEditorImageId: null,
          updatedAt: 30,
        },
        empty: {
          prompt: '',
          inputImages: [],
          maskDraft: null,
          maskEditorImageId: null,
          updatedAt: 40,
        },
      },
      prompt: '当前输入',
      inputImages: [imageA],
      maskDraft: null,
      maskEditorImageId: null,
    })

    expect(persisted).toEqual({
      active: {
        prompt: '当前输入',
        inputImages: [{ id: imageA.id, dataUrl: '' }],
        maskDraft: null,
        maskEditorImageId: null,
        updatedAt: 100,
      },
      saved: {
        prompt: '已保存',
        inputImages: [{ id: imageB.id, dataUrl: '' }],
        maskDraft: null,
        maskEditorImageId: null,
        updatedAt: 20,
      },
    })
  })
})
