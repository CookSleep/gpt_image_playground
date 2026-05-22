import { beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { DEFAULT_PARAMS } from './types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_RESPONSES_MODEL, DEFAULT_SETTINGS, normalizeSettings } from './lib/apiProfiles'
import type { AgentConversation, ExportData, StoredImage, StoredImageThumbnail, TaskRecord } from './types'
import { getSelectedImageMentionLabel } from './lib/promptImageMentions'
vi.mock('./lib/db', () => {
  const tasks = new Map<string, TaskRecord>()
  const images = new Map<string, StoredImage>()
  const thumbnails = new Map<string, StoredImageThumbnail>()
  const agentConversations = new Map<string, AgentConversation>()
  let imageSeq = 0

  return {
    CURRENT_THUMBNAIL_VERSION: 2,
    getAllTasks: async () => [...tasks.values()],
    putTask: async (task: TaskRecord) => {
      tasks.set(task.id, task)
      return task.id
    },
    deleteTask: async (id: string) => {
      tasks.delete(id)
    },
    clearTasks: async () => {
      tasks.clear()
    },
    getAllAgentConversations: async () => [...agentConversations.values()],
    putAgentConversation: async (conversation: AgentConversation) => {
      agentConversations.set(conversation.id, conversation)
      return conversation.id
    },
    deleteAgentConversation: async (id: string) => {
      agentConversations.delete(id)
    },
    clearAgentConversations: async () => {
      agentConversations.clear()
    },
    replaceAgentConversations: async (conversations: AgentConversation[]) => {
      agentConversations.clear()
      for (const conversation of conversations) agentConversations.set(conversation.id, conversation)
    },
    getImage: async (id: string) => images.get(id),
    getImageThumbnail: async (id: string) => thumbnails.get(id),
    getStoredFreshImageThumbnail: async (id: string) => thumbnails.get(id),
    getAllImageIds: async () => [...images.keys()],
    getAllImages: async () => [...images.values()],
    putImage: async (image: StoredImage) => {
      images.set(image.id, image)
      return image.id
    },
    putImageThumbnail: async (thumbnail: StoredImageThumbnail) => {
      thumbnails.set(thumbnail.id, thumbnail)
      return thumbnail.id
    },
    deleteImage: async (id: string) => {
      images.delete(id)
      thumbnails.delete(id)
    },
    clearImages: async () => {
      images.clear()
      thumbnails.clear()
    },
    storeImage: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++imageSeq}`
      images.set(id, { id, dataUrl, source, createdAt: Date.now() })
      return id
    },
  }
})
vi.mock('./lib/api', () => ({
  callImageApi: vi.fn(async () => ({
    images: [],
    actualParams: {},
    actualParamsList: [],
    revisedPrompts: [],
  })),
}))
vi.mock('./lib/agentApi', () => ({
  callAgentConversationTitleApi: vi.fn(async () => '标题'),
  callAgentResponsesApi: vi.fn(() => new Promise(() => {})),
  callBatchImageSingle: vi.fn(async (opts: { batchItemId: string; prompt: string }) => ({
    batchItemId: opts.batchItemId,
    image: { dataUrl: 'data:image/png;base64,batch-output', revisedPrompt: opts.prompt },
    error: null,
  })),
  parseBatchImageCallArguments: vi.fn((args: string) => {
    try {
      const parsed = JSON.parse(args) as { images?: Array<{ id?: string; prompt?: string }> }
      return parsed.images?.map((item, index) => ({
        id: item.id || `image_${index + 1}`,
        prompt: item.prompt || '',
      })) ?? null
    } catch {
      return null
    }
  }),
}))
vi.mock('./lib/agentImageSearch', () => ({
  searchAgentImages: vi.fn(async () => ({
    query: '春日影 人物',
    source: 'openverse',
    results: [{
      id: 'openverse:person-1',
      title: '春日影 人物参考图',
      imageUrl: 'https://example.com/person.png',
      thumbnailUrl: 'https://example.com/person-thumb.png',
      pageUrl: 'https://example.com/person',
      source: 'Openverse',
    }],
  })),
  fetchAgentImageAsDataUrl: vi.fn(async () => 'data:image/png;base64,reference-image'),
}))
import { clearAgentConversations, clearImages, getAllAgentConversations, getAllTasks, getImage, putAgentConversation, putImage, putTask as putDbTask } from './lib/db'
import { callAgentResponsesApi, callBatchImageSingle } from './lib/agentApi'
import { fetchAgentImageAsDataUrl, searchAgentImages } from './lib/agentImageSearch'
import { cleanStaleAgentInputDrafts, deleteAgentRoundFromConversation, deleteImageIfUnreferenced, editOutputs, getActiveAgentRounds, getErrorToastMessage, getPersistedState, getTaskApiProfile, importData, initStore, markInterruptedOpenAIRunningTasks, migratePersistedState, regenerateAgentAssistantMessage, remapAgentRoundMentionsForPathChange, removeTask, reuseConfig, submitAgentMessage, submitTask, useStore } from './store'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

describe('error toast messages', () => {
  it('drops long error detail after the failure title', () => {
    expect(getErrorToastMessage('Agent 请求失败：接口拒绝了很长的提示词内容')).toBe('Agent 请求失败')
  })

  it('uses a generic message for long raw errors without a title', () => {
    expect(getErrorToastMessage(`invalid request ${'x'.repeat(90)}`)).toBe('操作失败，请查看详情')
  })
})

function agentConversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conversation-a',
    title: '新对话',
    activeRoundId: null,
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
    ...overrides,
  }
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
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

function importFile(data: ExportData): File {
  const zipped = zipSync({ 'manifest.json': strToU8(JSON.stringify(data)) })
  const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength)
  return { arrayBuffer: async () => buffer } as File
}

describe('mask draft lifecycle in store actions', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: 'prompt',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      detailTaskId: null,
      lightboxImageId: null,
      lightboxImageList: [],
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('preserves an existing mask when quick edit-output adds outputs as references', async () => {
    const maskDraft = {
      targetImageId: imageA.id,
      maskDataUrl: 'data:image/png;base64,mask',
      updatedAt: 1,
    }
    useStore.setState({
      inputImages: [imageA],
      maskDraft,
    })

    await editOutputs(task({ outputImages: [imageA.id] }))

    expect(useStore.getState().maskDraft).toEqual(maskDraft)
  })

  it('clears an invalid mask draft when submit cannot find the mask target image', async () => {
    useStore.setState({
      inputImages: [imageA],
      maskDraft: {
        targetImageId: 'missing-image',
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
    })

    await submitTask()

    expect(useStore.getState().maskDraft).toBeNull()
  })

  it('shows a submitted toast after creating a gallery task', async () => {
    await submitTask()

    const state = useStore.getState()
    expect(state.tasks).toHaveLength(1)
    expect(state.showToast).toHaveBeenCalledWith('任务已提交', 'success')
  })

  it('preserves selected image mentions when replacing a mask target with an equivalent image id', () => {
    const replacement = { id: 'image-a-replacement', dataUrl: imageA.dataUrl }
    const prompt = `参考 ${getSelectedImageMentionLabel(0)} 生成`
    useStore.setState({
      prompt,
      inputImages: [imageA, imageB],
    })

    useStore.getState().setInputImages([replacement, imageB], {
      equivalentImageIds: { [imageA.id]: replacement.id },
    })

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([replacement.id, imageB.id])
    expect(state.prompt).toBe(prompt)
  })
})

describe('interrupted OpenAI running tasks', () => {
  it('marks legacy and OpenAI running tasks as interrupted', () => {
    const now = 10_000
    const legacyRunning = task({ id: 'legacy-running', status: 'running', createdAt: 1_000, finishedAt: null, elapsed: null })
    const openAIRunning = task({ id: 'openai-running', apiProvider: 'openai', status: 'running', createdAt: 2_000, finishedAt: null, elapsed: null })
    const falRunning = task({ id: 'fal-running', apiProvider: 'fal', status: 'running', createdAt: 3_000, finishedAt: null, elapsed: null })
    const customAsyncRunning = task({ id: 'custom-running', apiProvider: 'custom-provider', customTaskId: 'task-1', status: 'running', createdAt: 4_000, finishedAt: null, elapsed: null })
    const doneTask = task({ id: 'done-task', apiProvider: 'openai', status: 'done' })

    const result = markInterruptedOpenAIRunningTasks([legacyRunning, openAIRunning, falRunning, customAsyncRunning, doneTask], now)

    expect(result.interruptedTasks.map((item) => item.id)).toEqual(['legacy-running', 'openai-running'])
    expect(result.tasks.find((item) => item.id === 'legacy-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('请求中断'),
      finishedAt: now,
      elapsed: 9_000,
    })
    expect(result.tasks.find((item) => item.id === 'openai-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('请求中断'),
      finishedAt: now,
      elapsed: 8_000,
    })
    expect(result.tasks.find((item) => item.id === 'fal-running')).toEqual(falRunning)
    expect(result.tasks.find((item) => item.id === 'custom-running')).toEqual(customAsyncRunning)
    expect(result.tasks.find((item) => item.id === 'done-task')).toEqual(doneTask)
  })
})

describe('input persistence setting', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      appMode: 'gallery',
      prompt: 'prompt',
      inputImages: [imageA],
      galleryInputDraft: null,
      dismissedCodexCliPrompts: [],
    })
  })

  it('persists input when restart input restore is enabled', () => {
    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('prompt')
    expect(persisted.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
  })

  it('omits input when restart input restore is disabled', () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false } })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted).not.toHaveProperty('prompt')
    expect(persisted).not.toHaveProperty('inputImages')
  })

  it('writes empty input when persisted input is cleared', () => {
    useStore.setState({ prompt: '', inputImages: [] })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('')
    expect(persisted.inputImages).toEqual([])
  })
})

describe('agent conversation persistence', () => {
  beforeEach(async () => {
    await clearAgentConversations()
  })

  it('omits agent conversations from localStorage state', () => {
    const conversation = agentConversation({
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一张图',
        inputImageIds: [],
        outputTaskIds: ['task-a'],
        responseOutput: [
          { type: 'message', content: [{ type: 'output_text', text: '已生成图片。' }] },
          { type: 'image_generation_call', id: 'image-call-a', result: 'large-base64-a' },
          { type: 'image_generation_call', id: 'image-call-b', result: { b64_json: 'large-base64-b', base64: 'large-base64-c', image: 'large-base64-d', data: 'large-base64-e' } },
        ],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一张图', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '已生成图片。', roundId: 'round-a', outputTaskIds: ['task-a'], createdAt: 2 },
      ],
    })
    useStore.setState({ agentConversations: [conversation] })

    const persisted = getPersistedState(useStore.getState())
    const serializedPersisted = JSON.stringify(persisted)

    expect('agentConversations' in persisted).toBe(false)
    expect(serializedPersisted).not.toContain('image_generation_call')
    expect(serializedPersisted).not.toContain('large-base64')
    expect(JSON.stringify(useStore.getState().agentConversations)).toContain('large-base64-a')
  })

  it('loads agent conversations from IndexedDB and migrates legacy localStorage conversations', async () => {
    const storedConversation = agentConversation({ id: 'stored-conversation', createdAt: 1, updatedAt: 1 })
    const legacyConversation = agentConversation({ id: 'legacy-conversation', createdAt: 2, updatedAt: 2 })
    await putAgentConversation(storedConversation)
    useStore.setState({ agentConversations: [legacyConversation], activeAgentConversationId: legacyConversation.id })

    await initStore()

    const state = useStore.getState()
    const stored = await getAllAgentConversations()
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['stored-conversation', 'legacy-conversation'])
    expect(state.activeAgentConversationId).toBe('legacy-conversation')
    expect(stored.map((conversation) => conversation.id)).toEqual(['stored-conversation', 'legacy-conversation'])
  })

  it('keeps saved agent reference images during startup cleanup', async () => {
    await clearImages()
    await putImage({ id: 'saved-ref-image', dataUrl: imageA.dataUrl, source: 'upload', createdAt: 1 })
    await putImage({ id: 'orphan-image', dataUrl: imageB.dataUrl, source: 'upload', createdAt: 1 })
    await putAgentConversation(agentConversation({
      id: 'conversation-with-ref',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        prompt: '保存参考图',
        inputImageIds: [],
        outputTaskIds: [],
        savedReferenceImages: [{
          id: 'saved-ref-a',
          imageId: 'saved-ref-image',
          title: '参考图',
          sourceUrl: 'https://example.com/ref.png',
          createdAt: 1,
        }],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [{ id: 'user-a', role: 'user', content: '保存参考图', roundId: 'round-a', createdAt: 1 }],
    }))

    await initStore()

    expect(await getImage('saved-ref-image')).toBeTruthy()
    expect(await getImage('orphan-image')).toBeUndefined()
  })

  it('does not delete images referenced only by saved agent references', async () => {
    await clearImages()
    await putImage({ id: 'saved-ref-image', dataUrl: imageA.dataUrl, source: 'upload', createdAt: 1 })
    useStore.setState({
      inputImages: [],
      galleryInputDraft: null,
      agentInputDrafts: {},
      tasks: [],
      agentConversations: [agentConversation({
        rounds: [{
          id: 'round-a',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-a',
          prompt: '保存参考图',
          inputImageIds: [],
          outputTaskIds: [],
          savedReferenceImages: [{
            id: 'saved-ref-a',
            imageId: 'saved-ref-image',
            title: '参考图',
            sourceUrl: 'https://example.com/ref.png',
            createdAt: 1,
          }],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
      })],
    })

    await deleteImageIfUnreferenced('saved-ref-image')

    expect(await getImage('saved-ref-image')).toBeTruthy()
  })

  it('strips generated image payloads from legacy task raw payloads during startup migration', async () => {
    await putDbTask(task({
      id: 'legacy-task',
      outputImages: ['image-live'],
      rawResponsePayload: JSON.stringify({
        output: [{ type: 'image_generation_call', id: 'image-call-a', result: 'legacy-task-base64' }],
      }),
    }))

    await initStore()

    const storedTasks = await getAllTasks()
    const serializedStoredTasks = JSON.stringify(storedTasks)
    expect(serializedStoredTasks).toContain('image_generation_call')
    expect(serializedStoredTasks).not.toContain('legacy-task-base64')
  })

  it('keeps agent conversations created while initStore is loading', async () => {
    const legacyConversation = agentConversation({ id: 'legacy-conversation', createdAt: 1, updatedAt: 1 })
    const earlyConversation = agentConversation({ id: 'early-conversation', createdAt: 2, updatedAt: 2 })
    useStore.setState({ agentConversations: [legacyConversation], activeAgentConversationId: legacyConversation.id })

    const initPromise = initStore()
    useStore.setState({ agentConversations: [legacyConversation, earlyConversation], activeAgentConversationId: earlyConversation.id })
    await initPromise

    const state = useStore.getState()
    const stored = await getAllAgentConversations()
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['legacy-conversation', 'early-conversation'])
    expect(state.activeAgentConversationId).toBe('early-conversation')
    expect(stored.map((conversation) => conversation.id)).toEqual(['legacy-conversation', 'early-conversation'])
  })

  it('restores active conversation and draft when localStorage no longer stores conversations', async () => {
    const storedConversation = agentConversation({ id: 'stored-conversation', createdAt: 1, updatedAt: 1 })
    useStore.setState({
      appMode: 'agent',
      agentConversations: [],
      activeAgentConversationId: storedConversation.id,
      agentInputDrafts: {
        [storedConversation.id]: {
          prompt: '未发送草稿',
          inputImages: [],
          maskDraft: null,
          maskEditorImageId: null,
          updatedAt: Date.now(),
        },
      },
      prompt: '',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
    })
    await putAgentConversation(storedConversation)

    await initStore()

    const state = useStore.getState()
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['stored-conversation'])
    expect(state.activeAgentConversationId).toBe('stored-conversation')
    expect(state.agentInputDrafts['stored-conversation']?.prompt).toBe('未发送草稿')
    expect(state.prompt).toBe('未发送草稿')
  })

  it('strips generated image payloads when migrating old persisted state', () => {
    const migrated = migratePersistedState({
      settings: { ...DEFAULT_SETTINGS },
      agentConversations: [agentConversation({
        rounds: [{
          id: 'round-a',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-a',
          prompt: '画一张图',
          inputImageIds: [],
          outputTaskIds: ['task-a'],
          responseOutput: [
            { type: 'image_generation_call', id: 'image-call-a', result: 'legacy-base64-a' },
            { type: 'image_generation_call', id: 'image-call-b', result: { b64_json: 'legacy-base64-b', base64: 'legacy-base64-c' } },
          ],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
      })],
    })

    const serializedMigrated = JSON.stringify(migrated)
    expect(serializedMigrated).not.toContain('legacy-base64')
    expect(serializedMigrated).toContain('image_generation_call')
  })
})

describe('agent conversation creation', () => {
  beforeEach(() => {
    useStore.setState({
      agentConversations: [],
      activeAgentConversationId: null,
      agentSidebarCollapsed: false,
      agentEditingRoundId: null,
    })
  })

  it('refreshes the latest empty conversation instead of creating another one', () => {
    const olderEmpty = agentConversation({ id: 'older-empty', createdAt: 1_000, updatedAt: 1_000 })
    const latestEmpty = agentConversation({ id: 'latest-empty', createdAt: 2_000, updatedAt: 2_000 })
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000)
    useStore.setState({
      agentConversations: [olderEmpty, latestEmpty],
      activeAgentConversationId: olderEmpty.id,
      agentSidebarCollapsed: false,
      agentEditingRoundId: 'editing-round',
    })

    const id = useStore.getState().createAgentConversation()

    const state = useStore.getState()
    expect(id).toBe(latestEmpty.id)
    expect(state.activeAgentConversationId).toBe(latestEmpty.id)
    expect(state.agentConversations).toHaveLength(2)
    expect(state.agentConversations.find((item) => item.id === latestEmpty.id)).toMatchObject({
      createdAt: 3_000,
      updatedAt: 3_000,
    })
    expect(state.agentConversations.find((item) => item.id === olderEmpty.id)).toEqual(olderEmpty)
    expect(state.agentSidebarCollapsed).toBe(true)
    expect(state.agentEditingRoundId).toBeNull()
    now.mockRestore()
  })

  it('creates a new conversation when the latest conversation has messages', () => {
    const olderEmpty = agentConversation({ id: 'older-empty', createdAt: 1_000, updatedAt: 1_000 })
    const latestUsed = agentConversation({
      id: 'latest-used',
      activeRoundId: 'round-a',
      createdAt: 2_000,
      updatedAt: 2_000,
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'message-a',
        prompt: 'prompt',
        inputImageIds: [],
        outputTaskIds: [],
        status: 'done',
        error: null,
        createdAt: 2_000,
        finishedAt: 2_000,
      }],
      messages: [{ id: 'message-a', role: 'user', content: 'prompt', roundId: 'round-a', createdAt: 2_000 }],
    })
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000)
    useStore.setState({ agentConversations: [olderEmpty, latestUsed], activeAgentConversationId: latestUsed.id })

    const id = useStore.getState().createAgentConversation()

    const state = useStore.getState()
    expect(id).not.toBe(olderEmpty.id)
    expect(id).not.toBe(latestUsed.id)
    expect(state.agentConversations).toHaveLength(3)
    expect(state.agentConversations[state.agentConversations.length - 1]).toMatchObject({ id, createdAt: 3_000, updatedAt: 3_000, messages: [], rounds: [] })
    expect(state.activeAgentConversationId).toBe(id)
    now.mockRestore()
  })
})

describe('agent round deletion', () => {
  it('renumbers later rounds and remaps image mentions after deleting a middle round', () => {
    const conversation = agentConversation({
      activeRoundId: 'round-3',
      rounds: [
        {
          id: 'round-1',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
          prompt: '第一轮',
          inputImageIds: [],
          outputTaskIds: ['task-1'],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        },
        {
          id: 'round-2',
          index: 2,
          parentRoundId: 'round-1',
          userMessageId: 'user-2',
          assistantMessageId: 'assistant-2',
          prompt: '第二轮',
          inputImageIds: [],
          outputTaskIds: ['task-2'],
          status: 'done',
          error: null,
          createdAt: 3,
          finishedAt: 4,
        },
        {
          id: 'round-3',
          index: 3,
          parentRoundId: 'round-2',
          userMessageId: 'user-3',
          assistantMessageId: 'assistant-3',
          prompt: '第三轮',
          inputImageIds: [],
          outputTaskIds: ['task-3'],
          status: 'done',
          error: null,
          createdAt: 5,
          finishedAt: 6,
        },
      ],
      messages: [
        { id: 'user-1', role: 'user', content: '第一轮', roundId: 'round-1', createdAt: 1 },
        { id: 'assistant-1', role: 'assistant', content: '完成', roundId: 'round-1', createdAt: 2 },
        { id: 'user-2', role: 'user', content: '第二轮', roundId: 'round-2', createdAt: 3 },
        { id: 'assistant-2', role: 'assistant', content: '完成', roundId: 'round-2', createdAt: 4 },
        { id: 'user-3', role: 'user', content: '参考 @第1轮图1、@第2轮图1、@第3轮图1', roundId: 'round-3', createdAt: 5 },
        { id: 'assistant-3', role: 'assistant', content: '完成', roundId: 'round-3', createdAt: 6 },
      ],
    })

    const deleted = deleteAgentRoundFromConversation(conversation, 'round-2', 10)

    expect(deleted.rounds.map((round) => ({ id: round.id, index: round.index, parentRoundId: round.parentRoundId }))).toEqual([
      { id: 'round-1', index: 1, parentRoundId: null },
      { id: 'round-3', index: 2, parentRoundId: 'round-1' },
    ])
    expect(deleted.messages.map((message) => message.id)).toEqual(['user-1', 'assistant-1', 'user-3', 'assistant-3'])
    expect(deleted.messages.find((message) => message.id === 'user-3')?.content).toBe('参考 @第1轮图1、@已删除轮次图1、@第2轮图1')
    expect(deleted.activeRoundId).toBe('round-3')
    expect(deleted.updatedAt).toBe(10)
  })

  it('can remap draft mentions using the old and new active paths after deletion', () => {
    const conversation = agentConversation({
      activeRoundId: 'round-3',
      rounds: [
        {
          id: 'round-1',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-1',
          prompt: '第一轮',
          inputImageIds: [],
          outputTaskIds: ['task-1'],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        },
        {
          id: 'round-2',
          index: 2,
          parentRoundId: 'round-1',
          userMessageId: 'user-2',
          prompt: '第二轮',
          inputImageIds: [],
          outputTaskIds: ['task-2'],
          status: 'done',
          error: null,
          createdAt: 3,
          finishedAt: 4,
        },
        {
          id: 'round-3',
          index: 3,
          parentRoundId: 'round-2',
          userMessageId: 'user-3',
          prompt: '第三轮',
          inputImageIds: [],
          outputTaskIds: ['task-3'],
          status: 'done',
          error: null,
          createdAt: 5,
          finishedAt: 6,
        },
      ],
      messages: [],
    })
    const oldPath = getActiveAgentRounds(conversation)
    const deleted = deleteAgentRoundFromConversation(conversation, 'round-2', 10)
    const newPath = getActiveAgentRounds(deleted)

    expect(remapAgentRoundMentionsForPathChange('继续参考 @第1轮图1、@第2轮图1、@第3轮图1', oldPath, newPath))
      .toBe('继续参考 @第1轮图1、@已删除轮次图1、@第2轮图1')
  })
})

describe('data import', () => {
  beforeEach(async () => {
    useStore.setState({
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: null,
      showToast: vi.fn(),
    })
    await clearAgentConversations()
  })

  it('skips empty agent conversations when importing task data', async () => {
    const usedConversation = agentConversation({
      id: 'used-conversation',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'message-a',
        prompt: 'prompt',
        inputImageIds: [],
        outputTaskIds: [],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [{ id: 'message-a', role: 'user', content: 'prompt', roundId: 'round-a', createdAt: 1 }],
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [],
      agentConversations: [
        agentConversation({ id: 'empty-conversation' }),
        usedConversation,
      ],
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    const state = useStore.getState()
    expect(imported).toBe(true)
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['used-conversation'])
    expect(state.activeAgentConversationId).toBe('used-conversation')
  })

  it('merges imported agent conversations without replacing local conversations', async () => {
    const localConversation = agentConversation({
      id: 'local-conversation',
      title: '本地对话',
      createdAt: 1,
      updatedAt: 1,
    })
    const importedConversation = agentConversation({
      id: 'imported-conversation',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'message-a',
        prompt: 'imported prompt',
        inputImageIds: [],
        outputTaskIds: [],
        status: 'done',
        error: null,
        createdAt: 2,
        finishedAt: 3,
      }],
      messages: [{ id: 'message-a', role: 'user', content: 'imported prompt', roundId: 'round-a', createdAt: 2 }],
    })
    useStore.setState({
      agentConversations: [localConversation],
      activeAgentConversationId: localConversation.id,
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [],
      agentConversations: [importedConversation],
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    const state = useStore.getState()
    expect(imported).toBe(true)
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['local-conversation', 'imported-conversation'])
    expect(state.activeAgentConversationId).toBe('local-conversation')
  })

  it('stores imported legacy agent conversations in IndexedDB without localStorage or image payloads', async () => {
    const importedConversation = agentConversation({
      id: 'legacy-imported-conversation',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'message-a',
        prompt: 'imported prompt',
        inputImageIds: [],
        outputTaskIds: ['task-a'],
        responseOutput: [
          { type: 'message', content: [{ type: 'output_text', text: '已生成图片。' }] },
          { type: 'image_generation_call', id: 'image-call-a', result: { base64: 'imported-legacy-base64' } },
        ],
        status: 'done',
        error: null,
        createdAt: 2,
        finishedAt: 3,
      }],
      messages: [{ id: 'message-a', role: 'user', content: 'imported prompt', roundId: 'round-a', createdAt: 2 }],
    })

    const imported = await importData(importFile({
      version: 2,
      exportedAt: new Date(0).toISOString(),
      tasks: [],
      agentConversations: [importedConversation],
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    const indexedConversations = await getAllAgentConversations()
    const persisted = getPersistedState(useStore.getState())
    const serializedIndexedConversations = JSON.stringify(indexedConversations)
    const serializedPersisted = JSON.stringify(persisted)

    expect(imported).toBe(true)
    expect(indexedConversations.map((conversation) => conversation.id)).toEqual(['legacy-imported-conversation'])
    expect(serializedIndexedConversations).toContain('image_generation_call')
    expect(serializedIndexedConversations).not.toContain('imported-legacy-base64')
    expect('agentConversations' in persisted).toBe(false)
    expect(serializedPersisted).not.toContain('image_generation_call')
    expect(serializedPersisted).not.toContain('imported-legacy-base64')
  })

})

describe('agent draft lifecycle', () => {
  const responsesProfile = createDefaultOpenAIProfile({ id: 'openai-responses', apiKey: 'openai-key', apiMode: 'responses' })
  const draftState = {
    prompt: `参考 ${getSelectedImageMentionLabel(0)} 生成`,
    inputImages: [imageA],
    maskDraft: {
      targetImageId: imageA.id,
      maskDataUrl: 'data:image/png;base64,mask',
      updatedAt: 1,
    },
    maskEditorImageId: imageA.id,
    agentEditingRoundId: 'round-a',
  }

  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [responsesProfile],
        activeProfileId: responsesProfile.id,
      }),
      appMode: 'agent',
      agentConversations: [
        agentConversation({ id: 'conversation-a' }),
        agentConversation({ id: 'conversation-b' }),
      ],
      activeAgentConversationId: 'conversation-a',
      galleryInputDraft: null,
      agentInputDrafts: {},
      agentSidebarCollapsed: false,
      agentAssetPanelCollapsed: false,
      ...draftState,
    })
  })

  it('clears visible input but keeps the agent draft when returning to gallery mode', () => {
    useStore.getState().setAppMode('gallery')

    const state = useStore.getState()
    expect(state.appMode).toBe('gallery')
    expect(state.prompt).toBe('')
    expect(state.inputImages).toEqual([])
    expect(state.maskDraft).toBeNull()
    expect(state.maskEditorImageId).toBeNull()
    expect(state.agentEditingRoundId).toBeNull()
    expect(state.agentInputDrafts['conversation-a']).toMatchObject({
      prompt: draftState.prompt,
      inputImages: draftState.inputImages,
      maskDraft: draftState.maskDraft,
      maskEditorImageId: imageA.id,
    })
  })

  it('restores the agent draft when switching back from gallery mode', () => {
    useStore.getState().setAppMode('gallery')
    useStore.getState().setAppMode('agent')

    const state = useStore.getState()
    expect(state.appMode).toBe('agent')
    expect(state.prompt).toBe(draftState.prompt)
    expect(state.inputImages).toEqual(draftState.inputImages)
    expect(state.maskDraft).toEqual(draftState.maskDraft)
    expect(state.maskEditorImageId).toBe(imageA.id)
    expect(state.agentEditingRoundId).toBeNull()
  })

  it('keeps the gallery draft when switching into agent mode and back', () => {
    const galleryPrompt = `画廊 ${getSelectedImageMentionLabel(0)} 草稿`
    useStore.setState({
      appMode: 'gallery',
      prompt: galleryPrompt,
      inputImages: [imageB],
      maskDraft: null,
      maskEditorImageId: null,
      galleryInputDraft: null,
      agentInputDrafts: {
        'conversation-a': {
          prompt: draftState.prompt,
          inputImages: draftState.inputImages,
          maskDraft: draftState.maskDraft,
          maskEditorImageId: imageA.id,
        },
      },
    })

    useStore.getState().setAppMode('agent')

    let state = useStore.getState()
    expect(state.appMode).toBe('agent')
    expect(state.galleryInputDraft).toMatchObject({ prompt: galleryPrompt, inputImages: [imageB] })
    expect(state.prompt).toBe(draftState.prompt)

    useStore.getState().setAppMode('gallery')

    state = useStore.getState()
    expect(state.appMode).toBe('gallery')
    expect(state.prompt).toBe(galleryPrompt)
    expect(state.inputImages).toEqual([imageB])
  })

  it('persists the gallery draft while agent mode is active', () => {
    const galleryPrompt = 'gallery draft'
    useStore.setState({
      appMode: 'agent',
      galleryInputDraft: {
        prompt: galleryPrompt,
        inputImages: [imageB],
        maskDraft: null,
        maskEditorImageId: null,
      },
    })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe(galleryPrompt)
    expect(persisted.inputImages).toEqual([{ id: imageB.id, dataUrl: '' }])
  })

  it('clears stale mentions in the visible input when switching conversations', () => {
    useStore.getState().setActiveAgentConversationId('conversation-b')

    const state = useStore.getState()
    expect(state.activeAgentConversationId).toBe('conversation-b')
    expect(state.prompt).toBe('')
    expect(state.inputImages).toEqual([])
    expect(state.maskDraft).toBeNull()
    expect(state.maskEditorImageId).toBeNull()
    expect(state.agentEditingRoundId).toBeNull()
    expect(state.agentInputDrafts['conversation-a']?.prompt).toBe(draftState.prompt)
  })

  it('restores the previous conversation draft when switching back', () => {
    useStore.getState().setActiveAgentConversationId('conversation-b')
    useStore.getState().setActiveAgentConversationId('conversation-a')

    const state = useStore.getState()
    expect(state.activeAgentConversationId).toBe('conversation-a')
    expect(state.prompt).toBe(draftState.prompt)
    expect(state.inputImages).toEqual(draftState.inputImages)
    expect(state.maskDraft).toEqual(draftState.maskDraft)
    expect(state.maskEditorImageId).toBe(imageA.id)
    expect(state.agentEditingRoundId).toBeNull()
  })

  it('keeps the current draft when selecting the already active conversation', () => {
    useStore.getState().setActiveAgentConversationId('conversation-a')

    const state = useStore.getState()
    expect(state.prompt).toBe(draftState.prompt)
    expect(state.inputImages).toEqual(draftState.inputImages)
    expect(state.maskDraft).toEqual(draftState.maskDraft)
    expect(state.maskEditorImageId).toBe(imageA.id)
  })

  it('persists agent drafts separately from the gallery input draft', () => {
    const persisted = getPersistedState(useStore.getState())

    expect(persisted).not.toHaveProperty('prompt')
    expect(persisted.agentInputDrafts['conversation-a']).toMatchObject({
      prompt: draftState.prompt,
      inputImages: [{ id: imageA.id, dataUrl: '' }],
      maskDraft: draftState.maskDraft,
      maskEditorImageId: imageA.id,
    })
    expect(persisted.agentInputDrafts['conversation-a']?.updatedAt).toEqual(expect.any(Number))
  })

  it('removes stale agent drafts except the last active conversation', () => {
    const now = 10 * 24 * 60 * 60 * 1000
    const staleUpdatedAt = now - 3 * 24 * 60 * 60 * 1000 - 1
    const recentUpdatedAt = now - 3 * 24 * 60 * 60 * 1000
    const activeDraft = { prompt: 'active', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: staleUpdatedAt }
    const staleDraft = { prompt: 'stale', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: staleUpdatedAt }
    const recentDraft = { prompt: 'recent', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: recentUpdatedAt }

    const cleaned = cleanStaleAgentInputDrafts({
      'conversation-a': activeDraft,
      'conversation-b': staleDraft,
      'conversation-c': recentDraft,
    }, 'conversation-a', now)

    expect(cleaned).toEqual({
      'conversation-a': activeDraft,
      'conversation-c': recentDraft,
    })
  })

})

describe('agent context for removed outputs', () => {
  beforeEach(() => {
    const profile = createDefaultOpenAIProfile({
      id: 'responses-profile',
      apiKey: 'test-key',
      apiMode: 'responses',
      model: DEFAULT_RESPONSES_MODEL,
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        model: DEFAULT_RESPONSES_MODEL,
        profiles: [profile],
        activeProfileId: profile.id,
      }),
      prompt: '继续',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      appMode: 'agent',
      tasks: [task({
        id: 'task-live',
        outputImages: ['image-live'],
        sourceMode: 'agent',
        agentRoundId: 'round-a',
        agentToolCallId: 'live-call',
      })],
      agentConversations: [agentConversation({
        id: 'conversation-a',
        activeRoundId: 'round-a',
        rounds: [{
          id: 'round-a',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-a',
          assistantMessageId: 'assistant-a',
          prompt: '画两张图',
          inputImageIds: [],
          outputTaskIds: ['task-deleted', 'task-live'],
          responseOutput: [
            { type: 'message', content: [{ type: 'output_text', text: '已生成两张图。' }] },
            { type: 'image_generation_call', id: 'deleted-call', result: 'deleted-base64' },
            { type: 'image_generation_call', id: 'live-call', result: 'live-base64' },
          ],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
        messages: [
          { id: 'user-a', role: 'user', content: '画两张图', roundId: 'round-a', createdAt: 1 },
          { id: 'assistant-a', role: 'assistant', content: '已生成两张图。', roundId: 'round-a', outputTaskIds: ['task-deleted', 'task-live'], createdAt: 2 },
        ],
      })],
      activeAgentConversationId: 'conversation-a',
      agentEditingRoundId: null,
      showToast: vi.fn(),
    })
    vi.mocked(callAgentResponsesApi).mockClear()
    vi.mocked(callAgentResponsesApi).mockResolvedValue({
      text: 'ok',
      images: [],
      outputItems: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      responseId: 'response-b',
    })
  })

  it('does not send removed image_generation results back to the model', async () => {
    await putImage({ id: 'image-live', dataUrl: 'data:image/png;base64,live-base64' })
    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const input = vi.mocked(callAgentResponsesApi).mock.calls[0][0].input
    const serializedInput = JSON.stringify(input)
    expect(serializedInput).not.toContain('deleted-base64')
    expect(serializedInput).toContain('live-base64')
    expect(serializedInput).not.toContain('deleted-call')
    expect(serializedInput).not.toContain('live-call')
    expect(serializedInput).not.toContain('image_generation_call')
    expect(serializedInput).toContain('removed_ref')
    expect(serializedInput).toContain('round-1-image-1')
    expect(serializedInput).toContain('round-1-image-2')
    expect(serializedInput).toContain('input_image')
  })

  it('restores stripped image_generation results from task payloads when building context', async () => {
    await putImage({ id: 'image-live', dataUrl: 'data:image/png;base64,live-base64' })
    const rawResponsePayload = JSON.stringify({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '已生成两张图。' }] },
        { type: 'image_generation_call', id: 'deleted-call', result: 'deleted-base64' },
        { type: 'image_generation_call', id: 'live-call', result: 'live-base64' },
      ],
    }, null, 2)
    useStore.setState((state) => ({
      tasks: [task({
        id: 'task-live',
        outputImages: ['image-live'],
        rawResponsePayload,
        sourceMode: 'agent',
        agentRoundId: 'round-a',
        agentToolCallId: 'live-call',
      })],
      agentConversations: state.agentConversations.map((conversation) => ({
        ...conversation,
        rounds: conversation.rounds.map((round) => round.id === 'round-a'
          ? {
              ...round,
              responseOutput: [
                { type: 'message', content: [{ type: 'output_text', text: '已生成两张图。' }] },
                { type: 'image_generation_call', id: 'deleted-call' },
                { type: 'image_generation_call', id: 'live-call' },
              ],
            }
          : round,
        ),
      })),
    }))

    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const input = vi.mocked(callAgentResponsesApi).mock.calls[0][0].input
    const serializedInput = JSON.stringify(input)
    expect(serializedInput).toContain('live-base64')
    expect(serializedInput).toContain('input_image')
    expect(serializedInput).not.toContain('deleted-base64')
    expect(serializedInput).not.toContain('live-call')
    expect(serializedInput).not.toContain('image_generation_call')
  })

  it('hydrates stripped task payload image results from stored images when building context', async () => {
    await putImage({ id: 'image-hydrate', dataUrl: 'data:image/png;base64,hydrated-live-base64' })
    const rawResponsePayload = JSON.stringify({
      output: [{ type: 'image_generation_call' }],
    }, null, 2)
    useStore.setState((state) => ({
      tasks: [task({
        id: 'task-live',
        outputImages: ['image-hydrate'],
        rawResponsePayload,
        sourceMode: 'agent',
        agentRoundId: 'round-a',
      })],
      agentConversations: state.agentConversations.map((conversation) => ({
        ...conversation,
        rounds: conversation.rounds.map((round) => round.id === 'round-a'
          ? {
              ...round,
              outputTaskIds: ['task-live'],
              responseOutput: [{ type: 'image_generation_call' }],
            }
          : round,
        ),
      })),
    }))

    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const input = vi.mocked(callAgentResponsesApi).mock.calls[0][0].input
    const serializedInput = JSON.stringify(input)
    expect(serializedInput).toContain('hydrated-live-base64')
  })

  it('restores stripped image results even when legacy tasks lack tool call ids', async () => {
    await putImage({ id: 'image-legacy', dataUrl: 'data:image/png;base64,legacy-live-base64' })
    const rawResponsePayload = JSON.stringify({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '已生成图片。' }] },
        { type: 'image_generation_call', result: { base64: 'legacy-live-base64' } },
      ],
    }, null, 2)
    useStore.setState((state) => ({
      tasks: [task({
        id: 'legacy-task-live',
        outputImages: ['image-legacy'],
        rawResponsePayload,
        sourceMode: 'agent',
        agentRoundId: 'round-a',
        agentToolCallId: undefined,
      })],
      agentConversations: state.agentConversations.map((conversation) => ({
        ...conversation,
        rounds: conversation.rounds.map((round) => round.id === 'round-a'
          ? {
              ...round,
              outputTaskIds: ['legacy-task-live'],
              responseOutput: [
                { type: 'message', content: [{ type: 'output_text', text: '已生成图片。' }] },
                { type: 'image_generation_call' },
              ],
            }
          : round,
        ),
      })),
    }))

    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const input = vi.mocked(callAgentResponsesApi).mock.calls[0][0].input
    const serializedInput = JSON.stringify(input)
    expect(serializedInput).toContain('legacy-live-base64')
    expect(serializedInput).toContain('input_image')
    expect(serializedInput).not.toContain('image_generation_call')
    expect(serializedInput.match(/已生成图片。/g)).toHaveLength(1)
  })

  it('restores all stripped batch image results after restart', async () => {
    await putImage({ id: 'image-batch-1', dataUrl: 'data:image/png;base64,batch-base64-1' })
    await putImage({ id: 'image-batch-2', dataUrl: 'data:image/png;base64,batch-base64-2' })
    const batchOnePayload = JSON.stringify({
      output: [{ type: 'image_generation_call', id: 'batch-call-1', result: 'batch-base64-1' }],
    }, null, 2)
    const batchTwoPayload = JSON.stringify({
      output: [{ type: 'image_generation_call', id: 'batch-call-2', result: 'batch-base64-2' }],
    }, null, 2)
    useStore.setState((state) => ({
      tasks: [
        task({
          id: 'task-batch-1',
          outputImages: ['image-batch-1'],
          rawResponsePayload: batchOnePayload,
          sourceMode: 'agent',
          agentRoundId: 'round-a',
          agentToolCallId: 'batch-call-1',
          agentBatchCallId: 'batch-fc-1',
        }),
        task({
          id: 'task-batch-2',
          outputImages: ['image-batch-2'],
          rawResponsePayload: batchTwoPayload,
          sourceMode: 'agent',
          agentRoundId: 'round-a',
          agentToolCallId: 'batch-call-2',
          agentBatchCallId: 'batch-fc-1',
        }),
      ],
      agentConversations: state.agentConversations.map((conversation) => ({
        ...conversation,
        rounds: conversation.rounds.map((round) => round.id === 'round-a'
          ? {
              ...round,
              outputTaskIds: ['task-batch-1', 'task-batch-2'],
              responseOutput: [
                { type: 'function_call', name: 'generate_image_batch', call_id: 'batch-fc-1', arguments: '{}' },
                { type: 'function_call_output', call_id: 'batch-fc-1', output: '{"images":[{"id":"1","status":"done"},{"id":"2","status":"done"}]}' },
                { type: 'image_generation_call' },
                { type: 'image_generation_call' },
              ],
            }
          : round,
        ),
      })),
    }))

    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const input = vi.mocked(callAgentResponsesApi).mock.calls[0][0].input
    const serializedInput = JSON.stringify(input)
    expect(serializedInput).toContain('batch-base64-1')
    expect(serializedInput).toContain('batch-base64-2')
    expect(serializedInput).toContain('input_image')
    expect(serializedInput).not.toContain('batch-call-1')
    expect(serializedInput).not.toContain('batch-call-2')
    expect(serializedInput).not.toContain('image_generation_call')
  })

  it('scrubs stored agent response payloads when deleting an output task', async () => {
    const rawResponsePayload = JSON.stringify({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '已生成两张图。' }] },
        { type: 'image_generation_call', id: 'deleted-call', result: 'deleted-base64' },
        { type: 'image_generation_call', id: 'live-call', result: 'live-base64' },
      ],
    }, null, 2)
    const deletedTask = task({
      id: 'task-deleted',
      outputImages: ['image-deleted'],
      rawResponsePayload,
      sourceMode: 'agent',
      agentRoundId: 'round-a',
      agentToolCallId: 'deleted-call',
    })
    const liveTask = task({
      id: 'task-live',
      outputImages: ['image-live'],
      rawResponsePayload,
      sourceMode: 'agent',
      agentRoundId: 'round-a',
      agentToolCallId: 'live-call',
    })
    useStore.setState((state) => ({
      tasks: [deletedTask, liveTask],
      agentConversations: state.agentConversations.map((conversation) => ({
        ...conversation,
        rounds: conversation.rounds.map((round) => round.id === 'round-a'
          ? { ...round, outputTaskIds: ['task-deleted', 'task-live'], responseOutput: JSON.parse(rawResponsePayload).output }
          : round,
        ),
      })),
    }))

    await removeTask(deletedTask)

    const state = useStore.getState()
    const serializedConversations = JSON.stringify(state.agentConversations)
    const remainingTaskPayload = state.tasks.find((item) => item.id === 'task-live')?.rawResponsePayload ?? ''
    expect(serializedConversations).not.toContain('deleted-base64')
    expect(remainingTaskPayload).not.toContain('deleted-base64')
    expect(serializedConversations).toContain('live-base64')
    expect(remainingTaskPayload).toContain('live-base64')
  })

  it('does not corrupt batch task payloads when deleting one of the batch tasks', async () => {
    const batchDeletedPayload = JSON.stringify({
      output: [{ type: 'image_generation_call', id: 'batch-deleted-call', result: 'batch-deleted-base64' }],
    }, null, 2)
    const batchLivePayload = JSON.stringify({
      output: [{ type: 'image_generation_call', id: 'batch-live-call', result: 'batch-live-base64' }],
    }, null, 2)
    const batchDeletedTask = task({
      id: 'batch-task-deleted',
      outputImages: ['batch-img-deleted'],
      rawResponsePayload: batchDeletedPayload,
      sourceMode: 'agent',
      agentRoundId: 'round-a',
      agentToolCallId: 'batch-deleted-call',
      agentBatchCallId: 'batch-fc-1',
    })
    const batchLiveTask = task({
      id: 'batch-task-live',
      outputImages: ['batch-img-live'],
      rawResponsePayload: batchLivePayload,
      sourceMode: 'agent',
      agentRoundId: 'round-a',
      agentToolCallId: 'batch-live-call',
      agentBatchCallId: 'batch-fc-1',
    })
    useStore.setState((state) => ({
      tasks: [batchDeletedTask, batchLiveTask],
      agentConversations: state.agentConversations.map((conversation) => ({
        ...conversation,
        rounds: conversation.rounds.map((round) => round.id === 'round-a'
          ? {
              ...round,
              outputTaskIds: ['batch-task-deleted', 'batch-task-live'],
              responseOutput: [
                { type: 'function_call', name: 'generate_image_batch', call_id: 'batch-fc-1', arguments: '{}' },
                { type: 'function_call_output', call_id: 'batch-fc-1', output: '{"images":[{"id":"1","status":"done"},{"id":"2","status":"done"}]}' },
              ],
            }
          : round,
        ),
      })),
    }))

    await removeTask(batchDeletedTask)

    const state = useStore.getState()
    const liveTaskPayload = state.tasks.find((item) => item.id === 'batch-task-live')?.rawResponsePayload ?? ''
    expect(liveTaskPayload).toContain('batch-live-base64')
    expect(liveTaskPayload).not.toContain('batch-deleted-base64')
    const serializedConversations = JSON.stringify(state.agentConversations)
    expect(serializedConversations).toContain('function_call_output')
    expect(serializedConversations).not.toContain('batch-deleted-base64')
  })
})

describe('agent batch reference resolution', () => {
  const responsesProfile = createDefaultOpenAIProfile({
    id: 'responses-profile',
    apiKey: 'test-key',
    apiMode: 'responses',
    model: DEFAULT_RESPONSES_MODEL,
  })

  beforeEach(async () => {
    await clearImages()
    await putImage(imageA)
    await putImage(imageB)
    vi.mocked(callAgentResponsesApi).mockClear()
    vi.mocked(callBatchImageSingle).mockClear()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        model: DEFAULT_RESPONSES_MODEL,
        profiles: [responsesProfile],
        activeProfileId: responsesProfile.id,
      }),
      prompt: '继续生成',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      appMode: 'agent',
      tasks: [
        task({ id: 'task-branch-a', outputImages: [imageA.id], sourceMode: 'agent', agentRoundId: 'round-2-a' }),
        task({ id: 'task-branch-b', outputImages: [imageB.id], sourceMode: 'agent', agentRoundId: 'round-2-b' }),
      ],
      agentConversations: [agentConversation({
        id: 'conversation-a',
        activeRoundId: 'round-2-b',
        rounds: [
          {
            id: 'round-1',
            index: 1,
            parentRoundId: null,
            userMessageId: 'user-1',
            assistantMessageId: 'assistant-1',
            prompt: '画基础图',
            inputImageIds: [],
            outputTaskIds: [],
            status: 'done',
            error: null,
            createdAt: 1,
            finishedAt: 2,
          },
          {
            id: 'round-2-a',
            index: 2,
            parentRoundId: 'round-1',
            userMessageId: 'user-2-a',
            assistantMessageId: 'assistant-2-a',
            prompt: '分支 A',
            inputImageIds: [],
            outputTaskIds: ['task-branch-a'],
            status: 'done',
            error: null,
            createdAt: 3,
            finishedAt: 4,
          },
          {
            id: 'round-2-b',
            index: 2,
            parentRoundId: 'round-1',
            userMessageId: 'user-2-b',
            assistantMessageId: 'assistant-2-b',
            prompt: '分支 B',
            inputImageIds: [],
            outputTaskIds: ['task-branch-b'],
            status: 'done',
            error: null,
            createdAt: 5,
            finishedAt: 6,
          },
        ],
        messages: [
          { id: 'user-1', role: 'user', content: '画基础图', roundId: 'round-1', createdAt: 1 },
          { id: 'assistant-1', role: 'assistant', content: '完成', roundId: 'round-1', createdAt: 2 },
          { id: 'user-2-a', role: 'user', content: '分支 A', roundId: 'round-2-a', createdAt: 3 },
          { id: 'assistant-2-a', role: 'assistant', content: '完成', roundId: 'round-2-a', outputTaskIds: ['task-branch-a'], createdAt: 4 },
          { id: 'user-2-b', role: 'user', content: '分支 B', roundId: 'round-2-b', createdAt: 5 },
          { id: 'assistant-2-b', role: 'assistant', content: '完成', roundId: 'round-2-b', outputTaskIds: ['task-branch-b'], createdAt: 6 },
        ],
      })],
      activeAgentConversationId: 'conversation-a',
      agentEditingRoundId: null,
      showToast: vi.fn(),
    })
  })

  it('resolves batch references from the active branch path only', async () => {
    vi.mocked(callAgentResponsesApi)
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'generate_image_batch',
          call_id: 'batch-call',
          arguments: JSON.stringify({
            images: [{
              id: 'next-image',
              prompt: '参考 <ref id="round-2-image-1" /> 生成',
            }],
          }),
        }],
        responseId: 'response-1',
      })
      .mockResolvedValueOnce({
        text: '完成',
        images: [],
        outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
        responseId: 'response-2',
      })

    await submitAgentMessage()

    for (let i = 0; i < 5 && vi.mocked(callBatchImageSingle).mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(callBatchImageSingle).toHaveBeenCalled()
    const batchArgs = vi.mocked(callBatchImageSingle).mock.calls[0][0]
    expect(batchArgs.referenceImageDataUrls).toEqual([imageB.dataUrl])
    expect(batchArgs.referenceImageDataUrls).not.toContain(imageA.dataUrl)
    expect(batchArgs.referenceIds).toEqual(['round-2-image-1'])
  })

  it('resolves batch references to current round input images', async () => {
    useStore.setState({ inputImages: [imageA] })
    vi.mocked(callAgentResponsesApi)
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'generate_image_batch',
          call_id: 'batch-call',
          arguments: JSON.stringify({
            images: [{
              id: 'variant-image',
              prompt: '参考 <ref id="round-3-reference-1" /> 生成变体',
            }],
          }),
        }],
        responseId: 'response-1',
      })
      .mockResolvedValueOnce({
        text: '完成',
        images: [],
        outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
        responseId: 'response-2',
      })

    await submitAgentMessage()

    for (let i = 0; i < 5 && vi.mocked(callBatchImageSingle).mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(callBatchImageSingle).toHaveBeenCalled()
    const batchArgs = vi.mocked(callBatchImageSingle).mock.calls[0][0]
    expect(batchArgs.referenceImageDataUrls).toEqual([imageA.dataUrl])
    expect(batchArgs.referenceIds).toEqual(['round-3-reference-1'])
  })
})

describe('agent searched reference image flow', () => {
  const responsesProfile = createDefaultOpenAIProfile({
    id: 'responses-profile',
    apiKey: 'test-key',
    apiMode: 'responses',
    model: DEFAULT_RESPONSES_MODEL,
  })

  beforeEach(async () => {
    await clearImages()
    vi.mocked(callAgentResponsesApi).mockReset()
    vi.mocked(searchAgentImages).mockClear()
    vi.mocked(fetchAgentImageAsDataUrl).mockClear()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        model: DEFAULT_RESPONSES_MODEL,
        agentWebSearch: true,
        profiles: [responsesProfile],
        activeProfileId: responsesProfile.id,
      }),
      prompt: '搜索并整理一下“春日影”这个梗，然后将与其相关的人物的图片作为参考图。画一幅科普这个梗的图片，注意，请将相关人物图片传入参考图',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      appMode: 'agent',
      tasks: [],
      agentConversations: [agentConversation({ id: 'conversation-a', activeRoundId: null })],
      activeAgentConversationId: 'conversation-a',
      agentEditingRoundId: null,
      showToast: vi.fn(),
    })
  })

  it('collects and injects searched reference images before image generation', async () => {
    vi.mocked(callAgentResponsesApi)
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'search_images',
          call_id: 'search-call',
          arguments: JSON.stringify({
            query: '春日影 人物',
            count: 6,
            page_urls: ['https://anime.bang-dream.com/mygo/character/soyo/'],
          }),
        }],
        responseId: 'response-search',
      })
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'save_images_for_reference',
          call_id: 'save-call',
          arguments: JSON.stringify({
            images: [{
              search_result_id: 'openverse:person-1',
              image_url: '',
              title: '春日影 人物参考图',
              page_url: '',
            }],
            purpose: '作为科普信息图人物参考',
          }),
        }],
        responseId: 'response-save',
      })
      .mockResolvedValueOnce({
        text: '已使用保存的人物参考图生成。',
        images: [{
          toolCallId: 'image-call',
          dataUrl: 'data:image/png;base64,generated-image',
          revisedPrompt: '使用 <ref id="round-1-saved-reference-1" /> 作为人物参考生成中文科普信息图',
        }],
        outputItems: [
          { type: 'message', content: [{ type: 'output_text', text: '已使用保存的人物参考图生成。' }] },
          { type: 'image_generation_call', id: 'image-call', result: 'generated-image' },
        ],
        responseId: 'response-generate',
      })

    await submitAgentMessage()
    for (let i = 0; i < 10 && vi.mocked(callAgentResponsesApi).mock.calls.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(callAgentResponsesApi).toHaveBeenCalledTimes(3)
    expect(searchAgentImages).toHaveBeenCalledWith(expect.objectContaining({
      query: '春日影 人物',
      count: 6,
      pageUrls: ['https://anime.bang-dream.com/mygo/character/soyo/'],
    }))
    expect(fetchAgentImageAsDataUrl).toHaveBeenCalledWith('https://example.com/person.png', expect.any(AbortSignal))

    const firstCall = vi.mocked(callAgentResponsesApi).mock.calls[0][0]
    expect(firstCall.imageGenerationEnabled).toBe(false)
    expect(firstCall.toolChoice).toBeUndefined()

    const secondCall = vi.mocked(callAgentResponsesApi).mock.calls[1][0]
    expect(secondCall.imageGenerationEnabled).toBe(false)
    expect(secondCall.toolChoice).toEqual({ type: 'function', name: 'save_images_for_reference' })

    const thirdCall = vi.mocked(callAgentResponsesApi).mock.calls[2][0]
    expect(thirdCall.imageGenerationEnabled).toBe(true)
    const thirdInput = JSON.stringify(thirdCall.input)
    expect(thirdInput).toContain('input_image')
    expect(thirdInput).toContain('data:image/png;base64,reference-image')
    expect(thirdInput).toContain('round-1-saved-reference-1')

    const tasks = useStore.getState().tasks
    const generatedTask = tasks.find((item) => item.agentToolCallId === 'image-call')
    const conversation = useStore.getState().agentConversations.find((item) => item.id === 'conversation-a')
    const savedReferenceImages = conversation?.rounds[0]?.savedReferenceImages ?? []
    expect(tasks.some((item) => item.agentToolAction === 'save_reference')).toBe(false)
    expect(tasks).toHaveLength(1)
    expect(savedReferenceImages).toHaveLength(1)
    expect(savedReferenceImages[0]).toEqual(expect.objectContaining({
      imageId: expect.any(String),
      title: '春日影 人物参考图',
      sourceUrl: 'https://example.com/person.png',
      pageUrl: 'https://example.com/person',
      searchResultId: 'openverse:person-1',
      toolCallId: 'save-call',
    }))
    expect(generatedTask?.inputImageIds).toContain(savedReferenceImages[0].imageId)
    expect(conversation?.rounds[0]?.outputTaskIds).toEqual([generatedTask?.id])
  })

  it('keeps saved searched references available in later agent rounds', async () => {
    await putImage({ id: 'saved-ref-image', dataUrl: imageA.dataUrl, source: 'upload', createdAt: 1 })
    useStore.setState({
      prompt: '基于上一轮已选图片再画一张',
      agentConversations: [agentConversation({
        id: 'conversation-a',
        activeRoundId: 'round-a',
        rounds: [{
          id: 'round-a',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-a',
          assistantMessageId: 'assistant-a',
          prompt: '搜索并保存参考图',
          inputImageIds: [],
          outputTaskIds: [],
          savedReferenceImages: [{
            id: 'saved-ref-a',
            imageId: 'saved-ref-image',
            title: '春日影 人物参考图',
            sourceUrl: 'https://example.com/person.png',
            pageUrl: 'https://example.com/person',
            createdAt: 1,
          }],
          responseOutput: [
            { type: 'function_call', name: 'save_images_for_reference', call_id: 'save-call' },
            { type: 'function_call_output', call_id: 'save-call', output: '{"saved_refs":["<ref id=\\"round-1-saved-reference-1\\" />"]}' },
          ],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
        messages: [
          { id: 'user-a', role: 'user', content: '搜索并保存参考图', roundId: 'round-a', createdAt: 1 },
          { id: 'assistant-a', role: 'assistant', content: '已保存参考图。', roundId: 'round-a', createdAt: 2 },
        ],
      })],
    })
    vi.mocked(callAgentResponsesApi).mockResolvedValueOnce({
      text: '完成',
      images: [],
      outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
      responseId: 'response-followup',
    })

    await submitAgentMessage()
    for (let i = 0; i < 10 && vi.mocked(callAgentResponsesApi).mock.calls.length < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(callAgentResponsesApi).toHaveBeenCalledTimes(1)
    const serializedInput = JSON.stringify(vi.mocked(callAgentResponsesApi).mock.calls[0][0].input)
    expect(serializedInput).toContain('data:image/png;base64,a')
    expect(serializedInput).toContain('round-1-saved-reference-1')
  })

  it('does not silently generate when searched references are required but network search is disabled', async () => {
    useStore.setState((state) => ({
      settings: normalizeSettings({
        ...state.settings,
        agentWebSearch: false,
      }),
    }))

    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callAgentResponsesApi).not.toHaveBeenCalled()
    const conversation = useStore.getState().agentConversations.find((item) => item.id === 'conversation-a')
    const assistantMessage = conversation?.messages.find((message) => message.role === 'assistant')
    expect(assistantMessage?.content).toContain('请在设置的 Agent 配置中开启“网络搜索”')
  })

  it('keeps collecting source pages when generic image search returns no savable references', async () => {
    vi.mocked(searchAgentImages)
      .mockResolvedValueOnce({
        query: '春日影 人物',
        source: 'openverse',
        results: [],
      })
      .mockResolvedValueOnce({
        query: '長崎そよ 公式',
        source: 'webpage',
        pageUrls: ['https://anime.bang-dream.com/mygo/character/soyo/'],
        results: [{
          id: 'webpage:soyo',
          title: '長崎そよ',
          imageUrl: 'https://anime.bang-dream.com/mygo/wordpress/wp-content/themes/mygo_v1/assets/images/common/character/body_soyo.png',
          pageUrl: 'https://anime.bang-dream.com/mygo/character/soyo/',
          source: 'anime.bang-dream.com',
          provider: 'webpage',
        }],
      })
    vi.mocked(callAgentResponsesApi)
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'search_images',
          call_id: 'search-call-empty',
          arguments: JSON.stringify({ query: '春日影 人物', count: 6, page_urls: [] }),
        }],
        responseId: 'response-search-empty',
      })
      .mockResolvedValueOnce({
        text: '需要先找官方角色页。',
        images: [],
        outputItems: [
          { type: 'web_search_call', id: 'web-call', status: 'completed', action: { type: 'search' } },
          {
            type: 'function_call',
            name: 'search_images',
            call_id: 'search-call-page',
            arguments: JSON.stringify({
              query: '長崎そよ 公式',
              count: 6,
              page_urls: ['https://anime.bang-dream.com/mygo/character/soyo/'],
            }),
          },
        ],
        responseId: 'response-search-page',
      })
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'save_images_for_reference',
          call_id: 'save-call',
          arguments: JSON.stringify({
            images: [{
              search_result_id: 'webpage:soyo',
              image_url: '',
              title: '長崎そよ',
              page_url: 'https://anime.bang-dream.com/mygo/character/soyo/',
            }],
            purpose: '人物参考图',
          }),
        }],
        responseId: 'response-save',
      })
      .mockResolvedValueOnce({
        text: '完成',
        images: [{
          toolCallId: 'image-call',
          dataUrl: 'data:image/png;base64,generated-image',
          revisedPrompt: '参考 <ref id="round-1-saved-reference-1" /> 生成',
        }],
        outputItems: [{ type: 'image_generation_call', id: 'image-call', result: 'generated-image' }],
        responseId: 'response-generate',
      })

    await submitAgentMessage()
    for (let i = 0; i < 10 && vi.mocked(callAgentResponsesApi).mock.calls.length < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(callAgentResponsesApi).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(vi.mocked(callAgentResponsesApi).mock.calls[1][0].input)).toContain('previous image search returned no savable reference images')
    expect(JSON.stringify(vi.mocked(callAgentResponsesApi).mock.calls[1][0].input)).toContain('function_call_output')
    expect(searchAgentImages).toHaveBeenNthCalledWith(1, expect.objectContaining({ query: '春日影 人物', pageUrls: undefined }))
    expect(searchAgentImages).toHaveBeenNthCalledWith(2, expect.objectContaining({
      query: '長崎そよ 公式',
      pageUrls: ['https://anime.bang-dream.com/mygo/character/soyo/'],
    }))
    expect(JSON.stringify(vi.mocked(callAgentResponsesApi).mock.calls[3][0].input)).toContain('data:image/png;base64,reference-image')
  })

  it('stops when page image extraction returns no savable references', async () => {
    vi.mocked(searchAgentImages).mockResolvedValueOnce({
      query: '春日影 人物',
      source: 'webpage',
      pageUrls: ['https://example.com/page'],
      results: [],
    })
    vi.mocked(callAgentResponsesApi).mockResolvedValueOnce({
      text: '',
      images: [],
      outputItems: [{
        type: 'function_call',
        name: 'search_images',
        call_id: 'search-call',
        arguments: JSON.stringify({ query: '春日影 人物', count: 6, page_urls: ['https://example.com/page'] }),
      }],
      responseId: 'response-search',
    })

    await submitAgentMessage()
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callAgentResponsesApi).toHaveBeenCalledTimes(1)
    const conversation = useStore.getState().agentConversations.find((item) => item.id === 'conversation-a')
    const assistantMessage = conversation?.messages.find((message) => message.role === 'assistant')
    expect(assistantMessage?.content).toContain('图片搜索没有返回可保存的参考图')
    expect(useStore.getState().tasks).toHaveLength(0)
  })

  it('keeps collecting references after a research-only response', async () => {
    vi.mocked(callAgentResponsesApi)
      .mockResolvedValueOnce({
        text: '先确认相关人物。',
        images: [],
        outputItems: [
          { type: 'web_search_call', id: 'web-call', status: 'completed', action: { type: 'search' } },
          { type: 'message', content: [{ type: 'output_text', text: '相关人物包括角色 A。' }] },
        ],
        responseId: 'response-research',
      })
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'search_images',
          call_id: 'search-call',
          arguments: JSON.stringify({ query: '角色 A 春日影', count: 6 }),
        }],
        responseId: 'response-search',
      })
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'save_images_for_reference',
          call_id: 'save-call',
          arguments: JSON.stringify({
            images: [{
              search_result_id: 'openverse:person-1',
              image_url: '',
              title: '角色 A',
              page_url: '',
            }],
            purpose: '人物参考图',
          }),
        }],
        responseId: 'response-save',
      })
      .mockResolvedValueOnce({
        text: '完成',
        images: [{
          toolCallId: 'image-call',
          dataUrl: 'data:image/png;base64,generated-image',
          revisedPrompt: '参考 <ref id="round-1-saved-reference-1" /> 生成',
        }],
        outputItems: [{ type: 'image_generation_call', id: 'image-call', result: 'generated-image' }],
        responseId: 'response-generate',
      })

    await submitAgentMessage()
    for (let i = 0; i < 10 && vi.mocked(callAgentResponsesApi).mock.calls.length < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(callAgentResponsesApi).toHaveBeenCalledTimes(4)
    expect(vi.mocked(callAgentResponsesApi).mock.calls[0][0].imageGenerationEnabled).toBe(false)
    expect(vi.mocked(callAgentResponsesApi).mock.calls[1][0].imageGenerationEnabled).toBe(false)
    expect(JSON.stringify(vi.mocked(callAgentResponsesApi).mock.calls[1][0].input)).toContain('Do not generate the final image yet')
    expect(vi.mocked(callAgentResponsesApi).mock.calls[2][0].toolChoice).toEqual({ type: 'function', name: 'save_images_for_reference' })
    expect(vi.mocked(callAgentResponsesApi).mock.calls[3][0].imageGenerationEnabled).toBe(true)
    expect(JSON.stringify(vi.mocked(callAgentResponsesApi).mock.calls[3][0].input)).toContain('data:image/png;base64,reference-image')
  })
})

describe('agent assistant regeneration', () => {
  const responsesProfile = createDefaultOpenAIProfile({ id: 'openai-responses', apiKey: 'openai-key', apiMode: 'responses' })

  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [responsesProfile],
        activeProfileId: responsesProfile.id,
        alwaysShowRetryButton: false,
      }),
      params: { ...DEFAULT_PARAMS, n: 4 },
      agentEditingRoundId: 'round-a',
      agentConversations: [
        agentConversation({
          id: 'conversation-a',
          activeRoundId: 'round-a',
          rounds: [{
            id: 'round-a',
            index: 1,
            parentRoundId: null,
            userMessageId: 'user-a',
            assistantMessageId: 'assistant-a',
            prompt: '画一只猫',
            inputImageIds: [imageA.id],
            outputTaskIds: [],
            status: 'done',
            error: null,
            createdAt: 1,
            finishedAt: 2,
          }],
          messages: [
            { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', inputImageIds: [imageA.id], createdAt: 1 },
            { id: 'assistant-a', role: 'assistant', content: '已完成。', roundId: 'round-a', createdAt: 2 },
          ],
        }),
      ],
      toast: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('creates a sibling round from the assistant message regardless of retry setting', async () => {
    await regenerateAgentAssistantMessage('conversation-a', 'round-a')

    const conversation = useStore.getState().agentConversations[0]
    const newRound = conversation.rounds.find((round) => round.id !== 'round-a')
    expect(newRound).toMatchObject({
      index: 1,
      parentRoundId: null,
      prompt: '画一只猫',
      inputImageIds: [imageA.id],
      status: 'running',
      outputTaskIds: [],
    })
    expect(conversation.activeRoundId).toBe(newRound?.id)
    expect(conversation.messages).toContainEqual(expect.objectContaining({
      role: 'user',
      content: '画一只猫',
      roundId: newRound?.id,
      inputImageIds: [imageA.id],
    }))
    expect(useStore.getState().agentEditingRoundId).toBeNull()
  })

  it('overwrites the same round when regenerating an error assistant message', async () => {
    useStore.setState({
      agentConversations: [
        agentConversation({
          id: 'conversation-a',
          activeRoundId: 'round-a',
          rounds: [{
            id: 'round-a',
            index: 1,
            parentRoundId: null,
            userMessageId: 'user-a',
            assistantMessageId: 'assistant-a',
            prompt: '画一只猫',
            inputImageIds: [imageA.id],
            outputTaskIds: ['task-a'],
            status: 'error',
            error: '失败',
            createdAt: 1,
            finishedAt: 2,
          }],
          messages: [
            { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', inputImageIds: [imageA.id], createdAt: 1 },
            { id: 'assistant-a', role: 'assistant', content: '请求失败：失败', roundId: 'round-a', outputTaskIds: ['task-a'], createdAt: 2 },
          ],
        }),
      ],
    })

    await regenerateAgentAssistantMessage('conversation-a', 'round-a')

    const conversation = useStore.getState().agentConversations[0]
    expect(conversation.rounds).toHaveLength(1)
    expect(conversation.activeRoundId).toBe('round-a')
    expect(conversation.rounds[0]).toMatchObject({
      id: 'round-a',
      status: 'running',
      error: null,
      outputTaskIds: [],
      finishedAt: null,
    })
    expect(conversation.messages.find((message) => message.id === 'assistant-a')).toMatchObject({
      content: '',
      outputTaskIds: [],
    })
  })
})

describe('reused task API profile', () => {
  const openaiProfile = createDefaultOpenAIProfile({ id: 'openai-profile', apiKey: 'openai-key' })
  const falProfile = createDefaultFalProfile({ id: 'fal-profile', name: 'fal 配置', apiKey: 'fal-key' })

  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [openaiProfile, falProfile],
        activeProfileId: openaiProfile.id,
        reuseTaskApiProfileTemporarily: true,
      }),
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      showSettings: false,
      toast: null,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('resolves a task API profile by stored profile id', () => {
    const resolved = getTaskApiProfile(useStore.getState().settings, task({ apiProvider: 'fal', apiProfileId: falProfile.id }))

    expect(resolved?.id).toBe(falProfile.id)
  })

  it('does not resolve a task API profile by stored name or model', () => {
    const resolved = getTaskApiProfile(useStore.getState().settings, task({
      apiProvider: 'fal',
      apiProfileName: falProfile.name,
      apiModel: falProfile.model,
    }))

    expect(resolved).toBeNull()
  })

  it('reuses the task API profile temporarily without switching the active profile', async () => {
    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBe(falProfile.id)
    expect(state.params).toMatchObject({ n: 4, size: '1360x1024', quality: 'high' })
    expect(state.showToast).toHaveBeenCalledWith('已临时复用该任务的 API 配置「fal 配置」', 'success')
  })

  it('keeps selected image mentions when reusing a task with different current input images', async () => {
    await clearImages()
    await putImage(imageA)
    await putImage(imageB)
    const taskPrompt = `参考 ${getSelectedImageMentionLabel(1)} 生成`

    useStore.setState({
      prompt: `当前 ${getSelectedImageMentionLabel(1)}`,
      inputImages: [
        { id: 'current-x', dataUrl: 'data:image/png;base64,x' },
        { id: 'current-y', dataUrl: 'data:image/png;base64,y' },
      ],
    })

    await reuseConfig(task({
      apiProvider: 'openai',
      apiProfileId: openaiProfile.id,
      prompt: taskPrompt,
      inputImageIds: [imageA.id, imageB.id],
    }))

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([imageA.id, imageB.id])
    expect(state.prompt).toBe(taskPrompt)
  })

  it('clears temporary reuse when switching current settings to the reused API profile', async () => {
    await reuseConfig(task({ apiProvider: 'fal', apiProfileId: falProfile.id }))

    useStore.getState().setSettings({ activeProfileId: falProfile.id })

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(falProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.reusedTaskApiProfileMissing).toBe(false)
  })

  it('normalizes reused params to the current API profile when temporary reuse is disabled', async () => {
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        reuseTaskApiProfileTemporarily: false,
      }),
    })

    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.params).toMatchObject({ n: 8, size: 'auto', quality: 'auto' })
  })

  it('asks whether to submit with current API profile when the reused API profile is missing', async () => {
    await reuseConfig(task({ apiProvider: 'fal', apiProfileId: 'missing-profile' }))

    const state = useStore.getState()
    expect(state.tasks).toEqual([])
    expect(state.setConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '找不到 API 配置',
      message: '找不到复用任务所使用的 API 配置「未知配置」，要使用当前的 API 配置「默认」提交任务吗？',
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
    }))
    expect(state.showSettings).toBe(false)
  })
})
