import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCachedModel, writeCachedModel } from './oidcApiKeySelection'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubStorage() {
  const values = new Map<string, string>()
  const localStorage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  }
  vi.stubGlobal('window', { localStorage })
  return localStorage
}

describe('模型选择缓存', () => {
  it('按用户和使用区域分别保存', () => {
    stubStorage()

    writeCachedModel('user-a', 'image-model', 'gallery')
    writeCachedModel('user-a', 'agent-model', 'agent')
    writeCachedModel('user-b', 'other-model', 'gallery')

    expect(readCachedModel('user-a', 'gallery')).toBe('image-model')
    expect(readCachedModel('user-a', 'agent')).toBe('agent-model')
    expect(readCachedModel('user-b', 'gallery')).toBe('other-model')
  })

  it('模型为空时删除缓存', () => {
    const storage = stubStorage()
    writeCachedModel('user-a', 'image-model')

    writeCachedModel('user-a', '')

    expect(readCachedModel('user-a')).toBe('')
    expect(storage.removeItem).toHaveBeenCalledWith('gpt-image-playground:selected-model:user-a')
  })

  it('localStorage 不可用时安全降级', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => { throw new Error('blocked') },
        setItem: () => { throw new Error('blocked') },
        removeItem: () => { throw new Error('blocked') },
      },
    })

    expect(readCachedModel('user-a')).toBe('')
    expect(() => writeCachedModel('user-a', 'image-model')).not.toThrow()
  })
})
