import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { DEFAULT_PARAMS } from './types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_RESPONSES_MODEL, DEFAULT_SETTINGS, normalizeSettings } from './lib/apiProfiles'
import type { AgentConversation, ExportData, StoredImage, StoredImageThumbnail, TaskRecord } from './types'
import { getSelectedImageMentionLabel } from './lib/promptImageMentions'
import { hasActiveDataOperations } from './lib/dataOperations'
import { deleteAgentRoundFromConversation, getActiveAgentRounds, getAgentConversationTaskIds, getAgentRoundTaskIds, remapAgentRoundMentionsForPathChange } from './lib/agentConversationState'
import { cleanStaleAgentInputDrafts } from './lib/inputDraftState'
import { normalizePersistedState } from './lib/persistedState'
import { setPresetConfig } from './lib/presetConfig'
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
    deleteTask: vi.fn(async (id: string) => {
      tasks.delete(id)
    }),
    commitTaskDeletion: vi.fn(async (deletedTaskIds: string[], updatedTasks: TaskRecord[], updatedConversations: AgentConversation[]) => {
      for (const id of deletedTaskIds) tasks.delete(id)
      for (const task of updatedTasks) tasks.set(task.id, task)
      for (const conversation of updatedConversations) agentConversations.set(conversation.id, conversation)
    }),
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
    getStoredImageThumbnail: async (id: string) => thumbnails.get(id),
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
    deleteImage: vi.fn(async (id: string) => {
      images.delete(id)
      thumbnails.delete(id)
    }),
    clearImages: async () => {
      images.clear()
      thumbnails.clear()
    },
    storeImage: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++imageSeq}`
      images.set(id, { id, dataUrl, source, createdAt: Date.now() })
      return id
    },
    storeImageWithSize: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++imageSeq}`
      const size = dataUrl.match(/(\d+)x(\d+)/)
      const width = size ? Number(size[1]) : undefined
      const height = size ? Number(size[2]) : undefined
      images.set(id, { id, dataUrl, source, createdAt: Date.now(), width, height })
      return { id, width, height }
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
vi.mock('./lib/falAiImageApi', () => ({
  getFalErrorMessage: vi.fn((err: unknown) => err instanceof Error ? err.message : String(err)),
  getFalQueuedImageResult: vi.fn(async () => ({
    images: [],
    actualParams: {},
    actualParamsList: [],
    revisedPrompts: [],
  })),
}))
vi.mock('./lib/transparentImage', () => ({
  GREEN_KEY_COLOR: '#00FF00',
  MAGENTA_KEY_COLOR: '#FF00FF',
  createTransparentOutputMeta: vi.fn((prompt: string) => ({
    transparentOutput: true,
    effectivePrompt: `transparent:${prompt}`,
  })),
  getTransparentRequestParams: vi.fn((params: typeof DEFAULT_PARAMS) => ({
    ...params,
    output_format: params.output_format === 'webp' ? 'webp' : 'png',
    output_compression: params.output_format === 'webp' ? params.output_compression : null,
    transparent_output: true,
  })),
  removeKeyedBackgroundFromDataUrl: vi.fn(async (dataUrl: string) => `transparent:${dataUrl}`),
}))
vi.mock('./lib/agentApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/agentApi')>()
  return {
    ...actual,
    callAgentConversationTitleApi: vi.fn(async () => '标题'),
    callAgentResponsesApi: vi.fn(() => new Promise(() => {})),
    callBatchImageSingle: vi.fn(async (opts: { batchItemId: string; prompt: string }) => ({
      batchItemId: opts.batchItemId,
      image: { dataUrl: 'data:image/png;base64,batch-output', revisedPrompt: opts.prompt },
      error: null,
    })),
  }
})
import { clearAgentConversations, clearImages, clearTasks, commitTaskDeletion, deleteImage as deleteDbImage, deleteTask as deleteDbTask, getAllAgentConversations, getAllImageIds, getAllTasks, getImage, getStoredFreshImageThumbnail, putAgentConversation, putImage, putImageThumbnail, putTask as putDbTask } from './lib/db'
import { callImageApi } from './lib/api'
import { callAgentResponsesApi, callBatchImageSingle } from './lib/agentApi'
import { getFalQueuedImageResult } from './lib/falAiImageApi'
import { removeKeyedBackgroundFromDataUrl } from './lib/transparentImage'
import { clearData, clearFailedTasks, deleteFavoriteCollection, editOutputs, getErrorToastMessage, getPersistedState, getTaskApiProfile, importData, initStore, regenerateAgentAssistantMessage, removeMultipleTasks, removeTask, restoreExplicitPresetConfig, reuseConfig, stopAgentResponse, submitAgentMessage, submitTask, taskMatchesFilterStatus, taskMatchesSearchQuery, useStore } from './store'

const commitTaskDeletionImplementation = vi.mocked(commitTaskDeletion).getMockImplementation()!
const deleteDbImageImplementation = vi.mocked(deleteDbImage).getMockImplementation()!
const deleteDbTaskImplementation = vi.mocked(deleteDbTask).getMockImplementation()!
const callBatchImageSingleImplementation = vi.mocked(callBatchImageSingle).getMockImplementation()!

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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function importFile(data: ExportData, files: Record<string, Uint8Array> = {}): File {
  const zipped = zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(data)) })
  const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength)
  return { name: 'backup.zip', size: zipped.byteLength, arrayBuffer: async () => buffer.slice(0) } as File
}

describe('data operation locking', () => {
  it('detects running and recoverable work before import or export', () => {
    expect(hasActiveDataOperations([task({ status: 'running' })], [])).toBe(true)
    expect(hasActiveDataOperations([task({ falRecoverable: true })], [])).toBe(true)
    expect(hasActiveDataOperations([], [agentConversation({
      rounds: [{
        id: 'round-a',
        index: 1,
        userMessageId: 'message-a',
        prompt: 'prompt',
        inputImageIds: [],
        outputTaskIds: [],
        status: 'running',
        error: null,
        createdAt: 1,
        finishedAt: null,
      }],
    })])).toBe(true)
    expect(hasActiveDataOperations([task()], [])).toBe(false)
  })
})

describe('favorite collection deletion', () => {
  const collectionA = { id: 'collection-a', name: '收藏夹 A', createdAt: 1, updatedAt: 1 }
  const collectionB = { id: 'collection-b', name: '收藏夹 B', createdAt: 1, updatedAt: 1 }

  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    useStore.setState({
      tasks: [],
      favoriteCollections: [collectionA, collectionB],
      defaultFavoriteCollectionId: collectionA.id,
      activeFavoriteCollectionId: collectionA.id,
      selectedFavoriteCollectionIds: [collectionA.id],
      selectedTaskIds: [],
      inputImages: [],
      galleryInputDraft: null,
      agentConversations: [],
      showToast: vi.fn(),
    })
  })

  it('keeps tasks that are still referenced by another collection when deleting collection tasks', async () => {
    const sharedTask = task({
      id: 'shared-task',
      isFavorite: true,
      favoriteCollectionIds: [collectionA.id, collectionB.id],
    })
    const collectionOnlyTask = task({
      id: 'collection-only-task',
      isFavorite: true,
      favoriteCollectionIds: [collectionA.id],
    })
    useStore.setState({ tasks: [sharedTask, collectionOnlyTask] })
    await putDbTask(sharedTask)
    await putDbTask(collectionOnlyTask)

    await deleteFavoriteCollection(collectionA.id, true)

    const state = useStore.getState()
    expect(state.favoriteCollections.map((collection) => collection.id)).toEqual([collectionB.id])
    expect(state.activeFavoriteCollectionId).toBeNull()
    expect(state.selectedFavoriteCollectionIds).toEqual([])
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({
      id: sharedTask.id,
      isFavorite: true,
      favoriteCollectionIds: [collectionB.id],
    })
    expect((await getAllTasks()).map((item) => item.id)).toEqual([sharedTask.id])
  })
})

describe('mask draft lifecycle in store actions', () => {
  beforeEach(() => {
    vi.mocked(callImageApi).mockReset().mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockReset().mockImplementation(async (dataUrl) => `transparent:${dataUrl}`)
    useStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile, transparentBackgroundMethod: 'local' })),
      },
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
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const state = useStore.getState()
    expect(state.tasks).toHaveLength(1)
    expect(state.showToast).toHaveBeenCalledWith('任务已提交', 'success')
  })

  it('does not apply the outer watchdog to concurrent Codex CLI custom requests', async () => {
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)
    const profile = {
      ...createDefaultOpenAIProfile({ id: 'custom-sync-profile', apiKey: 'custom-key', timeout: 1, codexCli: true }),
      provider: 'custom-sync',
    }
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        customProviders: [{
          id: 'custom-sync',
          name: 'Custom Sync',
          submit: { path: 'images/generations' },
        }],
        profiles: [profile],
        activeProfileId: profile.id,
      }),
      params: { ...DEFAULT_PARAMS, n: 2 },
    })
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledOnce())

    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 1000)).toBe(false)
    request.resolve({
      images: ['data:image/png;base64,success'],
      actualParams: { n: 1 },
      actualParamsList: [{ n: 1 }],
      revisedPrompts: [],
      failedRequests: [{ requestIndex: 1, error: 'The operation was aborted' }],
    })
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(useStore.getState().tasks[0]).toMatchObject({
      outputErrors: [{ requestIndex: 1, error: 'The operation was aborted' }],
    })
    expect(useStore.getState().tasks[0].outputImages).toHaveLength(1)
    setTimeoutSpy.mockRestore()
  })

  it('stores decoded image size as actual size when the API omits size', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,actual-1254x1254'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '2048x2048' },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const [task] = useStore.getState().tasks
    expect(task.actualParams).toMatchObject({ size: '1254x1254', output_format: 'png', n: 1 })
    expect(task.actualParamsByImage?.[task.outputImages[0]]).toMatchObject({ size: '1254x1254', output_format: 'png' })
    await clearTasks()
    await clearImages()
  })

  it('keeps API-returned actual size over decoded image size', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,actual-1254x1254'],
      actualParams: { output_format: 'png', size: '1024x1024' },
      actualParamsList: [{ output_format: 'png', size: '1024x1024' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '2048x2048' },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const [task] = useStore.getState().tasks
    expect(task.actualParams?.size).toBe('1024x1024')
    expect(task.actualParamsByImage?.[task.outputImages[0]].size).toBe('1024x1024')
    await clearTasks()
    await clearImages()
  })

  it('stores transparent background output after local post-processing', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,generated'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: '单主体贴纸素材',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        output_compression: null,
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'transparent:单主体贴纸素材',
      params: expect.objectContaining({
        output_format: 'png',
        output_compression: null,
        transparent_output: true,
      }),
    }))
    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith('data:image/png;base64,generated')
    const [task] = useStore.getState().tasks
    expect(task).toMatchObject({
      prompt: '单主体贴纸素材',
      transparentOutput: true,
      transparentPrompt: 'transparent:单主体贴纸素材',
      status: 'done',
    })
    expect(task.transparentOriginalImages).toHaveLength(1)
    const outputImage = await getImage(task.outputImages[0])
    const originalImage = await getImage(task.transparentOriginalImages![0])
    expect(outputImage?.dataUrl).toBe('transparent:data:image/png;base64,generated')
    expect(originalImage?.dataUrl).toBe('data:image/png;base64,generated')
    await clearTasks()
    await clearImages()
  })

  it('stores locally post-processed transparent output as WebP', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/webp;base64,generated'],
      actualParams: { output_format: 'webp' },
      actualParamsList: [{ output_format: 'webp' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: '单主体贴纸素材',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'webp',
        output_compression: 25,
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        output_format: 'webp',
        output_compression: 25,
        transparent_output: true,
      }),
    }))
    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith(
      'data:image/webp;base64,generated',
      undefined,
      'webp',
      25,
    )
    await clearTasks()
    await clearImages()
  })

  it('keeps native transparent output unchanged and requests API transparency', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,native-transparent'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, baseUrl: 'https://api.example.com/v1', apiKey: 'test-key' },
      prompt: '透明玻璃瓶',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '透明玻璃瓶',
      nativeTransparentBackground: true,
    }))
    expect(removeKeyedBackgroundFromDataUrl).not.toHaveBeenCalled()
    const [task] = useStore.getState().tasks
    expect(task.transparentOutput).toBeUndefined()
    expect(task.transparentPrompt).toBeUndefined()
    expect(task.transparentOriginalImages).toBeUndefined()
    expect((await getImage(task.outputImages[0]))?.dataUrl).toBe('data:image/png;base64,native-transparent')
    await clearTasks()
    await clearImages()
  })

  it('falls back to the original output when transparent post-processing fails', async () => {
    const { callImageApi } = await import('./lib/api')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockRejectedValueOnce(new Error('post-process failed'))
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,generated'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: '单主体贴纸素材',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        output_compression: null,
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const [task] = useStore.getState().tasks
    expect(task).toMatchObject({
      transparentOutput: true,
      status: 'done',
    })
    expect(task.transparentOriginalImages).toEqual([''])
    const outputImage = await getImage(task.outputImages[0])
    expect(outputImage?.dataUrl).toBe('data:image/png;base64,generated')
    warnSpy.mockRestore()
    await clearTasks()
    await clearImages()
  })

  it('supports transparent background post-processing for fal gallery tasks', async () => {
    const { callImageApi } = await import('./lib/api')
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,fal-generated'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [{ ...falProfile, transparentBackgroundMethod: 'local' }],
        activeProfileId: falProfile.id,
      }),
      prompt: '单主体图标素材',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        output_format: 'png',
        transparent_output: true,
      }),
    }))
    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith('data:image/png;base64,fal-generated')
    const [task] = useStore.getState().tasks
    expect(task.apiProvider).toBe('fal')
    expect(task.transparentOutput).toBe(true)
    expect(task.transparentOriginalImages).toHaveLength(1)
    await clearTasks()
    await clearImages()
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

describe('input persistence setting', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      appMode: 'gallery',
      prompt: 'prompt',
      inputImages: [imageA],
      galleryInputDraft: null,
      agentConversations: [],
      activeAgentConversationId: null,
      agentInputDrafts: {},
      dismissedCodexCliPrompts: [],
    })
  })

  it('persists input when restart input restore is enabled', () => {
    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('prompt')
    expect(persisted.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
  })

  it('omits input when restart input restore is disabled', () => {
    const conversation = agentConversation()
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false },
      appMode: 'agent',
      prompt: '不应持久化的可见 Agent 输入',
      inputImages: [imageA],
      galleryInputDraft: {
        prompt: '不应持久化的画廊草稿',
        inputImages: [imageA],
        maskDraft: null,
        maskEditorImageId: null,
      },
      agentConversations: [conversation],
      activeAgentConversationId: conversation.id,
      agentInputDrafts: {
        [conversation.id]: {
          prompt: '不应持久化的 Agent 草稿',
          inputImages: [imageA],
          maskDraft: null,
          maskEditorImageId: null,
        },
      },
    })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted).not.toHaveProperty('prompt')
    expect(persisted).not.toHaveProperty('inputImages')
    expect(persisted.galleryInputDraft).toBeNull()
    expect(persisted.agentInputDrafts).toEqual({})
  })

  it('writes empty input when persisted input is cleared', () => {
    useStore.setState({ prompt: '', inputImages: [] })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('')
    expect(persisted.inputImages).toEqual([])
  })

  it('persists and restores normalized dismissed preset provider IDs', () => {
    useStore.setState({
      dismissedPresetProfileIds: ['profile-a'],
      dismissedPresetProviderIds: ['provider-a'],
    })

    const persisted = getPersistedState(useStore.getState())
    const restored = normalizePersistedState({
      ...persisted,
      dismissedPresetProviderIds: ['provider-a', 1, null, 'provider-b'],
    }, useStore.getState())!

    expect(persisted.dismissedPresetProviderIds).toEqual(['provider-a'])
    expect(restored.state.dismissedPresetProviderIds).toEqual(['provider-a', 'provider-b'])
  })
})

