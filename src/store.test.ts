import { beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { DEFAULT_PARAMS } from './types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_RESPONSES_MODEL, DEFAULT_SETTINGS, normalizeSettings } from './lib/apiProfiles'
import type { AgentConversation, ExportData, Project, StoredImage, StoredImageThumbnail, TaskRecord } from './types'
import { getSelectedImageMentionLabel } from './lib/promptImageMentions'
const authState = vi.hoisted(() => ({ accessToken: null as string | null }))
vi.mock('./auth/api', () => ({
  createRequestId: () => 'frontend-request-id',
  isAuthEnabled: () => true,
  getAccessToken: () => authState.accessToken,
}))
vi.mock('./lib/db', () => {
  const tasks = new Map<string, TaskRecord>()
  const images = new Map<string, StoredImage>()
  const thumbnails = new Map<string, StoredImageThumbnail>()
  const agentConversations = new Map<string, AgentConversation>()
  const projects = new Map<string, Project>()
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
    getAllProjects: async () => [...projects.values()],
    putProject: async (project: Project) => {
      projects.set(project.id, project)
      return project.id
    },
    deleteProject: async (id: string) => {
      projects.delete(id)
    },
    deleteProjectWithRecords: async (projectId: string, taskIds: string[], conversationIds: string[]) => {
      projects.delete(projectId)
      for (const id of taskIds) tasks.delete(id)
      for (const id of conversationIds) agentConversations.delete(id)
    },
    clearProjects: async () => {
      projects.clear()
    },
    putProjectWithRecords: async (project: Project, projectTasks: TaskRecord[], projectConversations: AgentConversation[]) => {
      projects.set(project.id, project)
      for (const task of projectTasks) tasks.set(task.id, task)
      for (const conversation of projectConversations) agentConversations.set(conversation.id, conversation)
    },
    replaceProjectCache: async (projectRecords: Project[], taskRecords: TaskRecord[], conversationRecords: AgentConversation[], imageRecords: StoredImage[], thumbnailRecords: StoredImageThumbnail[]) => {
      projects.clear()
      tasks.clear()
      agentConversations.clear()
      for (const project of projectRecords) projects.set(project.id, project)
      for (const task of taskRecords) tasks.set(task.id, task)
      for (const conversation of conversationRecords) agentConversations.set(conversation.id, conversation)
      for (const image of imageRecords) images.set(image.id, image)
      for (const thumbnail of thumbnailRecords) thumbnails.set(thumbnail.id, thumbnail)
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
    hashDataUrl: async (value: string) => `hash-${value}`,
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
vi.mock('./lib/onlineProjects', () => ({
  buildLegacyProjectArchive: vi.fn(async () => new Blob(['archive'], { type: 'application/zip' })),
  getLegacyProjectUploadId: vi.fn(() => '86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8'),
  clearLegacyProjectUploadId: vi.fn(),
  getTaskReferencedImageIds: vi.fn((record: TaskRecord) => [
    ...record.inputImageIds,
    ...(record.maskTargetImageId ? [record.maskTargetImageId] : []),
    ...(record.maskImageId ? [record.maskImageId] : []),
    ...record.outputImages,
    ...(record.transparentOriginalImages ?? []),
    ...(record.streamPartialImageIds ?? []),
  ]),
  getAgentConversationReferencedImageIds: vi.fn((conversation: AgentConversation) => [
    ...conversation.rounds.flatMap((round) => [
      ...round.inputImageIds,
      ...(round.maskTargetImageId ? [round.maskTargetImageId] : []),
      ...(round.maskImageId ? [round.maskImageId] : []),
    ]),
    ...conversation.messages.flatMap((message) => [
      ...(message.inputImageIds ?? []),
      ...(message.maskTargetImageId ? [message.maskTargetImageId] : []),
      ...(message.maskImageId ? [message.maskImageId] : []),
    ]),
  ]),
  uploadOnlineProject: vi.fn(async () => ({
    id: '86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8',
    title: '本地数据',
    archive_size: 7,
    archive_sha256: 'sha256',
    created_at: '2026-08-16T00:00:00Z',
    updated_at: '2026-08-16T00:00:00Z',
  })),
  renameOnlineProject: vi.fn(async (id: string, title: string) => ({
    id,
    title,
    archive_size: 7,
    archive_sha256: 'sha256',
    created_at: '2026-08-16T00:00:00Z',
    updated_at: '2026-08-16T00:00:00Z',
  })),
  listOnlineProjects: vi.fn(async () => []),
  listOnlineProjectImages: vi.fn(async () => []),
  downloadOnlineProjectImage: vi.fn(async (_projectId: string, image: { image_id: string; source?: StoredImage['source']; width?: number; height?: number; created_at: string }) => ({
    id: image.image_id,
    dataUrl: 'data:image/png;base64,AAECAw==',
    source: image.source,
    width: image.width,
    height: image.height,
    createdAt: Date.parse(image.created_at) || undefined,
  })),
  uploadOnlineProjectImage: vi.fn(async () => ({
    project_id: 'project-a',
    image_id: 'image-a',
    mime_type: 'image/png',
    image_size: 1,
    image_sha256: 'sha256',
    created_at: '2026-08-16T00:00:00Z',
    updated_at: '2026-08-16T00:00:00Z',
  })),
  saveOnlineProjectTask: vi.fn(async (project: { id: string; title: string }) => ({
    id: project.id,
    title: project.title,
    archive_size: 7,
    archive_sha256: 'task-sha256',
    created_at: '2026-08-16T00:00:00Z',
    updated_at: '2026-08-16T00:00:00Z',
  })),
  saveOnlineProjectCanvas: vi.fn(async (project: { id: string; title: string }) => ({
    id: project.id,
    title: project.title,
    archive_size: 7,
    archive_sha256: 'canvas-sha256',
    created_at: '2026-08-16T00:00:00Z',
    updated_at: '2026-08-16T00:00:00Z',
  })),
  getOnlineProjectCanvas: vi.fn(async () => null),
  deleteOnlineProjectTask: vi.fn(async () => ({
    id: 'project-a',
    title: '项目 A',
    archive_size: 7,
    archive_sha256: 'task-delete-sha256',
    created_at: '2026-08-16T00:00:00Z',
    updated_at: '2026-08-16T00:00:00Z',
  })),
  deleteOnlineProjectImage: vi.fn(async () => undefined),
  downloadOnlineProject: vi.fn(async () => new Uint8Array()),
  deleteOnlineProject: vi.fn(async () => undefined),
  buildOnlineProjectArchive: vi.fn(async () => new Blob(['archive'], { type: 'application/zip' })),
  readOnlineProjectArchive: vi.fn(() => ({
    tasks: [],
    agentConversations: [],
    favoriteCollections: [],
    defaultFavoriteCollectionId: null,
    images: [],
    thumbnails: [],
  })),
  createOnlineProject: vi.fn((response: { id: string; title: string; archive_sha256?: string }) => ({
    id: response.id,
    title: response.title,
    initialPrompt: '',
    storage: 'online',
    remoteId: response.id,
    remoteArchiveSha256: response.archive_sha256,
    syncPending: false,
    createdAt: 1,
    updatedAt: 1,
  })),
}))
vi.mock('./lib/api', () => ({
  callImageApi: vi.fn(async () => ({
    images: [],
    actualParams: {},
    actualParamsList: [],
    revisedPrompts: [],
  })),
}))
vi.mock('./lib/backendImageApi', () => ({
  callBackendImageApi: vi.fn(async () => ({
    images: [],
    actualParams: {},
    actualParamsList: [],
    revisedPrompts: [],
    imagesStoredOnline: true,
  })),
}))
vi.mock('./lib/backendCompositeImageApi', () => ({
  callBackendCompositeImageApi: vi.fn(async () => ({
    images: [],
    actualParams: {},
    actualParamsList: [],
    revisedPrompts: [],
    imagesStoredOnline: false,
  })),
  queryBackendCompositeImageTask: vi.fn(async () => null),
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
vi.mock('./lib/imageStatusApi', () => ({
  queryImageStatuses: vi.fn(async () => ({
    records: [],
    notFound: [],
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
    output_format: 'png',
    output_compression: null,
    transparent_output: true,
  })),
  removeKeyedBackgroundFromDataUrl: vi.fn(async (dataUrl: string) => `transparent:${dataUrl}`),
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
import { clearAgentConversations, clearImages, clearProjects, clearTasks, getAllAgentConversations, getAllProjects, getAllTasks, getImage, putAgentConversation, putImage, putTask as putDbTask } from './lib/db'
import { callAgentResponsesApi, callBatchImageSingle } from './lib/agentApi'
import { getFalQueuedImageResult } from './lib/falAiImageApi'
import { queryImageStatuses } from './lib/imageStatusApi'
import { removeKeyedBackgroundFromDataUrl } from './lib/transparentImage'
import { callBackendImageApi } from './lib/backendImageApi'
import { callBackendCompositeImageApi, queryBackendCompositeImageTask } from './lib/backendCompositeImageApi'
import { buildLegacyProjectArchive, clearLegacyProjectUploadId, deleteOnlineProject, downloadOnlineProject, listOnlineProjectImages, listOnlineProjects, readOnlineProjectArchive, renameOnlineProject, saveOnlineProjectCanvas, saveOnlineProjectTask, uploadOnlineProject, uploadOnlineProjectImage } from './lib/onlineProjects'
import { LOCAL_PROJECT_ID, cleanStaleAgentInputDrafts, clearFailedTasks, createFavoriteCollection, deleteAgentRoundFromConversation, deleteFavoriteCollection, editOutputs, getActiveAgentRounds, getActiveDefaultFavoriteCollectionId, getActiveFavoriteCollections, getErrorToastMessage, getPersistedState, getTaskApiProfile, importData, initStore, markInterruptedOpenAIRunningTasks, migratePersistedState, regenerateAgentAssistantMessage, remapAgentRoundMentionsForPathChange, removeTask, renameFavoriteCollection, reuseConfig, retryTask, submitAgentMessage, submitTask, taskMatchesFilterStatus, taskMatchesSearchQuery, useStore } from './store'

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

  it('deletes only collection images while preserving siblings and parent tasks', async () => {
    const project: Project = {
      id: 'project-favorites',
      title: '收藏项目',
      initialPrompt: '',
      storage: 'local',
      defaultFavoriteCollectionId: collectionA.id,
      createdAt: 1,
      updatedAt: 1,
      canvas: {
        version: 1,
        viewport: { x: 32, y: 32, scale: 1 },
        items: {
          'image-shared': { x: 0, y: 0, width: 240, z: 0, favoriteCollectionIds: [collectionA.id, collectionB.id] },
          'image-only': { x: 272, y: 0, width: 240, z: 1, favoriteCollectionIds: [collectionA.id] },
          'image-sibling': { x: 544, y: 0, width: 240, z: 2, favoriteCollectionIds: [] },
        },
      },
    }
    const scopedCollectionA = { ...collectionA, projectId: project.id }
    const scopedCollectionB = { ...collectionB, projectId: project.id }
    const sharedTask = task({
      id: 'shared-task',
      projectId: project.id,
      outputImages: ['image-shared'],
      isFavorite: true,
      favoriteCollectionIds: [collectionA.id, collectionB.id],
    })
    const collectionOnlyTask = task({
      id: 'collection-only-task',
      projectId: project.id,
      outputImages: ['image-only', 'image-sibling'],
      isFavorite: true,
      favoriteCollectionIds: [collectionA.id],
    })
    useStore.setState({
      projects: [project],
      activeProjectId: project.id,
      favoriteCollections: [scopedCollectionA, scopedCollectionB],
      tasks: [sharedTask, collectionOnlyTask],
    })
    await putDbTask(sharedTask)
    await putDbTask(collectionOnlyTask)

    await deleteFavoriteCollection(collectionA.id, true)

    const state = useStore.getState()
    expect(state.favoriteCollections.map((collection) => collection.id)).toEqual([collectionB.id])
    expect(state.activeFavoriteCollectionId).toBeNull()
    expect(state.selectedFavoriteCollectionIds).toEqual([])
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks.find((item) => item.id === sharedTask.id)).toMatchObject({
      id: sharedTask.id,
      isFavorite: true,
      favoriteCollectionIds: [collectionB.id],
    })
    expect(state.tasks.find((item) => item.id === collectionOnlyTask.id)).toMatchObject({
      outputImages: ['image-sibling'],
      isFavorite: false,
      favoriteCollectionIds: [],
    })
    expect(state.projects[0].canvas?.items['image-only']).toBeUndefined()
    expect(state.projects[0].canvas?.items['image-sibling']).toBeDefined()
    expect((await getAllTasks()).map((item) => item.id).sort()).toEqual([collectionOnlyTask.id, sharedTask.id].sort())
  })
})

describe('project favorite collection scope', () => {
  const projectA: Project = {
    id: 'project-a',
    title: '项目 A',
    initialPrompt: '',
    storage: 'local',
    defaultFavoriteCollectionId: 'shared-id',
    createdAt: 1,
    updatedAt: 1,
  }
  const projectB: Project = {
    ...projectA,
    id: 'project-b',
    title: '项目 B',
  }
  const collectionA = { id: 'shared-id', projectId: projectA.id, name: '项目 A 收藏夹', createdAt: 1, updatedAt: 1 }
  const collectionB = { id: 'shared-id', projectId: projectB.id, name: '项目 B 收藏夹', createdAt: 1, updatedAt: 1 }

  beforeEach(() => {
    useStore.setState({
      projects: [projectA, projectB],
      activeProjectId: projectA.id,
      tasks: [],
      favoriteCollections: [collectionA, collectionB],
      showToast: vi.fn(),
    })
  })

  it('creates and renames collections only in the active project', () => {
    const created = createFavoriteCollection('新收藏夹')
    expect(created?.projectId).toBe(projectA.id)

    renameFavoriteCollection(collectionA.id, '项目 A 已改名')
    expect(getActiveFavoriteCollections().map((collection) => collection.name)).toEqual(['项目 A 已改名', '新收藏夹'])

    useStore.getState().setActiveProjectId(projectB.id)
    expect(getActiveFavoriteCollections()).toEqual([collectionB])
    expect(getActiveDefaultFavoriteCollectionId()).toBe(collectionB.id)
  })

  it('deletes only the active project collection and task references', async () => {
    const keepA = { id: 'keep-a', projectId: projectA.id, name: '保留', createdAt: 1, updatedAt: 1 }
    const taskA = task({ id: 'task-a', projectId: projectA.id, isFavorite: true, favoriteCollectionIds: [collectionA.id] })
    const taskB = task({ id: 'task-b', projectId: projectB.id, isFavorite: true, favoriteCollectionIds: [collectionB.id] })
    useStore.setState({ tasks: [taskA, taskB], favoriteCollections: [collectionA, keepA, collectionB] })

    await deleteFavoriteCollection(collectionA.id)

    const state = useStore.getState()
    expect(state.favoriteCollections).toEqual([keepA, collectionB])
    expect(state.tasks.find((item) => item.id === taskA.id)).toMatchObject({ isFavorite: false, favoriteCollectionIds: [] })
    expect(state.tasks.find((item) => item.id === taskB.id)).toMatchObject({ isFavorite: true, favoriteCollectionIds: [collectionB.id] })
  })

  it('marks an online project pending when collection metadata changes', () => {
    useStore.setState({
      projects: [{ ...projectA, storage: 'online', remoteId: projectA.id, syncPending: false }],
      activeProjectId: projectA.id,
    })

    createFavoriteCollection('需要同步')

    expect(useStore.getState().projects[0]).toMatchObject({
      id: projectA.id,
      syncPending: true,
    })
  })
})

describe('online canvas persistence', () => {
  it('saves canvas metadata independently and clears pending archive sync', async () => {
    const project: Project = {
      id: 'project-canvas',
      remoteId: 'project-canvas',
      title: '画布项目',
      initialPrompt: '',
      storage: 'online',
      syncPending: false,
      createdAt: 1,
      updatedAt: 1,
    }
    const canvas = {
      version: 1,
      viewport: { x: 12, y: 24, scale: 1.25 },
      items: {},
    }
    useStore.setState({ projects: [project], tasks: [] })
    vi.mocked(saveOnlineProjectCanvas).mockClear()

    useStore.getState().updateProjectCanvas(project.id, canvas)

    await vi.waitFor(() => expect(saveOnlineProjectCanvas).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }), canvas))
    expect(useStore.getState().projects[0]).toMatchObject({ syncPending: false, remoteArchiveSha256: 'canvas-sha256' })
  })
})

describe('mask draft lifecycle in store actions', () => {
  beforeEach(async () => {
    await clearProjects()
    await clearTasks()
    await clearAgentConversations()
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: 'prompt',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      projects: [],
      activeProjectId: null,
      detailTaskId: null,
      lightboxImageId: null,
      lightboxImageList: [],
      oidcApiOverride: null,
      agentOidcApiOverride: null,
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

  it('forces parameter submissions to use the Images API', async () => {
    const settings = normalizeSettings(useStore.getState().settings)
    const profiles = settings.profiles.map((profile) => (
      profile.id === settings.activeProfileId ? { ...profile, apiKey: 'test-key', apiMode: 'responses' as const } : profile
    ))
    useStore.setState({ settings: normalizeSettings({ ...settings, apiMode: 'responses', profiles }) })

    await submitTask()

    expect(useStore.getState().tasks[0]?.apiMode).toBe('images')
  })

  it('stores new gallery tasks in the active project', async () => {
    const projectId = useStore.getState().createProject('夏日饮品海报')

    await submitTask()

    expect(useStore.getState().tasks[0]?.projectId).toBe(projectId)
    expect((await getAllTasks())[0]?.projectId).toBe(projectId)
    await vi.waitFor(async () => expect((await getAllProjects()).map((project) => project.id)).toContain(projectId))
  })

  it('removes a project and all of its generation records', async () => {
    const projectId = useStore.getState().createProject('品牌主视觉')
    await submitTask()

    await useStore.getState().deleteProject(projectId)

    expect(useStore.getState().projects).toEqual([])
    expect(useStore.getState().tasks).toEqual([])
    expect(await getAllProjects()).toEqual([])
    expect(await getAllTasks()).toEqual([])
  })

  it('removes local project records without deleting saved project records', async () => {
    const projectId = useStore.getState().createProject('已保存项目')
    const localTask = task({ id: 'local-task' })
    const projectTask = task({ id: 'project-task', projectId })
    const localConversation = agentConversation({ id: 'local-conversation' })
    const projectConversation = agentConversation({ id: 'project-conversation', projectId })
    useStore.setState({
      activeProjectId: LOCAL_PROJECT_ID,
      tasks: [localTask, projectTask],
      agentConversations: [localConversation, projectConversation],
      activeAgentConversationId: localConversation.id,
      agentInputDrafts: {
        [localConversation.id]: {
          prompt: 'local draft',
          inputImages: [],
          maskDraft: null,
          maskEditorImageId: null,
          updatedAt: 1,
        },
      },
    })
    await Promise.all([
      putDbTask(localTask),
      putDbTask(projectTask),
      putAgentConversation(localConversation),
      putAgentConversation(projectConversation),
    ])

    await useStore.getState().deleteProject(LOCAL_PROJECT_ID)

    expect(useStore.getState().projects.map((project) => project.id)).toEqual([projectId])
    expect(useStore.getState().tasks.map((item) => item.id)).toEqual([projectTask.id])
    expect(useStore.getState().agentConversations.map((item) => item.id)).toEqual([projectConversation.id])
    expect(useStore.getState().agentInputDrafts).toEqual({})
    expect(useStore.getState().activeProjectId).toBeNull()
    expect((await getAllTasks()).map((item) => item.id)).toEqual([projectTask.id])
    expect((await getAllAgentConversations()).map((item) => item.id)).toEqual([projectConversation.id])
  })

  it('removes project-only images but keeps shared images', async () => {
    const projectId = useStore.getState().createProject('带图片的项目')
    const projectTask = task({
      id: 'project-task-with-images',
      projectId,
      inputImageIds: [imageB.id],
      outputImages: [imageA.id],
    })
    const retainedTask = task({ id: 'retained-task-with-shared-image', outputImages: [imageB.id] })
    useStore.setState({ tasks: [projectTask, retainedTask] })
    await Promise.all([
      putDbTask(projectTask),
      putDbTask(retainedTask),
      putImage(imageA),
      putImage(imageB),
    ])

    await useStore.getState().deleteProject(projectId)

    expect(useStore.getState().tasks.map((item) => item.id)).toEqual([retainedTask.id])
    expect(await getImage(imageA.id)).toBeUndefined()
    expect(await getImage(imageB.id)).toEqual(imageB)
  })

  it('deletes the project agent conversation and its draft', async () => {
    const projectId = useStore.getState().createProject('带 Agent 的项目')
    const conversation = agentConversation({ id: 'project-conversation', projectId })
    const projectTask = task({ id: 'project-task', projectId })
    useStore.setState({
      tasks: [projectTask],
      agentConversations: [conversation],
      activeAgentConversationId: conversation.id,
      agentInputDrafts: {
        [conversation.id]: {
          prompt: 'draft',
          inputImages: [],
          maskDraft: null,
          maskEditorImageId: null,
          updatedAt: 1,
        },
      },
    })
    await putDbTask(projectTask)
    await putAgentConversation(conversation)

    await useStore.getState().deleteProject(projectId)

    expect(useStore.getState().projects).toEqual([])
    expect(useStore.getState().tasks).toEqual([])
    expect(useStore.getState().agentConversations).toEqual([])
    expect(useStore.getState().agentInputDrafts).toEqual({})
    expect(await getAllTasks()).toEqual([])
    expect(await getAllAgentConversations()).toEqual([])
  })

  it('renames a project and persists the new title', async () => {
    const projectId = useStore.getState().createProject('旧项目名')

    useStore.getState().renameProject(projectId, '  新   项目名  ')

    expect(useStore.getState().projects[0]?.title).toBe('新 项目名')
    await vi.waitFor(async () => expect((await getAllProjects()).find((project) => project.id === projectId)?.title).toBe('新 项目名'))
  })

  it('renames an online project through the backend', async () => {
    const project = {
      id: 'online-project',
      title: '旧项目名',
      initialPrompt: '',
      storage: 'online' as const,
      remoteId: '86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8',
      createdAt: 1,
      updatedAt: 1,
    }
    useStore.setState({ projects: [project] })

    useStore.getState().renameProject(project.id, '新项目名')

    await vi.waitFor(() => expect(renameOnlineProject).toHaveBeenCalledWith(project.remoteId, '新项目名'))
  })

  it('creates an online UUID project when the user is logged in', () => {
    authState.accessToken = 'token'
    try {
      const projectId = useStore.getState().createProject('在线项目')
      const project = useStore.getState().projects.find((item) => item.id === projectId)

      expect(project).toMatchObject({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        storage: 'online',
        remoteId: projectId,
        syncPending: true,
      })
    } finally {
      authState.accessToken = null
    }
  })

  it('creates an auto-recorded project without a cached auth token', () => {
    const projectId = useStore.getState().createProject('home prompt', { autoRecord: true })
    const project = useStore.getState().projects.find((item) => item.id === projectId)

    expect(project).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      storage: 'online',
      remoteId: projectId,
      syncPending: true,
    })
  })

  it('uploads generated images immediately for an online project', async () => {
    const { callImageApi } = await import('./lib/api')
    authState.accessToken = 'token'
    vi.mocked(uploadOnlineProjectImage).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,AAECAw=='],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    try {
      const projectId = useStore.getState().createProject('在线生成')
      await submitTask()

      await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))
      const generatedTask = useStore.getState().tasks[0]
      expect(uploadOnlineProjectImage).toHaveBeenCalledWith(projectId, generatedTask.id, expect.objectContaining({
        id: generatedTask.outputImages[0],
        dataUrl: 'data:image/png;base64,AAECAw==',
        source: 'generated',
      }))
    } finally {
      authState.accessToken = null
    }
  })

  it('generates and stores OIDC project images through the backend without uploading again', async () => {
    const { callImageApi } = await import('./lib/api')
    authState.accessToken = 'token'
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callBackendImageApi).mockClear()
    vi.mocked(saveOnlineProjectTask).mockClear()
    vi.mocked(uploadOnlineProject).mockClear()
    vi.mocked(uploadOnlineProjectImage).mockClear()
    vi.mocked(callBackendImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,AAECAw=='],
      imageIds: ['remote-image-id'],
      actualParams: { size: '1024x1024', output_format: 'png', n: 1 },
      actualParamsList: [{ size: '1024x1024', output_format: 'png', n: 1 }],
      revisedPrompts: ['后端改写'],
      imagesStoredOnline: true,
      taskRecordQueued: true,
    })
    try {
      const settings = normalizeSettings(useStore.getState().settings)
      useStore.setState({
        settings: normalizeSettings({
          ...settings,
          model: 'gpt-5.5',
          apiMode: 'responses',
          profiles: settings.profiles.map((profile) => (
            profile.id === settings.activeProfileId
              ? { ...profile, model: 'gpt-5.5', apiMode: 'responses' as const }
              : profile
          )),
        }),
      })
      const projectId = useStore.getState().createProject('后端在线生成')
      useStore.setState({ oidcApiOverride: { apiKey: 'oidc-key' } })

      await submitTask({ apiOverride: { apiKey: 'oidc-key', model: 'gpt-image-2' } })

      await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))
      const generatedTask = useStore.getState().tasks[0]
      expect(callBackendImageApi).toHaveBeenCalledWith(expect.objectContaining({
        project: expect.objectContaining({ id: projectId, title: '后端在线生成' }),
        task: expect.objectContaining({ id: generatedTask.id, status: 'running' }),
        manageTaskRecord: true,
        apiKey: 'oidc-key',
        provider: 'openai',
        model: 'gpt-image-2',
        prompt: 'prompt',
        onImageStatusRequestCreated: expect.any(Function),
      }))
      expect(callImageApi).not.toHaveBeenCalled()
      expect(uploadOnlineProjectImage).not.toHaveBeenCalled()
      expect(saveOnlineProjectTask).not.toHaveBeenCalled()
      expect(uploadOnlineProject).not.toHaveBeenCalled()
      expect(useStore.getState().projects.find((item) => item.id === projectId)?.syncPending).toBe(false)
      expect(generatedTask.outputImages).toHaveLength(1)
      expect(generatedTask).toMatchObject({ apiMode: 'images', apiModel: 'gpt-image-2' })
    } finally {
      authState.accessToken = null
    }
  })

  it('routes a Composite platform API key through the asynchronous backend', async () => {
    const { callImageApi } = await import('./lib/api')
    authState.accessToken = 'token'
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callBackendImageApi).mockClear()
    vi.mocked(callBackendCompositeImageApi).mockClear()
    vi.mocked(uploadOnlineProjectImage).mockClear()
    vi.mocked(callBackendCompositeImageApi).mockImplementationOnce(async (options) => {
      await options.onRequestCreated?.({
        requestId: 'composite-request-1',
        statusUrl: 'https://provider.example/status/composite-request-1',
      })
      return {
        images: ['data:image/png;base64,Y29tcG9zaXRl'],
        imagesStoredOnline: false,
        actualCost: 0.0375,
      }
    })
    try {
      useStore.setState({
        settings: normalizeSettings(DEFAULT_SETTINGS),
      })
      const projectId = useStore.getState().createProject('Composite 在线生成')

      await submitTask({ apiOverride: { apiKey: 'composite-key', model: 'openai/gpt-image-2', platform: 'Composite' } })

      await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))
      expect(callBackendCompositeImageApi).toHaveBeenCalledWith(expect.objectContaining({
        apiKey: 'composite-key',
        clientRequestId: 'frontend-request-id',
        model: 'openai/gpt-image-2',
        onRequestCreated: expect.any(Function),
      }))
      expect(callBackendImageApi).not.toHaveBeenCalled()
      expect(callImageApi).not.toHaveBeenCalled()
      expect(uploadOnlineProjectImage).toHaveBeenCalledWith(projectId, expect.any(String), expect.objectContaining({
        dataUrl: 'data:image/png;base64,Y29tcG9zaXRl',
      }))
      expect(useStore.getState().tasks[0]).toMatchObject({
        requestId: 'frontend-request-id',
        compositeRequestId: 'composite-request-1',
        compositeStatusUrl: 'https://provider.example/status/composite-request-1',
        actualCost: 0.0375,
      })
    } finally {
      authState.accessToken = null
    }
  })

  it('persists and reuses Composite File API URLs only for the same API key', async () => {
    authState.accessToken = 'token'
    vi.mocked(callBackendCompositeImageApi).mockClear()
    const dataUrl = 'data:image/png;base64,Y2FjaGVkLXJlZmVyZW5jZQ=='
    const inputImage = { id: `hash-${dataUrl}`, dataUrl }
    await putImage(inputImage)
    vi.mocked(callBackendCompositeImageApi).mockImplementation(async (options) => {
      if (!options.inputImageFileUrls?.[0]) {
        const url = options.apiKey === 'composite-key-a'
          ? 'https://files.example/reference-a.png'
          : 'https://files.example/reference-b.png'
        await options.onReferenceUploaded?.({ source: 'inputImage', index: 0, url })
      }
      return {
        images: [],
        imagesStoredOnline: false,
      }
    })
    try {
      useStore.setState({
        settings: normalizeSettings(DEFAULT_SETTINGS),
        inputImages: [inputImage],
      })

      await submitTask({ apiOverride: { apiKey: 'composite-key-a', model: 'openai/gpt-image-2', platform: 'Composite' } })
      await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

      expect((await getImage(inputImage.id))?.compositeFileUrls).toEqual({
        'hash-composite-key-a': 'https://files.example/reference-a.png',
      })

      await submitTask({ apiOverride: { apiKey: 'composite-key-a', model: 'openai/gpt-image-2', platform: 'Composite' } })
      await vi.waitFor(() => expect(callBackendCompositeImageApi).toHaveBeenCalledTimes(2))
      expect(vi.mocked(callBackendCompositeImageApi).mock.calls[1][0].inputImageFileUrls).toEqual([
        'https://files.example/reference-a.png',
      ])

      await submitTask({ apiOverride: { apiKey: 'composite-key-b', model: 'openai/gpt-image-2', platform: 'Composite' } })
      await vi.waitFor(() => expect(callBackendCompositeImageApi).toHaveBeenCalledTimes(3))
      expect(vi.mocked(callBackendCompositeImageApi).mock.calls[2][0].inputImageFileUrls).toEqual([undefined])
    } finally {
      authState.accessToken = null
    }
  })

  it('shows Composite reference upload failures in the task and toast', async () => {
    authState.accessToken = 'token'
    vi.mocked(callBackendCompositeImageApi).mockClear()
    vi.mocked(callBackendCompositeImageApi).mockImplementationOnce(async (options) => {
      const error = new Error('File API developer key is not configured')
      options.onReferenceUploadFailed?.(error)
      throw error
    })
    try {
      useStore.setState({
        settings: normalizeSettings(DEFAULT_SETTINGS),
      })

      await submitTask({ apiOverride: { apiKey: 'composite-key', model: 'openai/gpt-image-2', platform: 'Composite' } })

      await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('error'))
      const failedTask = useStore.getState().tasks[0]
      expect(failedTask.error).toBe('File API developer key is not configured')
      expect(useStore.getState().detailTaskId).toBe(failedTask.id)
      expect(useStore.getState().showToast).toHaveBeenCalledWith('File API developer key is not configured', 'error')
    } finally {
      authState.accessToken = null
    }
  })

  it('uses the Images API for online OIDC project generation with a Responses profile', async () => {
    const { callImageApi } = await import('./lib/api')
    const profile = createDefaultOpenAIProfile({
      id: 'responses-profile',
      apiMode: 'responses',
      model: 'gpt-image-2',
    })
    authState.accessToken = 'token'
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callBackendImageApi).mockClear()
    vi.mocked(uploadOnlineProjectImage).mockClear()
    vi.mocked(callBackendImageApi).mockImplementationOnce(async (options) => {
      options.onImageStatusRequestCreated?.({ requestId: 'img-response-a' })
      return {
        images: ['data:image/png;base64,cmVzcG9uc2Vz'],
        actualParams: { output_format: 'png', n: 1 },
        actualParamsList: [{ output_format: 'png', n: 1 }],
        revisedPrompts: [],
        imagesStoredOnline: true,
        taskRecordQueued: true,
      }
    })
    try {
      useStore.setState({
        settings: normalizeSettings({
          ...DEFAULT_SETTINGS,
          profiles: [profile],
          activeProfileId: profile.id,
        }),
      })
      const projectId = useStore.getState().createProject('Responses 在线生成')
      useStore.setState({ oidcApiOverride: { apiKey: 'oidc-key', model: 'gpt-image-2' } })

      await submitTask()

      await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))
      expect(callBackendImageApi).toHaveBeenCalledWith(expect.objectContaining({
        project: expect.objectContaining({ id: projectId }),
        task: expect.objectContaining({ projectId, status: 'running' }),
        manageTaskRecord: true,
        apiMode: 'images',
        apiKey: 'oidc-key',
        model: 'gpt-image-2',
        onImageStatusRequestCreated: expect.any(Function),
      }))
      expect(callImageApi).not.toHaveBeenCalled()
      expect(uploadOnlineProjectImage).not.toHaveBeenCalled()
      expect(useStore.getState().tasks[0].imageStatusRequestIds).toEqual(['img-response-a'])
    } finally {
      authState.accessToken = null
    }
  })

  it('loads changed online project archives during startup', async () => {
    const projectId = '86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8'
    authState.accessToken = 'token'
    await putDbTask(task({ id: 'legacy-local-task' }))
    vi.mocked(listOnlineProjects).mockResolvedValueOnce([{
      id: projectId,
      title: '云端项目',
      archive_size: 10,
      archive_sha256: 'remote-sha',
      created_at: '2026-08-16T00:00:00Z',
      updated_at: '2026-08-16T01:00:00Z',
    }])
    vi.mocked(readOnlineProjectArchive).mockReturnValueOnce({
      project: {
        id: projectId,
        title: '云端项目',
        initialPrompt: '云端提示词',
        storage: 'online',
        remoteId: projectId,
        createdAt: 1,
        updatedAt: 2,
      },
      tasks: [task({ id: 'remote-task', outputImages: ['remote-image'] })],
      agentConversations: [],
      favoriteCollections: [],
      defaultFavoriteCollectionId: null,
      images: [],
      thumbnails: [],
    })
    vi.mocked(listOnlineProjectImages).mockResolvedValueOnce([{
      project_id: projectId,
      image_id: 'remote-image',
      task_id: 'remote-task',
      source: 'generated',
      mime_type: 'image/png',
      image_size: 3,
      image_sha256: 'image-sha',
      created_at: '2026-08-16T00:00:00Z',
      updated_at: '2026-08-16T01:00:00Z',
    }])
    try {
      await initStore()

      expect(listOnlineProjects).toHaveBeenCalled()
      expect(downloadOnlineProject).toHaveBeenCalledWith(projectId)
      expect(useStore.getState().projects[0]).toMatchObject({
        id: projectId,
        storage: 'online',
        remoteArchiveSha256: 'remote-sha',
        initialPrompt: '云端提示词',
      })
      expect(useStore.getState().tasks.find((item) => item.id === 'remote-task')?.projectId).toBe(projectId)
      expect(useStore.getState().tasks.find((item) => item.id === 'legacy-local-task')).not.toHaveProperty('projectId')
      expect((await getImage('remote-image'))?.dataUrl).toBe('data:image/png;base64,AAECAw==')
    } finally {
      authState.accessToken = null
    }
  })

  it('loads only the active online project contents and hydrates another project after switching', async () => {
    const projectA = '86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8'
    const projectB = '4d7493e9-2d64-4ef2-b106-9ce56fd9873d'
    const responses = [projectA, projectB].map((id, index) => ({
      id,
      title: `项目 ${index + 1}`,
      archive_size: 10,
      archive_sha256: `remote-sha-${index + 1}`,
      created_at: '2026-08-16T00:00:00Z',
      updated_at: '2026-08-16T01:00:00Z',
    }))
    authState.accessToken = 'token'
    vi.mocked(listOnlineProjects).mockResolvedValue(responses)
    vi.mocked(downloadOnlineProject).mockClear()
    vi.mocked(listOnlineProjectImages).mockClear()
    useStore.setState({ activeProjectId: projectA })
    try {
      await initStore()

      expect(downloadOnlineProject).toHaveBeenCalledTimes(1)
      expect(downloadOnlineProject).toHaveBeenCalledWith(projectA)
      expect(listOnlineProjectImages).toHaveBeenCalledTimes(1)
      expect(listOnlineProjectImages).toHaveBeenCalledWith(projectA)
      expect(useStore.getState().projects.find((project) => project.id === projectB)?.remoteArchiveSha256).toBeUndefined()

      vi.mocked(downloadOnlineProject).mockClear()
      vi.mocked(listOnlineProjectImages).mockClear()
      useStore.getState().setActiveProjectId(projectB)
      await initStore()

      expect(downloadOnlineProject).toHaveBeenCalledTimes(1)
      expect(downloadOnlineProject).toHaveBeenCalledWith(projectB)
      expect(listOnlineProjectImages).toHaveBeenCalledTimes(1)
      expect(listOnlineProjectImages).toHaveBeenCalledWith(projectB)
    } finally {
      vi.mocked(listOnlineProjects).mockResolvedValue([])
      authState.accessToken = null
    }
  })

  it('deduplicates concurrent startup project requests', async () => {
    authState.accessToken = 'token'
    vi.mocked(listOnlineProjects).mockClear()
    let finishList: ((projects: Awaited<ReturnType<typeof listOnlineProjects>>) => void) | undefined
    vi.mocked(listOnlineProjects).mockImplementationOnce(() => new Promise((resolve) => {
      finishList = resolve
    }))
    try {
      const first = initStore()
      const second = initStore()

      await vi.waitFor(() => expect(listOnlineProjects).toHaveBeenCalledTimes(1))
      finishList?.([])
      await Promise.all([first, second])

      expect(listOnlineProjects).toHaveBeenCalledTimes(1)
      await initStore()
      expect(listOnlineProjects).toHaveBeenCalledTimes(2)
    } finally {
      finishList?.([])
      authState.accessToken = null
    }
  })

  it('deletes an online project through the backend before removing its cache', async () => {
    const project = {
      id: 'online-project',
      title: '在线项目',
      initialPrompt: '',
      storage: 'online' as const,
      remoteId: '86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8',
      createdAt: 1,
      updatedAt: 1,
    }
    useStore.setState({ projects: [project] })

    await useStore.getState().deleteProject(project.id)

    expect(deleteOnlineProject).toHaveBeenCalledWith(project.remoteId)
    expect(useStore.getState().projects).toEqual([])
  })

  it('removes cached records when an online project no longer exists', async () => {
    const project = {
      id: 'missing-online-project',
      title: '已删除项目',
      initialPrompt: '',
      storage: 'online' as const,
      remoteId: '86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8',
      remoteArchiveSha256: 'old-sha',
      createdAt: 1,
      updatedAt: 1,
    }
    authState.accessToken = 'token'
    useStore.setState({ projects: [project] })
    await putDbTask(task({ id: 'cached-task', projectId: project.id }))
    try {
      await initStore()

      expect(useStore.getState().projects).toEqual([])
      expect(useStore.getState().tasks.find((item) => item.id === 'cached-task')).toBeUndefined()
    } finally {
      authState.accessToken = null
    }
  })

  it('keeps OIDC api override when retrying a task', async () => {
    const { callImageApi } = await import('./lib/api')
    const profile = createDefaultOpenAIProfile({
      id: 'openai-profile',
      apiKey: 'profile-key',
      model: 'profile-model',
    })
    vi.mocked(callImageApi).mockClear()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [profile],
        activeProfileId: profile.id,
      }),
      tasks: [],
    })

    await retryTask(task({
      apiOverride: { apiKey: 'oidc-key', model: 'oidc-model' },
    }))
    for (let i = 0; i < 5 && vi.mocked(callImageApi).mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const [newTask] = useStore.getState().tasks
    expect(newTask.apiOverride).toEqual({ apiKey: 'oidc-key', model: 'oidc-model' })
    expect(newTask.apiModel).toBe('oidc-model')
    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        profiles: [expect.objectContaining({
          apiKey: 'oidc-key',
          model: 'oidc-model',
        })],
      }),
    }))
  })

  it('uses current OIDC api override when retrying from a task card', async () => {
    const { callImageApi } = await import('./lib/api')
    const profile = createDefaultOpenAIProfile({
      id: 'openai-profile',
      apiKey: 'profile-key',
      model: 'profile-model',
    })
    vi.mocked(callImageApi).mockClear()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [profile],
        activeProfileId: profile.id,
      }),
      oidcApiOverride: { apiKey: 'current-oidc-key', model: 'current-oidc-model' },
      tasks: [],
    })

    await retryTask(task({
      apiOverride: { apiKey: 'old-oidc-key', model: 'old-oidc-model' },
    }))
    for (let i = 0; i < 5 && vi.mocked(callImageApi).mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const [newTask] = useStore.getState().tasks
    expect(newTask.apiOverride).toEqual({ apiKey: 'current-oidc-key', model: 'current-oidc-model' })
    expect(newTask.apiModel).toBe('current-oidc-model')
    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        profiles: [expect.objectContaining({
          apiKey: 'current-oidc-key',
          model: 'current-oidc-model',
        })],
      }),
    }))
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
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))

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
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))

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
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

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
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

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
        profiles: [falProfile],
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
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

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

