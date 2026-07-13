import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/components/AssetLibrary.tsx', import.meta.url), 'utf8')

describe('asset library interaction contract', () => {
  it('separates folder loading from filter-sensitive asset loading', () => {
    expect(source).toMatch(/useEffect\(\(\) => \{\s*void loadFolders\(\).*?\}, \[loadFolders\]\)/s)
    expect(source).toMatch(/useEffect\(\(\) => \{\s*void loadAssets\(\).*?\}, \[loadAssets\]\)/s)
    expect(source).not.toMatch(/Promise\.all\(\[loadFolders\(\), loadAssets\(\)\]\).*?\[loadAssets, loadFolders\]/s)
  })

  it('only lets the latest asset request update component state', () => {
    expect(source).toContain('createLatestAssetRequestGuard')
    expect(source).toMatch(/assetRequestGuard\.current\.begin\(\)/)
    expect(source).toMatch(/assetRequestGuard\.current\.isLatest\(requestId\)/)
  })

  it('groups folder creation and result search with their owners', () => {
    expect(source).toMatch(/className="asset-folders-head"[\s\S]*?setCreatingFolder\(true\)/)
    expect(source).toMatch(/className="asset-results-toolbar"[\s\S]*?aria-label="搜索图片资产"/)
  })

  it('provides a readable card body and independently expandable prompts', () => {
    expect(source).toContain('toggleExpandedAsset')
    expect(source).toContain('className="asset-card-body"')
    expect(source).toContain("const expandable = asset.prompt.trim().length > 120")
    expect(source).toMatch(/className=\{`asset-prompt \$\{!expandable \|\| expanded \? 'expanded' : ''\}`\}/)
    expect(source).toContain('aria-expanded={expanded}')
    expect(source).toContain('aria-controls={`asset-prompt-${asset.id}`}')
  })
})
