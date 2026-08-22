import { describe, expect, it } from 'vitest'
import type { AgentConversation, AppSettings, FavoriteCollection } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { DEFAULT_SETTINGS } from './apiProfiles'
import { DEFAULT_FAVORITE_COLLECTION_ID } from './favoriteState'
import { createPersistedState, mergePersistedAgentConversations, migratePersistedState, normalizePersistedState } from './persistedState'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,image-a' }
const collectionA: FavoriteCollection = { id: 'collection-a', name: '收藏夹 A', createdAt: 1, updatedAt: 1 }

function conversation(patch: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conversation-a',
    title: '对话 A',
    activeRoundId: null,
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
    ...patch,
  }
}

function source(settings: AppSettings = DEFAULT_SETTINGS) {
  return {
    settings,
    params: { ...DEFAULT_PARAMS },
    prompt: '画廊输入',
    inputImages: [imageA],
    maskDraft: null,
    maskEditorImageId: null,
    dismissedCodexCliPrompts: [],
    appMode: 'gallery' as const,
    galleryInputDraft: null,
    agentConversations: [conversation()],
    activeAgentConversationId: 'conversation-a',
    agentInputDrafts: {},
    agentSidebarCollapsed: true,
    agentAssetTab: 'outputs' as const,
    agentAssetPanelCollapsed: false,
    favoriteCollections: [collectionA],
    defaultFavoriteCollectionId: collectionA.id,
    supportPromptDismissed: false,
    supportPromptOpen: false,
    supportPromptSkippedForImportedData: false,
  }
}

function fallback() {
  return {
    settings: DEFAULT_SETTINGS,
    params: { ...DEFAULT_PARAMS },
    dismissedCodexCliPrompts: ['current'],
    agentConversations: [conversation({ id: 'indexed-conversation' })],
    favoriteCollections: [collectionA],
    defaultFavoriteCollectionId: collectionA.id,
  }
}

