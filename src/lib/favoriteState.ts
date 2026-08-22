import type { FavoriteCollection, TaskRecord } from '../types'

export const ALL_FAVORITES_COLLECTION_ID = '__all_favorites__'
export const DEFAULT_FAVORITE_COLLECTION_ID = '__default_favorites__'
export const DEFAULT_FAVORITE_COLLECTION_NAME = '默认'

export function normalizeFavoriteCollectionName(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

export function createDefaultFavoriteCollection(now = Date.now()): FavoriteCollection {
  return {
    id: DEFAULT_FAVORITE_COLLECTION_ID,
    name: DEFAULT_FAVORITE_COLLECTION_NAME,
    createdAt: now,
    updatedAt: now,
  }
}

export function normalizeFavoriteCollections(value: unknown, now = Date.now()): FavoriteCollection[] {
  const collections = Array.isArray(value) ? value : []
  const normalized: FavoriteCollection[] = []
  const ids = new Set<string>()
  for (const item of collections) {
    if (!item || typeof item !== 'object') continue
    const collection = item as Partial<FavoriteCollection>
    if (typeof collection.id !== 'string' || !collection.id.trim()) continue
    if (collection.id === ALL_FAVORITES_COLLECTION_ID || ids.has(collection.id)) continue
    const name = normalizeFavoriteCollectionName(typeof collection.name === 'string' ? collection.name : '')
    if (!name) continue
    ids.add(collection.id)
    normalized.push({
      id: collection.id,
      name: name.slice(0, 60),
      createdAt: typeof collection.createdAt === 'number' ? collection.createdAt : now,
      updatedAt: typeof collection.updatedAt === 'number' ? collection.updatedAt : now,
    })
  }
  return normalized
}

export function ensureDefaultFavoriteCollection(collections: FavoriteCollection[], now = Date.now()) {
  if (collections.length > 0) return collections
  return [createDefaultFavoriteCollection(now)]
}

function getDefaultNamedFavoriteCollectionId(collections: FavoriteCollection[]) {
  return collections.find((collection) => collection.id === DEFAULT_FAVORITE_COLLECTION_ID)?.id
    ?? collections.find((collection) => collection.name === DEFAULT_FAVORITE_COLLECTION_NAME)?.id
    ?? null
}

function ensureDefaultNamedFavoriteCollection(collections: FavoriteCollection[], now = Date.now()) {
  if (getDefaultNamedFavoriteCollectionId(collections)) return collections
  return [createDefaultFavoriteCollection(now), ...collections]
}

export function resolveDefaultFavoriteCollectionId(collections: FavoriteCollection[], preferredId: unknown) {
  if (preferredId === null) return null
  if (typeof preferredId === 'string' && collections.some((collection) => collection.id === preferredId)) return preferredId
  if (collections.some((collection) => collection.id === DEFAULT_FAVORITE_COLLECTION_ID)) return DEFAULT_FAVORITE_COLLECTION_ID
  return collections[0]?.id ?? null
}

export function normalizeFavoriteCollectionIds(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map(String).filter((id) => id && id !== ALL_FAVORITES_COLLECTION_ID)))
}

export function sameFavoriteCollectionIds(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((id) => bSet.has(id))
}

export function getTaskFavoriteCollectionIds(task: TaskRecord, defaultFavoriteCollectionId: string | null) {
  const ids = normalizeFavoriteCollectionIds(task.favoriteCollectionIds)
  if (ids.length > 0) return ids
  return task.isFavorite && defaultFavoriteCollectionId ? [defaultFavoriteCollectionId] : []
}

export function normalizeFavoritePatch(task: TaskRecord, patch: Partial<TaskRecord>, defaultFavoriteCollectionId: string | null): Partial<TaskRecord> {
  if ('favoriteCollectionIds' in patch) {
    const ids = normalizeFavoriteCollectionIds(patch.favoriteCollectionIds)
    return { ...patch, favoriteCollectionIds: ids, isFavorite: ids.length > 0 }
  }
  if ('isFavorite' in patch) {
    if (patch.isFavorite) {
      const ids = normalizeFavoriteCollectionIds(task.favoriteCollectionIds)
      return { ...patch, favoriteCollectionIds: ids.length ? ids : defaultFavoriteCollectionId ? [defaultFavoriteCollectionId] : [] }
    }
    return { ...patch, favoriteCollectionIds: [] }
  }
  return patch
}

