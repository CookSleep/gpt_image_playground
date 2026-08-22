import type { TaskRecord, FavoriteCollection } from '../../types'
import { ALL_FAVORITES_COLLECTION_ID, getTaskFavoriteCollectionIds } from '../../lib/favoriteState'

export type CollectionCard = {
  id: string
  name: string
  collection?: FavoriteCollection
  tasks: TaskRecord[]
}

function sameIdSet(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((id) => bSet.has(id))
}

export function getInitialCheckedCollectionIds(tasks: TaskRecord[], defaultFavoriteCollectionId: string | null) {
  if (!tasks.length) return defaultFavoriteCollectionId ? [defaultFavoriteCollectionId] : []
  const idSets = tasks.map((task) => getTaskFavoriteCollectionIds(task, defaultFavoriteCollectionId))
  const hasFavorite = idSets.some((ids) => ids.length > 0)
  if (!hasFavorite) return defaultFavoriteCollectionId ? [defaultFavoriteCollectionId] : []
  const first = idSets[0] ?? []
  return idSets.every((ids) => sameIdSet(ids, first)) ? first : []
}

export function getCollectionTasks(collectionId: string, tasks: TaskRecord[], defaultFavoriteCollectionId: string | null) {
  const favoriteTasks = tasks.filter((task) => task.isFavorite)
  if (collectionId === ALL_FAVORITES_COLLECTION_ID) return favoriteTasks
  return favoriteTasks.filter((task) => getTaskFavoriteCollectionIds(task, defaultFavoriteCollectionId).includes(collectionId))
}

export function getLatestCoverTask(tasks: TaskRecord[]) {
  return [...tasks]
    .filter((task) => task.outputImages?.length)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}
