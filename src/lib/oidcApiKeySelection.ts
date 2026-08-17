// 上次选中的 API Key 本地缓存：按用户维度存储，避免每次刷新都回落到列表第一个。
const SELECTED_API_KEY_STORAGE_PREFIX = 'gpt-image-playground:selected-api-key:'

function getSelectedApiKeyStorageKey(userId?: string | null): string {
  return SELECTED_API_KEY_STORAGE_PREFIX + (userId || 'anonymous')
}

export function readCachedApiKey(userId?: string | null): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(getSelectedApiKeyStorageKey(userId)) || ''
  } catch {
    return ''
  }
}

export function writeCachedApiKey(userId: string | null | undefined, key: string): void {
  if (typeof window === 'undefined') return
  try {
    const storageKey = getSelectedApiKeyStorageKey(userId)
    if (key) {
      window.localStorage.setItem(storageKey, key)
    } else {
      window.localStorage.removeItem(storageKey)
    }
  } catch {
    // localStorage 不可用时忽略，仅保留内存态
  }
}