export function normalizeLoadedFavoriteState(tasks: TaskRecord[], collections: unknown, preferredDefaultFavoriteCollectionId: unknown, now = Date.now()) {
  let changed = false
  const initialCollections = ensureDefaultFavoriteCollection(normalizeFavoriteCollections(collections, now), now)
  const initialCollectionIds = new Set(initialCollections.map((collection) => collection.id))
  const needsLegacyFallback = tasks.some((task) => (
    Boolean(task.isFavorite) && !normalizeFavoriteCollectionIds(task.favoriteCollectionIds).some((id) => initialCollectionIds.has(id))
  ))
  const normalizedCollections = needsLegacyFallback
    ? ensureDefaultNamedFavoriteCollection(initialCollections, now)
    : initialCollections
  const defaultFavoriteCollectionId = resolveDefaultFavoriteCollectionId(normalizedCollections, preferredDefaultFavoriteCollectionId)
  const collectionIds = new Set(normalizedCollections.map((collection) => collection.id))
  const fallbackId = needsLegacyFallback ? getDefaultNamedFavoriteCollectionId(normalizedCollections) : null
  const normalizedTasks = tasks.map((task) => {
    const normalizedIds = normalizeFavoriteCollectionIds(task.favoriteCollectionIds).filter((id) => collectionIds.has(id))
    // 旧版本只有 isFavorite，孤立收藏统一迁移到名为“默认”的收藏夹。
    const ids = normalizedIds.length > 0 ? normalizedIds : task.isFavorite && fallbackId ? [fallbackId] : []
    const isFavorite = ids.length > 0 || Boolean(task.isFavorite)
    const currentIds = Array.isArray(task.favoriteCollectionIds) ? task.favoriteCollectionIds : []
    if (ids.length === currentIds.length && ids.every((id, index) => id === currentIds[index]) && Boolean(task.isFavorite) === isFavorite) return task
    changed = true
    return { ...task, favoriteCollectionIds: ids, isFavorite }
  })
  return { tasks: normalizedTasks, collections: normalizedCollections, defaultFavoriteCollectionId, changed }
}

export function mergeFavoriteCollections(current: FavoriteCollection[], imported: unknown, now = Date.now()) {
  const importedCollections = normalizeFavoriteCollections(imported, now)
  if (!importedCollections.length) return { collections: current, importedCollections }
  const collections = ensureDefaultFavoriteCollection(normalizeFavoriteCollections([...current, ...importedCollections], now), now)
  return { collections, importedCollections }
}

type DeleteFavoriteCollectionInput = {
  collections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
  activeFavoriteCollectionId: string | null
  selectedFavoriteCollectionIds: string[]
  selectedTaskIds: string[]
  tasks: TaskRecord[]
  collectionId: string
  deleteTasks: boolean
}

export function deleteFavoriteCollectionState(input: DeleteFavoriteCollectionInput) {
  if (!input.collectionId || input.collectionId === ALL_FAVORITES_COLLECTION_ID) return null
  if (input.collections.length <= 1 || !input.collections.some((collection) => collection.id === input.collectionId)) return null

  const collections = input.collections.filter((collection) => collection.id !== input.collectionId)
  const collectionIds = new Set(collections.map((collection) => collection.id))
  const taskIdsToDelete: string[] = []
  const updatedTasks: TaskRecord[] = []
  for (const task of input.tasks) {
    const currentIds = getTaskFavoriteCollectionIds(task, input.defaultFavoriteCollectionId)
    if (!currentIds.includes(input.collectionId)) continue
    const favoriteCollectionIds = currentIds.filter((id) => id !== input.collectionId && collectionIds.has(id))
    if (input.deleteTasks && !favoriteCollectionIds.length) {
      taskIdsToDelete.push(task.id)
      continue
    }
    const updated = { ...task, favoriteCollectionIds, isFavorite: favoriteCollectionIds.length > 0 }
    updatedTasks.push(updated)
  }
  const activeDeleted = input.activeFavoriteCollectionId === input.collectionId

  return {
    collections,
    defaultFavoriteCollectionId: input.defaultFavoriteCollectionId === input.collectionId
      ? collections[0]?.id ?? null
      : resolveDefaultFavoriteCollectionId(collections, input.defaultFavoriteCollectionId),
    activeFavoriteCollectionId: activeDeleted ? null : input.activeFavoriteCollectionId,
    selectedFavoriteCollectionIds: activeDeleted
      ? []
      : input.selectedFavoriteCollectionIds.filter((id) => id !== input.collectionId),
    selectedTaskIds: activeDeleted ? [] : input.selectedTaskIds,
    updatedTasks,
    taskIdsToDelete,
  }
}