describe('preset deletion state', () => {
  afterEach(() => {
    setPresetConfig(null)
    useStore.setState({ previousPresetConfig: null })
  })

  it('removes an untouched preset after deployment removes it', async () => {
    const providers = [
      { id: 'preset-provider-a', name: 'Provider A', submit: { path: 'a' } },
      { id: 'preset-provider-b', name: 'Provider B', submit: { path: 'b' } },
    ]
    const profiles = [
      createDefaultOpenAIProfile({ id: 'preset-profile-a', provider: providers[0].id, isDefault: true }),
      createDefaultOpenAIProfile({ id: 'preset-profile-b', provider: providers[1].id }),
    ]
    const previous = { customProviders: providers, profiles }
    const next = { customProviders: [providers[0]], profiles: [profiles[0]] }
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
      previousPresetConfig: null,
      tasks: [],
    })
    setPresetConfig(previous)
    await useStore.getState().setPresetImportedSettings(previous)

    setPresetConfig(next)
    await useStore.getState().setPresetImportedSettings(next)

    const state = useStore.getState()
    expect(state.settings.profiles.map((profile) => profile.id)).toEqual(['preset-profile-a'])
    expect(state.settings.customProviders.map((provider) => provider.id)).toEqual(['preset-provider-a'])
  })

  it('removes untouched presets when deployment removes the entire preset config', async () => {
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'preset-profile', provider: provider.id, isDefault: true })
    const preset = { customProviders: [provider], profiles: [profile] }
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
      previousPresetConfig: null,
      tasks: [],
    })
    setPresetConfig(preset)
    await useStore.getState().setPresetImportedSettings(preset)

    setPresetConfig(null)
    await useStore.getState().setPresetImportedSettings({ customProviders: [], profiles: [] })

    const state = useStore.getState()
    expect(state.settings.profiles.map((item) => item.id)).toEqual([DEFAULT_SETTINGS.profiles[0].id])
    expect(state.settings.customProviders).toEqual([])
    expect(state.previousPresetConfig).toBeNull()
  })

  it('clearData clears both dismissal lists and reapplies the current preset', async () => {
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({
      id: 'preset-profile',
      isDefault: true,
      provider: provider.id,
      model: 'preset-model',
    })
    const preset = { customProviders: [provider], profiles: [profile] }
    setPresetConfig(preset)
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        customProviders: [],
        profiles: [createDefaultFalProfile({ id: 'user-profile' })],
        activeProfileId: 'user-profile',
      }),
      dismissedPresetProfileIds: [profile.id],
      dismissedPresetProviderIds: [provider.id],
      dismissedCodexCliPrompts: ['prompt-a'],
    })

    await clearData({ clearConfig: true, clearTasks: false })

    const state = useStore.getState()
    expect(state.dismissedPresetProfileIds).toEqual([])
    expect(state.dismissedPresetProviderIds).toEqual([])
    expect(state.dismissedCodexCliPrompts).toEqual([])
    expect(state.settings.customProviders).toEqual([expect.objectContaining({ id: provider.id })])
    expect(state.settings.profiles).toEqual([expect.objectContaining({ id: profile.id, provider: provider.id })])
  })

  it('restores an explicitly reimported preset provider', () => {
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'preset-profile', provider: provider.id })
    setPresetConfig({ customProviders: [provider], profiles: [profile] })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        customProviders: [],
        profiles: [{ ...profile, provider: 'openai' }],
      }),
      dismissedPresetProviderIds: [provider.id],
    })

    const state = useStore.getState()
    state.restorePresetProvider(provider.id)
    state.setSettings({ customProviders: [provider], profiles: [profile] })

    expect(useStore.getState().dismissedPresetProviderIds).toEqual([])
    expect(useStore.getState().settings.customProviders).toEqual([expect.objectContaining({ id: provider.id })])
    expect(useStore.getState().settings.profiles[0].provider).toBe(provider.id)
  })

  it('restores only preset IDs explicitly selected by a URL import', async () => {
    const providers = [
      { id: 'preset-provider-a', name: 'Preset Provider A', submit: { path: 'generate-a' } },
      { id: 'preset-provider-b', name: 'Preset Provider B', submit: { path: 'generate-b' } },
    ]
    const profiles = [
      createDefaultOpenAIProfile({ id: 'preset-profile-a', provider: providers[0].id, isDefault: true }),
      createDefaultOpenAIProfile({ id: 'preset-profile-b', provider: providers[1].id }),
    ]
    setPresetConfig({ customProviders: providers, profiles })
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
      dismissedPresetProviderIds: providers.map((provider) => provider.id),
      dismissedPresetProfileIds: profiles.map((profile) => profile.id),
    })

    const restored = await restoreExplicitPresetConfig({
      providerIds: [providers[0].id, 'not-a-preset'],
      profileIds: [profiles[0].id, 'not-a-preset'],
    })

    const state = useStore.getState()
    expect(restored).toBe(true)
    expect(state.dismissedPresetProviderIds).toEqual([providers[1].id])
    expect(state.dismissedPresetProfileIds).toEqual([profiles[1].id])
    expect(state.settings.customProviders).toEqual([expect.objectContaining({ id: providers[0].id })])
    expect(state.settings.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: profiles[0].id })]))
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
    useStore.setState({ agentConversations: [legacyConversation], activeAgentConversationId: legacyConversation.id })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await putAgentConversation(storedConversation)

    await initStore()

    const state = useStore.getState()
    const stored = await getAllAgentConversations()
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['stored-conversation', 'legacy-conversation'])
    expect(state.activeAgentConversationId).toBe('legacy-conversation')
    expect(stored.map((conversation) => conversation.id)).toEqual(['stored-conversation', 'legacy-conversation'])
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

  it('clears masks and renumbers mentions when startup cannot restore a draft image', async () => {
    await clearTasks()
    await clearImages()
    await clearAgentConversations()
    const conversation = agentConversation({ id: 'restore-conversation' })
    await putAgentConversation(conversation)
    await putImage(imageB)
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      appMode: 'agent',
      tasks: [],
      agentConversations: [conversation],
      activeAgentConversationId: conversation.id,
      agentInputDrafts: {
        [conversation.id]: {
          prompt: `保留 ${getSelectedImageMentionLabel(1)}，缺失 ${getSelectedImageMentionLabel(0)}`,
          inputImages: [
            { id: imageA.id, dataUrl: '' },
            { id: imageB.id, dataUrl: '' },
          ],
          maskDraft: {
            targetImageId: imageA.id,
            maskDataUrl: 'data:image/png;base64,mask',
            updatedAt: 1,
          },
          maskEditorImageId: imageA.id,
          updatedAt: 2,
        },
      },
      galleryInputDraft: null,
      prompt: '',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
    })

    await initStore()

    const state = useStore.getState()
    const expectedPrompt = `保留 ${getSelectedImageMentionLabel(0)}，缺失 @已移除图片`
    expect(state.agentInputDrafts[conversation.id]).toMatchObject({
      prompt: expectedPrompt,
      inputImages: [imageB],
      maskDraft: null,
      maskEditorImageId: null,
      updatedAt: 2,
    })
    expect(state.prompt).toBe(expectedPrompt)
    expect(state.inputImages).toEqual([imageB])
    expect(state.maskDraft).toBeNull()
    expect(state.maskEditorImageId).toBeNull()
  })

  it('clears gallery masks and renumbers mentions when startup cannot restore a draft image', async () => {
    await clearTasks()
    await clearImages()
    await clearAgentConversations()
    await putImage(imageB)
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      appMode: 'gallery',
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: null,
      agentInputDrafts: {},
      galleryInputDraft: {
        prompt: `保留 ${getSelectedImageMentionLabel(1)}，缺失 ${getSelectedImageMentionLabel(0)}`,
        inputImages: [
          { id: imageA.id, dataUrl: '' },
          { id: imageB.id, dataUrl: '' },
        ],
        maskDraft: {
          targetImageId: imageA.id,
          maskDataUrl: 'data:image/png;base64,mask',
          updatedAt: 1,
        },
        maskEditorImageId: imageA.id,
        updatedAt: 2,
      },
      prompt: '',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
    })

    await initStore()

    const state = useStore.getState()
    const expectedPrompt = `保留 ${getSelectedImageMentionLabel(0)}，缺失 @已移除图片`
    expect(state.galleryInputDraft).toMatchObject({
      prompt: expectedPrompt,
      inputImages: [imageB],
      maskDraft: null,
      maskEditorImageId: null,
      updatedAt: 2,
    })
    expect(state.prompt).toBe(expectedPrompt)
    expect(state.inputImages).toEqual([imageB])
    expect(state.maskDraft).toBeNull()
    expect(state.maskEditorImageId).toBeNull()
  })

})

