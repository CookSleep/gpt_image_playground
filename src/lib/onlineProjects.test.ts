import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentConversation, AppSettings, StoredImage, TaskParams, TaskRecord } from '../types'
import { readExportZip } from './exportZip'

const images: StoredImage[] = []
const authFetch = vi.hoisted(() => vi.fn())

vi.mock('../auth/api', () => ({ authFetch }))

vi.mock('./db', () => ({
  getAllImages: async () => images,
}))

import { buildLegacyProjectArchive, buildOnlineProjectArchive, deleteOnlineProject, deleteOnlineProjectTask, downloadOnlineProject, getAgentConversationReferencedImageIds, getOnlineProjectCanvas, getTaskReferencedImageIds, listOnlineProjects, saveOnlineProjectCanvas, saveOnlineProjectTask, uploadOnlineProjectImage } from './onlineProjects'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: {} as TaskParams,
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1700000000000,
    finishedAt: 1700000000001,
    elapsed: 1,
    ...overrides,
  }
}

function conversation(id: string, projectId?: string): AgentConversation {
  return {
    id,
    ...(projectId ? { projectId } : {}),
    title: id,
    activeRoundId: null,
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
  }
}

describe('onlineProjects', () => {
  beforeEach(() => {
    images.splice(0)
    authFetch.mockReset()
  })

  it('collects every image referenced by a task', () => {
    expect(getTaskReferencedImageIds(task({
      inputImageIds: ['input'],
      maskTargetImageId: 'target',
      maskImageId: 'mask',
      outputImages: ['output'],
      transparentOriginalImages: ['original'],
      streamPartialImageIds: ['partial'],
    }))).toEqual(['input', 'target', 'mask', 'output', 'original', 'partial'])
  })

  it('collects every image referenced by an Agent conversation', () => {
    const value = conversation('conversation-a')
    value.rounds = [{
      id: 'round-a',
      index: 1,
      userMessageId: 'message-a',
      prompt: 'prompt',
      inputImageIds: ['round-input'],
      maskTargetImageId: 'round-target',
      maskImageId: 'round-mask',
      outputTaskIds: [],
      status: 'done',
      error: null,
      createdAt: 1,
      finishedAt: 2,
    }]
    value.messages = [{
      id: 'message-a',
      role: 'user',
      content: 'prompt',
      roundId: 'round-a',
      inputImageIds: ['message-input'],
      maskTargetImageId: 'message-target',
      maskImageId: 'message-mask',
      createdAt: 1,
    }]

    expect(getAgentConversationReferencedImageIds(value)).toEqual([
      'round-input',
      'round-target',
      'round-mask',
      'message-input',
      'message-target',
      'message-mask',
    ])
  })

  it('archives only unassigned records without embedding image binaries', async () => {
    images.push(
      { id: 'local-image', dataUrl: 'data:image/png;base64,AAECAw==', source: 'generated' },
      { id: 'online-image', dataUrl: 'data:image/png;base64,BAUGBw==', source: 'generated' },
      { id: 'unused-image', dataUrl: 'data:image/png;base64,CAkKCw==', source: 'upload' },
    )
    const archive = await buildLegacyProjectArchive({
      settings: { apiKey: 'secret' } as AppSettings,
      tasks: [
        task({ id: 'local-task', outputImages: ['local-image'] }),
        task({ id: 'online-task', projectId: 'project-a', outputImages: ['online-image'] }),
      ],
      agentConversations: [conversation('local-conversation'), conversation('online-conversation', 'project-a')],
      favoriteCollections: [],
      defaultFavoriteCollectionId: null,
    })
    const parsed = readExportZip(new Uint8Array(await archive.arrayBuffer()))

    expect(parsed.manifest.settings).toBeUndefined()
    expect(parsed.manifest.projects).toEqual([])
    expect(parsed.manifest.tasks?.map((item) => item.id)).toEqual(['local-task'])
    expect(parsed.manifest.agentConversations?.map((item) => item.id)).toEqual(['local-conversation'])
    expect(parsed.manifest.imageFiles).toEqual({})
  })

  it('archives only records belonging to one online project', async () => {
    images.push(
      { id: 'project-image', dataUrl: 'data:image/png;base64,AAECAw==', source: 'generated' },
      { id: 'agent-reference', dataUrl: 'data:image/png;base64,AgMEBQ==', source: 'upload' },
      { id: 'other-image', dataUrl: 'data:image/png;base64,BAUGBw==', source: 'generated' },
    )
    const project = {
      id: 'project-a',
      title: '项目 A',
      initialPrompt: '提示词',
      storage: 'online' as const,
      remoteId: 'project-a',
      remoteArchiveSha256: 'old-sha',
      syncPending: true,
      defaultFavoriteCollectionId: 'favorite-a',
      createdAt: 1,
      updatedAt: 2,
    }
    const projectConversation = conversation('project-conversation', project.id)
    projectConversation.rounds = [{
      id: 'round-a',
      index: 1,
      userMessageId: 'message-a',
      prompt: 'prompt',
      inputImageIds: ['agent-reference'],
      outputTaskIds: [],
      status: 'done',
      error: null,
      createdAt: 1,
      finishedAt: 2,
    }]
    const archive = await buildOnlineProjectArchive({
      settings: { apiKey: 'secret' } as AppSettings,
      projects: [project],
      tasks: [
        task({ id: 'project-task', projectId: project.id, outputImages: ['project-image'] }),
        task({ id: 'other-task', projectId: 'project-b', outputImages: ['other-image'] }),
      ],
      agentConversations: [projectConversation, conversation('other-conversation', 'project-b')],
      favoriteCollections: [
        { id: 'favorite-a', projectId: project.id, name: '项目 A 收藏夹', createdAt: 1, updatedAt: 1 },
        { id: 'favorite-b', projectId: 'project-b', name: '项目 B 收藏夹', createdAt: 1, updatedAt: 1 },
        { id: 'favorite-local', name: '本地收藏夹', createdAt: 1, updatedAt: 1 },
      ],
      defaultFavoriteCollectionId: null,
    }, project.id)
    const parsed = readExportZip(new Uint8Array(await archive.arrayBuffer()))

    expect(parsed.manifest.settings).toBeUndefined()
    expect(parsed.manifest.projects?.[0]).not.toHaveProperty('remoteArchiveSha256')
    expect(parsed.manifest.tasks?.map((item) => item.id)).toEqual(['project-task'])
    expect(parsed.manifest.agentConversations?.map((item) => item.id)).toEqual(['project-conversation'])
    expect(parsed.manifest.favoriteCollections?.map((item) => item.id)).toEqual(['favorite-a'])
    expect(parsed.manifest.defaultFavoriteCollectionId).toBe('favorite-a')
    expect(parsed.manifest.imageFiles).toEqual({})
  })

  it('uploads a generated image as an independent project record', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      project_id: 'project-a',
      image_id: 'image-a',
      mime_type: 'image/png',
      image_size: 4,
      image_sha256: 'sha256',
      created_at: '2026-08-16T00:00:00Z',
      updated_at: '2026-08-16T00:00:00Z',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))

    await uploadOnlineProjectImage('project-a', 'task-a', {
      id: 'image-a',
      dataUrl: 'data:image/png;base64,AAECAw==',
      source: 'generated',
      width: 1024,
      height: 1024,
    })

    const [url, options] = authFetch.mock.calls[0]
    const form = options?.body as FormData
    expect(url).toBe('/api/v1/projects/project-a/images')
    expect(options?.method).toBe('POST')
    expect(form.get('image_id')).toBe('image-a')
    expect(form.get('task_id')).toBe('task-a')
    expect(form.get('source')).toBe('generated')
    expect(form.get('width')).toBe('1024')
    expect(form.get('image')).toBeInstanceOf(Blob)
  })

  it('saves and deletes one task without uploading a project archive', async () => {
    const response = {
      id: 'project-a',
      title: '项目 A',
      archive_size: 10,
      archive_sha256: 'sha256',
      created_at: '2026-08-16T00:00:00Z',
      updated_at: '2026-08-16T01:00:00Z',
    }
    authFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }))
    const project = {
      id: 'project-a',
      title: '项目 A',
      initialPrompt: 'prompt',
      storage: 'online' as const,
      remoteId: 'project-a',
      createdAt: 1,
      updatedAt: 2,
    }

    await saveOnlineProjectTask(project, task({ id: 'task-a', projectId: project.id }))
    await deleteOnlineProjectTask(project.id, 'task-a')

    expect(authFetch).toHaveBeenNthCalledWith(1, '/api/v1/projects/project-a/tasks/task-a', expect.objectContaining({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    }))
    const body = JSON.parse(String(authFetch.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({
      project_title: '项目 A',
      project: { id: 'project-a' },
      task: { id: 'task-a' },
    })
    expect(authFetch).toHaveBeenNthCalledWith(2, '/api/v1/projects/project-a/tasks/task-a', { method: 'DELETE' })
  })

  it('loads the online project list', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify([{
      id: '86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8',
      title: '云端项目',
      archive_size: 10,
      archive_sha256: 'sha256',
      created_at: '2026-08-16T00:00:00Z',
      updated_at: '2026-08-16T01:00:00Z',
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const projects = await listOnlineProjects()

    expect(authFetch).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/v1\/projects\?_=\d+$/), { cache: 'no-store' })
    expect(projects).toHaveLength(1)
    expect(projects[0]?.title).toBe('云端项目')
  })

  it('saves canvas state through the dedicated endpoint', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'project-a' }), { status: 200 }))
    const project = {
      id: 'project-a',
      title: '项目 A',
      initialPrompt: '',
      storage: 'online' as const,
      remoteId: 'remote-a',
      createdAt: 1,
      updatedAt: 2,
    }
    const canvas = { version: 1, viewport: { x: 1, y: 2, scale: 1 }, items: {} }

    await saveOnlineProjectCanvas(project, canvas)

    expect(authFetch).toHaveBeenCalledWith('/api/v1/projects/remote-a/canvas', expect.objectContaining({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvas }),
    }))
  })

  it('loads canvas state through the dedicated endpoint', async () => {
    const canvas = { version: 1, viewport: { x: 4, y: 8, scale: 1 }, items: {} }
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ canvas }), { status: 200 }))

    await expect(getOnlineProjectCanvas('project-a')).resolves.toEqual(canvas)
    expect(authFetch).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/v1\/projects\/project-a\/canvas\?_\=\d+$/), { cache: 'no-store' })
  })

  it('returns no canvas for legacy projects', async () => {
    authFetch.mockResolvedValueOnce(new Response(null, { status: 404 }))

    await expect(getOnlineProjectCanvas('project-a')).resolves.toBeNull()
  })

  it('downloads and deletes an online project', async () => {
    const id = '86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8'
    authFetch
      .mockResolvedValueOnce(new Response(new Uint8Array([80, 75, 3, 4]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    expect([...await downloadOnlineProject(id)]).toEqual([80, 75, 3, 4])
    await deleteOnlineProject(id)

    expect(authFetch).toHaveBeenNthCalledWith(1, expect.stringMatching(new RegExp(`^/api/v1/projects/${id}\\?_=\\d+$`)), { cache: 'no-store' })
    expect(authFetch).toHaveBeenNthCalledWith(2, `/api/v1/projects/${id}`, { method: 'DELETE' })
  })
})
