export interface AssetQuery {
  q?: string
  folderId?: string | null
  cursor?: string | null
  limit?: number
}

export function buildAssetQuery(query: AssetQuery) {
  const params = new URLSearchParams()
  if (query.q?.trim()) params.set('q', query.q.trim())
  if (query.folderId === null) params.set('folderId', 'uncategorized')
  else if (query.folderId) params.set('folderId', query.folderId)
  if (query.cursor) params.set('cursor', query.cursor)
  params.set('limit', String(query.limit ?? 60))
  return `/api/assets?${params}`
}

export function toggleAssetSelection(current: Set<string>, id: string) {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function mergeMovedAssets<T extends { id: string; folderId: string | null }>(assets: T[], imageIds: string[], folderId: string | null) {
  const ids = new Set(imageIds)
  return assets.map((asset) => ids.has(asset.id) ? { ...asset, folderId } : asset)
}

export function removeAssets<T extends { id: string }>(assets: T[], imageIds: string[]) {
  const ids = new Set(imageIds)
  return assets.filter((asset) => !ids.has(asset.id))
}

export function createLatestAssetRequestGuard() {
  let latest = 0
  return {
    begin() {
      latest += 1
      return latest
    },
    isLatest(requestId: number) {
      return requestId === latest
    },
  }
}

export function toggleExpandedAsset(current: Set<string>, id: string) {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