describe('fal task recovery', () => {
  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    await clearAgentConversations()
    vi.mocked(getFalQueuedImageResult).mockReset().mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    vi.mocked(callAgentResponsesApi).mockReset().mockResolvedValue({ text: '', images: [], outputItems: [], responseId: 'response-default' })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockReset().mockImplementation(async (dataUrl) => `transparent:${dataUrl}`)
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [falProfile],
        activeProfileId: falProfile.id,
      }),
      tasks: [],
      inputImages: [],
      galleryInputDraft: null,
      agentConversations: [],
      showToast: vi.fn(),
    })
  })

  it('applies transparent post-processing when a fal task recovers', async () => {
    const falTask = task({
      id: 'fal-transparent-task',
      apiProvider: 'fal',
      apiProfileId: 'fal-profile',
      apiProfileName: 'fal',
      apiModel: 'fal-model',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        transparent_output: true,
      },
      transparentOutput: true,
      transparentPrompt: 'transparent:prompt',
      status: 'error',
      error: '连接已断开，等待自动恢复',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      finishedAt: null,
      elapsed: null,
    })
    await putDbTask(falTask)
    vi.mocked(getFalQueuedImageResult).mockResolvedValueOnce({
      images: ['data:image/png;base64,fal-recovered'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })

    await initStore()
    await vi.waitFor(() => {
      expect(useStore.getState().tasks.find((item) => item.id === falTask.id)).toMatchObject({ status: 'done', falRecoverable: false })
    })

    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith('data:image/png;base64,fal-recovered')
    const recovered = useStore.getState().tasks.find((item) => item.id === falTask.id)
    expect(recovered).toMatchObject({
      status: 'done',
      falRecoverable: false,
      transparentOutput: true,
    })
    expect(recovered?.transparentOriginalImages).toHaveLength(1)
    const outputImage = await getImage(recovered!.outputImages[0])
    const originalImage = await getImage(recovered!.transparentOriginalImages![0])
    expect(outputImage?.dataUrl).toBe('transparent:data:image/png;base64,fal-recovered')
    expect(originalImage?.dataUrl).toBe('data:image/png;base64,fal-recovered')
  })

  it('deletes a normalized error round with an in-flight recoverable task without reviving it', async () => {
    const agentTask = task({
      id: 'agent-restart-task',
      apiProvider: 'fal',
      apiProfileId: 'fal-profile',
      apiProfileName: 'fal',
      apiModel: 'fal-model',
      status: 'error',
      error: '等待自动恢复',
      falRequestId: 'restart-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
    })
    const conversation = agentConversation({
      id: 'conversation-a',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '重启恢复',
        inputImageIds: [],
        outputTaskIds: [agentTask.id],
        status: 'running',
        error: null,
        createdAt: 1,
        finishedAt: null,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '重启恢复', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
      ],
    })
    const recovery = deferred<Awaited<ReturnType<typeof getFalQueuedImageResult>>>()
    vi.mocked(getFalQueuedImageResult).mockImplementationOnce(() => recovery.promise)
    await putDbTask(agentTask)
    await putAgentConversation(conversation)

    await initStore()
    await vi.waitFor(() => expect(getFalQueuedImageResult).toHaveBeenCalledTimes(1))
    expect(useStore.getState().agentConversations[0].rounds[0]).toMatchObject({
      status: 'error',
      error: '上次请求已中断',
    })

    const result = await useStore.getState().deleteAgentRound('conversation-a', 'round-a')

    expect(result).toBe('deleted')
    expect(useStore.getState().tasks).toEqual([])
    expect(useStore.getState().agentConversations[0].rounds).toEqual([])
    expect(useStore.getState().agentConversations[0].messages).toEqual([])

    recovery.resolve({
      images: ['data:image/png;base64,late-recovery'],
      actualParams: {},
      actualParamsList: [{}],
      revisedPrompts: [],
    })
    await recovery.promise
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useStore.getState().tasks).toEqual([])
    expect(useStore.getState().agentConversations[0].rounds).toEqual([])
    expect(useStore.getState().agentConversations[0].messages).toEqual([])
    expect(await getAllImageIds()).toEqual([])
  })

  it('continues an Agent round after all fal image tasks recover', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'agent-text-profile', apiKey: 'text-key', apiMode: 'responses' })
    const imageProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    const agentTask = task({
      id: 'agent-fal-task',
      prompt: '画一只猫',
      apiProvider: 'fal',
      apiProfileId: imageProfile.id,
      apiProfileName: imageProfile.name,
      apiModel: imageProfile.model,
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
      agentToolCallId: 'tool-a',
      finishedAt: Date.now(),
      elapsed: 10,
    })
    const conversation = agentConversation({
      id: 'conversation-a',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一只猫',
        inputImageIds: [],
        outputTaskIds: [agentTask.id],
        responseOutput: [{ type: 'function_call', name: 'generate_image', call_id: 'tool-a', arguments: JSON.stringify({ id: 'cat', prompt: '画一只猫' }) }],
        status: 'running',
        error: null,
        createdAt: 1,
        finishedAt: null,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
      ],
    })
    vi.mocked(getFalQueuedImageResult).mockResolvedValue({
      images: ['data:image/png;base64,agent-recovered'],
      actualParams: {},
      actualParamsList: [{}],
      revisedPrompts: [],
    })
    const continuation = deferred<Awaited<ReturnType<typeof callAgentResponsesApi>>>()
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(() => continuation.promise)
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [textProfile, imageProfile],
        activeProfileId: textProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: textProfile.id,
        agentImageProfileId: imageProfile.id,
      }),
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: conversation.id,
      showToast: vi.fn(),
    })
    await putDbTask(agentTask)
    await putAgentConversation(conversation)

    await initStore()
    await vi.waitFor(() => expect(callAgentResponsesApi).toHaveBeenCalledTimes(1))
    expect(useStore.getState().agentConversations[0].rounds[0]).toMatchObject({ status: 'running', error: null })
    expect(await useStore.getState().deleteAgentRound(conversation.id, 'round-a')).toBe('running')
    continuation.resolve({
      text: '已完成。',
      images: [],
      outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '已完成。' }] }],
      responseId: 'response-done',
    })
    await vi.waitFor(() => expect(useStore.getState().agentConversations[0]?.rounds[0]?.status).toBe('done'))

    const recoveredTask = useStore.getState().tasks.find((item) => item.id === agentTask.id)
    expect(recoveredTask).toMatchObject({ status: 'done', falRecoverable: false })
    expect(callAgentResponsesApi).toHaveBeenCalledTimes(1)
    const agentInputJson = JSON.stringify(vi.mocked(callAgentResponsesApi).mock.calls[0][0].input)
    expect(agentInputJson).toContain('function_call_output')
    expect(agentInputJson).toContain('\\"status\\":\\"done\\"')
    const round = useStore.getState().agentConversations[0].rounds[0]
    expect(round).toMatchObject({ status: 'done', error: null, responseId: 'response-done' })
    expect(round.responseOutput).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call_output', call_id: 'tool-a' }),
    ]))
  })

  it('records recovered Agent tool failures without continuing the Agent round', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'agent-text-profile', apiKey: 'text-key', apiMode: 'responses' })
    const imageProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    const agentTask = task({
      id: 'agent-fal-task',
      prompt: '画一只猫',
      apiProvider: 'fal',
      apiProfileId: imageProfile.id,
      apiProfileName: imageProfile.name,
      apiModel: imageProfile.model,
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
      agentToolCallId: 'tool-a',
      finishedAt: Date.now(),
      elapsed: 10,
    })
    const conversation = agentConversation({
      id: 'conversation-a',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一只猫',
        inputImageIds: [],
        outputTaskIds: [agentTask.id],
        responseOutput: [{ type: 'function_call', name: 'generate_image', call_id: 'tool-a', arguments: JSON.stringify({ id: 'cat', prompt: '画一只猫' }) }],
        status: 'running',
        error: null,
        createdAt: 1,
        finishedAt: null,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
      ],
    })
    vi.mocked(getFalQueuedImageResult).mockRejectedValueOnce(new Error('quota exceeded'))
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [textProfile, imageProfile],
        activeProfileId: textProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: textProfile.id,
        agentImageProfileId: imageProfile.id,
      }),
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: 'conversation-a',
      showToast: vi.fn(),
    })
    await putDbTask(agentTask)
    await putAgentConversation(conversation)

    await initStore()
    await vi.waitFor(() => {
      expect(useStore.getState().agentConversations[0]?.rounds[0]).toMatchObject({ status: 'error', error: 'quota exceeded' })
    })

    expect(callAgentResponsesApi).not.toHaveBeenCalled()
    const failedTask = useStore.getState().tasks.find((item) => item.id === agentTask.id)
    expect(failedTask).toMatchObject({ status: 'error', error: 'quota exceeded', falRecoverable: false })
    const round = useStore.getState().agentConversations[0].rounds[0]
    expect(round).toMatchObject({ status: 'error', error: 'quota exceeded' })
    const toolOutput = round.responseOutput?.find((item) => item.type === 'function_call_output')
    expect(toolOutput).toMatchObject({ call_id: 'tool-a' })
    expect(toolOutput?.output).toContain('"status":"error"')
    expect(toolOutput?.output).toContain('quota exceeded')
  })

  it('does not call Agent again when recovered tasks already reached the tool limit', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'agent-text-profile', apiKey: 'text-key', apiMode: 'responses' })
    const imageProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    const agentTask = task({
      id: 'agent-fal-task',
      prompt: '画一只猫',
      apiProvider: 'fal',
      apiProfileId: imageProfile.id,
      apiProfileName: imageProfile.name,
      apiModel: imageProfile.model,
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'limit-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
      agentToolCallId: 'tool-a',
      finishedAt: Date.now(),
      elapsed: 10,
    })
    const conversation = agentConversation({
      id: 'conversation-a',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一只猫',
        inputImageIds: [],
        outputTaskIds: [agentTask.id],
        responseOutput: [{ type: 'function_call', name: 'generate_image', call_id: 'tool-a', arguments: JSON.stringify({ id: 'cat', prompt: '画一只猫' }) }],
        status: 'running',
        error: null,
        createdAt: 1,
        finishedAt: null,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
      ],
    })
    vi.mocked(getFalQueuedImageResult).mockResolvedValueOnce({
      images: ['data:image/png;base64,agent-recovered-limit'],
      actualParams: {},
      actualParamsList: [{}],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [textProfile, imageProfile],
        activeProfileId: textProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: textProfile.id,
        agentImageProfileId: imageProfile.id,
        agentMaxToolRounds: 1,
      }),
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: conversation.id,
      showToast: vi.fn(),
    })
    await putDbTask(agentTask)
    await putAgentConversation(conversation)

    await initStore()
    await vi.waitFor(() => expect(useStore.getState().agentConversations[0]?.rounds[0]?.status).toBe('done'))

    expect(callAgentResponsesApi).not.toHaveBeenCalled()
    const round = useStore.getState().agentConversations[0].rounds[0]
    expect(round).toMatchObject({ status: 'done', error: null })
    expect(useStore.getState().agentConversations[0].messages.find((message) => message.id === 'assistant-a')?.content).toContain('已达到最大工具调用次数（1）')
  })

  it('does not continue a stopped Agent round when a recoverable fal task later completes', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'agent-text-profile', apiKey: 'text-key', apiMode: 'responses' })
    const imageProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    const agentTask = task({
      id: 'agent-fal-task',
      prompt: '画一只猫',
      apiProvider: 'fal',
      apiProfileId: imageProfile.id,
      apiProfileName: imageProfile.name,
      apiModel: imageProfile.model,
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
      agentToolCallId: 'tool-a',
      finishedAt: Date.now(),
      elapsed: 10,
    })
    const conversation = agentConversation({
      id: 'conversation-a',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一只猫',
        inputImageIds: [],
        outputTaskIds: [agentTask.id],
        responseOutput: [{ type: 'function_call', name: 'generate_image', call_id: 'tool-a', arguments: JSON.stringify({ id: 'cat', prompt: '画一只猫' }) }],
        status: 'error',
        error: '已停止生成。',
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '已停止生成。', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
      ],
    })
    vi.mocked(getFalQueuedImageResult).mockResolvedValueOnce({
      images: ['data:image/png;base64,agent-recovered-after-stop'],
      actualParams: {},
      actualParamsList: [{}],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [textProfile, imageProfile],
        activeProfileId: textProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: textProfile.id,
        agentImageProfileId: imageProfile.id,
      }),
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: 'conversation-a',
      showToast: vi.fn(),
    })
    await putDbTask(agentTask)
    await putAgentConversation(conversation)

    await initStore()
    await vi.waitFor(() => {
      expect(useStore.getState().tasks.find((item) => item.id === agentTask.id)).toMatchObject({ status: 'done', falRecoverable: false })
    })

    expect(callAgentResponsesApi).not.toHaveBeenCalled()
    expect(useStore.getState().tasks.find((item) => item.id === agentTask.id)).toMatchObject({ status: 'done', falRecoverable: false })
    expect(useStore.getState().agentConversations[0].rounds[0]).toMatchObject({ status: 'error', error: '已停止生成。' })
  })

  it('does not overwrite a stopped Agent task when an in-flight fal recovery completes', async () => {
    const agentTask = task({
      id: 'agent-fal-task',
      prompt: '画一只猫',
      apiProvider: 'fal',
      apiProfileId: 'fal-profile',
      apiProfileName: 'fal',
      apiModel: 'fal-model',
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
      agentToolCallId: 'tool-a',
      finishedAt: Date.now(),
      elapsed: 10,
    })
    const recovery = deferred<Awaited<ReturnType<typeof getFalQueuedImageResult>>>()
    vi.mocked(getFalQueuedImageResult).mockImplementationOnce(() => recovery.promise)
    const conversation = agentConversation({
      id: 'conversation-a',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一只猫',
        inputImageIds: [],
        outputTaskIds: [agentTask.id],
        status: 'running',
        error: null,
        createdAt: 1,
        finishedAt: null,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
      ],
    })
    useStore.setState({
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: 'conversation-a',
      showToast: vi.fn(),
    })
    await putDbTask(agentTask)
    await putAgentConversation(conversation)

    await initStore()
    await vi.waitFor(() => expect(getFalQueuedImageResult).toHaveBeenCalledTimes(1))
    useStore.setState((state) => ({
      agentConversations: state.agentConversations.map((item) => item.id === 'conversation-a'
        ? { ...item, rounds: item.rounds.map((round) => round.id === 'round-a' ? { ...round, status: 'running', error: null } : round) }
        : item),
    }))
    stopAgentResponse('conversation-a')
    recovery.resolve({
      images: ['data:image/png;base64,should-not-write'],
      actualParams: {},
      actualParamsList: [{}],
      revisedPrompts: [],
    })
    await recovery.promise
    await vi.waitFor(() => {
      expect(useStore.getState().tasks[0]).toMatchObject({ status: 'error', error: '已停止生成。', falRecoverable: false })
    })

    expect(useStore.getState().tasks[0]).toMatchObject({
      status: 'error',
      error: '已停止生成。',
      falRecoverable: false,
      outputImages: [],
    })
  })

  it('clears recoverable Agent image tasks when stopping the Agent round', () => {
    const agentTask = task({
      id: 'agent-fal-task',
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
      agentToolCallId: 'tool-a',
    })
    useStore.setState({
      tasks: [agentTask],
      activeAgentConversationId: 'conversation-a',
      agentConversations: [agentConversation({
        id: 'conversation-a',
        activeRoundId: 'round-a',
        rounds: [{
          id: 'round-a',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-a',
          assistantMessageId: 'assistant-a',
          prompt: '画一只猫',
          inputImageIds: [],
          outputTaskIds: [agentTask.id],
          status: 'running',
          error: null,
          createdAt: 1,
          finishedAt: null,
        }],
        messages: [
          { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', createdAt: 1 },
          { id: 'assistant-a', role: 'assistant', content: '', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
        ],
      })],
      showToast: vi.fn(),
    })

    stopAgentResponse('conversation-a')

    expect(useStore.getState().tasks[0]).toMatchObject({
      status: 'error',
      error: '已停止生成。',
      falRecoverable: false,
    })
    expect(useStore.getState().agentConversations[0].rounds[0]).toMatchObject({
      status: 'error',
      error: '已停止生成。',
    })
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

  it('deletes a round and tasks added after the confirmation snapshot from the latest state', async () => {
    const deleteRound = useStore.getState().deleteAgentRound
    const latestConversation = agentConversation({
      activeRoundId: 'round-3',
      rounds: [
        {
          id: 'round-1',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-1',
          prompt: '第一轮',
          inputImageIds: [],
          outputTaskIds: [],
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
          outputTaskIds: ['task-before-confirm'],
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
          outputTaskIds: [],
          status: 'done',
          error: null,
          createdAt: 5,
          finishedAt: 6,
        },
      ],
      messages: [
        { id: 'user-1', role: 'user', content: '第一轮', roundId: 'round-1', createdAt: 1 },
        { id: 'user-2', role: 'user', content: '第二轮', roundId: 'round-2', createdAt: 3 },
        { id: 'user-3', role: 'user', content: '保留 @第3轮图1', roundId: 'round-3', createdAt: 5 },
      ],
    })
    const unrelatedConversation = agentConversation({ id: 'conversation-b', title: '并发新增对话' })
    useStore.setState({
      appMode: 'agent',
      agentConversations: [latestConversation, unrelatedConversation],
      activeAgentConversationId: latestConversation.id,
      prompt: '继续参考 @第1轮图1、@第2轮图1、@第3轮图1',
      agentInputDrafts: {
        [latestConversation.id]: {
          prompt: '草稿参考 @第2轮图1 和 @第3轮图1',
          inputImages: [imageA],
          maskDraft: null,
          maskEditorImageId: null,
          updatedAt: 99,
        },
      },
      agentEditingRoundId: 'round-2',
      tasks: [
        task({ id: 'task-before-confirm', sourceMode: 'agent', agentConversationId: latestConversation.id, agentRoundId: 'round-2' }),
        task({ id: 'task-unrelated' }),
      ],
    })
    useStore.setState((state) => ({
      tasks: [
        task({ id: 'task-after-confirm', sourceMode: 'agent', agentConversationId: latestConversation.id, agentRoundId: 'round-2' }),
        ...state.tasks,
      ],
    }))

    const result = await deleteRound(latestConversation.id, 'round-2')

    const state = useStore.getState()
    const updated = state.agentConversations.find((item) => item.id === latestConversation.id)!
    expect(updated.rounds.map((round) => ({ id: round.id, index: round.index, parentRoundId: round.parentRoundId }))).toEqual([
      { id: 'round-1', index: 1, parentRoundId: null },
      { id: 'round-3', index: 2, parentRoundId: 'round-1' },
    ])
    expect(updated.activeRoundId).toBe('round-3')
    expect(updated.messages.map((message) => message.id)).toEqual(['user-1', 'user-3'])
    expect(updated.messages.find((message) => message.id === 'user-3')?.content).toBe('保留 @第2轮图1')
    expect(state.prompt).toBe('继续参考 @第1轮图1、@已删除轮次图1、@第2轮图1')
    expect(state.agentInputDrafts[latestConversation.id]).toMatchObject({
      prompt: '草稿参考 @已删除轮次图1 和 @第2轮图1',
      inputImages: [imageA],
      updatedAt: 99,
    })
    expect(state.agentConversations.find((item) => item.id === unrelatedConversation.id)).toBe(unrelatedConversation)
    expect(state.activeAgentConversationId).toBe(latestConversation.id)
    expect(state.agentEditingRoundId).toBeNull()
    expect(state.tasks.map((item) => item.id)).toEqual(['task-unrelated'])
    expect(result).toBe('deleted')
  })

  it('deletes an assistant message using latest associations and cleans mismatched references', async () => {
    const deleteAssistantMessage = useStore.getState().deleteAgentAssistantMessage
    const now = vi.spyOn(Date, 'now').mockReturnValue(20)
    const latestConversation = agentConversation({
      activeRoundId: 'round-2',
      rounds: [
        {
          id: 'round-1',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-a',
          prompt: '第一轮',
          inputImageIds: [],
          outputTaskIds: ['task-message', 'task-keep'],
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
          assistantMessageId: 'assistant-a',
          prompt: '第二轮',
          inputImageIds: [],
          outputTaskIds: ['task-round', 'task-missing'],
          status: 'done',
          error: null,
          createdAt: 3,
          finishedAt: 4,
        },
      ],
      messages: [
        { id: 'user-1', role: 'user', content: '第一轮', roundId: 'round-1', createdAt: 1 },
        { id: 'user-2', role: 'user', content: '第二轮', roundId: 'round-2', createdAt: 3 },
        { id: 'assistant-a', role: 'assistant', content: '待删除', roundId: 'round-2', outputTaskIds: ['task-message', 'task-missing'], createdAt: 4 },
        { id: 'assistant-keep', role: 'assistant', content: '保留', roundId: 'round-1', outputTaskIds: ['task-round', 'task-keep'], createdAt: 5 },
      ],
    })
    useStore.setState({
      agentConversations: [latestConversation],
      agentEditingRoundId: 'round-2',
      tasks: [
        task({ id: 'task-round', sourceMode: 'agent', agentConversationId: latestConversation.id, agentRoundId: 'round-2' }),
        task({ id: 'task-message', sourceMode: 'agent', agentConversationId: latestConversation.id, agentMessageId: 'assistant-a' }),
        task({ id: 'task-keep' }),
      ],
    })
    vi.mocked(commitTaskDeletion).mockClear()

    const result = await deleteAssistantMessage(latestConversation.id, 'assistant-a')

    const state = useStore.getState()
    const updated = state.agentConversations[0]
    expect(updated.updatedAt).toBe(20)
    expect(updated.rounds.every((item) => item.assistantMessageId === undefined)).toBe(true)
    expect(updated.rounds[0].outputTaskIds).toEqual(['task-keep'])
    expect(updated.rounds[1].outputTaskIds).toEqual([])
    expect(updated.messages.map((message) => message.id)).toEqual(['user-1', 'user-2', 'assistant-keep'])
    expect(updated.messages.find((message) => message.id === 'assistant-keep')?.outputTaskIds).toEqual(['task-keep'])
    expect(state.tasks.map((item) => item.id)).toEqual(['task-keep'])
    expect(state.agentEditingRoundId).toBe('round-2')
    expect(result).toBe('deleted')
    const commitCalls = vi.mocked(commitTaskDeletion).mock.calls
    const storedConversation = commitCalls[commitCalls.length - 1]?.[2][0]
    expect(storedConversation).toEqual(updated)
    now.mockRestore()
  })

  it('rejects deletion while the round is running without changing tasks or persistence', async () => {
    const conversation = agentConversation({
      activeRoundId: 'round-running',
      rounds: [{
        id: 'round-running',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-running',
        prompt: '生成中',
        inputImageIds: [],
        outputTaskIds: ['task-running'],
        status: 'running',
        error: null,
        createdAt: 1,
        finishedAt: null,
      }],
      messages: [{ id: 'user-running', role: 'user', content: '生成中', roundId: 'round-running', createdAt: 1 }],
    })
    const runningTask = task({
      id: 'task-running',
      sourceMode: 'agent',
      agentConversationId: conversation.id,
      agentRoundId: 'round-running',
      status: 'running',
      finishedAt: null,
    })
    useStore.setState({ agentConversations: [conversation], tasks: [runningTask] })
    vi.mocked(commitTaskDeletion).mockClear()

    const result = await useStore.getState().deleteAgentRound(conversation.id, 'round-running')

    expect(result).toBe('running')
    expect(useStore.getState().agentConversations[0]).toBe(conversation)
    expect(useStore.getState().tasks).toEqual([runningTask])
    expect(commitTaskDeletion).not.toHaveBeenCalled()
  })

  it('does nothing when the assistant message disappeared after confirmation', async () => {
    const conversation = agentConversation({
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        prompt: '保留',
        inputImageIds: [],
        outputTaskIds: ['task-a'],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [{ id: 'user-a', role: 'user', content: '保留', roundId: 'round-a', createdAt: 1 }],
    })
    const remainingTask = task({ id: 'task-a', sourceMode: 'agent', agentConversationId: conversation.id, agentRoundId: 'round-a' })
    useStore.setState({ agentConversations: [conversation], tasks: [remainingTask] })
    vi.mocked(commitTaskDeletion).mockClear()

    const result = await useStore.getState().deleteAgentAssistantMessage(conversation.id, 'assistant-gone')

    expect(result).toBe('not-found')
    expect(useStore.getState().tasks).toEqual([remainingTask])
    expect(commitTaskDeletion).not.toHaveBeenCalled()
  })

  it('does not overwrite state added while the deletion transaction is pending', async () => {
    const conversation = agentConversation({
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        prompt: '删除',
        inputImageIds: [],
        outputTaskIds: ['task-a'],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [{ id: 'user-a', role: 'user', content: '删除', roundId: 'round-a', createdAt: 1 }],
    })
    useStore.setState({
      agentConversations: [conversation],
      tasks: [task({ id: 'task-a', sourceMode: 'agent', agentConversationId: conversation.id, agentRoundId: 'round-a' })],
    })
    let releaseCommit: (() => void) | undefined
    vi.mocked(commitTaskDeletion).mockImplementationOnce((...args) => new Promise((resolve) => {
      releaseCommit = () => {
        void commitTaskDeletionImplementation(...args).then(resolve)
      }
    }))

    const deletion = useStore.getState().deleteAgentRound(conversation.id, 'round-a')
    useStore.setState((state) => ({
      agentConversations: state.agentConversations.map((item) => item.id === conversation.id
        ? {
            ...item,
            activeRoundId: 'round-concurrent',
            rounds: [...item.rounds, {
              id: 'round-concurrent',
              index: 1,
              parentRoundId: null,
              userMessageId: 'message-concurrent',
              prompt: '并发写入',
              inputImageIds: [],
              outputTaskIds: [],
              status: 'done' as const,
              error: null,
              createdAt: 10,
              finishedAt: 11,
            }],
            messages: [...item.messages, { id: 'message-concurrent', role: 'user' as const, content: '并发写入', roundId: 'round-concurrent', createdAt: 10 }],
          }
        : item),
      tasks: [task({ id: 'task-concurrent' }), ...state.tasks],
    }))
    releaseCommit?.()

    expect(await deletion).toBe('deleted')
    expect(useStore.getState().tasks.map((item) => item.id)).toEqual(['task-concurrent'])
    expect(useStore.getState().agentConversations[0].rounds.map((round) => round.id)).toEqual(['round-concurrent'])
    expect(useStore.getState().agentConversations[0].messages.map((message) => message.id)).toEqual(['message-concurrent'])
  })

  it('reports a warning when both atomic persistence and its fallback fail after deletion', async () => {
    const conversation = agentConversation({
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        prompt: '删除',
        inputImageIds: [],
        outputTaskIds: ['task-a'],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [{ id: 'user-a', role: 'user', content: '删除', roundId: 'round-a', createdAt: 1 }],
    })
    useStore.setState({
      agentConversations: [conversation],
      tasks: [task({ id: 'task-a', sourceMode: 'agent', agentConversationId: conversation.id, agentRoundId: 'round-a' })],
    })
    vi.mocked(commitTaskDeletion).mockRejectedValueOnce(new Error('atomic failed'))
    vi.mocked(deleteDbTask).mockRejectedValueOnce(new Error('fallback failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await useStore.getState().deleteAgentRound(conversation.id, 'round-a')

    expect(result).toBe('deleted-with-warning')
    expect(useStore.getState().tasks).toEqual([])
    expect(useStore.getState().agentConversations[0].rounds).toEqual([])
    expect(warn).toHaveBeenCalledWith('Agent 轮次已删除，但持久化或图片清理失败', expect.any(Error))
    warn.mockRestore()
    vi.mocked(commitTaskDeletion).mockImplementation(commitTaskDeletionImplementation)
    vi.mocked(deleteDbTask).mockImplementation(deleteDbTaskImplementation)
  })

  it('reports a warning when image cleanup fails after persistence succeeds', async () => {
    const conversation = agentConversation({
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        prompt: '删除',
        inputImageIds: [],
        outputTaskIds: ['task-a'],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [{ id: 'user-a', role: 'user', content: '删除', roundId: 'round-a', createdAt: 1 }],
    })
    const imageId = 'image-cleanup-failure'
    await putImage({ id: imageId, dataUrl: 'data:image/png;base64,cleanup', source: 'generated' })
    useStore.setState({
      agentConversations: [conversation],
      tasks: [task({
        id: 'task-a',
        sourceMode: 'agent',
        agentConversationId: conversation.id,
        agentRoundId: 'round-a',
        outputImages: [imageId],
      })],
    })
    vi.mocked(commitTaskDeletion).mockImplementation(commitTaskDeletionImplementation)
    vi.mocked(deleteDbImage).mockRejectedValueOnce(new Error('image cleanup failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await useStore.getState().deleteAgentRound(conversation.id, 'round-a')

    expect(result).toBe('deleted-with-warning')
    expect(useStore.getState().tasks).toEqual([])
    expect(useStore.getState().agentConversations[0].rounds).toEqual([])
    expect(await getImage(imageId)).toBeDefined()
    expect(warn).toHaveBeenCalledWith('Agent 轮次已删除，但持久化或图片清理失败', expect.any(Error))
    warn.mockRestore()
    vi.mocked(deleteDbImage).mockImplementation(deleteDbImageImplementation)
    await clearImages()
  })

  it('collects agent round and conversation tasks even when some failed tasks are not in outputTaskIds', () => {
    const conversation = agentConversation({
      id: 'conversation-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '第一轮',
        inputImageIds: [],
        outputTaskIds: ['task-success', 'task-missing'],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [],
    })
    const tasks = [
      task({ id: 'task-success', agentConversationId: 'conversation-a', agentRoundId: 'round-a', status: 'done', outputImages: ['image-a'] }),
      task({ id: 'task-failed', agentConversationId: 'conversation-a', agentRoundId: 'round-a', status: 'error', error: '失败' }),
      task({ id: 'task-unrelated', agentConversationId: 'other', agentRoundId: 'other-round', status: 'error', error: '失败' }),
    ]

    expect(getAgentRoundTaskIds(conversation.rounds[0], tasks)).toEqual(['task-success', 'task-failed'])
    expect(getAgentConversationTaskIds(conversation, tasks)).toEqual(['task-success', 'task-failed'])
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

  it('restores favorite collections and default collection when importing task data', async () => {
    await clearTasks()
    const importedCollections = [
      { id: 'imported-collection-a', name: '导入收藏夹 A', createdAt: 1, updatedAt: 1 },
      { id: 'imported-collection-b', name: '导入收藏夹 B', createdAt: 2, updatedAt: 2 },
    ]
    const importedTask = task({
      id: 'imported-favorite-task',
      isFavorite: true,
      favoriteCollectionIds: [importedCollections[1].id],
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [importedTask],
      favoriteCollections: importedCollections,
      defaultFavoriteCollectionId: importedCollections[1].id,
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    const state = useStore.getState()
    expect(imported).toBe(true)
    expect(state.favoriteCollections).toEqual(expect.arrayContaining(importedCollections))
    expect(state.defaultFavoriteCollectionId).toBe(importedCollections[1].id)
    expect(state.tasks.find((item) => item.id === importedTask.id)).toMatchObject({
      favoriteCollectionIds: [importedCollections[1].id],
      isFavorite: true,
    })
    expect((await getAllTasks()).find((item) => item.id === importedTask.id)).toMatchObject({
      favoriteCollectionIds: [importedCollections[1].id],
      isFavorite: true,
    })
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

  it('imports a complete multipart backup selected in any order', async () => {
    await clearTasks()
    await clearImages()
    const importedTask = task({ id: 'multipart-task', outputImages: ['multipart-image-a', 'multipart-image-b'] })
    const part1 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 1, total: 2 },
      tasks: [importedTask],
      favoriteCollections: [],
      agentConversations: [],
      imageFiles: { 'multipart-image-a': { path: 'images/image-a.png' } },
    }, { 'images/image-a.png': new Uint8Array([1, 2]) })
    const part2 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 2, total: 2 },
      tasks: [task({ id: 'multipart-task-2' })],
      imageFiles: { 'multipart-image-b': { path: 'images/image-b.png' } },
    }, { 'images/image-b.png': new Uint8Array([3, 4]) })

    const imported = await importData([part2, part1], { importConfig: false, importTasks: true })

    expect(imported).toBe(true)
    expect((await getAllTasks()).some((item) => item.id === importedTask.id)).toBe(true)
    expect((await getAllTasks()).some((item) => item.id === 'multipart-task-2')).toBe(true)
    expect(await getImage('multipart-image-a')).toMatchObject({ dataUrl: 'data:image/png;base64,AQI=' })
    expect(await getImage('multipart-image-b')).toMatchObject({ dataUrl: 'data:image/png;base64,AwQ=' })
  })

  it('imports multiple regular backups together', async () => {
    await clearTasks()
    await clearImages()
    const sharedCollection = { id: 'regular-collection-shared', name: '共享收藏夹', createdAt: 1, updatedAt: 1 }
    const collectionA = { id: 'regular-collection-a', name: '普通备份 A', createdAt: 1, updatedAt: 1 }
    const collectionB = { id: 'regular-collection-b', name: '普通备份 B', createdAt: 2, updatedAt: 2 }
    const sharedTask = task({ id: 'regular-task-shared', outputImages: ['regular-image-shared'] })
    const backupA = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [sharedTask, task({ id: 'regular-task-a', outputImages: ['regular-image-a'], favoriteCollectionIds: [collectionA.id], isFavorite: true })],
      favoriteCollections: [sharedCollection, collectionA],
      defaultFavoriteCollectionId: collectionA.id,
      imageFiles: {
        'regular-image-shared': { path: 'images/shared.png' },
        'regular-image-a': { path: 'images/image-a.png' },
      },
    }, {
      'images/shared.png': new Uint8Array([5, 6]),
      'images/image-a.png': new Uint8Array([1, 2]),
    })
    const backupB = importFile({
      version: 3,
      exportedAt: new Date(1).toISOString(),
      tasks: [sharedTask, task({ id: 'regular-task-b', outputImages: ['regular-image-b'], favoriteCollectionIds: [collectionB.id], isFavorite: true })],
      favoriteCollections: [sharedCollection, collectionB],
      defaultFavoriteCollectionId: collectionB.id,
      imageFiles: {
        'regular-image-shared': { path: 'images/shared.png' },
        'regular-image-b': { path: 'images/image-b.png' },
      },
    }, {
      'images/shared.png': new Uint8Array([5, 6]),
      'images/image-b.png': new Uint8Array([3, 4]),
    })

    const imported = await importData([backupA, backupB], { importConfig: false, importTasks: true })

    const state = useStore.getState()
    const taskIds = (await getAllTasks()).map((item) => item.id)
    const collectionIds = state.favoriteCollections.map((collection) => collection.id)
    expect(imported).toBe(true)
    expect(taskIds).toEqual(expect.arrayContaining(['regular-task-shared', 'regular-task-a', 'regular-task-b']))
    expect(taskIds.filter((id) => id === sharedTask.id)).toHaveLength(1)
    expect(await getImage('regular-image-shared')).toMatchObject({ dataUrl: 'data:image/png;base64,BQY=' })
    expect(await getImage('regular-image-a')).toMatchObject({ dataUrl: 'data:image/png;base64,AQI=' })
    expect(await getImage('regular-image-b')).toMatchObject({ dataUrl: 'data:image/png;base64,AwQ=' })
    expect(collectionIds).toEqual(expect.arrayContaining([sharedCollection.id, collectionA.id, collectionB.id]))
    expect(collectionIds.filter((id) => id === sharedCollection.id)).toHaveLength(1)
  })

  it('deduplicates shared config when merging multiple regular backups', async () => {
    const sharedProfile = createDefaultOpenAIProfile({ id: 'regular-profile-shared', name: '共享配置', apiKey: 'shared-key' })
    const profileA = createDefaultOpenAIProfile({ id: 'regular-profile-a', name: '普通配置 A', apiKey: 'key-a' })
    const profileB = createDefaultOpenAIProfile({ id: 'regular-profile-b', name: '普通配置 B', apiKey: 'key-b' })
    const backupA = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [sharedProfile, profileA], activeProfileId: profileA.id }),
    })
    const backupB = importFile({
      version: 3,
      exportedAt: new Date(1).toISOString(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [sharedProfile, profileB], activeProfileId: profileB.id }),
    })

    const imported = await importData([backupA, backupB], { importConfig: true, importTasks: false })

    const apiKeys = useStore.getState().settings.profiles.map((profile) => profile.apiKey)
    expect(imported).toBe(true)
    expect(apiKeys).toEqual(expect.arrayContaining(['shared-key', 'key-a', 'key-b']))
    expect(apiKeys.filter((apiKey) => apiKey === 'shared-key')).toHaveLength(1)
  })

  it('preserves internal IDs when restoring config', async () => {
    const provider = {
      id: 'backup-provider-id',
      name: 'Backup Provider',
      submit: { path: 'v1/generate' },
    }
    const profile = createDefaultOpenAIProfile({
      id: 'backup-profile-id',
      isDefault: true,
      provider: provider.id,
      model: 'model-v1',
    })
    useStore.setState({ settings: DEFAULT_SETTINGS })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, customProviders: [provider], profiles: [profile], activeProfileId: profile.id }),
    }), { importConfig: true, importTasks: false })
    await useStore.getState().setPresetImportedSettings({
      customProviders: [{ id: provider.id, name: 'Backup Provider', submit: { path: 'v2/generate' } }],
      profiles: [{ ...profile, provider: provider.id, model: 'model-v2' }],
    })

    const settings = useStore.getState().settings
    expect(imported).toBe(true)
    expect(settings.customProviders[0]).toMatchObject({ id: provider.id })
    expect(settings.profiles[0]).toMatchObject({ id: profile.id })
  })

  it('restores dismissed preset provider and profile IDs explicitly included in a backup', async () => {
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'preset-profile', provider: provider.id })
    const otherProfile = createDefaultOpenAIProfile({ id: 'other-preset-profile' })
    setPresetConfig({ customProviders: [provider], profiles: [profile, otherProfile] })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        customProviders: [],
        profiles: [{ ...profile, provider: 'openai' }],
      }),
      dismissedPresetProviderIds: [provider.id],
      dismissedPresetProfileIds: [profile.id, 'other-preset-profile'],
    })

    try {
      const imported = await importData(importFile({
        version: 3,
        exportedAt: new Date(0).toISOString(),
        settings: normalizeSettings({
          ...DEFAULT_SETTINGS,
          customProviders: [provider],
          profiles: [profile],
          activeProfileId: profile.id,
        }),
      }), { importConfig: true, importTasks: false })

      expect(imported).toBe(true)
      expect(useStore.getState().dismissedPresetProviderIds).toEqual([])
      expect(useStore.getState().dismissedPresetProfileIds).toEqual(['other-preset-profile'])
      expect(useStore.getState().settings.customProviders).toEqual([expect.objectContaining({ id: provider.id })])
      expect(useStore.getState().settings.profiles[0].provider).toBe(provider.id)
    } finally {
      setPresetConfig(null)
    }
  })

  it('preserves imported task references when restoring config into a non-empty workspace', async () => {
    await clearTasks()
    const localProfile = createDefaultFalProfile({ id: 'local-profile', apiKey: 'local-key' })
    const provider = { id: 'backup-provider', name: 'Backup Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'backup-profile', provider: provider.id, apiKey: 'backup-key' })
    const importedTask = task({ id: 'backup-task', apiProfileId: profile.id, apiProvider: provider.id })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [localProfile], activeProfileId: localProfile.id }),
      tasks: [],
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, customProviders: [provider], profiles: [profile], activeProfileId: profile.id }),
      tasks: [importedTask],
      imageFiles: {},
    }), { importConfig: true, importTasks: true })

    const state = useStore.getState()
    expect(imported).toBe(true)
    expect(state.settings.profiles.map((item) => item.id)).toEqual(expect.arrayContaining([localProfile.id, profile.id]))
    expect(getTaskApiProfile(state.settings, state.tasks.find((item) => item.id === importedTask.id)!)).toMatchObject({ id: profile.id, provider: provider.id })
  })

  it('rejects an incomplete multipart backup before importing data', async () => {
    await clearTasks()
    const part1 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 1, total: 2 },
      tasks: [task({ id: 'incomplete-task' })],
      imageFiles: {},
    })

    const imported = await importData([part1], { importConfig: false, importTasks: true })

    expect(imported).toBe(false)
    expect((await getAllTasks()).some((item) => item.id === 'incomplete-task')).toBe(false)
  })

  it('validates image entries in every part before writing earlier parts', async () => {
    await clearImages()
    const part1 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 1, total: 2 },
      tasks: [],
      imageFiles: { 'preflight-image-a': { path: 'images/image-a.png' } },
    }, { 'images/image-a.png': new Uint8Array([1, 2]) })
    const part2 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 2, total: 2 },
      imageFiles: { 'preflight-image-b': { path: 'images/missing.png' } },
    })

    const imported = await importData([part1, part2], { importConfig: false, importTasks: true })

    expect(imported).toBe(false)
    expect(await getImage('preflight-image-a')).toBeUndefined()
  })

  it('imports config with running tasks without requiring image parts', async () => {
    useStore.setState({ tasks: [task({ status: 'running' })] })
    const part1 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'config-backup', index: 1, total: 3 },
      settings: DEFAULT_SETTINGS,
      tasks: [],
      imageFiles: { 'unused-image': { path: 'images/missing.png' } },
    })

    const imported = await importData([part1], { importConfig: true, importTasks: false })

    expect(imported).toBe(true)
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
    vi.mocked(callAgentResponsesApi).mockReset().mockResolvedValue({
      text: 'ok',
      images: [],
      outputItems: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      responseId: 'response-b',
    })
  })

  it('does not send removed image_generation results back to the model', async () => {
    await putImage({ id: 'image-live', dataUrl: 'data:image/png;base64,live-base64' })
    await submitAgentMessage()
    await vi.waitFor(() => expect(callAgentResponsesApi).toHaveBeenCalledTimes(1))

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
    await vi.waitFor(() => expect(callAgentResponsesApi).toHaveBeenCalledTimes(1))

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
    await vi.waitFor(() => expect(callAgentResponsesApi).toHaveBeenCalledTimes(1))

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
    await vi.waitFor(() => expect(callAgentResponsesApi).toHaveBeenCalledTimes(1))

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
    await vi.waitFor(() => expect(callAgentResponsesApi).toHaveBeenCalledTimes(1))

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
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentToolCallId: 'deleted-call',
    })
    const liveTask = task({
      id: 'task-live',
      outputImages: ['image-live'],
      rawResponsePayload,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
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
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentToolCallId: 'batch-deleted-call',
      agentBatchCallId: 'batch-fc-1',
    })
    const batchLiveTask = task({
      id: 'batch-task-live',
      outputImages: ['batch-img-live'],
      rawResponsePayload: batchLivePayload,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
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

  it('clears only failed gallery tasks', async () => {
    const failedA = task({ id: 'failed-a', status: 'error', error: '生成失败', outputImages: ['failed-image-a'] })
    const failedB = task({ id: 'failed-b', status: 'error', error: '生成失败', outputImages: ['failed-image-b'] })
    const done = task({ id: 'done-task', status: 'done', outputImages: ['done-image'] })
    const running = task({ id: 'running-task', status: 'running', finishedAt: null, elapsed: null })
    useStore.setState({
      tasks: [failedA, done, failedB, running],
      selectedTaskIds: ['failed-a', 'done-task', 'failed-b'],
      showToast: vi.fn(),
    })

    await clearFailedTasks()

    const state = useStore.getState()
    expect(state.tasks.map((item) => item.id)).toEqual(['done-task', 'running-task'])
    expect(state.selectedTaskIds).toEqual(['done-task'])
    expect(state.showToast).toHaveBeenCalledWith('已删除 2 个任务', 'success')
  })

  it('matches partial failures in failed filters and searches error text', () => {
    const partial = task({
      id: 'partial-task',
      status: 'done',
      outputImages: ['done-image-a', 'done-image-b'],
      outputErrors: [{ requestIndex: 2, error: 'Failed to fetch' }],
    })

    expect(taskMatchesFilterStatus(partial, 'error')).toBe(true)
    expect(taskMatchesFilterStatus(partial, 'done')).toBe(true)
    expect(taskMatchesSearchQuery(partial, 'failed to fetch')).toBe(true)
  })

  it('clears partial failure markers without deleting successful outputs', async () => {
    const partial = task({
      id: 'partial-task',
      status: 'done',
      outputImages: ['done-image-a'],
      outputErrors: [{ requestIndex: 1, error: 'Failed to fetch' }],
    })
    useStore.setState({ tasks: [partial], selectedTaskIds: ['partial-task'], showToast: vi.fn() })

    await clearFailedTasks(['partial-task'])

    const state = useStore.getState()
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ id: 'partial-task', outputImages: ['done-image-a'], outputErrors: undefined })
    expect(state.selectedTaskIds).toEqual([])
    expect(state.showToast).toHaveBeenCalledWith('已清除 1 条部分失败记录', 'success')
  })

  it('keeps failed tasks created after the cleanup snapshot', async () => {
    const failedAtConfirmOpen = task({ id: 'failed-at-confirm-open', status: 'error', error: '生成失败' })
    const failedAfterConfirmOpen = task({ id: 'failed-after-confirm-open', status: 'error', error: '生成失败' })
    useStore.setState({ tasks: [failedAtConfirmOpen] })
    const failedTaskIds = useStore.getState().tasks
      .filter((item) => item.status === 'error')
      .map((item) => item.id)
    useStore.setState({ tasks: [failedAtConfirmOpen, failedAfterConfirmOpen] })

    await clearFailedTasks(failedTaskIds)

    expect(useStore.getState().tasks.map((item) => item.id)).toEqual(['failed-after-confirm-open'])
  })

  afterEach(async () => {
    await vi.waitFor(() => {
      expect(useStore.getState().agentConversations.flatMap((conversation) => conversation.rounds).every((round) => round.status !== 'running')).toBe(true)
    })
  })
})

