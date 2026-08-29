import type { TaskRecord, FavoriteCollection } from '../../types'
import { ALL_FAVORITES_COLLECTION_ID, getImageFavoriteCollectionIds, getTaskFavoriteCollectionIds } from '../../store'

export type CollectionCard = {
  id: string
  name: string
  collection?: FavoriteCollection
  tasks: TaskRecord[]
  imageIds: string[]
}

function sameIdSet(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((id) => bSet.has(id))
}

export function getInitialCheckedCollectionIds(tasks: TaskRecord[], defaultFavoriteCollectionId: string | null) {
  if (!tasks.length) return defaultFavoriteCollectionId ? [defaultFavoriteCollectionId] : []
  const idSets = tasks.map(getTaskFavoriteCollectionIds)
  const hasFavorite = idSets.some((ids) => ids.length > 0)
  if (!hasFavorite) return defaultFavoriteCollectionId ? [defaultFavoriteCollectionId] : []
  const first = idSets[0] ?? []
  return idSets.every((ids) => sameIdSet(ids, first)) ? first : []
}

export function getCollectionTasks(collectionId: string, tasks: TaskRecord[]) {
  return tasks.filter((task) => task.outputImages.some((imageId) => {
    const ids = getImageFavoriteCollectionIds(imageId, task)
    return collectionId === ALL_FAVORITES_COLLECTION_ID ? ids.length > 0 : ids.includes(collectionId)
  }))
}

export function getCollectionImageIds(collectionId: string, tasks: TaskRecord[]) {
  return tasks.flatMap((task) => task.outputImages.filter((imageId) => {
    const ids = getImageFavoriteCollectionIds(imageId, task)
    return collectionId === ALL_FAVORITES_COLLECTION_ID ? ids.length > 0 : ids.includes(collectionId)
  }))
}

export function getLatestCoverImageId(imageIds: string[], tasks: TaskRecord[]) {
  const ids = new Set(imageIds)
  const task = [...tasks].filter((item) => item.outputImages.some((imageId) => ids.has(imageId))).sort((a, b) => b.createdAt - a.createdAt)[0]
  return task?.outputImages.find((imageId) => ids.has(imageId))
}
