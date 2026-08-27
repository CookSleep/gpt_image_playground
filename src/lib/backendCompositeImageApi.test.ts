import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { authFetch } from '../auth/api'
import { callBackendCompositeImageApi, queryBackendCompositeImageTask } from './backendCompositeImageApi'

vi.mock('../auth/api', () => ({
  authFetch: vi.fn(),
}))

describe('callBackendCompositeImageApi', () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset()
  })

  it('submits, polls and reads the result through independent backend endpoints', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        request_id: 'request-1',
        status_url: 'https://provider.example/api/v1/model/openai/gpt-image-2/requests/request-1/status',
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED', actual_cost: 0.0375 }), { status: 200 }))
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
    expect(onRequestCreated).toHaveBeenCalledWith({
      requestId: 'request-1',
      statusUrl: 'https://provider.example/api/v1/model/openai/gpt-image-2/requests/request-1/status',
    })
    expect(result).toMatchObject({
      images: ['data:image/png;base64,AAECAw=='],
      rawImageUrls: ['data:image/png;base64,AAECAw=='],
      imagesStoredOnline: false,
      actualCost: 0.0375,
    })
  })

  it('queries a persisted Composite request without submitting it again', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED', actual_cost: '0.125' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        images: [{ url: 'data:image/png;base64,AAECAw==' }],
      }), { status: 200 }))

    const result = await queryBackendCompositeImageTask({
      apiKey: 'composite-key',
      model: 'openai/gpt-image-2',
      requestId: 'persisted-request',
      params: { ...DEFAULT_PARAMS },
    })

    expect(vi.mocked(authFetch).mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/model/openai/gpt-image-2/requests/persisted-request/status',
      '/api/v1/model/openai/gpt-image-2/requests/persisted-request',
    ])
    expect(result?.images).toEqual(['data:image/png;base64,AAECAw=='])
    expect(result?.actualCost).toBe(0.125)
  })

  it('uploads edit files and reports their persistent URLs before submitting', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { url: 'https://files.example/reference.png' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { url: 'https://files.example/mask.png' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'request-edit' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ images: [{ url: 'data:image/png;base64,AAECAw==' }] }), { status: 200 }))
    const onReferenceUploaded = vi.fn()

    await callBackendCompositeImageApi({
      apiKey: 'composite-key',
      model: 'openai/gpt-image-2',
      prompt: '编辑图片',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,AQID'],
      maskDataUrl: 'data:image/png;base64,BAUG',
      onReferenceUploaded,
    })

    expect(vi.mocked(authFetch).mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/files',
      '/api/v1/files',
      '/api/v1/model/openai/gpt-image-2',
      '/api/v1/model/openai/gpt-image-2/requests/request-edit/status',
      '/api/v1/model/openai/gpt-image-2/requests/request-edit',
    ])
    const request = JSON.parse(vi.mocked(authFetch).mock.calls[2][1]?.body as string)
    expect(request).toMatchObject({
      image_urls: ['https://files.example/reference.png'],
      mask_url: 'https://files.example/mask.png',
    })
    expect(JSON.stringify(request)).not.toContain('data:image/')
    expect(onReferenceUploaded.mock.calls.map(([reference]) => reference)).toEqual([
      { source: 'inputImage', index: 0, url: 'https://files.example/reference.png' },
      { source: 'mask', index: 0, url: 'https://files.example/mask.png' },
    ])
  })

  it('uploads reference files sequentially so failures cannot strand parallel requests', async () => {
    let activeUploads = 0
    let maxActiveUploads = 0
    let uploaded = 0
    vi.mocked(authFetch).mockImplementation(async (path, init) => {
      if (path === '/api/v1/files' && init?.method === 'POST') {
        activeUploads += 1
        maxActiveUploads = Math.max(maxActiveUploads, activeUploads)
        await Promise.resolve()
        activeUploads -= 1
        uploaded += 1
        return new Response(JSON.stringify({ data: { url: `https://files.example/${uploaded}.png` } }), { status: 201 })
      }
      if (path === '/api/v1/model/openai/gpt-image-2' && init?.method === 'POST') {
        return new Response(JSON.stringify({ request_id: 'request-sequential' }), { status: 202 })
      }
      if (String(path).endsWith('/status')) {
        return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 })
      }
      if (path === '/api/v1/model/openai/gpt-image-2/requests/request-sequential') {
        return new Response(JSON.stringify({ images: [{ url: 'data:image/png;base64,AAECAw==' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: { deleted: true } }), { status: 200 })
    })

    await callBackendCompositeImageApi({
      apiKey: 'composite-key',
      model: 'openai/gpt-image-2',
      prompt: '编辑图片',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [
        'data:image/png;base64,AQID',
        'data:image/png;base64,BAUG',
        'data:image/png;base64,BwgJ',
      ],
    })

    expect(uploaded).toBe(3)
    expect(maxActiveUploads).toBe(1)
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

  it('reuses cached File API URLs instead of uploading local references again', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'request-cached' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ images: [{ url: 'data:image/png;base64,AAECAw==' }] }), { status: 200 }))
    const onReferenceUploaded = vi.fn()

    await callBackendCompositeImageApi({
      apiKey: 'composite-key',
      model: 'openai/gpt-image-2',
      prompt: '复用参考图',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,AQID'],
      inputImageFileUrls: ['https://files.example/cached-reference.png'],
      onReferenceUploaded,
    })

    expect(vi.mocked(authFetch).mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/model/openai/gpt-image-2',
      '/api/v1/model/openai/gpt-image-2/requests/request-cached/status',
      '/api/v1/model/openai/gpt-image-2/requests/request-cached',
    ])
    expect(JSON.parse(vi.mocked(authFetch).mock.calls[0][1]?.body as string).image_urls).toEqual([
      'https://files.example/cached-reference.png',
    ])
    expect(onReferenceUploaded).not.toHaveBeenCalled()
  })

  it('keeps uploaded file URLs when Composite submission fails', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { url: 'https://files.example/reference.png' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: '提交失败' }), { status: 400 }))

    await expect(callBackendCompositeImageApi({
      apiKey: 'composite-key',
      model: 'openai/gpt-image-2',
      prompt: '编辑图片',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,AQID'],
    })).rejects.toThrow('提交失败')

    expect(vi.mocked(authFetch).mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/files',
      '/api/v1/model/openai/gpt-image-2',
    ])
  })

  it('reports a reference upload failure as soon as File API returns an error', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      code: 503,
      message: 'File API developer key is not configured',
    }), { status: 503 }))
    const onReferenceUploadFailed = vi.fn()

    await expect(callBackendCompositeImageApi({
      apiKey: 'composite-key',
      model: 'openai/gpt-image-2',
      prompt: '编辑图片',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,AQID'],
      onReferenceUploadFailed,
    })).rejects.toThrow('File API developer key is not configured')

    expect(onReferenceUploadFailed).toHaveBeenCalledOnce()
    expect(onReferenceUploadFailed).toHaveBeenCalledWith(expect.objectContaining({
      message: 'File API developer key is not configured',
    }))
    expect(authFetch).toHaveBeenCalledOnce()
  })

  it('does not append edit twice when the selected model already ends with /edit', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { url: 'https://files.example/reference.png' } }), { status: 201 }))
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
      '/api/v1/files',
      '/api/v1/model/openai/gpt-image-2',
      '/api/v1/model/openai/gpt-image-2/requests/request-suffixed/status',
      '/api/v1/model/openai/gpt-image-2/requests/request-suffixed',
    ])
  })
})