describe('legacy project online save', () => {
  beforeEach(async () => {
    await clearProjects()
    await clearTasks()
    await clearAgentConversations()
    vi.mocked(buildLegacyProjectArchive).mockClear()
    vi.mocked(uploadOnlineProject).mockClear()
    vi.mocked(clearLegacyProjectUploadId).mockClear()
    useStore.setState({
      tasks: [],
      projects: [],
      activeProjectId: null,
      agentConversations: [],
      legacyProjectSaving: false,
      showToast: vi.fn(),
    })
  })

  it('moves only unassigned tasks into the uploaded online project', async () => {
    const legacyTask = task({ id: 'legacy-task' })
    const existingProjectTask = task({ id: 'project-task', projectId: 'project-a' })
    await putDbTask(legacyTask)
    await putDbTask(existingProjectTask)
    useStore.setState({
      tasks: [legacyTask, existingProjectTask],
      agentConversations: [agentConversation({ id: 'legacy-conversation' })],
    })

    await useStore.getState().saveLegacyProjectOnline()

    const state = useStore.getState()
    const project = state.projects[0]
    expect(project).toMatchObject({ storage: 'online', title: '本地数据' })
    expect(state.tasks.find((item) => item.id === legacyTask.id)?.projectId).toBe(project.id)
    expect(state.tasks.find((item) => item.id === existingProjectTask.id)?.projectId).toBe('project-a')
    expect(state.agentConversations[0]?.projectId).toBe(project.id)
    expect(state.activeProjectId).toBe(project.id)
    expect((await getAllTasks()).find((item) => item.id === legacyTask.id)?.projectId).toBe(project.id)
    expect((await getAllAgentConversations())[0]?.projectId).toBe(project.id)
    expect(clearLegacyProjectUploadId).toHaveBeenCalledOnce()
  })

  it('does not move records assigned while the upload is in progress', async () => {
    const legacyTask = task({ id: 'legacy-task' })
    const legacyConversation = agentConversation({ id: 'legacy-conversation' })
    await putDbTask(legacyTask)
    await putAgentConversation(legacyConversation)
    useStore.setState({ tasks: [legacyTask], agentConversations: [legacyConversation] })
    let finishArchive: ((archive: Blob) => void) | undefined
    vi.mocked(buildLegacyProjectArchive).mockImplementationOnce(() => new Promise((resolve) => {
      finishArchive = resolve
    }))

    const saving = useStore.getState().saveLegacyProjectOnline()
    await vi.waitFor(() => expect(finishArchive).toBeTypeOf('function'))
    const reassignedTask = { ...legacyTask, projectId: 'project-a' }
    const reassignedConversation = { ...legacyConversation, projectId: 'project-a' }
    await putDbTask(reassignedTask)
    await putAgentConversation(reassignedConversation)
    useStore.setState({ tasks: [reassignedTask], agentConversations: [reassignedConversation] })
    finishArchive?.(new Blob(['archive'], { type: 'application/zip' }))
    await saving

    expect(useStore.getState().tasks[0]?.projectId).toBe('project-a')
    expect(useStore.getState().agentConversations[0]?.projectId).toBe('project-a')
    expect((await getAllTasks())[0]?.projectId).toBe('project-a')
    expect((await getAllAgentConversations())[0]?.projectId).toBe('project-a')
  })

  it('keeps local data unchanged when upload fails', async () => {
    const legacyTask = task({ id: 'legacy-task' })
    vi.mocked(uploadOnlineProject).mockRejectedValueOnce(new Error('网络错误'))
    useStore.setState({ tasks: [legacyTask] })

    await useStore.getState().saveLegacyProjectOnline()

    const state = useStore.getState()
    expect(state.tasks[0]).not.toHaveProperty('projectId')
    expect(state.projects).toEqual([])
    expect(state.legacyProjectSaving).toBe(false)
    expect(state.showToast).toHaveBeenCalledWith('网络错误', 'error')
    expect(clearLegacyProjectUploadId).not.toHaveBeenCalled()
  })
})

