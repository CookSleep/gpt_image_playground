import { describe, expect, it } from 'vitest'
import { buildAssetQuery, createLatestAssetRequestGuard, mergeMovedAssets, removeAssets, toggleAssetSelection, toggleExpandedAsset } from './assetLibrary'

describe('asset library state', () => {
  it('builds server queries for search, folders, uncategorized, and cursors', () => {
    expect(buildAssetQuery({ q: '霓虹 城市', folderId: '12', cursor: '88' }))
      .toBe('/api/assets?q=%E9%9C%93%E8%99%B9+%E5%9F%8E%E5%B8%82&folderId=12&cursor=88&limit=60')
    expect(buildAssetQuery({ q: '', folderId: null }))
      .toBe('/api/assets?folderId=uncategorized&limit=60')
    expect(buildAssetQuery({ q: '', folderId: undefined }))
      .toBe('/api/assets?limit=60')
  })

  it('toggles selections without mutating the previous set', () => {
    const current = new Set(['1'])
    expect([...toggleAssetSelection(current, '2')]).toEqual(['1', '2'])
    expect([...toggleAssetSelection(current, '1')]).toEqual([])
    expect([...current]).toEqual(['1'])
  })

  it('updates moved assets and removes deleted assets', () => {
    const assets = [
      { id: '1', folderId: null },
      { id: '2', folderId: 'old' },
      { id: '3', folderId: null },
    ]
    expect(mergeMovedAssets(assets, ['1', '2'], 'new')).toEqual([
      { id: '1', folderId: 'new' },
      { id: '2', folderId: 'new' },
      { id: '3', folderId: null },
    ])
    expect(removeAssets(assets, ['2'])).toEqual([{ id: '1', folderId: null }, { id: '3', folderId: null }])
  })

  it('only accepts the latest asset request', () => {
    const guard = createLatestAssetRequestGuard()
    const first = guard.begin()
    const second = guard.begin()

    expect(guard.isLatest(first)).toBe(false)
    expect(guard.isLatest(second)).toBe(true)
  })

  it('toggles expanded prompts without mutating the previous set', () => {
    const current = new Set(['1'])

    expect([...toggleExpandedAsset(current, '2')]).toEqual(['1', '2'])
    expect([...toggleExpandedAsset(current, '1')]).toEqual([])
    expect([...current]).toEqual(['1'])
  })
})
