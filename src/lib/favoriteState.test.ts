import { describe, expect, it } from 'vitest'
import type { FavoriteCollection, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import {
  ALL_FAVORITES_COLLECTION_ID,
  DEFAULT_FAVORITE_COLLECTION_ID,
  createDefaultFavoriteCollection,
  deleteFavoriteCollectionState,
  ensureDefaultFavoriteCollection,
  getTaskFavoriteCollectionIds,
  mergeFavoriteCollections,
  normalizeFavoriteCollectionIds,
  normalizeFavoriteCollectionName,
  normalizeFavoriteCollections,
  normalizeFavoritePatch,
  normalizeLoadedFavoriteState,
  resolveDefaultFavoriteCollectionId,
} from './favoriteState'

const collectionA: FavoriteCollection = { id: 'collection-a', name: '同名', createdAt: 1, updatedAt: 1 }
const collectionB: FavoriteCollection = { id: 'collection-b', name: '同名', createdAt: 2, updatedAt: 2 }

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...patch,
  }
}

describe('favorite collection normalization', () => {
  it('normalizes names and validates persisted collections without merging equal names', () => {
    expect(normalizeFavoriteCollectionName('  收藏夹   A\nB  ')).toBe('收藏夹 A B')
    expect(normalizeFavoriteCollections([
      { id: collectionA.id, name: '  同名  ', createdAt: 1, updatedAt: 2 },
      { id: collectionB.id, name: '同名' },
      { id: collectionA.id, name: '重复 ID' },
      { id: ALL_FAVORITES_COLLECTION_ID, name: '虚拟集合' },
      { id: '', name: '无 ID' },
      { id: 'empty-name', name: '   ' },
      null,
    ], 10)).toEqual([
      { id: collectionA.id, name: '同名', createdAt: 1, updatedAt: 2 },
      { id: collectionB.id, name: '同名', createdAt: 10, updatedAt: 10 },
    ])
  })

  it('ensures and resolves the default collection with explicit null preserved', () => {
    expect(ensureDefaultFavoriteCollection([], 10)).toEqual([createDefaultFavoriteCollection(10)])
    expect(ensureDefaultFavoriteCollection([collectionA], 10)).toEqual([collectionA])
    expect(resolveDefaultFavoriteCollectionId([collectionA, collectionB], null)).toBeNull()
    expect(resolveDefaultFavoriteCollectionId([collectionA, collectionB], collectionB.id)).toBe(collectionB.id)
    expect(resolveDefaultFavoriteCollectionId([collectionA, collectionB], 'missing')).toBe(collectionA.id)
    expect(resolveDefaultFavoriteCollectionId([createDefaultFavoriteCollection(10), collectionA], 'missing')).toBe(DEFAULT_FAVORITE_COLLECTION_ID)
  })

  it('merges imports by ID while retaining collections with equal names', () => {
    const result = mergeFavoriteCollections([collectionA], [
      { ...collectionA, name: '导入覆盖' },
      collectionB,
      { id: '', name: '无效' },
    ], 10)

    expect(result.importedCollections).toHaveLength(2)
    expect(result.collections).toEqual([collectionA, collectionB])
    const current = [collectionA]
    expect(mergeFavoriteCollections(current, 'invalid', 10).collections).toBe(current)
  })
})

