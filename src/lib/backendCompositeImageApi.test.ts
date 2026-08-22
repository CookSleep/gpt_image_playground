import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { authFetch, syncOIDCUserProfile } from '../auth/api'
import { callBackendCompositeImageApi } from './backendCompositeImageApi'

vi.mock('../auth/api', () => ({
  authFetch: vi.fn(),
  syncOIDCUserProfile: vi.fn(async () => null),
}))

describe('callBackendCompositeImageApi', () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset()
    vi.mocked(syncOIDCUserProfile).mockReset()
  })

  it('submits, polls and reads the result through independent backend endpoints', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'request-1' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        images: [{ url: 'data:image/png;base64,AAECAw==' }],
      }), { status: 200 }))
    const onRequestCreated = vi.fn()

    const result = await callBackendCompositeImageApi({
      apiKey: 'composite-key',
      model: 'openai/gpt-image-2',
      prompt: '画一张图',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      onRequestCreated,
    })

    expect(vi.mocked(authFetch).mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/model/openai/gpt-image-2',
      '/api/v1/model/openai/gpt-image-2/requests/request-1/status',
      '/api/v1/model/openai/gpt-image-2/requests/request-1',
    ])
    expect(authFetch).toHaveBeenNthCalledWith(1, '/api/v1/model/openai/gpt-image-2', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-Upstream-API-Key': 'composite-key' }),
    }))
    expect(onRequestCreated).toHaveBeenCalledWith('request-1')
    expect(result).toMatchObject({
      images: ['data:image/png;base64,AAECAw=='],
      rawImageUrls: ['data:image/png;base64,AAECAw=='],
      imagesStoredOnline: false,
    })
  })

  it('uploads edit materials before putting their URLs in the asynchronous request', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ file_url: 'https://materials.example/reference.png' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ file_url: 'https://materials.example/mask.png' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'request-edit' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ images: [{ url: 'data:image/png;base64,AAECAw==' }] }), { status: 200 }))

    await callBackendCompositeImageApi({
      apiKey: 'composite-key',
      model: 'openai/gpt-image-2',
      prompt: '编辑图片',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,AQID'],
      maskDataUrl: 'data:image/png;base64,BAUG',
    })

    expect(vi.mocked(authFetch).mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/materials',
      '/api/v1/materials',
      '/api/v1/model/openai/gpt-image-2',
      '/api/v1/model/openai/gpt-image-2/requests/request-edit/status',
      '/api/v1/model/openai/gpt-image-2/requests/request-edit',
    ])
    const request = JSON.parse(vi.mocked(authFetch).mock.calls[2][1]?.body as string)
    expect(request).toMatchObject({
      image_urls: ['https://materials.example/reference.png'],
      mask_url: 'https://materials.example/mask.png',
    })
    expect(JSON.stringify(request)).not.toContain('data:image/')
  })

  it('reuses remote material URLs without downloading or re-uploading them', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'request-remote' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ images: [{ url: 'data:image/png;base64,AAECAw==' }] }), { status: 200 }))

    await callBackendCompositeImageApi({
      apiKey: 'composite-key',
      model: 'openai/gpt-image-2',
      prompt: '使用素材库图片',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['https://img.example/material.png'],
    })

    expect(vi.mocked(authFetch).mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/model/openai/gpt-image-2',
      '/api/v1/model/openai/gpt-image-2/requests/request-remote/status',
      '/api/v1/model/openai/gpt-image-2/requests/request-remote',
    ])
    const request = JSON.parse(vi.mocked(authFetch).mock.calls[0][1]?.body as string)
    expect(request.image_urls).toEqual(['https://img.example/material.png'])
  })

  it('re-reads UserInfo with the existing OIDC access token before retrying material upload', async () => {
    vi.mocked(syncOIDCUserProfile).mockResolvedValueOnce({
      id: 'user-1',
      oidc_provider: 'sub2api',
      account_id: 'acct-1',
    })
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'account_id_required' }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ file_url: 'https://materials.example/reference.png' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'request-sync' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ images: [{ url: 'data:image/png;base64,AAECAw==' }] }), { status: 200 }))

    await callBackendCompositeImageApi({
      apiKey: 'composite-key',
      model: 'openai/gpt-image-2',
      prompt: '编辑图片',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,AQID'],
    })

    expect(syncOIDCUserProfile).toHaveBeenCalledOnce()
    expect(vi.mocked(authFetch).mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/materials',
      '/api/v1/materials',
      '/api/v1/model/openai/gpt-image-2',
      '/api/v1/model/openai/gpt-image-2/requests/request-sync/status',
      '/api/v1/model/openai/gpt-image-2/requests/request-sync',
    ])
  })

  it('does not append edit twice when the selected model already ends with /edit', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ file_url: 'https://materials.example/reference.png' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'request-suffixed' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ images: [{ url: 'data:image/png;base64,AAECAw==' }] }), { status: 200 }))

    await callBackendCompositeImageApi({
      apiKey: 'composite-key',
      model: 'openai/gpt-image-2/edit',
      prompt: '编辑图片',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,AQID'],
    })

    expect(vi.mocked(authFetch).mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/materials',
      '/api/v1/model/openai/gpt-image-2',
      '/api/v1/model/openai/gpt-image-2/requests/request-suffixed/status',
      '/api/v1/model/openai/gpt-image-2/requests/request-suffixed',
    ])
  })
})