describe('interrupted OpenAI running tasks', () => {
  it('marks legacy and OpenAI running tasks as interrupted', () => {
    const now = 10_000
    const legacyRunning = task({ id: 'legacy-running', status: 'running', createdAt: 1_000, finishedAt: null, elapsed: null })
    const openAIRunning = task({ id: 'openai-running', apiProvider: 'openai', status: 'running', createdAt: 2_000, finishedAt: null, elapsed: null })
    const trackedOpenAIRunning = task({ id: 'tracked-openai-running', apiProvider: 'openai', status: 'running', imageStatusRequestIds: ['img_request'], createdAt: 2_500, finishedAt: null, elapsed: null })
    const compositeRunning = task({ id: 'composite-running', apiProvider: 'openai', status: 'running', compositeRequestId: 'composite-request', createdAt: 2_700, finishedAt: null, elapsed: null })
    const falRunning = task({ id: 'fal-running', apiProvider: 'fal', status: 'running', createdAt: 3_000, finishedAt: null, elapsed: null })
    const customAsyncRunning = task({ id: 'custom-running', apiProvider: 'custom-provider', customTaskId: 'task-1', status: 'running', createdAt: 4_000, finishedAt: null, elapsed: null })
    const doneTask = task({ id: 'done-task', apiProvider: 'openai', status: 'done' })

    const result = markInterruptedOpenAIRunningTasks([legacyRunning, openAIRunning, trackedOpenAIRunning, compositeRunning, falRunning, customAsyncRunning, doneTask], now)

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
    expect(result.tasks.find((item) => item.id === 'tracked-openai-running')).toEqual(trackedOpenAIRunning)
    expect(result.tasks.find((item) => item.id === 'composite-running')).toEqual(compositeRunning)
    expect(result.tasks.find((item) => item.id === 'fal-running')).toEqual(falRunning)
    expect(result.tasks.find((item) => item.id === 'custom-running')).toEqual(customAsyncRunning)
    expect(result.tasks.find((item) => item.id === 'done-task')).toEqual(doneTask)
  })

  it('queries a persisted Composite request during startup instead of interrupting it', async () => {
    await clearTasks()
    await clearImages()
    const compositeTask = task({
      id: 'composite-recovery',
      apiProvider: 'openai',
      apiModel: 'openai/gpt-image-2',
      apiOverride: { apiKey: 'composite-key', model: 'openai/gpt-image-2', platform: 'Composite' },
      compositeRequestId: 'composite-request',
      compositeStatusUrl: 'https://provider.example/status/composite-request',
      status: 'running',
      createdAt: Date.now(),
      finishedAt: null,
      elapsed: null,
    })
    await putDbTask(compositeTask)
    vi.mocked(queryBackendCompositeImageTask).mockClear()
    vi.mocked(queryBackendCompositeImageTask).mockResolvedValueOnce({
      images: ['data:image/png;base64,Y29tcG9zaXRlLXJlY292ZXJlZA=='],
      rawImageUrls: ['https://images.example/recovered.png'],
      actualParams: { ...DEFAULT_PARAMS },
      actualParamsList: [{ ...DEFAULT_PARAMS }],
      revisedPrompts: [],
      imagesStoredOnline: false,
      actualCost: 0.125,
    })
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
      tasks: [],
      projects: [],
      activeProjectId: null,
      showToast: vi.fn(),
    })

    await initStore()

    await vi.waitFor(() => expect(queryBackendCompositeImageTask).toHaveBeenCalledWith({
      apiKey: 'composite-key',
      model: 'openai/gpt-image-2',
      requestId: 'composite-request',
      clientRequestId: 'frontend-request-id',
      params: compositeTask.params,
    }))
    await vi.waitFor(() => expect(useStore.getState().tasks.find((item) => item.id === compositeTask.id)?.status).toBe('done'))
    expect(useStore.getState().tasks.find((item) => item.id === compositeTask.id)).toMatchObject({
      error: null,
      rawImageUrls: ['https://images.example/recovered.png'],
      compositeRecoverable: false,
      actualCost: 0.125,
    })
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

describe('fal task recovery', () => {
  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    vi.mocked(getFalQueuedImageResult).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
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
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

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
})

describe('image status recovery', () => {
  const openAIProfile = createDefaultOpenAIProfile({ id: 'openai-profile', apiKey: 'openai-key', timeout: 60 })

  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    await clearAgentConversations()
    vi.mocked(queryImageStatuses).mockReset()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [openAIProfile],
        activeProfileId: openAIProfile.id,
      }),
      tasks: [],
      inputImages: [],
      galleryInputDraft: null,
      agentConversations: [],
      activeAgentConversationId: null,
      showToast: vi.fn(),
    })
  })

  it('recovers a tracked non-fal task from image status cos urls', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['ok'], { type: 'image/png' }), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    }))
    const runningTask = task({
      id: 'status-task',
      apiProvider: 'openai',
      apiProfileId: openAIProfile.id,
      apiMode: 'images',
      status: 'running',
      imageStatusRequestIds: ['img_status_1'],
      createdAt: Date.now(),
      finishedAt: null,
      elapsed: null,
    })
    await putDbTask(runningTask)
    vi.mocked(queryImageStatuses).mockResolvedValueOnce({
      records: [{
        requestId: 'img_status_1',
        status: 'succeeded',
        cosUrls: ['https://cos.example/a.png'],
      }],
      notFound: [],
    })

    await initStore()
    await vi.waitFor(() => expect(useStore.getState().tasks.find((item) => item.id === runningTask.id)?.status).toBe('done'))

    const recovered = useStore.getState().tasks.find((item) => item.id === runningTask.id)!
    expect(queryImageStatuses).toHaveBeenCalledWith(expect.objectContaining({ id: openAIProfile.id }), ['img_status_1'], { requestId: 'frontend-request-id' })
    expect(fetchMock).toHaveBeenCalledWith('https://cos.example/a.png', expect.objectContaining({ cache: 'no-store' }))
    expect(recovered.imageStatusRecoverable).toBe(false)
    expect(recovered.outputImages).toHaveLength(1)
    expect((await getImage(recovered.outputImages[0]))?.dataUrl).toBe('data:image/png;base64,b2s=')
    fetchMock.mockRestore()
  })

  it('keeps image status cos urls when recovered image download is blocked', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    const runningTask = task({
      id: 'status-cors-task',
      apiProvider: 'openai',
      apiProfileId: openAIProfile.id,
      apiMode: 'images',
      status: 'running',
      imageStatusRequestIds: ['img_status_cors'],
      createdAt: Date.now(),
      finishedAt: null,
      elapsed: null,
    })
    await putDbTask(runningTask)
    vi.mocked(queryImageStatuses).mockResolvedValueOnce({
      records: [{
        requestId: 'img_status_cors',
        status: 'succeeded',
        cosUrls: ['https://cos.example/blocked.png'],
      }],
      notFound: [],
    })

    await initStore()
    await vi.waitFor(() => expect(useStore.getState().tasks.find((item) => item.id === runningTask.id)?.status).toBe('error'))

    const recovered = useStore.getState().tasks.find((item) => item.id === runningTask.id)!
    expect(recovered.rawImageUrls).toEqual(['https://cos.example/blocked.png'])
    expect(recovered.imageStatusRecoverable).toBe(false)
    expect(recovered.error).toContain('图片链接下载失败')
    fetchMock.mockRestore()
  })

  it('restores Agent assistant message from image status texts after refresh', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['agent'], { type: 'image/png' }), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    }))
    const conversation = agentConversation({
      id: 'agent-status-conversation',
      activeRoundId: 'agent-status-round',
      rounds: [{
        id: 'agent-status-round',
        index: 1,
        parentRoundId: null,
        userMessageId: 'agent-status-user',
        prompt: '生成图片',
        inputImageIds: [],
        outputTaskIds: ['agent-status-task'],
        status: 'running',
        error: null,
        createdAt: Date.now(),
        finishedAt: null,
      }],
      messages: [{
        id: 'agent-status-user',
        role: 'user',
        content: '生成图片',
        roundId: 'agent-status-round',
        createdAt: Date.now(),
      }],
    })
    const runningTask = task({
      id: 'agent-status-task',
      apiProvider: 'openai',
      apiProfileId: openAIProfile.id,
      apiMode: 'responses',
      status: 'running',
      imageStatusRequestIds: ['img_agent_status'],
      createdAt: Date.now(),
      finishedAt: null,
      elapsed: null,
      sourceMode: 'agent',
      agentConversationId: conversation.id,
      agentRoundId: 'agent-status-round',
      agentMessageId: 'agent-status-assistant',
      agentToolCallId: 'agent-tool-call',
    })
    await putAgentConversation(conversation)
    await putDbTask(runningTask)
    vi.mocked(queryImageStatuses).mockResolvedValueOnce({
      records: [{
        requestId: 'img_agent_status',
        status: 'succeeded',
        cosUrls: ['https://cos.example/agent.png'],
        texts: ['Generated the image and adjusted the prompt.'],
      }],
      notFound: [],
    })

    await initStore()
    await vi.waitFor(() => {
      const restored = useStore.getState().agentConversations.find((item) => item.id === conversation.id)
      expect(restored?.rounds[0].status).toBe('done')
    })

    const restored = useStore.getState().agentConversations.find((item) => item.id === conversation.id)!
    const round = restored.rounds[0]
    const assistant = restored.messages.find((message) => message.id === round.assistantMessageId)
    const recovered = useStore.getState().tasks.find((item) => item.id === runningTask.id)!
    expect(round.assistantMessageId).toBe('agent-status-assistant')
    expect(round.outputTaskIds).toEqual(['agent-status-task'])
    expect(assistant?.content).toBe('Generated the image and adjusted the prompt.')
    expect(assistant?.outputTaskIds).toEqual(['agent-status-task'])
    expect(recovered.status).toBe('done')
    expect(recovered.outputImages).toHaveLength(1)
    fetchMock.mockRestore()
  })

  it('keeps a tracked Agent round running and queries image status after refresh before a task exists', async () => {
    const conversation = agentConversation({
      id: 'agent-round-status-conversation',
      activeRoundId: 'agent-round-status',
      rounds: [{
        id: 'agent-round-status',
        index: 1,
        parentRoundId: null,
        userMessageId: 'agent-round-status-user',
        assistantMessageId: 'agent-round-status-assistant',
        prompt: '生成图片',
        inputImageIds: [],
        outputTaskIds: [],
        imageStatusRequestIds: ['img_agent_round_status'],
        imageStatusApiProfileId: openAIProfile.id,
        status: 'running',
        error: null,
        createdAt: Date.now(),
        finishedAt: null,
      }],
      messages: [
        {
          id: 'agent-round-status-user',
          role: 'user',
          content: '生成图片',
          roundId: 'agent-round-status',
          createdAt: Date.now(),
        },
        {
          id: 'agent-round-status-assistant',
          role: 'assistant',
          content: '',
          roundId: 'agent-round-status',
          createdAt: Date.now(),
        },
      ],
    })
    await putAgentConversation(conversation)
    vi.mocked(queryImageStatuses).mockResolvedValueOnce({
      records: [{
        requestId: 'img_agent_round_status',
        status: 'running',
      }],
      notFound: [],
    })

    await initStore()
    await vi.waitFor(() => expect(queryImageStatuses).toHaveBeenCalledWith(expect.objectContaining({ id: openAIProfile.id }), ['img_agent_round_status'], { requestId: 'frontend-request-id' }))

    const restored = useStore.getState().agentConversations.find((item) => item.id === conversation.id)!
    expect(restored.rounds[0]).toMatchObject({
      status: 'running',
      error: null,
      imageStatusRecoverable: true,
    })
    expect(restored.messages.find((message) => message.id === 'agent-round-status-assistant')).toBeTruthy()
    expect(useStore.getState().tasks).toEqual([])
  })

  it('queries a shared Agent round/task image status id only once after refresh', async () => {
    const conversation = agentConversation({
      id: 'agent-shared-status-conversation',
      activeRoundId: 'agent-shared-status-round',
      rounds: [{
        id: 'agent-shared-status-round',
        index: 1,
        parentRoundId: null,
        userMessageId: 'agent-shared-status-user',
        assistantMessageId: 'agent-shared-status-assistant',
        prompt: '生成图片',
        inputImageIds: [],
        outputTaskIds: ['agent-shared-status-task'],
        imageStatusRequestIds: ['img_agent_shared_status'],
        imageStatusApiProfileId: openAIProfile.id,
        status: 'running',
        error: null,
        createdAt: Date.now(),
        finishedAt: null,
      }],
      messages: [
        {
          id: 'agent-shared-status-user',
          role: 'user',
          content: '生成图片',
          roundId: 'agent-shared-status-round',
          createdAt: Date.now(),
        },
        {
          id: 'agent-shared-status-assistant',
          role: 'assistant',
          content: '',
          roundId: 'agent-shared-status-round',
          outputTaskIds: ['agent-shared-status-task'],
          createdAt: Date.now(),
        },
      ],
    })
    const runningTask = task({
      id: 'agent-shared-status-task',
      apiProvider: 'openai',
      apiProfileId: openAIProfile.id,
      apiMode: 'responses',
      status: 'running',
      imageStatusRequestIds: ['img_agent_shared_status'],
      createdAt: Date.now(),
      finishedAt: null,
      elapsed: null,
      sourceMode: 'agent',
      agentConversationId: conversation.id,
      agentRoundId: 'agent-shared-status-round',
      agentMessageId: 'agent-shared-status-assistant',
      agentToolCallId: 'img_agent_shared_status',
    })
    await putAgentConversation(conversation)
    await putDbTask(runningTask)
    vi.mocked(queryImageStatuses).mockResolvedValue({
      records: [{
        requestId: 'img_agent_shared_status',
        status: 'running',
      }],
      notFound: [],
    })

    await initStore()
    await vi.waitFor(() => expect(queryImageStatuses).toHaveBeenCalledTimes(1))

    expect(queryImageStatuses).toHaveBeenCalledWith(expect.objectContaining({ id: openAIProfile.id }), ['img_agent_shared_status'], { requestId: 'frontend-request-id' })
  })

  it('does not query image status for a stopped Agent round after refresh', async () => {
    const conversation = agentConversation({
      id: 'agent-stopped-conversation',
      activeRoundId: 'agent-stopped-round',
      rounds: [{
        id: 'agent-stopped-round',
        index: 1,
        parentRoundId: null,
        userMessageId: 'agent-stopped-user',
        assistantMessageId: 'agent-stopped-assistant',
        prompt: '生成图片',
        inputImageIds: [],
        outputTaskIds: [],
        imageStatusRequestIds: ['img_agent_stopped'],
        imageStatusRecoverable: true,
        imageStatusApiProfileId: openAIProfile.id,
        status: 'error',
        error: '已停止生成。',
        createdAt: Date.now(),
        finishedAt: Date.now(),
      }],
      messages: [
        {
          id: 'agent-stopped-user',
          role: 'user',
          content: '生成图片',
          roundId: 'agent-stopped-round',
          createdAt: Date.now(),
        },
        {
          id: 'agent-stopped-assistant',
          role: 'assistant',
          content: '已停止生成。',
          roundId: 'agent-stopped-round',
          createdAt: Date.now(),
        },
      ],
    })
    await putAgentConversation(conversation)

    await initStore()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const restored = useStore.getState().agentConversations.find((item) => item.id === conversation.id)!
    expect(queryImageStatuses).not.toHaveBeenCalled()
    expect(restored.rounds[0]).toMatchObject({
      status: 'error',
      error: '已停止生成。',
    })
  })

  it('does not turn an Agent round back to running when status returns after manual stop', async () => {
    let resolveStatus: (value: Awaited<ReturnType<typeof queryImageStatuses>>) => void = () => {}
    vi.mocked(queryImageStatuses).mockImplementationOnce(() => new Promise((resolve) => {
      resolveStatus = resolve
    }))
    const conversation = agentConversation({
      id: 'agent-stop-race-conversation',
      activeRoundId: 'agent-stop-race-round',
      rounds: [{
        id: 'agent-stop-race-round',
        index: 1,
        parentRoundId: null,
        userMessageId: 'agent-stop-race-user',
        assistantMessageId: 'agent-stop-race-assistant',
        prompt: '生成图片',
        inputImageIds: [],
        outputTaskIds: [],
        imageStatusRequestIds: ['img_agent_stop_race'],
        imageStatusApiProfileId: openAIProfile.id,
        status: 'running',
        error: null,
        createdAt: Date.now(),
        finishedAt: null,
      }],
      messages: [
        {
          id: 'agent-stop-race-user',
          role: 'user',
          content: '生成图片',
          roundId: 'agent-stop-race-round',
          createdAt: Date.now(),
        },
        {
          id: 'agent-stop-race-assistant',
          role: 'assistant',
          content: '',
          roundId: 'agent-stop-race-round',
          createdAt: Date.now(),
        },
      ],
    })
    await putAgentConversation(conversation)

    await initStore()
    await vi.waitFor(() => expect(queryImageStatuses).toHaveBeenCalledWith(expect.objectContaining({ id: openAIProfile.id }), ['img_agent_stop_race'], { requestId: 'frontend-request-id' }))
    useStore.setState((state) => ({
      agentConversations: state.agentConversations.map((item) =>
        item.id === conversation.id
          ? {
              ...item,
              rounds: item.rounds.map((round) =>
                round.id === 'agent-stop-race-round'
                  ? { ...round, status: 'error', error: '已停止生成。', imageStatusRecoverable: false, finishedAt: Date.now() }
                  : round,
              ),
            }
          : item,
      ),
    }))
    resolveStatus({
      records: [{
        requestId: 'img_agent_stop_race',
        status: 'running',
      }],
      notFound: [],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const restored = useStore.getState().agentConversations.find((item) => item.id === conversation.id)!
    expect(restored.rounds[0]).toMatchObject({
      status: 'error',
      error: '已停止生成。',
      imageStatusRecoverable: false,
    })
  })

  it('does not keep polling when a tracked task fails while image status is running', async () => {
    vi.useFakeTimers()
    try {
      let resolveStatus: (value: Awaited<ReturnType<typeof queryImageStatuses>>) => void = () => {}
      vi.mocked(queryImageStatuses).mockImplementationOnce(() => new Promise((resolve) => {
        resolveStatus = resolve
      }))
      const runningTask = task({
        id: 'status-invalid-key-task',
        apiProvider: 'openai',
        apiProfileId: openAIProfile.id,
        apiMode: 'responses',
        status: 'running',
        imageStatusRequestIds: ['img_status_invalid_key'],
        createdAt: Date.now(),
        finishedAt: null,
        elapsed: null,
      })
      await putDbTask(runningTask)

      await initStore()
      await vi.advanceTimersByTimeAsync(0)
      expect(queryImageStatuses).toHaveBeenCalledWith(expect.objectContaining({ id: openAIProfile.id }), ['img_status_invalid_key'], { requestId: 'frontend-request-id' })

      useStore.setState((state) => ({
        tasks: state.tasks.map((item) =>
          item.id === runningTask.id
            ? { ...item, status: 'error', error: 'Invalid API key', imageStatusRecoverable: false, finishedAt: Date.now() }
            : item,
        ),
      }))
      resolveStatus({
        records: [{
          requestId: 'img_status_invalid_key',
          status: 'running',
        }],
        notFound: [],
      })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5000)

      const restored = useStore.getState().tasks.find((item) => item.id === runningTask.id)!
      expect(queryImageStatuses).toHaveBeenCalledTimes(1)
      expect(restored).toMatchObject({
        status: 'error',
        error: 'Invalid API key',
        imageStatusRecoverable: false,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not keep polling when an Agent round fails while image status is running', async () => {
    vi.useFakeTimers()
    try {
      let resolveStatus: (value: Awaited<ReturnType<typeof queryImageStatuses>>) => void = () => {}
      vi.mocked(queryImageStatuses).mockImplementationOnce(() => new Promise((resolve) => {
        resolveStatus = resolve
      }))
      const conversation = agentConversation({
        id: 'agent-invalid-key-conversation',
        activeRoundId: 'agent-invalid-key-round',
        rounds: [{
          id: 'agent-invalid-key-round',
          index: 1,
          parentRoundId: null,
          userMessageId: 'agent-invalid-key-user',
          assistantMessageId: 'agent-invalid-key-assistant',
          prompt: '生成图片',
          inputImageIds: [],
          outputTaskIds: [],
          imageStatusRequestIds: ['img_agent_invalid_key'],
          imageStatusApiProfileId: openAIProfile.id,
          status: 'running',
          error: null,
          createdAt: Date.now(),
          finishedAt: null,
        }],
        messages: [
          {
            id: 'agent-invalid-key-user',
            role: 'user',
            content: '生成图片',
            roundId: 'agent-invalid-key-round',
            createdAt: Date.now(),
          },
          {
            id: 'agent-invalid-key-assistant',
            role: 'assistant',
            content: '',
            roundId: 'agent-invalid-key-round',
            createdAt: Date.now(),
          },
        ],
      })
      await putAgentConversation(conversation)

      await initStore()
      await vi.advanceTimersByTimeAsync(0)
      expect(queryImageStatuses).toHaveBeenCalledWith(expect.objectContaining({ id: openAIProfile.id }), ['img_agent_invalid_key'], { requestId: 'frontend-request-id' })

      useStore.setState((state) => ({
        agentConversations: state.agentConversations.map((item) =>
          item.id === conversation.id
            ? {
                ...item,
                rounds: item.rounds.map((round) =>
                  round.id === 'agent-invalid-key-round'
                    ? { ...round, status: 'error', error: 'Invalid API key', imageStatusRecoverable: false, finishedAt: Date.now() }
                    : round,
                ),
              }
            : item,
        ),
      }))
      resolveStatus({
        records: [{
          requestId: 'img_agent_invalid_key',
          status: 'running',
        }],
        notFound: [],
      })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5000)

      const restored = useStore.getState().agentConversations.find((item) => item.id === conversation.id)!
      expect(queryImageStatuses).toHaveBeenCalledTimes(1)
      expect(restored.rounds[0]).toMatchObject({
        status: 'error',
        error: 'Invalid API key',
        imageStatusRecoverable: false,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not recheck a terminal errored image status task on init', async () => {
    const erroredTask = task({
      id: 'status-errored-task',
      apiProvider: 'openai',
      apiProfileId: openAIProfile.id,
      apiMode: 'images',
      status: 'error',
      error: '图片状态查询超时',
      imageStatusRequestIds: ['img_status_retry'],
      imageStatusRecoverable: false,
      createdAt: Date.now(),
      finishedAt: Date.now(),
      elapsed: 1000,
    })
    await putDbTask(erroredTask)

    await initStore()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const recovered = useStore.getState().tasks.find((item) => item.id === erroredTask.id)!
    expect(queryImageStatuses).not.toHaveBeenCalled()
    expect(recovered.rawImageUrls).toBeUndefined()
    expect(recovered.error).toBe('图片状态查询超时')
  })

  it('does not query Agent round status on init when its image task is terminally failed', async () => {
    const conversation = agentConversation({
      id: 'agent-terminal-task-conversation',
      activeRoundId: 'agent-terminal-task-round',
      rounds: [{
        id: 'agent-terminal-task-round',
        index: 1,
        parentRoundId: null,
        userMessageId: 'agent-terminal-task-user',
        assistantMessageId: 'agent-terminal-task-assistant',
        prompt: '生成图片',
        inputImageIds: [],
        outputTaskIds: ['agent-terminal-task'],
        imageStatusRequestIds: ['img_agent_terminal_task'],
        imageStatusApiProfileId: openAIProfile.id,
        status: 'running',
        error: null,
        createdAt: Date.now(),
        finishedAt: null,
      }],
      messages: [
        {
          id: 'agent-terminal-task-user',
          role: 'user',
          content: '生成图片',
          roundId: 'agent-terminal-task-round',
          createdAt: Date.now(),
        },
        {
          id: 'agent-terminal-task-assistant',
          role: 'assistant',
          content: '',
          roundId: 'agent-terminal-task-round',
          outputTaskIds: ['agent-terminal-task'],
          createdAt: Date.now(),
        },
      ],
    })
    const failedTask = task({
      id: 'agent-terminal-task',
      apiProvider: 'openai',
      apiProfileId: openAIProfile.id,
      apiMode: 'responses',
      status: 'error',
      error: 'Invalid API key',
      imageStatusRequestIds: ['img_agent_terminal_task'],
      imageStatusRecoverable: false,
      createdAt: Date.now(),
      finishedAt: Date.now(),
      elapsed: 1000,
      sourceMode: 'agent',
      agentConversationId: conversation.id,
      agentRoundId: 'agent-terminal-task-round',
      agentMessageId: 'agent-terminal-task-assistant',
      agentToolCallId: 'img_agent_terminal_task',
    })
    await putAgentConversation(conversation)
    await putDbTask(failedTask)

    await initStore()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const restored = useStore.getState().agentConversations.find((item) => item.id === conversation.id)!
    expect(queryImageStatuses).not.toHaveBeenCalled()
    expect(restored.rounds[0]).toMatchObject({
      status: 'error',
      error: 'Invalid API key',
      imageStatusRecoverable: false,
    })
  })

  it('fails a tracked non-fal task when image status explicitly fails', async () => {
    const runningTask = task({
      id: 'status-failed-task',
      apiProvider: 'openai',
      apiProfileId: openAIProfile.id,
      apiMode: 'responses',
      status: 'running',
      imageStatusRequestIds: ['img_status_failed'],
      createdAt: Date.now(),
      finishedAt: null,
      elapsed: null,
    })
    await putDbTask(runningTask)
    vi.mocked(queryImageStatuses).mockResolvedValueOnce({
      records: [{
        requestId: 'img_status_failed',
        status: 'failed',
        error: 'upstream failed',
      }],
      notFound: [],
    })

    await initStore()
    await vi.waitFor(() => expect(useStore.getState().tasks.find((item) => item.id === runningTask.id)?.status).toBe('error'))

    const recovered = useStore.getState().tasks.find((item) => item.id === runningTask.id)!
    expect(recovered.error).toBe('upstream failed')
    expect(recovered.imageStatusRecoverable).toBe(false)
  })
})

describe('agent conversation creation', () => {
  beforeEach(() => {
    useStore.setState({
      agentConversations: [],
      activeAgentConversationId: null,
      activeProjectId: null,
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
  it('persists new and deleted conversations without losing older data', async () => {
    await clearAgentConversations()
    await initStore()
    const first = agentConversation({
      id: 'persisted-first',
      title: 'older chat',
      messages: [{ id: 'first-message', role: 'user', content: 'old', roundId: 'first-round', createdAt: 1 }],
    })
    useStore.setState({ agentConversations: [first], activeAgentConversationId: first.id })
    await vi.waitFor(async () => expect((await getAllAgentConversations()).map((item) => item.id)).toEqual([first.id]))

    const secondId = useStore.getState().createAgentConversation()
    await vi.waitFor(async () => expect((await getAllAgentConversations()).map((item) => item.id)).toEqual([first.id, secondId]))

    useStore.getState().deleteAgentConversation(first.id)
    await vi.waitFor(async () => expect((await getAllAgentConversations()).map((item) => item.id)).toEqual([secondId]))
    expect(useStore.getState().agentConversations.map((item) => item.id)).toEqual([secondId])
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

  it('keeps embedded Agent attachments separate from gallery attachments', () => {
    useStore.setState({
      appMode: 'gallery',
      prompt: 'gallery prompt',
      inputImages: [imageB],
      agentInputDrafts: {
        'conversation-a': {
          prompt: 'agent prompt',
          inputImages: [],
          maskDraft: null,
          maskEditorImageId: null,
        },
      },
    })

    const state = useStore.getState()
    state.addAgentInputImage('conversation-a', imageA)

    expect(useStore.getState().inputImages).toEqual([imageB])
    expect(useStore.getState().agentInputDrafts['conversation-a']?.inputImages).toEqual([imageA])

    state.removeAgentInputImage('conversation-a', 0)

    expect(useStore.getState().inputImages).toEqual([imageB])
    expect(useStore.getState().agentInputDrafts['conversation-a']?.inputImages).toEqual([])
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
      oidcApiOverride: null,
      agentOidcApiOverride: null,
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

  it('submits embedded Agent attachments without clearing gallery attachments', async () => {
    useStore.setState({
      appMode: 'gallery',
      prompt: 'gallery prompt',
      inputImages: [imageB],
      agentConversations: [agentConversation({ id: 'conversation-embedded', rounds: [], messages: [] })],
      activeAgentConversationId: 'conversation-embedded',
      agentInputDrafts: {
        'conversation-embedded': {
          prompt: 'agent prompt',
          inputImages: [imageA],
          maskDraft: null,
          maskEditorImageId: null,
        },
      },
    })

    await submitAgentMessage()

    const state = useStore.getState()
    const conversation = state.agentConversations.find((item) => item.id === 'conversation-embedded')
    expect(conversation?.rounds[0]?.inputImageIds).toEqual([imageA.id])
    expect(state.inputImages).toEqual([imageB])
    expect(state.prompt).toBe('gallery prompt')
    expect(state.agentInputDrafts['conversation-embedded']).toBeUndefined()

    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  it('forces Agent submissions to use the Responses API', async () => {
    const current = useStore.getState()
    const settings = normalizeSettings({
      ...current.settings,
      apiMode: 'images',
      profiles: current.settings.profiles.map((profile) => ({ ...profile, apiMode: 'images' as const })),
    })
    useStore.setState({
      settings,
      tasks: [],
      agentConversations: [agentConversation({ id: 'conversation-mode', rounds: [], messages: [] })],
      activeAgentConversationId: 'conversation-mode',
      prompt: '生成图片',
    })

    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(vi.mocked(callAgentResponsesApi).mock.calls[0][0].profile.apiMode).toBe('responses')
  })

  it('uses the Agent model without changing the gallery model override', async () => {
    useStore.setState({
      oidcApiOverride: { apiKey: 'shared-key', model: 'gallery-model' },
      agentOidcApiOverride: { model: 'agent-model' },
      agentConversations: [agentConversation({ id: 'conversation-model', rounds: [], messages: [] })],
      activeAgentConversationId: 'conversation-model',
      prompt: '生成图片',
    })

    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(vi.mocked(callAgentResponsesApi).mock.calls[0][0].profile).toMatchObject({
      apiKey: 'shared-key',
      model: 'agent-model',
    })
    expect(useStore.getState().oidcApiOverride).toEqual({ apiKey: 'shared-key', model: 'gallery-model' })
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
    vi.mocked(callAgentResponsesApi).mockClear()
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
    for (let i = 0; i < 10 && useStore.getState().tasks[0]?.status !== 'error'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

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
    for (let i = 0; i < 10 && useStore.getState().agentConversations[0].rounds[0]?.status !== 'done'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

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