describe('task deletion', () => {
  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    await clearAgentConversations()
    vi.mocked(callImageApi).mockReset().mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    vi.mocked(commitTaskDeletion).mockReset().mockImplementation(commitTaskDeletionImplementation)
    vi.mocked(deleteDbImage).mockReset().mockImplementation(deleteDbImageImplementation)
    vi.mocked(getFalQueuedImageResult).mockReset().mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockReset().mockImplementation(async (dataUrl) => `transparent:${dataUrl}`)
    useStore.setState({
      tasks: [],
      selectedTaskIds: [],
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      galleryInputDraft: null,
      agentInputDrafts: {},
      agentConversations: [],
      streamPreviews: {},
      streamPreviewSlots: {},
      detailTaskId: null,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('removes a deleted task from the current selection', async () => {
    const deleted = task({ id: 'task-deleted' })
    const remaining = task({ id: 'task-remaining' })
    await putDbTask(deleted)
    await putDbTask(remaining)
    useStore.setState({ tasks: [deleted, remaining], selectedTaskIds: [deleted.id, remaining.id] })

    await removeTask(deleted)

    const state = useStore.getState()
    expect(state.tasks.map((item) => item.id)).toEqual([remaining.id])
    expect(state.selectedTaskIds).toEqual([remaining.id])
    expect((await getAllTasks()).map((item) => item.id)).toEqual([remaining.id])
    expect(state.showToast).toHaveBeenCalledWith('任务已删除', 'success')
  })

  it('still deletes the target DB record when sibling payload persistence fails', async () => {
    const rawResponsePayload = JSON.stringify({
      output: [
        { type: 'image_generation_call', id: 'deleted-call', result: 'deleted' },
        { type: 'image_generation_call', id: 'live-call', result: 'live' },
      ],
    })
    const deleted = task({
      id: 'task-deleted',
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentToolCallId: 'deleted-call',
    })
    const remaining = task({
      id: 'task-live',
      rawResponsePayload,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentToolCallId: 'live-call',
    })
    const conversation = agentConversation({
      rounds: [{
        id: 'round-a',
        index: 1,
        userMessageId: 'message-a',
        prompt: 'prompt',
        inputImageIds: [],
        outputTaskIds: [deleted.id, remaining.id],
        responseOutput: JSON.parse(rawResponsePayload).output,
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
    })
    await putDbTask(deleted)
    await putDbTask(remaining)
    await putAgentConversation(conversation)
    useStore.setState({ tasks: [deleted, remaining], agentConversations: [conversation] })
    vi.mocked(commitTaskDeletion).mockRejectedValueOnce(new Error('payload write failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await removeTask(deleted)

    expect((await getAllTasks()).map((item) => item.id)).toEqual([remaining.id])
    expect(useStore.getState().tasks[0].rawResponsePayload).not.toContain('deleted-call')
    expect((await getAllTasks())[0].rawResponsePayload).not.toContain('deleted-call')
    expect(JSON.stringify(await getAllAgentConversations())).not.toContain('deleted-call')
    expect(warn).toHaveBeenCalledWith('原子清理任务关联数据失败，改用逐项持久化', expect.any(Error))
    warn.mockRestore()
  })

  it('keeps Agent conversation references unchanged for unrelated gallery deletion', async () => {
    const conversations = [agentConversation({
      rounds: [{
        id: 'round-a',
        index: 1,
        userMessageId: 'message-a',
        prompt: 'prompt',
        inputImageIds: [],
        outputTaskIds: ['agent-task'],
        responseOutput: [{ type: 'image_generation_call', id: 'agent-call', result: 'agent-result' }],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
    })]
    const galleryTask = task({ id: 'gallery-task' })
    useStore.setState({ tasks: [galleryTask], agentConversations: conversations })

    await removeTask(galleryTask)

    expect(useStore.getState().agentConversations).toBe(conversations)
  })

  it('matches anonymous image items after identified items when scrubbing', async () => {
    const live = task({
      id: 'task-live',
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentToolCallId: 'live-call',
    })
    const deleted = task({
      id: 'task-deleted',
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
    })
    useStore.setState({
      tasks: [live, deleted],
      agentConversations: [agentConversation({
        rounds: [{
          id: 'round-a',
          index: 1,
          userMessageId: 'message-a',
          prompt: 'prompt',
          inputImageIds: [],
          outputTaskIds: [live.id, deleted.id],
          responseOutput: [
            { type: 'image_generation_call', id: 'live-call', result: 'live-result' },
            { type: 'image_generation_call', result: 'anonymous-deleted-result' },
          ],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
      })],
    })

    await removeTask(deleted)

    const output = JSON.stringify(useStore.getState().agentConversations[0].rounds[0].responseOutput)
    expect(output).toContain('live-result')
    expect(output).not.toContain('anonymous-deleted-result')
  })

  it.each([
    { label: 'first', deletedIndex: 0, liveId: 'duplicate_2', livePrompt: 'second prompt' },
    { label: 'second', deletedIndex: 1, liveId: 'duplicate', livePrompt: 'first prompt' },
  ])('migrates legacy duplicate batch ids when deleting the $label occurrence', async ({ deletedIndex, liveId, livePrompt }) => {
    const functionCall = {
      type: 'function_call',
      name: 'generate_image_batch',
      call_id: 'legacy-batch-call',
      arguments: JSON.stringify({ images: [
        { id: ' duplicate ', prompt: ' first prompt ' },
        { id: 'duplicate', prompt: 'second prompt' },
        { prompt: 'missing prompt' },
        { id: 'skipped', prompt: '   ' },
      ] }),
    }
    const functionOutput = {
      type: 'function_call_output',
      call_id: 'legacy-batch-call',
      output: JSON.stringify({ images: [
        { id: 'duplicate', status: 'done' },
        { id: 'duplicate', status: 'done' },
        { id: 'image_3', status: 'done' },
      ] }),
    }
    const rawResponsePayload = JSON.stringify({ output: [functionCall, functionOutput] })
    const batchTasks = [
      task({
        id: 'legacy-task-first',
        prompt: 'first prompt',
        rawResponsePayload,
        sourceMode: 'agent',
        agentConversationId: 'conversation-a',
        agentRoundId: 'round-a',
        agentToolCallId: 'legacy-tool-first',
        agentBatchCallId: 'legacy-batch-call',
      }),
      task({
        id: 'legacy-task-second',
        prompt: 'second prompt',
        rawResponsePayload,
        sourceMode: 'agent',
        agentConversationId: 'conversation-a',
        agentRoundId: 'round-a',
        agentToolCallId: 'legacy-tool-second',
        agentBatchCallId: 'legacy-batch-call',
      }),
      task({
        id: 'legacy-task-missing',
        prompt: 'missing prompt',
        rawResponsePayload,
        sourceMode: 'agent',
        agentConversationId: 'conversation-a',
        agentRoundId: 'round-a',
        agentToolCallId: 'legacy-tool-missing',
        agentBatchCallId: 'legacy-batch-call',
      }),
    ]
    const trigger = task({
      id: 'legacy-cleanup-trigger',
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentBatchCallId: 'legacy-batch-call',
    })
    useStore.setState({
      tasks: [...batchTasks, trigger],
      agentConversations: [agentConversation({
        rounds: [{
          id: 'round-a',
          index: 1,
          userMessageId: 'message-a',
          prompt: 'prompt',
          inputImageIds: [],
          outputTaskIds: batchTasks.map((item) => item.id),
          responseOutput: [functionCall, functionOutput],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
      })],
    })
    for (const item of batchTasks) await putDbTask(item)

    await removeTask(batchTasks[deletedIndex])

    const roundOutput = useStore.getState().agentConversations[0].rounds[0].responseOutput ?? []
    const cleanedCall = roundOutput.find((item) => item.type === 'function_call')
    const cleanedOutput = roundOutput.find((item) => item.type === 'function_call_output')
    expect(JSON.parse(cleanedCall?.arguments ?? '{}').images).toEqual([
      { id: liveId, prompt: livePrompt },
      { id: 'image_3', prompt: 'missing prompt' },
    ])
    expect(JSON.parse(typeof cleanedOutput?.output === 'string' ? cleanedOutput.output : '{}').images).toEqual([
      { id: liveId, status: 'done' },
      { id: 'image_3', status: 'done' },
    ])
    expect(useStore.getState().tasks.find((item) => item.id.startsWith('legacy-task'))?.agentBatchItemId).toBeUndefined()
    const firstCleanup = JSON.stringify(roundOutput)

    await removeTask(trigger)

    expect(JSON.stringify(useStore.getState().agentConversations[0].rounds[0].responseOutput)).toBe(firstCleanup)
    const persistedPayload = (await getAllTasks()).find((item) => item.id.startsWith('legacy-task'))?.rawResponsePayload ?? ''
    expect(JSON.parse(persistedPayload).output.find((item: { type: string }) => item.type === 'function_call_output')).toMatchObject({
      output: JSON.stringify({ images: [
        { id: liveId, status: 'done' },
        { id: 'image_3', status: 'done' },
      ] }),
    })
  })

  it('restores an orphan image and thumbnail referenced during the check-delete window', async () => {
    const deleteImage = vi.mocked(deleteDbImage).getMockImplementation()!
    vi.mocked(deleteDbImage).mockImplementationOnce(async (id) => {
      await deleteImage(id)
      useStore.setState({ tasks: [task({ id: 'new-task', inputImageIds: [id] })] })
    })
    await putImage({ id: 'referenced-late', dataUrl: 'data:image/png;base64,second', createdAt: 1 })
    await putImageThumbnail({
      id: 'referenced-late',
      thumbnailDataUrl: 'data:image/webp;base64,thumb',
      width: 10,
      height: 10,
      thumbnailVersion: 2,
    })
    const deleted = task({ id: 'task-deleted', outputImages: ['referenced-late'] })
    useStore.setState({ tasks: [deleted] })

    await removeTask(deleted)

    await expect(getImage('referenced-late')).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,second' })
    await expect(getStoredFreshImageThumbnail('referenced-late')).resolves.toMatchObject({ thumbnailDataUrl: 'data:image/webp;base64,thumb' })
    expect(deleteDbImage).toHaveBeenCalledTimes(1)
  })

  it('does not open deleted gallery task details after a late rejection', async () => {
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
    })

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    await removeTask(useStore.getState().tasks[0])
    request.reject(new Error('late gallery rejection'))
    await request.promise.catch(() => {})

    expect(useStore.getState().tasks).toEqual([])
    expect(useStore.getState().detailTaskId).toBeNull()
  })

  it('does not schedule fal recovery after a deleted task rejects late', async () => {
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    vi.mocked(callImageApi).mockImplementationOnce((opts) => {
      opts.onFalRequestEnqueued?.({ requestId: 'fal-request', endpoint: 'fal-endpoint' })
      return request.promise
    })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [falProfile], activeProfileId: falProfile.id }),
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
    })

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    await removeTask(useStore.getState().tasks[0])
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    request.reject(new Error('Failed to fetch'))
    await request.promise.catch(() => {})

    expect(useStore.getState().tasks).toEqual([])
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    setTimeoutSpy.mockRestore()
  })

  it('does not schedule custom recovery after a deleted task rejects late', async () => {
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const customProfile = {
      ...createDefaultOpenAIProfile({ id: 'custom-profile', apiKey: 'custom-key', apiMode: 'images' }),
      provider: 'custom-async',
    }
    vi.mocked(callImageApi).mockImplementationOnce((opts) => {
      opts.onCustomTaskEnqueued?.({ taskId: 'custom-task' })
      return request.promise
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [customProfile],
        activeProfileId: customProfile.id,
        customProviders: [{
          id: 'custom-async',
          name: 'Custom Async',
          submit: { path: 'submit', taskIdPath: 'data.id' },
          poll: {
            path: 'tasks/{task_id}',
            statusPath: 'data.status',
            successValues: ['done'],
            failureValues: ['failed'],
            result: { imageUrlPaths: ['data.images.*.url'] },
          },
        }],
      }),
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
    })

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    await removeTask(useStore.getState().tasks[0])
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    request.reject(new Error('Failed to fetch'))
    await request.promise.catch(() => {})

    expect(useStore.getState().tasks).toEqual([])
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(useStore.getState().detailTaskId).toBeNull()
    setTimeoutSpy.mockRestore()
  })

  it('preserves concurrent task deletion, creation, and updates', async () => {
    const rawResponsePayload = JSON.stringify({
      output: [
        { type: 'image_generation_call', id: 'call-a', result: 'base64-a' },
        { type: 'image_generation_call', id: 'call-b', result: 'base64-b' },
      ],
    })
    const deletedA = task({ id: 'task-a', sourceMode: 'agent', agentConversationId: 'conversation-a', agentRoundId: 'round-a', agentToolCallId: 'call-a' })
    const deletedB = task({ id: 'task-b', sourceMode: 'agent', agentConversationId: 'conversation-a', agentRoundId: 'round-a', agentToolCallId: 'call-b' })
    const existing = task({ id: 'task-existing', rawResponsePayload, sourceMode: 'agent', agentConversationId: 'conversation-a', agentRoundId: 'round-a' })
    const created = task({ id: 'task-created' })
    await putDbTask(deletedA)
    await putDbTask(deletedB)
    await putDbTask(existing)
    useStore.setState({
      tasks: [deletedA, deletedB, existing],
      selectedTaskIds: [deletedA.id, deletedB.id],
      agentConversations: [agentConversation({
        rounds: [{
          id: 'round-a',
          index: 1,
          userMessageId: 'message-a',
          prompt: 'prompt',
          inputImageIds: [],
          outputTaskIds: [deletedA.id, deletedB.id],
          responseOutput: JSON.parse(rawResponsePayload).output,
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
      })],
    })
    const firstCommitStarted = deferred<void>()
    const releaseFirstCommit = deferred<void>()
    let transactionQueue = Promise.resolve()
    let commitCount = 0
    vi.mocked(commitTaskDeletion).mockImplementation((...args) => {
      const commitIndex = ++commitCount
      const transaction = transactionQueue.then(async () => {
        if (commitIndex === 1) {
          firstCommitStarted.resolve()
          await releaseFirstCommit.promise
        }
        await commitTaskDeletionImplementation(...args)
        return undefined
      })
      transactionQueue = transaction.catch(() => {})
      return transaction
    })

    const deletionA = removeTask(deletedA)
    await firstCommitStarted.promise
    useStore.setState((state) => ({
      tasks: [created, ...state.tasks.map((item) => item.id === existing.id ? { ...item, prompt: 'updated' } : item)],
    }))
    const createTask = putDbTask(created)
    const updateTask = putDbTask({ ...existing, prompt: 'updated' })
    const deletionB = removeTask(deletedB)
    releaseFirstCommit.resolve()
    await Promise.all([deletionA, deletionB, createTask, updateTask])
    await transactionQueue

    const state = useStore.getState()
    expect(state.tasks.map((item) => item.id)).toEqual([created.id, existing.id])
    expect(state.tasks.find((item) => item.id === existing.id)?.prompt).toBe('updated')
    expect(state.tasks.find((item) => item.id === existing.id)?.rawResponsePayload).not.toContain('call-a')
    expect(state.tasks.find((item) => item.id === existing.id)?.rawResponsePayload).not.toContain('call-b')
    expect(JSON.stringify(state.agentConversations)).not.toContain('call-a')
    expect(JSON.stringify(state.agentConversations)).not.toContain('call-b')
    expect(state.selectedTaskIds).toEqual([])
    expect(commitTaskDeletion).toHaveBeenCalledTimes(2)
    const firstStoredUpdate = vi.mocked(commitTaskDeletion).mock.calls[0][1].find((item) => item.id === existing.id)
    const secondStoredUpdate = vi.mocked(commitTaskDeletion).mock.calls[1][1].find((item) => item.id === existing.id)
    expect(firstStoredUpdate?.rawResponsePayload).not.toContain('call-a')
    expect(firstStoredUpdate?.rawResponsePayload).toContain('call-b')
    expect(secondStoredUpdate?.prompt).toBe('updated')
    expect(secondStoredUpdate?.rawResponsePayload).not.toContain('call-a')
    expect(secondStoredUpdate?.rawResponsePayload).not.toContain('call-b')
    const storedTasks = await getAllTasks()
    expect(storedTasks.map((item) => item.id).sort()).toEqual([created.id, existing.id].sort())
    expect(storedTasks.find((item) => item.id === existing.id)?.prompt).toBe('updated')
    expect(storedTasks.find((item) => item.id === existing.id)?.rawResponsePayload).not.toContain('call-a')
    expect(storedTasks.find((item) => item.id === existing.id)?.rawResponsePayload).not.toContain('call-b')
    const storedConversations = await getAllAgentConversations()
    expect(JSON.stringify(storedConversations)).not.toContain('call-a')
    expect(JSON.stringify(storedConversations)).not.toContain('call-b')
  })

  it('counts duplicate and missing ids only when they match an existing task', async () => {
    const deleted = task({ id: 'task-deleted' })
    const remaining = task({ id: 'task-remaining' })
    await putDbTask(deleted)
    await putDbTask(remaining)
    useStore.setState({ tasks: [deleted, remaining], selectedTaskIds: [deleted.id, 'task-missing'] })

    await removeMultipleTasks([deleted.id, deleted.id, 'task-missing'])

    const state = useStore.getState()
    expect(state.tasks.map((item) => item.id)).toEqual([remaining.id])
    expect(state.selectedTaskIds).toEqual([])
    expect((await getAllTasks()).map((item) => item.id)).toEqual([remaining.id])
    expect(state.showToast).toHaveBeenCalledWith('已删除 1 个任务', 'success')
  })

  it('does not show a success toast when no task id exists', async () => {
    const showToast = vi.fn()
    useStore.setState({ selectedTaskIds: ['task-missing'], showToast })

    await removeMultipleTasks(['task-missing', 'task-missing'])
    await removeTask(task({ id: 'another-missing-task' }))

    expect(useStore.getState().selectedTaskIds).toEqual([])
    expect(showToast).not.toHaveBeenCalled()
  })

  it('removes gallery output images stored while the task is being deleted', async () => {
    const { callImageApi } = await import('./lib/api')
    const postProcess = deferred<string>()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,late-gallery-output'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockImplementationOnce(() => postProcess.promise)
    useStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile, transparentBackgroundMethod: 'local' })),
      },
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'png', transparent_output: true },
    })

    await submitTask()
    await vi.waitFor(() => expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledTimes(1))
    const runningTask = useStore.getState().tasks[0]
    expect(runningTask?.status).toBe('running')
    expect(await getAllImageIds()).toHaveLength(1)

    await removeTask(runningTask)
    postProcess.resolve('data:image/png;base64,late-transparent-output')
    await postProcess.promise
    await vi.waitFor(async () => expect(await getAllImageIds()).toEqual([]))

    expect(useStore.getState().tasks).toEqual([])
    expect(await getAllImageIds()).toEqual([])
  })

  it('clears stream previews and ignores partial images arriving after deletion', async () => {
    const { callImageApi } = await import('./lib/api')
    let emitPartialImage: () => void = () => {}
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce((opts) => {
      emitPartialImage = () => opts.onPartialImage?.({ image: 'data:image/png;base64,partial', requestIndex: 1 })
      return request.promise
    })
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
    })

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    const runningTask = useStore.getState().tasks[0]
    emitPartialImage()
    expect(useStore.getState().streamPreviews[runningTask.id]).toContain('partial')
    expect(useStore.getState().streamPreviewSlots[runningTask.id]?.['1']).toContain('partial')

    await removeTask(runningTask)
    expect(useStore.getState().streamPreviews[runningTask.id]).toBeUndefined()
    expect(useStore.getState().streamPreviewSlots[runningTask.id]).toBeUndefined()
    emitPartialImage()
    expect(useStore.getState().streamPreviews[runningTask.id]).toBeUndefined()
    expect(useStore.getState().streamPreviewSlots[runningTask.id]).toBeUndefined()

    request.resolve({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await request.promise
    await vi.waitFor(() => {
      expect(useStore.getState().tasks).toEqual([])
      expect(useStore.getState().streamPreviews[runningTask.id]).toBeUndefined()
      expect(useStore.getState().streamPreviewSlots[runningTask.id]).toBeUndefined()
    })
  })

  afterEach(async () => {
    await vi.waitFor(() => {
      expect(useStore.getState().agentConversations.flatMap((conversation) => conversation.rounds).every((round) => round.status !== 'running')).toBe(true)
    })
  })

  it('keeps deleted-task images that remain referenced by tasks, Agent state, or drafts', async () => {
    const imageIds = ['shared-task', 'shared-agent', 'shared-agent-draft', 'shared-gallery-draft', 'orphan']
    for (const id of imageIds) await putImage({ id, dataUrl: `data:image/png;base64,${id}` })

    const deleted = task({ id: 'task-deleted', outputImages: imageIds })
    const remaining = task({ id: 'task-remaining', inputImageIds: ['shared-task'] })
    useStore.setState({
      tasks: [deleted, remaining],
      agentConversations: [agentConversation({
        rounds: [{
          id: 'round-a',
          index: 1,
          userMessageId: 'message-a',
          prompt: 'prompt',
          inputImageIds: ['shared-agent'],
          outputTaskIds: [],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
      })],
      agentInputDrafts: {
        'conversation-draft': {
          prompt: '',
          inputImages: [{ id: 'shared-agent-draft', dataUrl: '' }],
          maskDraft: null,
          maskEditorImageId: null,
          updatedAt: 1,
        },
      },
      galleryInputDraft: {
        prompt: '',
        inputImages: [{ id: 'shared-gallery-draft', dataUrl: '' }],
        maskDraft: null,
        maskEditorImageId: null,
        updatedAt: 1,
      },
    })

    await removeTask(deleted)

    await expect(getImage('shared-task')).resolves.toBeDefined()
    await expect(getImage('shared-agent')).resolves.toBeDefined()
    await expect(getImage('shared-agent-draft')).resolves.toBeDefined()
    await expect(getImage('shared-gallery-draft')).resolves.toBeDefined()
    await expect(getImage('orphan')).resolves.toBeUndefined()
  })

  it('scrubs Agent raw payloads through the batch deletion path', async () => {
    const rawResponsePayload = JSON.stringify({
      output: [
        { type: 'image_generation_call', id: 'deleted-call', result: 'deleted-base64' },
        { type: 'image_generation_call', id: 'live-call', result: 'live-base64' },
      ],
    }, null, 2)
    const deleted = task({
      id: 'task-deleted',
      rawResponsePayload,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentToolCallId: 'deleted-call',
    })
    const remaining = task({
      id: 'task-remaining',
      rawResponsePayload,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentToolCallId: 'live-call',
    })
    await putDbTask(deleted)
    await putDbTask(remaining)
    useStore.setState({
      tasks: [deleted, remaining],
      agentConversations: [agentConversation({
        rounds: [{
          id: 'round-a',
          index: 1,
          userMessageId: 'message-a',
          prompt: 'prompt',
          inputImageIds: [],
          outputTaskIds: [deleted.id, remaining.id],
          responseOutput: JSON.parse(rawResponsePayload).output,
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
      })],
    })

    await removeMultipleTasks([deleted.id])

    const state = useStore.getState()
    const remainingPayload = state.tasks[0].rawResponsePayload ?? ''
    expect(remainingPayload).not.toContain('deleted-base64')
    expect(remainingPayload).toContain('live-base64')
    expect(JSON.stringify(state.agentConversations)).not.toContain('deleted-base64')
    const persistedPayload = (await getAllTasks())[0].rawResponsePayload ?? ''
    expect(persistedPayload).not.toContain('deleted-call')
    expect(persistedPayload).toContain('live-call')
  })
})

describe('agent built-in image tool failure', () => {
  const responsesProfile = createDefaultOpenAIProfile({
    id: 'responses-profile',
    apiKey: 'test-key',
    apiMode: 'responses',
    model: DEFAULT_RESPONSES_MODEL,
    streamImages: true,
  })

  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    await clearAgentConversations()
    vi.mocked(callAgentResponsesApi).mockReset()
    vi.mocked(callImageApi).mockReset()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        model: DEFAULT_RESPONSES_MODEL,
        streamImages: true,
        profiles: [responsesProfile],
        activeProfileId: responsesProfile.id,
      }),
      prompt: '画一张图',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      appMode: 'agent',
      tasks: [],
      streamPreviews: {},
      streamPreviewSlots: {},
      agentConversations: [agentConversation({
        id: 'conversation-a',
        activeRoundId: null,
        rounds: [],
        messages: [],
      })],
      activeAgentConversationId: 'conversation-a',
      agentEditingRoundId: null,
      showToast: vi.fn(),
    })
  })

  it('normalizes Agent image params with the Hybrid image profile', async () => {
    const imageProfile = createDefaultOpenAIProfile({
      id: 'codex-image-profile',
      apiKey: 'image-key',
      apiMode: 'images',
      codexCli: true,
    })
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        profiles: [responsesProfile, imageProfile],
        activeProfileId: responsesProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: responsesProfile.id,
        agentImageProfileId: imageProfile.id,
      }),
      params: { ...DEFAULT_PARAMS, size: '2048x2048' },
    })
    vi.mocked(callAgentResponsesApi).mockResolvedValueOnce({
      text: '',
      images: [],
      outputItems: [],
      responseId: 'response-normalized-params',
    })

    await submitAgentMessage()
    await vi.waitFor(() => expect(callAgentResponsesApi).toHaveBeenCalledTimes(1))

    expect(vi.mocked(callAgentResponsesApi).mock.calls[0][0].params.size).toBe('1024x1024')
  })

  it('does not apply Codex text-profile limits to a non-Codex image profile', async () => {
    const textProfile = createDefaultOpenAIProfile({
      ...responsesProfile,
      id: 'codex-text-profile',
      codexCli: true,
    })
    const imageProfile = createDefaultOpenAIProfile({
      id: 'standard-image-profile',
      apiKey: 'image-key',
      apiMode: 'images',
    })
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        profiles: [textProfile, imageProfile],
        activeProfileId: textProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: textProfile.id,
        agentImageProfileId: imageProfile.id,
      }),
      params: { ...DEFAULT_PARAMS, size: '2048x2048', quality: 'high' },
    })
    vi.mocked(callAgentResponsesApi).mockResolvedValueOnce({
      text: '',
      images: [],
      outputItems: [],
      responseId: 'response-standard-image-params',
    })

    await submitAgentMessage()
    await vi.waitFor(() => expect(callAgentResponsesApi).toHaveBeenCalledTimes(1))

    expect(vi.mocked(callAgentResponsesApi).mock.calls[0][0].params).toMatchObject({
      size: '2048x2048',
      quality: 'high',
    })
  })

  it('does not commit or report a deleted Hybrid single-image result', async () => {
    const imageProfile = createDefaultOpenAIProfile({ id: 'image-profile', apiKey: 'image-key', apiMode: 'images' })
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        profiles: [responsesProfile, imageProfile],
        activeProfileId: responsesProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: responsesProfile.id,
        agentImageProfileId: imageProfile.id,
        agentMaxToolRounds: 1,
      }),
    })
    vi.mocked(callAgentResponsesApi).mockResolvedValueOnce({
      text: '',
      images: [],
      outputItems: [{
        type: 'function_call',
        name: 'generate_image',
        call_id: 'hybrid-single-call',
        arguments: JSON.stringify({ id: 'single', prompt: 'single prompt' }),
      }],
      responseId: 'response-function',
    })
    vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)

    await submitAgentMessage()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    const runningTask = useStore.getState().tasks.find((item) => item.agentToolCallId === 'hybrid-single-call')
    expect(runningTask).toBeDefined()
    await removeTask(runningTask!)
    request.resolve({
      images: ['data:image/png;base64,deleted-hybrid-single'],
      actualParams: {},
      actualParamsList: [{}],
      revisedPrompts: ['single prompt'],
    })

    await vi.waitFor(() => expect(useStore.getState().agentConversations[0].rounds[0]?.status).toBe('done'))
    const conversation = useStore.getState().agentConversations[0]
    expect(useStore.getState().tasks).toEqual([])
    expect(callAgentResponsesApi).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(conversation.rounds[0].responseOutput)).not.toContain('hybrid-single-call')
    expect(conversation.messages.find((message) => message.role === 'assistant')?.content).not.toContain('已达到最大工具调用次数')
  })

  it('reports only committed Hybrid batch results and counts only those tools', async () => {
    const imageProfile = createDefaultOpenAIProfile({ id: 'image-profile', apiKey: 'image-key', apiMode: 'images' })
    const deletedRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const liveRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        profiles: [responsesProfile, imageProfile],
        activeProfileId: responsesProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: responsesProfile.id,
        agentImageProfileId: imageProfile.id,
        agentMaxToolRounds: 3,
      }),
    })
    vi.mocked(callAgentResponsesApi)
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'generate_image_batch',
          call_id: 'hybrid-batch-call',
          arguments: JSON.stringify({ images: [
            { id: 'deleted-item', prompt: 'deleted prompt' },
            { id: 'live-item', prompt: 'live prompt' },
          ] }),
        }],
        responseId: 'response-batch-function',
      })
      .mockResolvedValueOnce({
        text: 'batch complete',
        images: [],
        outputItems: [{ type: 'message', content: [{ type: 'output_text', text: 'batch complete' }] }],
        responseId: 'response-batch-done',
      })
    vi.mocked(callImageApi)
      .mockImplementationOnce(() => deletedRequest.promise)
      .mockImplementationOnce(() => liveRequest.promise)

    await submitAgentMessage()
    await vi.waitFor(() => expect(useStore.getState().tasks.filter((item) => item.agentBatchCallId === 'hybrid-batch-call')).toHaveLength(2))
    const deletedTask = useStore.getState().tasks.find((item) => item.prompt === 'deleted prompt')
    expect(deletedTask).toBeDefined()
    expect(deletedTask).toMatchObject({ agentBatchCallId: 'hybrid-batch-call' })
    await removeTask(deletedTask!)
    expect(JSON.stringify(useStore.getState().agentConversations[0].rounds[0].responseOutput)).not.toContain('deleted-item')
    deletedRequest.resolve({ images: ['data:image/png;base64,deleted-batch'], actualParams: {}, actualParamsList: [{}], revisedPrompts: ['deleted prompt'] })
    liveRequest.resolve({ images: ['data:image/png;base64,live-batch'], actualParams: {}, actualParamsList: [{}], revisedPrompts: ['live prompt'] })

    await vi.waitFor(() => expect(callAgentResponsesApi).toHaveBeenCalledTimes(2))
    const continuationInput = JSON.stringify(vi.mocked(callAgentResponsesApi).mock.calls[1][0].input)
    expect(continuationInput).not.toContain('deleted-item')
    expect(continuationInput).not.toContain('deleted prompt')
    expect(continuationInput).toContain('live-item')
    expect(continuationInput).toContain('\\"status\\":\\"done\\"')
    expect(continuationInput).toContain('Tool-call budget: 1/3 used.')
    await vi.waitFor(() => expect(useStore.getState().agentConversations[0].rounds[0]?.status).toBe('done'))
    expect(useStore.getState().tasks).toHaveLength(1)
    expect(useStore.getState().tasks[0]).toMatchObject({ prompt: 'live prompt', status: 'done' })
    const finalOutput = JSON.stringify(useStore.getState().agentConversations[0].rounds[0].responseOutput)
    expect(finalOutput).not.toContain('deleted-item')
    expect(finalOutput).toContain('live-item')
    expect(finalOutput).toContain('function_call_output')
  })

  it('canonicalizes batch identities across tasks, round output, and continuation without deletion', async () => {
    const imageProfile = createDefaultOpenAIProfile({ id: 'image-profile', apiKey: 'image-key', apiMode: 'images' })
    const requests = Array.from({ length: 4 }, () => deferred<Awaited<ReturnType<typeof callImageApi>>>())
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        profiles: [responsesProfile, imageProfile],
        activeProfileId: responsesProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: responsesProfile.id,
        agentImageProfileId: imageProfile.id,
      }),
    })
    vi.mocked(callAgentResponsesApi)
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'generate_image_batch',
          call_id: 'normalized-batch-call',
          arguments: JSON.stringify({ images: [
            { id: ' duplicate ', prompt: ' deleted duplicate ' },
            { id: 'duplicate', prompt: 'live duplicate' },
            { id: '   ', prompt: 'blank id' },
            { prompt: 'missing id' },
            { id: 'ignored', prompt: '   ' },
          ] }),
        }],
        responseId: 'response-normalized-batch',
      })
      .mockResolvedValueOnce({
        text: 'complete',
        images: [],
        outputItems: [{ type: 'message', content: [{ type: 'output_text', text: 'complete' }] }],
        responseId: 'response-normalized-complete',
      })
    for (const request of requests) vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)

    await submitAgentMessage()
    await vi.waitFor(() => expect(useStore.getState().tasks.filter((item) => item.agentBatchCallId === 'normalized-batch-call')).toHaveLength(4))
    for (let index = 0; index < requests.length; index++) {
      requests[index].resolve({
        images: [`data:image/png;base64,normalized-${index}`],
        actualParams: {},
        actualParamsList: [{}],
        revisedPrompts: [],
      })
    }

    await vi.waitFor(() => expect(useStore.getState().agentConversations[0].rounds[0]?.status).toBe('done'))
    expect(useStore.getState().tasks.map((item) => item.agentBatchItemId).sort()).toEqual(['duplicate', 'duplicate_2', 'image_3', 'image_4'])
    expect(callImageApi).toHaveBeenCalledTimes(4)
    const output = useStore.getState().agentConversations[0].rounds[0].responseOutput ?? []
    const functionCall = output.find((item) => item.type === 'function_call' && item.call_id === 'normalized-batch-call')
    const functionOutput = output.find((item) => item.type === 'function_call_output' && item.call_id === 'normalized-batch-call')
    expect(JSON.parse(functionCall?.arguments ?? '{}').images).toEqual([
      { id: 'duplicate', prompt: 'deleted duplicate' },
      { id: 'duplicate_2', prompt: 'live duplicate' },
      { id: 'image_3', prompt: 'blank id' },
      { id: 'image_4', prompt: 'missing id' },
    ])
    expect(JSON.parse(typeof functionOutput?.output === 'string' ? functionOutput.output : '{}').images.map((item: { id: string }) => item.id)).toEqual(['duplicate', 'duplicate_2', 'image_3', 'image_4'])
    const continuationInput = JSON.stringify(vi.mocked(callAgentResponsesApi).mock.calls[1][0].input)
    expect(continuationInput).toContain('duplicate_2')
    expect(continuationInput).not.toContain(' duplicate ')
    expect(continuationInput).not.toContain('ignored')
  })

  it('keeps live batch output through repeated cleanup when deleted items fail or reject', async () => {
    const imageProfile = createDefaultOpenAIProfile({ id: 'image-profile', apiKey: 'image-key', apiMode: 'images' })
    const failedRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const rejectedRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const liveRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        profiles: [responsesProfile, imageProfile],
        activeProfileId: responsesProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: responsesProfile.id,
        agentImageProfileId: imageProfile.id,
      }),
    })
    vi.mocked(callAgentResponsesApi)
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'generate_image_batch',
          call_id: 'batch-failure-call',
          arguments: JSON.stringify({ images: [
            { id: 'failed-deleted', prompt: 'failed deleted prompt' },
            { id: 'rejected-deleted', prompt: 'rejected deleted prompt' },
            { id: 'live-item', prompt: 'live prompt' },
          ] }),
        }],
        responseId: 'response-batch-failures',
      })
      .mockImplementationOnce(async () => {
        useStore.setState((state) => ({
          agentConversations: state.agentConversations.map((conversation) => ({
            ...conversation,
            rounds: conversation.rounds.map((round) => round.id === conversation.activeRoundId
              ? {
                  ...round,
                  responseOutput: [
                    {
                      type: 'function_call',
                      name: 'generate_image_batch',
                      call_id: 'batch-failure-call',
                      arguments: JSON.stringify({ images: [
                        { id: 'failed-deleted', prompt: 'failed deleted prompt' },
                        { id: 'rejected-deleted', prompt: 'rejected deleted prompt' },
                        { id: 'live-item', prompt: 'live prompt' },
                      ] }),
                    },
                    {
                      type: 'function_call_output',
                      call_id: 'batch-failure-call',
                      output: JSON.stringify({ images: [
                        { id: 'failed-deleted', status: 'error' },
                        { id: 'rejected-deleted', status: 'error' },
                        { id: 'live-item', status: 'done' },
                      ] }),
                    },
                  ],
                }
              : round),
          })),
        }))
        throw new Error('continuation failed')
      })
    vi.mocked(callImageApi)
      .mockImplementationOnce(() => failedRequest.promise)
      .mockImplementationOnce(() => rejectedRequest.promise)
      .mockImplementationOnce(() => liveRequest.promise)

    await submitAgentMessage()
    await vi.waitFor(() => expect(useStore.getState().tasks.filter((item) => item.agentBatchCallId === 'batch-failure-call')).toHaveLength(3))
    await removeTask(useStore.getState().tasks.find((item) => item.agentBatchItemId === 'failed-deleted')!)
    await removeTask(useStore.getState().tasks.find((item) => item.agentBatchItemId === 'rejected-deleted')!)
    const afterRepeatedCleanup = JSON.stringify(useStore.getState().agentConversations[0].rounds[0].responseOutput)
    expect(afterRepeatedCleanup).not.toContain('failed-deleted')
    expect(afterRepeatedCleanup).not.toContain('rejected-deleted')
    expect(afterRepeatedCleanup).toContain('live-item')

    failedRequest.resolve({
      images: [],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
      failedRequests: [{ requestIndex: 0, error: 'deleted null result' }],
    })
    rejectedRequest.reject(new Error('deleted rejection'))
    liveRequest.resolve({ images: ['data:image/png;base64,live'], actualParams: {}, actualParamsList: [{}], revisedPrompts: ['live prompt'] })

    await vi.waitFor(() => {
      const round = useStore.getState().agentConversations[0].rounds[0]
      expect(round?.status).toBe('error')
      expect(JSON.stringify(round.responseOutput)).not.toContain('failed-deleted')
      expect(JSON.stringify(round.responseOutput)).not.toContain('rejected-deleted')
    })
    const finalOutput = JSON.stringify(useStore.getState().agentConversations[0].rounds[0].responseOutput)
    expect(finalOutput).not.toContain('failed-deleted')
    expect(finalOutput).not.toContain('rejected-deleted')
    expect(finalOutput).not.toContain('deleted null result')
    expect(finalOutput).not.toContain('deleted rejection')
    expect(finalOutput).toContain('live-item')
    expect(finalOutput).toContain('function_call_output')
    expect(useStore.getState().tasks).toHaveLength(1)
    expect(useStore.getState().tasks[0]).toMatchObject({ agentBatchItemId: 'live-item', status: 'done' })
    await vi.waitFor(async () => {
      const persistedOutput = JSON.stringify((await getAllAgentConversations())[0]?.rounds[0]?.responseOutput)
      expect(persistedOutput).not.toContain('failed-deleted')
      expect(persistedOutput).not.toContain('rejected-deleted')
      expect(persistedOutput).toContain('live-item')
    })
  })

  it('removes the function pair without reporting success when an entire batch is deleted', async () => {
    const imageProfile = createDefaultOpenAIProfile({ id: 'image-profile', apiKey: 'image-key', apiMode: 'images' })
    const failedRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const rejectedRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        profiles: [responsesProfile, imageProfile],
        activeProfileId: responsesProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: responsesProfile.id,
        agentImageProfileId: imageProfile.id,
      }),
    })
    vi.mocked(callAgentResponsesApi).mockResolvedValueOnce({
      text: '',
      images: [],
      outputItems: [{
        type: 'function_call',
        name: 'generate_image_batch',
        call_id: 'all-deleted-batch',
        arguments: JSON.stringify({ images: [
          { id: 'deleted-a', prompt: 'deleted a' },
          { id: 'deleted-b', prompt: 'deleted b' },
        ] }),
      }],
      responseId: 'response-all-deleted',
    })
    vi.mocked(callImageApi)
      .mockImplementationOnce(() => failedRequest.promise)
      .mockImplementationOnce(() => rejectedRequest.promise)

    await submitAgentMessage()
    await vi.waitFor(() => expect(useStore.getState().tasks.filter((item) => item.agentBatchCallId === 'all-deleted-batch')).toHaveLength(2))
    await removeMultipleTasks(useStore.getState().tasks.map((item) => item.id))
    failedRequest.resolve({
      images: [],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
      failedRequests: [{ requestIndex: 0, error: 'deleted failure' }],
    })
    rejectedRequest.reject(new Error('deleted rejection'))

    await vi.waitFor(() => expect(useStore.getState().agentConversations[0].rounds[0]?.status).toBe('done'))
    expect(callAgentResponsesApi).toHaveBeenCalledTimes(1)
    expect(useStore.getState().tasks).toEqual([])
    const conversation = useStore.getState().agentConversations[0]
    expect(JSON.stringify(conversation.rounds[0].responseOutput)).not.toContain('all-deleted-batch')
    expect(conversation.messages.find((message) => message.role === 'assistant')?.content).not.toContain('图像已生成')
  })

  it('marks a started built-in image task as error when the stream fails', async () => {
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(async (opts) => {
      await opts.onImageToolStarted?.({ toolCallId: 'ig-fail' })
      await opts.onImagePartialImage?.({
        toolCallId: 'ig-fail',
        image: 'data:image/png;base64,cGFydGlhbA==',
        partialImageIndex: 0,
      })
      throw new Error('image_generation failed')
    })

    await submitAgentMessage()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('error'))

    const state = useStore.getState()
    const failedTask = state.tasks[0]
    expect(failedTask).toMatchObject({
      status: 'error',
      error: 'image_generation failed',
      agentToolCallId: 'ig-fail',
      sourceMode: 'agent',
    })
    expect(state.streamPreviews[failedTask.id]).toBeUndefined()
    expect(state.streamPreviewSlots[failedTask.id]).toBeUndefined()

    const round = state.agentConversations[0].rounds[0]
    expect(round).toMatchObject({
      status: 'error',
      error: 'image_generation failed',
      outputTaskIds: [failedTask.id],
    })
  })

  it('marks a failed built-in image task as error while the Agent stream continues', async () => {
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(async (opts) => {
      await opts.onImageToolStarted?.({ toolCallId: 'ig-fail' })
      await opts.onImagePartialImage?.({
        toolCallId: 'ig-fail',
        image: 'data:image/png;base64,cGFydGlhbA==',
        partialImageIndex: 0,
      })
      await opts.onImageToolFailed?.({ toolCallId: 'ig-fail', error: 'safety rejected' })
      opts.onTextDelta?.('图片失败，但回复继续。')
      return {
        text: '图片失败，但回复继续。',
        images: [],
        outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '图片失败，但回复继续。' }] }],
        responseId: 'response-continued',
      }
    })

    await submitAgentMessage()
    await vi.waitFor(() => expect(useStore.getState().agentConversations[0].rounds[0]?.status).toBe('done'))

    const state = useStore.getState()
    const failedTask = state.tasks[0]
    expect(failedTask).toMatchObject({
      status: 'error',
      error: 'safety rejected',
      agentToolCallId: 'ig-fail',
      sourceMode: 'agent',
    })
    expect(state.streamPreviews[failedTask.id]).toBeUndefined()
    expect(state.streamPreviewSlots[failedTask.id]).toBeUndefined()

    const round = state.agentConversations[0].rounds[0]
    expect(round).toMatchObject({
      status: 'done',
      error: null,
      outputTaskIds: [failedTask.id],
    })
    expect(state.agentConversations[0].messages.find((message) => message.role === 'assistant')).toMatchObject({
      content: '图片失败，但回复继续。',
      outputTaskIds: [failedTask.id],
    })
  })

  it('does not restore a deleted Agent task when its image and final response arrive late', async () => {
    let deletedTaskId = ''
    let liveTaskId = ''
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(async (opts) => {
      await opts.onImageToolStarted?.({ toolCallId: 'ig-deleted' })
      await opts.onImageToolStarted?.({ toolCallId: 'ig-live' })
      const runningTask = useStore.getState().tasks.find((item) => item.agentToolCallId === 'ig-deleted')
      const liveTask = useStore.getState().tasks.find((item) => item.agentToolCallId === 'ig-live')
      if (!runningTask) throw new Error('Agent task was not created')
      if (!liveTask) throw new Error('Live Agent task was not created')
      deletedTaskId = runningTask.id
      liveTaskId = liveTask.id
      await removeTask(runningTask)
      await opts.onImageToolCompleted?.({
        toolCallId: 'ig-deleted',
        dataUrl: 'data:image/png;base64,late-agent-output',
      })
      const outputItems = [
        { type: 'image_generation_call' as const, id: 'ig-deleted', result: 'late-agent-base64' },
        { type: 'image_generation_call' as const, id: 'ig-live', result: 'live-agent-base64' },
      ]
      return {
        text: '',
        images: [],
        outputItems,
        rawResponsePayload: JSON.stringify({ output: outputItems }),
        responseId: 'response-late',
      }
    })

    await submitAgentMessage()
    await vi.waitFor(() => {
      const state = useStore.getState()
      expect(state.agentConversations[0].rounds[0]?.status).toBe('done')
      expect(state.tasks[0]?.rawResponsePayload).not.toContain('ig-deleted')
    })

    const state = useStore.getState()
    const round = state.agentConversations[0].rounds[0]
    const assistantMessage = state.agentConversations[0].messages.find((message) => message.role === 'assistant')
    expect(deletedTaskId).not.toBe('')
    expect(liveTaskId).not.toBe('')
    expect(state.tasks.map((item) => item.id)).toEqual([liveTaskId])
    expect((await getAllTasks()).map((item) => item.id)).toEqual([liveTaskId])
    expect(await getAllImageIds()).toEqual([])
    expect(round.outputTaskIds).toEqual([liveTaskId])
    expect(JSON.stringify(round.responseOutput)).not.toContain('ig-deleted')
    expect(JSON.stringify(round.responseOutput)).not.toContain('late-agent-base64')
    expect(JSON.stringify(round.responseOutput)).toContain('ig-live')
    expect(state.tasks[0].rawResponsePayload).not.toContain('ig-deleted')
    expect(state.tasks[0].rawResponsePayload).toContain('ig-live')
    expect(assistantMessage?.outputTaskIds).toEqual([liveTaskId])
  })

  it('cleans late response output after an Agent failure', async () => {
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(async (opts) => {
      await opts.onImageToolStarted?.({ toolCallId: 'ig-deleted-failure' })
      const runningTask = useStore.getState().tasks.find((item) => item.agentToolCallId === 'ig-deleted-failure')
      if (!runningTask) throw new Error('Agent task was not created')
      await removeTask(runningTask)
      opts.onOutputItems?.([{ type: 'image_generation_call', id: 'ig-deleted-failure', result: 'late-failure-base64' }])
      throw new Error('stream failed')
    })

    await submitAgentMessage()
    await vi.waitFor(() => {
      const round = useStore.getState().agentConversations[0].rounds[0]
      expect(round).toMatchObject({ status: 'error', error: 'stream failed' })
      expect(JSON.stringify(round.responseOutput)).not.toContain('ig-deleted-failure')
    })

    const round = useStore.getState().agentConversations[0].rounds[0]
    expect(round).toMatchObject({ status: 'error', error: 'stream failed' })
    expect(JSON.stringify(round.responseOutput)).not.toContain('ig-deleted-failure')
    expect(JSON.stringify(round.responseOutput)).not.toContain('late-failure-base64')
  })

  it('cleans late response output after an Agent abort', async () => {
    let ready: () => void = () => {}
    const outputWritten = new Promise<void>((resolve) => { ready = resolve })
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(async (opts) => {
      await opts.onImageToolStarted?.({ toolCallId: 'ig-deleted-abort' })
      const runningTask = useStore.getState().tasks.find((item) => item.agentToolCallId === 'ig-deleted-abort')
      if (!runningTask) throw new Error('Agent task was not created')
      await removeTask(runningTask)
      opts.onOutputItems?.([{ type: 'image_generation_call', id: 'ig-deleted-abort', result: 'late-abort-base64' }])
      ready()
      const signal = opts.signal
      if (!signal) throw new Error('Abort signal was not provided')
      return new Promise((_, reject) => {
        const abort = () => reject(new DOMException('Agent 请求已停止', 'AbortError'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    })

    await submitAgentMessage()
    await outputWritten
    stopAgentResponse('conversation-a')
    await vi.waitFor(() => {
      const round = useStore.getState().agentConversations[0].rounds[0]
      expect(round).toMatchObject({ status: 'error', error: '已停止生成。' })
      expect(JSON.stringify(round.responseOutput)).not.toContain('ig-deleted-abort')
    })

    const round = useStore.getState().agentConversations[0].rounds[0]
    expect(round).toMatchObject({ status: 'error', error: '已停止生成。' })
    expect(JSON.stringify(round.responseOutput)).not.toContain('ig-deleted-abort')
    expect(JSON.stringify(round.responseOutput)).not.toContain('late-abort-base64')
  })

  it('deletes a stopped round while its aborted controller is still awaiting cleanup', async () => {
    const response = deferred<Awaited<ReturnType<typeof callAgentResponsesApi>>>()
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(() => response.promise)
    vi.mocked(commitTaskDeletion).mockImplementation(commitTaskDeletionImplementation)

    await submitAgentMessage()
    await vi.waitFor(() => expect(callAgentResponsesApi).toHaveBeenCalledTimes(1))
    const roundId = useStore.getState().agentConversations[0].rounds[0].id
    stopAgentResponse('conversation-a')
    expect(useStore.getState().agentConversations[0].rounds[0]).toMatchObject({
      status: 'error',
      error: '已停止生成。',
    })

    const result = await useStore.getState().deleteAgentRound('conversation-a', roundId)

    expect(result).toBe('deleted')
    expect(useStore.getState().agentConversations[0].rounds).toEqual([])
    expect(useStore.getState().agentConversations[0].messages).toEqual([])
    expect(useStore.getState().tasks).toEqual([])

    response.resolve({
      text: '不应复活',
      images: [],
      outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '不应复活' }] }],
      responseId: 'late-response',
    })
    await response.promise
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useStore.getState().agentConversations[0].rounds).toEqual([])
    expect(useStore.getState().agentConversations[0].messages).toEqual([])
    expect(useStore.getState().tasks).toEqual([])
  })

  it('cleans late response output when Agent execution pauses for recovery', async () => {
    const { callImageApi } = await import('./lib/api')
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [responsesProfile, falProfile],
        activeProfileId: responsesProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: responsesProfile.id,
        agentImageProfileId: falProfile.id,
      }),
    })
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(async (opts) => {
      await opts.onImageToolStarted?.({ toolCallId: 'ig-deleted-recovery' })
      const runningTask = useStore.getState().tasks.find((item) => item.agentToolCallId === 'ig-deleted-recovery')
      if (!runningTask) throw new Error('Agent task was not created')
      await removeTask(runningTask)
      const outputItems = [
        { type: 'image_generation_call' as const, id: 'ig-deleted-recovery', result: 'late-recovery-base64' },
        { type: 'function_call' as const, name: 'generate_image', call_id: 'recovery-call', arguments: JSON.stringify({ id: 'image', prompt: '画一张图' }) },
      ]
      opts.onOutputItems?.(outputItems)
      return { text: '', images: [], outputItems, responseId: 'response-recovery' }
    })
    vi.mocked(callImageApi).mockImplementationOnce(async (opts) => {
      opts.onFalRequestEnqueued?.({ requestId: 'fal-request', endpoint: 'fal-endpoint' })
      throw new Error('Failed to fetch')
    })

    await submitAgentMessage()
    await vi.waitFor(() => {
      const state = useStore.getState()
      const recoveryTask = state.tasks.find((item) => item.agentToolCallId === 'recovery-call')
      const responseOutput = JSON.stringify(state.agentConversations[0].rounds[0]?.responseOutput)
      expect(recoveryTask?.falRecoverable).toBe(true)
      expect(responseOutput).not.toContain('ig-deleted-recovery')
    })

    const state = useStore.getState()
    const recoveryTask = state.tasks.find((item) => item.agentToolCallId === 'recovery-call')
    expect(recoveryTask).toMatchObject({ status: 'error', falRecoverable: true })
    expect(callAgentResponsesApi).toHaveBeenCalledTimes(1)
    expect(state.agentConversations[0].rounds[0].status).toBe('running')
    expect(JSON.stringify(state.agentConversations[0].rounds[0].responseOutput)).not.toContain('ig-deleted-recovery')
    expect(JSON.stringify(state.agentConversations[0].rounds[0].responseOutput)).not.toContain('late-recovery-base64')
    await removeTask(recoveryTask!)
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
    vi.mocked(callAgentResponsesApi).mockReset()
    vi.mocked(callBatchImageSingle).mockReset().mockImplementation(callBatchImageSingleImplementation)
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

    await vi.waitFor(() => expect(callBatchImageSingle).toHaveBeenCalled())
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

    await vi.waitFor(() => expect(callBatchImageSingle).toHaveBeenCalled())
    expect(callBatchImageSingle).toHaveBeenCalled()
    const batchArgs = vi.mocked(callBatchImageSingle).mock.calls[0][0]
    expect(batchArgs.referenceImageDataUrls).toEqual([imageA.dataUrl])
    expect(batchArgs.referenceIds).toEqual(['round-3-reference-1'])
  })

  afterEach(async () => {
    await vi.waitFor(() => {
      expect(useStore.getState().agentConversations.flatMap((conversation) => conversation.rounds).every((round) => round.status !== 'running')).toBe(true)
    })
  })
})

