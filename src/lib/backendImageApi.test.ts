import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type Project, type TaskRecord } from '../types'
import { authFetch } from '../auth/api'
import { callBackendImageApi } from './backendImageApi'

vi.mock('../auth/api', () => ({
  authFetch: vi.fn(),
  REQUEST_ID_HEADER: 'X-Request-ID',
}))

function project(): Project {
  return {
    id: 'project/a',
    title: '项目 A',
    initialPrompt: '画一张图',
    storage: 'online',
    remoteId: 'project/a',
    createdAt: 1,
    updatedAt: 1,
  }
}

function task(): TaskRecord {
  return {
    id: 'task-a',
    requestId: 'frontend-request-a',
    projectId: 'project/a',
    prompt: '画一张图',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: 1,
    finishedAt: null,
    elapsed: null,
  }
}

describe('callBackendImageApi', () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset()
  })

  it('sends project generation to the authenticated backend', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      images: ['data:image/png;base64,AAECAw=='],
      image_ids: ['image-a'],
      actual_params: { size: '1024x1024', output_format: 'png', n: 1 },
      actual_params_list: [{ size: '1024x1024', output_format: 'png', n: 1 }],
      revised_prompts: ['rewritten'],
      task_record_queued: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const requests: Array<{ requestId: string; requestIndex?: number }> = []
    const result = await callBackendImageApi({
      project: project(),
      task: task(),
      manageTaskRecord: true,
      apiKey: 'oidc-key',
      provider: 'openai',
      model: 'gpt-image-2',
      apiMode: 'responses',
      allowPromptRewrite: false,
      prompt: '画一张图',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      onImageStatusRequestCreated: (request) => requests.push(request),
    })

    expect(authFetch).toHaveBeenCalledWith('/api/v1/projects/project%2Fa/generations', expect.objectContaining({
      method: 'POST',
      headers: { 'X-Request-ID': 'frontend-request-a' },
    }))
    const request = JSON.parse(vi.mocked(authFetch).mock.calls[0][1]?.body as string)
    expect(request).toMatchObject({
      task_id: 'task-a',
      project_title: '项目 A',
      api_key: 'oidc-key',
      provider: 'openai',
      model: 'gpt-image-2',
      api_mode: 'responses',
      allow_prompt_rewrite: false,
      request_ids: [requests[0].requestId],
      prompt: '画一张图',
      input_images: [],
      project: expect.objectContaining({ id: 'project/a' }),
      task: expect.objectContaining({ id: 'task-a', status: 'running' }),
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].requestId).toMatch(/^img_/)
    expect(result).toMatchObject({
      imagesStoredOnline: true,
      taskRecordQueued: true,
      imageIds: ['image-a'],
      actualParams: { size: '1024x1024', output_format: 'png', n: 1 },
      revisedPrompts: ['rewritten'],
    })
  })

  it('sends image edits to the authenticated backend edit endpoint', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      images: ['data:image/png;base64,AAECAw=='],
      image_ids: ['image-a'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const image = 'data:image/png;base64,aW1hZ2U='
    const mask = 'data:image/png;base64,bWFzaw=='
    await callBackendImageApi({
      project: project(),
      task: task(),
      manageTaskRecord: true,
      apiKey: 'oidc-key',
      provider: 'openai',
      model: 'gpt-image-2',
      apiMode: 'images',
      allowPromptRewrite: true,
      prompt: '按参考图编辑',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [image],
      maskDataUrl: mask,
    })

    expect(authFetch).toHaveBeenCalledWith('/api/v1/projects/project%2Fa/edits', expect.objectContaining({
      method: 'POST',
    }))
    const request = JSON.parse(vi.mocked(authFetch).mock.calls[0][1]?.body as string)
    expect(request).toMatchObject({
      provider: 'openai',
      prompt: '按参考图编辑',
      input_images: [image],
      mask,
    })
  })

  it('surfaces backend generation errors', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({ message: 'provider failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callBackendImageApi({
      project: { ...project(), id: 'project-a', remoteId: 'project-a' },
      task: { ...task(), projectId: 'project-a' },
      manageTaskRecord: true,
      apiKey: 'oidc-key',
      provider: 'openai',
      model: 'gpt-image-2',
      apiMode: 'images',
      allowPromptRewrite: true,
      prompt: '画一张图',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })).rejects.toThrow('provider failed')
  })

  it('preserves the upstream status code for recoverable timeout handling', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'origin response timeout' }), {
      status: 524,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callBackendImageApi({
      project: { ...project(), id: 'project-a', remoteId: 'project-a' },
      task: { ...task(), projectId: 'project-a' },
      manageTaskRecord: true,
      apiKey: 'oidc-key',
      provider: 'openai',
      model: 'gpt-image-2',
      apiMode: 'images',
      allowPromptRewrite: true,
      prompt: '画一张图',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })).rejects.toMatchObject({ status: 524 })
  })
})
