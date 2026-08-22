import { useMemo } from 'react'
import { getFavoriteCollectionTitle, getFavoriteCollectionsForProject, getFavoriteScopeProjectId, useStore } from '../../store'

export function useFavoriteCollectionTitle() {
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const allCollections = useStore((s) => s.favoriteCollections)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const collections = useMemo(
    () => getFavoriteCollectionsForProject(allCollections, getFavoriteScopeProjectId(activeProjectId)),
    [activeProjectId, allCollections],
  )
  return activeFavoriteCollectionId ? getFavoriteCollectionTitle(activeFavoriteCollectionId, collections) : ''
}