describe('agent assistant regeneration', () => {
  const responsesProfile = createDefaultOpenAIProfile({ id: 'openai-responses', apiKey: 'openai-key', apiMode: 'responses' })
  let response: ReturnType<typeof deferred<Awaited<ReturnType<typeof callAgentResponsesApi>>>>

  beforeEach(() => {
    response = deferred<Awaited<ReturnType<typeof callAgentResponsesApi>>>()
    vi.mocked(callAgentResponsesApi).mockReset().mockImplementation(() => response.promise)
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

  afterEach(async () => {
    response.resolve({
      text: '已完成。',
      images: [],
      outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '已完成。' }] }],
      responseId: 'response-regenerated',
    })
    await response.promise
    await vi.waitFor(() => {
      expect(useStore.getState().agentConversations.flatMap((conversation) => conversation.rounds).every((round) => round.status !== 'running')).toBe(true)
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

  beforeEach(async () => {
    await clearTasks()
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

  it('keeps unlocked preset settings and task profile references on refresh', async () => {
    const provider = { id: 'provider-internal', name: 'Custom Provider', submit: { path: 'v1/generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'profile-internal', isDefault: true, provider: provider.id, model: 'model-v1' })
    const sourceTask = task({ apiProvider: provider.id, apiProfileId: profile.id })
    await putDbTask(sourceTask)
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        profiles: [profile, openaiProfile],
        customProviders: [provider],
        activeProfileId: openaiProfile.id,
      }),
      tasks: [sourceTask],
      reusedTaskApiProfileId: profile.id,
    })

    await useStore.getState().setPresetImportedSettings({
      customProviders: [{ id: provider.id, name: provider.name, submit: { path: 'v2/generate' } }],
      profiles: [{ ...profile, provider: provider.id, model: 'model-v2' }],
    })

    const state = useStore.getState()
    expect(state.tasks[0]).toMatchObject({
      apiProfileId: profile.id,
      apiProvider: provider.id,
    })
    expect(state.settings.profiles[0]).toMatchObject({ id: profile.id, model: 'model-v1' })
    expect(state.settings.customProviders[0]).toMatchObject({ id: provider.id, submit: { path: 'generate' } })
    expect(state.reusedTaskApiProfileId).toBe(profile.id)
    expect((await getAllTasks())[0]).toMatchObject({
      apiProfileId: profile.id,
      apiProvider: provider.id,
    })
  })

  it('does not change an unlocked preset provider on refresh', async () => {
    const oldProvider = { id: 'provider-old', name: 'Old Provider', submit: { path: 'old' } }
    const profile = createDefaultOpenAIProfile({ id: 'stable-profile', isDefault: true, provider: oldProvider.id })
    const sourceTask = task({ apiProvider: oldProvider.id, apiProfileId: profile.id })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, customProviders: [oldProvider], profiles: [profile] }),
      tasks: [sourceTask],
    })

    await useStore.getState().setPresetImportedSettings({
      customProviders: [{ id: 'provider-new', name: 'New Provider', submit: { path: 'new' } }],
      profiles: [{ ...profile, provider: 'provider-new', model: 'model-new' }],
    })

    expect(getTaskApiProfile(useStore.getState().settings, sourceTask)).toMatchObject({
      id: profile.id,
      provider: 'provider-old',
      model: 'gpt-image-2',
    })
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
