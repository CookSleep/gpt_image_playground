import { useStore } from '../../store'
import { ALL_FAVORITES_COLLECTION_ID, DEFAULT_FAVORITE_COLLECTION_NAME } from '../../lib/favoriteState'

export function useFavoriteCollectionTitle() {
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const collections = useStore((s) => s.favoriteCollections)
  if (!activeFavoriteCollectionId) return ''
  if (activeFavoriteCollectionId === ALL_FAVORITES_COLLECTION_ID) return '全部'
  return collections.find((collection) => collection.id === activeFavoriteCollectionId)?.name ?? DEFAULT_FAVORITE_COLLECTION_NAME
}