describe('persisted state codec', () => {
  it('rejects non-record unknown data and falls back field-by-field for an invalid record', () => {
    class ExternalState {}

    expect(normalizePersistedState(null, fallback(), 100)).toBeNull()
    expect(normalizePersistedState([], fallback(), 100)).toBeNull()
    expect(normalizePersistedState(new Date(), fallback(), 100)).toBeNull()
    expect(normalizePersistedState(new Map(), fallback(), 100)).toBeNull()
    expect(normalizePersistedState(new ExternalState(), fallback(), 100)).toBeNull()

    const result = normalizePersistedState({
      params: { quality: 'invalid', n: Number.NaN },
      dismissedCodexCliPrompts: 'invalid',
      favoriteCollections: 'invalid',
      appMode: 'invalid',
      setPrompt: 'external action must not escape the codec',
    }, fallback(), 100)!

    expect(result.state.params).toEqual(DEFAULT_PARAMS)
    expect(result.state.dismissedCodexCliPrompts).toEqual(['current'])
    expect(result.state.favoriteCollections).toEqual([collectionA])
    expect(result.state.agentConversations.map((item) => item.id)).toEqual(['indexed-conversation'])
    expect(result.state.appMode).toBe('gallery')
    expect(result.state).not.toHaveProperty('setPrompt')
  })

  it('migrates old Agent conversations without retaining generated image payloads', () => {
    const legacy = conversation({
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        prompt: '画一张图',
        inputImageIds: [],
        outputTaskIds: [],
        responseOutput: [
          { type: 'image_generation_call', id: 'image-call-a', result: 'legacy-base64-a' },
          { type: 'image_generation_call', id: 'image-call-b', result: { b64_json: 'legacy-base64-b', base64: 'legacy-base64-c' } },
        ],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
    })

    const migrated = migratePersistedState({ agentConversations: [legacy] }, 1)
    const serialized = JSON.stringify(migrated)
    expect(serialized).toContain('image_generation_call')
    expect(serialized).not.toContain('legacy-base64')
    expect(migratePersistedState('invalid', 1)).toBe('invalid')
  })

  it('normalizes legacy conversations, active ID, and top-level Agent draft fallback', () => {
    const result = normalizePersistedState({
      settings: DEFAULT_SETTINGS,
      appMode: 'agent',
      agentConversations: [{
        ...conversation(),
        rounds: [{
          id: 'round-a',
          userMessageId: 'user-a',
          prompt: '旧轮次',
          status: 'running',
        }],
      }],
      activeAgentConversationId: 'conversation-a',
      prompt: '旧版 Agent 草稿',
      inputImages: [imageA],
    }, fallback(), 100)!

    expect(result.hasLegacyAgentConversations).toBe(true)
    expect(result.shouldMigrateAgentConversations).toBe(true)
    expect(result.state.activeAgentConversationId).toBe('conversation-a')
    expect(result.state.agentConversations[0].rounds[0]).toMatchObject({ status: 'error', error: '上次请求已中断' })
    expect(result.state.agentInputDrafts['conversation-a']).toMatchObject({ prompt: '旧版 Agent 草稿', inputImages: [imageA] })
    expect(result.state.prompt).toBe('旧版 Agent 草稿')
  })

  it('persists gallery and Agent drafts only when input persistence is enabled', () => {
    const previousPresetConfig = {
      customProviders: [],
      profiles: [DEFAULT_SETTINGS.profiles[0]],
    }
    const enabled = createPersistedState({
      ...source(),
      previousPresetConfig,
      agentInputDrafts: {
        'conversation-a': {
          prompt: 'Agent 草稿',
          inputImages: [imageA],
          maskDraft: null,
          maskEditorImageId: null,
          updatedAt: 1,
        },
      },
    })
    const disabled = createPersistedState({
      ...source({ ...DEFAULT_SETTINGS, persistInputOnRestart: false }),
      appMode: 'agent',
      prompt: '不应持久化的可见 Agent 输入',
      agentInputDrafts: {
        'conversation-a': {
          prompt: '不应持久化的 Agent 草稿',
          inputImages: [imageA],
          maskDraft: null,
          maskEditorImageId: null,
        },
      },
    })
    const legacyConversation = conversation({
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        prompt: '旧轮次',
        inputImageIds: [],
        outputTaskIds: [],
        responseOutput: [{ type: 'image_generation_call', result: 'legacy-conversation-base64' }],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
    })
    const withLegacyConversation = createPersistedState({ ...source(), agentConversations: [legacyConversation] }, true)

    expect(enabled.prompt).toBe('画廊输入')
    expect(enabled.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
    expect(enabled.galleryInputDraft?.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
    expect(enabled.agentInputDrafts['conversation-a'].inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
    expect(enabled.previousPresetConfig).toEqual(previousPresetConfig)
    expect(disabled).not.toHaveProperty('prompt')
    expect(disabled).not.toHaveProperty('inputImages')
    expect(disabled.galleryInputDraft).toBeNull()
    expect(disabled.agentInputDrafts).toEqual({})
    expect(JSON.stringify(withLegacyConversation.agentConversations)).not.toContain('legacy-conversation-base64')
  })

  it('preserves an empty deployed profile snapshot when restoring persisted state', () => {
    const result = normalizePersistedState({
      previousPresetConfig: {
        customProviders: [{ id: 'provider-a', name: 'Provider A', submit: { path: 'generate' } }],
        profiles: [],
      },
    }, fallback())!

    expect(result.state.previousPresetConfig?.profiles).toEqual([])
    expect(result.state.previousPresetConfig?.customProviders).toEqual([
      expect.objectContaining({ id: 'provider-a' }),
    ])
  })

  it('does not restore Agent drafts or legacy top-level input when input persistence is disabled', () => {
    const result = normalizePersistedState({
      settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false },
      appMode: 'agent',
      activeAgentConversationId: 'indexed-conversation',
      prompt: '旧版顶层 Agent 输入',
      inputImages: [imageA],
      galleryInputDraft: { prompt: '画廊草稿', inputImages: [imageA] },
      agentInputDrafts: {
        'indexed-conversation': { prompt: 'Agent 草稿', inputImages: [imageA] },
      },
    }, fallback(), 100)!

    expect(result.state.activeAgentConversationId).toBe('indexed-conversation')
    expect(result.state.galleryInputDraft).toBeNull()
    expect(result.state.agentInputDrafts).toEqual({})
    expect(result.state.prompt).toBe('')
    expect(result.state.inputImages).toEqual([])
    expect(result.state.maskDraft).toBeNull()
    expect(result.state.maskEditorImageId).toBeNull()
  })

  it('filters malformed external response output before later payload stripping', () => {
    const result = normalizePersistedState({
      agentConversations: [{
        ...conversation(),
        activeRoundId: 'round-a',
        rounds: [{
          id: 'round-a',
          userMessageId: 'user-a',
          responseOutput: [
            null,
            [],
            'invalid',
            {},
            { type: '' },
            { type: 'message', content: 'invalid' },
            { type: 'message', content: [
              null,
              { type: 'output_text', text: 123 },
              { type: 'output_text', text: '安全文本' },
              { type: 'refusal', refusal: '拒绝文本' },
              { type: 'future_content_part', custom: true },
            ] },
            { type: 'function_call', call_id: 'bad-call', name: 'tool', arguments: null },
            { type: 'function_call_output', call_id: 'bad-call', output: null },
            { type: 'function_call', call_id: 'paired', name: 'tool', arguments: '{}' },
            { type: 'function_call_output', call_id: 'paired', output: '{}' },
            { type: 'function_call', call_id: 'content-output', name: 'tool', arguments: '{}' },
            { type: 'function_call_output', call_id: 'content-output', output: [
              { type: 'input_text', text: '数组工具输出' },
              { type: 'future_input_part', custom: true },
            ] },
            { type: 'future_response_item', custom: true },
            { type: 'image_generation_call', result: 'external-base64' },
            { type: 'image_generation_call', id: 'pending-image', result: null },
          ],
        }],
      }],
    }, fallback(), 100)!
    const encoded = createPersistedState({
      ...source(),
      agentConversations: result.state.agentConversations,
    }, true)

    expect(result.state.agentConversations[0].rounds[0].responseOutput).toEqual([
      { type: 'message', content: [
        { type: 'output_text', text: '安全文本' },
        { type: 'refusal', refusal: '拒绝文本' },
        { type: 'future_content_part', custom: true },
      ] },
      { type: 'function_call', call_id: 'paired', name: 'tool', arguments: '{}' },
      { type: 'function_call_output', call_id: 'paired', output: '{}' },
      { type: 'function_call', call_id: 'content-output', name: 'tool', arguments: '{}' },
      { type: 'function_call_output', call_id: 'content-output', output: [
        { type: 'input_text', text: '数组工具输出' },
        { type: 'future_input_part', custom: true },
      ] },
      { type: 'future_response_item', custom: true },
      { type: 'image_generation_call', result: 'external-base64' },
      { type: 'image_generation_call', id: 'pending-image', result: null },
    ])
    expect(JSON.stringify(encoded.agentConversations)).not.toContain('external-base64')
    expect(encoded.agentConversations?.[0].rounds[0].responseOutput).toContainEqual({
      type: 'function_call_output',
      call_id: 'content-output',
      output: [
        { type: 'input_text', text: '数组工具输出' },
        { type: 'future_input_part', custom: true },
      ],
    })
    expect(encoded.agentConversations?.[0].rounds[0].responseOutput).toContainEqual({ type: 'image_generation_call', id: 'pending-image', result: null })
  })

  it('restores old gallery and keyed Agent drafts while normalizing favorites and default ID', () => {
    const gallery = normalizePersistedState({
      settings: DEFAULT_SETTINGS,
      prompt: '旧画廊草稿',
      inputImages: [{ id: imageA.id, dataUrl: 123 }],
      favoriteCollections: [
        { id: '', name: '无效' },
        { id: 'collection-b', name: '  收藏夹 B  ', createdAt: 2, updatedAt: 3 },
      ],
      defaultFavoriteCollectionId: 'missing',
    }, fallback(), 100)!
    const agent = normalizePersistedState({
      settings: DEFAULT_SETTINGS,
      appMode: 'agent',
      activeAgentConversationId: 'indexed-conversation',
      agentInputDrafts: {
        'indexed-conversation': { prompt: 'IndexedDB 对话草稿', inputImages: [imageA], updatedAt: 1 },
        orphan: { prompt: '兼容保留的 keyed 草稿', inputImages: [], updatedAt: 1 },
      },
    }, fallback(), 100)!
    const emptyFavorites = normalizePersistedState({ favoriteCollections: [] }, fallback(), 100)!

    expect(gallery.state.galleryInputDraft).toMatchObject({ prompt: '旧画廊草稿', inputImages: [{ id: imageA.id, dataUrl: '' }] })
    expect(gallery.state.favoriteCollections).toEqual([{ id: 'collection-b', name: '收藏夹 B', createdAt: 2, updatedAt: 3 }])
    expect(gallery.state.defaultFavoriteCollectionId).toBe('collection-b')
    expect(agent.state.activeAgentConversationId).toBe('indexed-conversation')
    expect(agent.state.prompt).toBe('IndexedDB 对话草稿')
    expect(Object.keys(agent.state.agentInputDrafts)).toEqual(['indexed-conversation', 'orphan'])
    expect(emptyFavorites.state.favoriteCollections[0].id).toBe(DEFAULT_FAVORITE_COLLECTION_ID)
    expect(emptyFavorites.state.defaultFavoriteCollectionId).toBe(DEFAULT_FAVORITE_COLLECTION_ID)
  })

  it('plans legacy and IndexedDB conversation merging by freshness and creation order', () => {
    const merged = mergePersistedAgentConversations(
      [conversation({ id: 'same', createdAt: 2, updatedAt: 5, title: 'IndexedDB' })],
      [
        conversation({ id: 'same', createdAt: 2, updatedAt: 6, title: 'legacy' }),
        conversation({ id: 'first', createdAt: 1, updatedAt: 1 }),
      ],
    )

    expect(merged.map((item) => item.id)).toEqual(['first', 'same'])
    expect(merged[1].title).toBe('legacy')
  })
})