describe('task favorite compatibility', () => {
  it('normalizes IDs and maps legacy isFavorite through an explicit default ID', () => {
    expect(normalizeFavoriteCollectionIds(['a', 'a', '', ALL_FAVORITES_COLLECTION_ID, 'b'])).toEqual(['a', 'b'])
    expect(getTaskFavoriteCollectionIds(task({ isFavorite: true }), collectionA.id)).toEqual([collectionA.id])
    expect(getTaskFavoriteCollectionIds(task({ isFavorite: true }), null)).toEqual([])
    expect(getTaskFavoriteCollectionIds(task({ isFavorite: false, favoriteCollectionIds: [collectionB.id] }), collectionA.id)).toEqual([collectionB.id])
  })

  it('keeps isFavorite and collection IDs synchronized in task patches', () => {
    const favoriteTask = task({ isFavorite: true, favoriteCollectionIds: [collectionB.id] })

    expect(normalizeFavoritePatch(favoriteTask, { favoriteCollectionIds: [collectionA.id, collectionA.id], isFavorite: false }, collectionB.id)).toEqual({
      favoriteCollectionIds: [collectionA.id],
      isFavorite: true,
    })
    expect(normalizeFavoritePatch(task(), { isFavorite: true }, collectionA.id)).toEqual({
      isFavorite: true,
      favoriteCollectionIds: [collectionA.id],
    })
    expect(normalizeFavoritePatch(favoriteTask, { isFavorite: false }, collectionA.id)).toEqual({
      isFavorite: false,
      favoriteCollectionIds: [],
    })
  })

  it('normalizes loaded tasks and creates a named default for orphaned favorites', () => {
    const unchanged = task({ id: 'unchanged', isFavorite: true, favoriteCollectionIds: [collectionA.id] })
    const legacy = task({ id: 'legacy', isFavorite: true })
    const invalid = task({ id: 'invalid', isFavorite: false, favoriteCollectionIds: ['missing'] })
    const result = normalizeLoadedFavoriteState([unchanged, legacy, invalid], [collectionA], collectionA.id, 10)

    expect(result.collections).toEqual([createDefaultFavoriteCollection(10), collectionA])
    expect(result.defaultFavoriteCollectionId).toBe(collectionA.id)
    expect(result.tasks).toEqual([
      unchanged,
      { ...legacy, favoriteCollectionIds: [DEFAULT_FAVORITE_COLLECTION_ID], isFavorite: true },
      { ...invalid, favoriteCollectionIds: [], isFavorite: false },
    ])
    expect(result.changed).toBe(true)
  })

  it('does not restore the built-in default after deletion when all favorite tasks have valid collections', () => {
    const favorite = task({ isFavorite: true, favoriteCollectionIds: [collectionA.id] })
    const deleted = deleteFavoriteCollectionState({
      collections: [createDefaultFavoriteCollection(10), collectionA, collectionB],
      defaultFavoriteCollectionId: DEFAULT_FAVORITE_COLLECTION_ID,
      activeFavoriteCollectionId: null,
      selectedFavoriteCollectionIds: [],
      selectedTaskIds: [],
      tasks: [favorite],
      collectionId: DEFAULT_FAVORITE_COLLECTION_ID,
      deleteTasks: false,
    })!
    const result = normalizeLoadedFavoriteState([favorite], deleted.collections, collectionB.id, 10)

    expect(result.collections).toEqual([collectionA, collectionB])
    expect(result.collections.some((collection) => collection.id === DEFAULT_FAVORITE_COLLECTION_ID)).toBe(false)
    expect(result.defaultFavoriteCollectionId).toBe(collectionB.id)
    expect(result.tasks).toEqual([favorite])
    expect(result.changed).toBe(false)
  })

  it('uses an existing collection named 默认 for legacy tasks', () => {
    const namedDefault = { ...collectionA, name: '默认' }
    const legacy = task({ isFavorite: true })
    const result = normalizeLoadedFavoriteState([legacy], [namedDefault], null, 10)

    expect(result.collections).toEqual([namedDefault])
    expect(result.defaultFavoriteCollectionId).toBeNull()
    expect(result.tasks[0]).toMatchObject({ isFavorite: true, favoriteCollectionIds: [namedDefault.id] })
  })
})

describe('favorite collection deletion transform', () => {
  it('removes the collection from tasks without deleting tasks by default', () => {
    const shared = task({ id: 'shared', isFavorite: true, favoriteCollectionIds: [collectionA.id, collectionB.id] })
    const only = task({ id: 'only', isFavorite: true, favoriteCollectionIds: [collectionA.id] })
    const result = deleteFavoriteCollectionState({
      collections: [collectionA, collectionB],
      defaultFavoriteCollectionId: collectionA.id,
      activeFavoriteCollectionId: collectionA.id,
      selectedFavoriteCollectionIds: [ALL_FAVORITES_COLLECTION_ID, collectionA.id],
      selectedTaskIds: [shared.id],
      tasks: [shared, only],
      collectionId: collectionA.id,
      deleteTasks: false,
    })!

    expect(result.collections).toEqual([collectionB])
    expect(result.defaultFavoriteCollectionId).toBe(collectionB.id)
    expect(result.activeFavoriteCollectionId).toBeNull()
    expect(result.selectedFavoriteCollectionIds).toEqual([])
    expect(result.selectedTaskIds).toEqual([])
    expect(result.taskIdsToDelete).toEqual([])
    expect(result.updatedTasks).toEqual([
      { ...shared, favoriteCollectionIds: [collectionB.id], isFavorite: true },
      { ...only, favoriteCollectionIds: [], isFavorite: false },
    ])
  })

  it('deletes only tasks with no remaining collection and keeps shared tasks', () => {
    const shared = task({ id: 'shared', isFavorite: true, favoriteCollectionIds: [collectionA.id, collectionB.id] })
    const only = task({ id: 'only', isFavorite: true, favoriteCollectionIds: [collectionA.id] })
    const legacy = task({ id: 'legacy', isFavorite: true })
    const result = deleteFavoriteCollectionState({
      collections: [collectionA, collectionB],
      defaultFavoriteCollectionId: collectionA.id,
      activeFavoriteCollectionId: null,
      selectedFavoriteCollectionIds: [],
      selectedTaskIds: [],
      tasks: [shared, only, legacy],
      collectionId: collectionA.id,
      deleteTasks: true,
    })!

    expect(result.updatedTasks).toEqual([{ ...shared, favoriteCollectionIds: [collectionB.id], isFavorite: true }])
    expect(result.taskIdsToDelete).toEqual(['only', 'legacy'])
  })
})
