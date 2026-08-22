import { authFetch, syncOIDCUserProfile } from '../auth/api'

export type MaterialItem = {
  id: string
  account_id: string
  file_name: string
  url: string
  content_type: string
  size_bytes: number
  kind: string
  source: string
  created_at: string
}

export type MaterialList = {
  items: MaterialItem[]
  total: number
  page: number
  page_size: number
}

export type MaterialBatchDeleteResult = {
  deleted_ids: string[]
  deleted_count: number
}

export type MaterialDownloadResult = {
  successCount: number
  failCount: number
}

export function getMaterialKey(item: MaterialItem, index: number) {
  const id = item.id.trim()
  if (id) return `material-id-${id}`
  const url = item.url.trim()
  if (url) return `material-url-${url}-${index}`
  return `material-fallback-${item.file_name}-${item.created_at}-${index}`
}

type MaterialError = { code?: unknown; message?: unknown }

async function readError(response: Response) {
  const data = await response.json().catch(() => null) as MaterialError | null
  const message = typeof data?.message === 'string' && data.message.trim() ? data.message : `素材接口失败：HTTP ${response.status}`
  const error = new Error(message) as Error & { code?: unknown }
  error.code = data?.code
  return error
}

async function requestWithAccountSync(path: string, init: RequestInit = {}, allowSync = true): Promise<Response> {
  const response = await authFetch(path, { ...init, cache: 'no-store' })
  if (allowSync && response.status === 409) {
    const data = await response.clone().json().catch(() => null) as MaterialError | null
    if (data?.code === 'account_id_required' && (await syncOIDCUserProfile())?.account_id) {
      return requestWithAccountSync(path, init, false)
    }
  }
  return response
}

export async function listMaterials(options: { page?: number; pageSize?: number; kind?: string; keyword?: string } = {}): Promise<MaterialList> {
  const query = new URLSearchParams({
    page: String(options.page ?? 1),
    page_size: String(options.pageSize ?? 24),
  })
  if (options.kind) query.set('kind', options.kind)
  if (options.keyword?.trim()) query.set('keyword', options.keyword.trim())
  const response = await requestWithAccountSync(`/api/v1/materials?${query.toString()}`)
  if (!response.ok) throw await readError(response)
  return await response.json() as MaterialList
}

export async function uploadMaterialFile(file: File): Promise<MaterialItem> {
  const body = new FormData()
  body.append('file', file, file.name)
  const response = await requestWithAccountSync('/api/v1/materials', { method: 'POST', body })
  if (!response.ok) throw await readError(response)
  return await response.json() as MaterialItem
}

export async function deleteMaterial(id: string): Promise<void> {
  const response = await requestWithAccountSync(`/api/v1/materials/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
  if (!response.ok) throw await readError(response)
}

export async function batchDeleteMaterials(ids: string[]): Promise<MaterialBatchDeleteResult> {
  const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)))
  const deletedIds: string[] = []
  let deletedCount = 0
  for (let index = 0; index < uniqueIds.length; index += 100) {
    const response = await requestWithAccountSync('/api/v1/materials/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: uniqueIds.slice(index, index + 100) }),
    })
    if (!response.ok) throw await readError(response)
    const result = await response.json() as MaterialBatchDeleteResult
    deletedIds.push(...(Array.isArray(result.deleted_ids) ? result.deleted_ids : []))
    deletedCount += Number.isFinite(result.deleted_count) ? result.deleted_count : 0
  }
  return { deleted_ids: deletedIds, deleted_count: deletedCount }
}

export async function downloadMaterialFiles(items: MaterialItem[]): Promise<MaterialDownloadResult> {
  let successCount = 0
  let failCount = 0
  for (const item of items) {
    try {
      const response = await fetch(item.url)
      if (!response.ok) throw new Error(`下载素材失败：HTTP ${response.status}`)
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = item.file_name || `material-${item.id}`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      successCount++
    } catch (err) {
      console.error(err)
      failCount++
    }
  }
  return { successCount, failCount }
}
