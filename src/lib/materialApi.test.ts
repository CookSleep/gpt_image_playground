import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authFetch } from '../auth/api'
import { batchDeleteMaterials, deleteMaterial, downloadMaterialFiles, type MaterialItem } from './materialApi'

vi.mock('../auth/api', () => ({
  authFetch: vi.fn(),
  syncOIDCUserProfile: vi.fn(),
}))

describe('materialApi', () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deletes materials using the opaque public id', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(null, { status: 200 }))

    await deleteMaterial('mat_public/A+B')

    expect(authFetch).toHaveBeenCalledWith('/api/v1/materials/mat_public%2FA%2BB', expect.objectContaining({ method: 'DELETE' }))
  })

  it('batch deletes opaque ids in chunks of 100', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted_ids: Array.from({ length: 100 }, (_, index) => `mat-${index}`), deleted_count: 100 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted_ids: ['mat-100'], deleted_count: 1 }), { status: 200 }))

    const result = await batchDeleteMaterials(Array.from({ length: 101 }, (_, index) => `mat-${index}`))

    expect(result.deleted_count).toBe(101)
    expect(authFetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(vi.mocked(authFetch).mock.calls[0]?.[1]?.body)).ids).toHaveLength(100)
    expect(JSON.parse(String(vi.mocked(authFetch).mock.calls[1]?.[1]?.body)).ids).toEqual(['mat-100'])
  })

  it('downloads material content directly from its url', async () => {
    const click = vi.fn()
    const revokeObjectURL = vi.fn()
    const link = { href: '', download: '', click }
    const item: MaterialItem = {
      id: 'mat-public-1',
      account_id: 'account-1',
      file_name: 'reference.jpg',
      url: 'https://materials.example/reference.jpg',
      content_type: 'image/jpeg',
      size_bytes: 5,
      kind: 'image',
      source: 'upload',
      created_at: '2026-08-23T00:00:00Z',
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(['image'], { type: 'image/jpeg' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:material-1'), revokeObjectURL })
    vi.stubGlobal('document', { createElement: vi.fn(() => link), body: { appendChild: vi.fn(), removeChild: vi.fn() } })
    vi.stubGlobal('window', { setTimeout: (callback: () => void) => { callback(); return 1 } })

    const result = await downloadMaterialFiles([item])

    expect(result).toEqual({ successCount: 1, failCount: 0 })
    expect(fetchMock).toHaveBeenCalledWith(item.url)
    expect(link.download).toBe(item.file_name)
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:material-1')
    expect(authFetch).not.toHaveBeenCalled()
  })
})
