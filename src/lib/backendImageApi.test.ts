import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { authFetch } from '../auth/api'
import { callBackendImageApi } from './backendImageApi'

vi.mock('../auth/api', () => ({
  authFetch: vi.fn(),
}))

describe('callBackendImageApi', () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset()
  })

  it('sends project generation to the authenticated backend', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      images: ['data:image/png;base64,AAECAw=='],
      image_ids: ['image-a'],
      actual_params: { size: '1024x1024', output_format: 'png', n: 1 },
      revised_prompts: ['rewritten'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const requests: Array<{ requestId: string; requestIndex?: number }> = []
    const result = await callBackendImageApi({
      projectId: 'project/a',
      projectTitle: '项目 A',
      taskId: 'task-a',
      apiKey: 'oidc-key',
      model: 'gpt-image-2',
      apiMode: 'responses',
      allowPromptRewrite: false,
      codexCli: false,
      prompt: '画一张图',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      onImageStatusRequestCreated: (request) => requests.push(request),
    })

    expect(authFetch).toHaveBeenCalledWith('/api/v1/projects/project%2Fa/generations', expect.objectContaining({
      method: 'POST',
    }))
    const request = JSON.parse(vi.mocked(authFetch).mock.calls[0][1]?.body as string)
    expect(request).toMatchObject({
      task_id: 'task-a',
      project_title: '项目 A',
      api_key: 'oidc-key',
      model: 'gpt-image-2',
      api_mode: 'responses',
      allow_prompt_rewrite: false,
      codex_cli: false,
      request_ids: [requests[0].requestId],
      prompt: '画一张图',
      input_images: [],
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].requestId).toMatch(/^img_/)
    expect(result).toMatchObject({
      imagesStoredOnline: true,
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
      projectId: 'project/a',
      projectTitle: '项目 A',
      taskId: 'task-a',
      apiKey: 'oidc-key',
      model: 'gpt-image-2',
      apiMode: 'images',
      allowPromptRewrite: true,
      codexCli: false,
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
      projectId: 'project-a',
      projectTitle: '项目 A',
      taskId: 'task-a',
      apiKey: 'oidc-key',
      model: 'gpt-image-2',
      apiMode: 'images',
      allowPromptRewrite: true,
      codexCli: false,
      prompt: '画一张图',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })).rejects.toThrow('provider failed')
  })
})
