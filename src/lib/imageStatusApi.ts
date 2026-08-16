import type { ApiProfile } from '../types'
import { authFetch } from '../auth/api'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'

export const IMAGE_STATUS_QUERY_BATCH_SIZE = 100

export type ImageStatusState = 'accepted' | 'running' | 'upstream_done' | 'cos_uploading' | 'succeeded' | 'failed'

export interface ImageStatusRecord {
  requestId: string
  status: ImageStatusState
  progress?: number
  urls?: string[]
  cosUrls?: string[]
  texts?: string[]
  error?: string
  createdAt?: string
  updatedAt?: string
}

export interface ImageStatusQueryResult {
  records: ImageStatusRecord[]
  notFound: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

function normalizeStatus(value: unknown): ImageStatusState | null {
  if (
    value === 'accepted' ||
    value === 'running' ||
    value === 'upstream_done' ||
    value === 'cos_uploading' ||
    value === 'succeeded' ||
    value === 'failed'
  ) {
    return value
  }
  return null
}

function getErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (isRecord(value) && typeof value.message === 'string' && value.message.trim()) return value.message
  return undefined
}

function normalizeImageStatusRecord(value: unknown): ImageStatusRecord | null {
  if (!isRecord(value)) return null
  const requestId = typeof value.request_id === 'string' && value.request_id.trim() ? value.request_id : ''
  const status = normalizeStatus(value.status)
  if (!requestId || !status) return null

  return {
    requestId,
    status,
    progress: typeof value.progress === 'number' && Number.isFinite(value.progress) ? value.progress : undefined,
    urls: normalizeStringArray(value.urls),
    cosUrls: normalizeStringArray(value.cos_urls),
    texts: normalizeStringArray(value.texts),
    error: getErrorMessage(value.error),
    createdAt: typeof value.created_at === 'string' ? value.created_at : undefined,
    updatedAt: typeof value.updated_at === 'string' ? value.updated_at : undefined,
  }
}

function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += IMAGE_STATUS_QUERY_BATCH_SIZE) {
    chunks.push(ids.slice(i, i + IMAGE_STATUS_QUERY_BATCH_SIZE))
  }
  return chunks
}

async function queryImageStatusChunk(profile: ApiProfile, requestIds: string[], options: { viaBackend?: boolean }): Promise<ImageStatusQueryResult> {
  if (requestIds.length === 0) return { records: [], notFound: [] }

  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const params = new URLSearchParams()
  params.set('request_ids', requestIds.join(','))
  const directUrl = `${buildApiUrl(profile.baseUrl, 'images/status/', proxyConfig, useApiProxy)}?${params.toString()}`
  const response = options.viaBackend
    ? await authFetch('/api/v1/images/status', {
        method: 'POST',
        body: JSON.stringify({ api_key: profile.apiKey, request_ids: requestIds }),
        cache: 'no-store',
      })
    : await fetch(directUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${profile.apiKey}`,
        },
        cache: 'no-store',
      })

  if (response.status === 404) return { records: [], notFound: requestIds }
  if (!response.ok) throw new Error(await getApiErrorMessage(response))

  const payload = await response.json()
  if (!isRecord(payload)) return { records: [], notFound: [] }

  return {
    records: Array.isArray(payload.data)
      ? payload.data.map(normalizeImageStatusRecord).filter((record): record is ImageStatusRecord => record != null)
      : [],
    notFound: normalizeStringArray(payload.not_found),
  }
}

export async function queryImageStatuses(profile: ApiProfile, requestIds: string[], options: { viaBackend?: boolean } = {}): Promise<ImageStatusQueryResult> {
  const uniqueIds = [...new Set(requestIds.filter((id) => id.trim()))]
  const results = await Promise.all(chunkIds(uniqueIds).map((ids) => queryImageStatusChunk(profile, ids, options)))

  return {
    records: results.flatMap((result) => result.records),
    notFound: [...new Set(results.flatMap((result) => result.notFound))],
  }
}
