// 上次选中的 API Key 本地缓存：按用户维度存储，避免每次刷新都回落到列表第一个。
const SELECTED_API_KEY_STORAGE_PREFIX = 'gpt-image-playground:selected-api-key:'
const SELECTED_MODEL_STORAGE_PREFIX = 'gpt-image-playground:selected-model:'
type ApiKeyScope = 'gallery' | 'agent'

function getSelectionStorageKey(prefix: string, userId?: string | null, scope: ApiKeyScope = 'gallery'): string {
  const suffix = userId || 'anonymous'
  return prefix + (scope === 'gallery' ? suffix : `${scope}:${suffix}`)
}

export function readCachedApiKey(userId?: string | null, scope: ApiKeyScope = 'gallery'): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(getSelectionStorageKey(SELECTED_API_KEY_STORAGE_PREFIX, userId, scope)) || ''
  } catch {
    return ''
  }
}

export function writeCachedApiKey(userId: string | null | undefined, key: string, scope: ApiKeyScope = 'gallery'): void {
  if (typeof window === 'undefined') return
  try {
    const storageKey = getSelectionStorageKey(SELECTED_API_KEY_STORAGE_PREFIX, userId, scope)
    if (key) {
      window.localStorage.setItem(storageKey, key)
    } else {
      window.localStorage.removeItem(storageKey)
    }
  } catch {
    // localStorage 不可用时忽略，仅保留内存态
  }
}

export function readCachedModel(userId?: string | null, scope: ApiKeyScope = 'gallery'): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(getSelectionStorageKey(SELECTED_MODEL_STORAGE_PREFIX, userId, scope)) || ''
  } catch {
    return ''
  }
}

export function writeCachedModel(userId: string | null | undefined, model: string, scope: ApiKeyScope = 'gallery'): void {
  if (typeof window === 'undefined') return
  try {
    const storageKey = getSelectionStorageKey(SELECTED_MODEL_STORAGE_PREFIX, userId, scope)
    if (model) {
      window.localStorage.setItem(storageKey, model)
    } else {
      window.localStorage.removeItem(storageKey)
    }
  } catch {
    // localStorage 不可用时忽略，仅保留内存态
  }
}
