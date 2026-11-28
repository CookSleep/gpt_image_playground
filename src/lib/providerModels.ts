import type { ApiProfile, CustomProviderDefinition } from '../types'
import { BUILT_IN_PROVIDER_IDS, DEFAULT_FAL_BASE_URL } from './apiProfiles'
import { buildApiUrl, readClientDevProxyConfig } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'
import { getByPath } from './imageProviderMappings'
import { apiFetch } from './platform'

export async function fetchProviderModels(profile: ApiProfile, useProxy: boolean, signal: AbortSignal, mapping?: CustomProviderDefinition['modelList']) {
  if (!mapping && !BUILT_IN_PROVIDER_IDS.has(profile.provider)) throw new Error('自定义服务商尚未配置模型列表映射')
  const google = profile.provider === 'google'
  const fal = profile.provider === 'fal'
  const base = profile.baseUrl.trim()
  if (!fal && !useProxy && !base) throw new Error('请先填写 API URL')

  const path = mapping?.path ?? (profile.provider === 'xai' ? 'image-generation-models' : 'models')
  const version = google ? 'v1beta' : profile.provider === 'bytedance' ? 'v3' : 'v1'
  const endpoint = fal ? 'https://api.fal.ai/v1/models' : buildApiUrl(base, path, readClientDevProxyConfig(), useProxy, version)
  const falProxy = fal && base && base.replace(/\/+$/, '') !== DEFAULT_FAL_BASE_URL
  const headers: Record<string, string> = {}
  if (profile.apiKey.trim()) {
    if (google) headers['x-goog-api-key'] = profile.apiKey.trim()
    else headers.Authorization = (fal ? 'Key ' : 'Bearer ') + profile.apiKey.trim()
  }

  const models = new Set<string>()
  const cursors = new Set<string>()
  const nextCursorPath = google ? 'nextPageToken' : fal ? 'next_cursor' : mapping?.nextCursorPath
  const cursorParam = google ? 'pageToken' : fal ? 'cursor' : mapping?.cursorParam
  if (Boolean(nextCursorPath) !== Boolean(cursorParam)) throw new Error('模型列表分页映射需要同时填写 nextCursorPath 和 cursorParam')
  const url = new URL(endpoint, 'http://localhost')
  if (fal) url.searchParams.set('limit', '50')
  if (google) url.searchParams.set('pageSize', '1000')
  for (;;) {
    const target = endpoint.startsWith('/') ? url.pathname + url.search : url.href
    if (falProxy) headers['x-fal-target-url'] = target
    const response = await apiFetch(falProxy ? base : target, { headers, signal, cache: 'no-store' })
    if (!response.ok) throw new Error(await getApiErrorMessage(response) || `HTTP ${response.status}`)
    const page = await response.json()
    const entries = mapping ? getByPath(page, mapping.listPath) : google || fal || profile.provider === 'xai' ? page?.models : page?.data
    if (!Array.isArray(entries)) throw new Error('接口未返回有效的模型列表')
    let hasModelId = false
    for (const entry of entries) {
      const id = mapping ? getByPath(entry, mapping.idPath) : google ? entry?.name : fal ? entry?.endpoint_id : entry?.id
      if (typeof id !== 'string') continue
      const model = (google ? id.replace(/^models\//, '') : id).trim()
      if (!model) continue
      hasModelId = true
      models.add(model)
    }

    if (mapping && entries.length && !hasModelId) throw new Error('未能从列表项中读取模型 ID，请检查模型列表映射的 idPath')
    if (!nextCursorPath || !cursorParam) return [...models]
    const next = getByPath(page, nextCursorPath)
    if (next == null || next === '') return [...models]
    if (typeof next !== 'string' && typeof next !== 'number') throw new Error('模型列表分页游标无效')
    const cursor = String(next)
    if (cursors.has(cursor)) throw new Error('模型列表分页游标重复')
    cursors.add(cursor)
    url.searchParams.set(cursorParam, cursor)
  }
}
