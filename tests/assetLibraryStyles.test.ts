import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

describe('asset library visual contract', () => {
  it('keeps the page header and split layout compact', () => {
    expect(css).toMatch(/\.asset-manager\.asset-library\s*\{[^}]*padding:\s*22px var\(--space-page\) 40px/s)
    expect(css).toMatch(/\.asset-manager \.asset-library-head\s*\{[^}]*min-height:\s*80px/s)
    expect(css).toMatch(/\.asset-manager-layout\s*\{[^}]*grid-template-columns:\s*196px minmax\(0, 1fr\)[^}]*margin-top:\s*12px/s)
  })

  it('groups folder creation and result search with their owners', () => {
    expect(css).toMatch(/\.asset-folders-head\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*space-between/s)
    expect(css).toMatch(/\.asset-results-toolbar\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s)
    expect(css).toMatch(/\.asset-results-toolbar > label\s*\{[^}]*height:\s*40px/s)
  })

  it('uses two-column horizontal desktop cards', () => {
    expect(css).toMatch(/\.asset-manager \.asset-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s)
    expect(css).toMatch(/\.asset-manager \.asset-grid article\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(180px, 38%\) minmax\(0, 1fr\)/s)
    expect(css).toMatch(/\.asset-manager \.asset-grid article > \.asset-card-body\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*aspect-ratio:\s*auto/s)
  })

  it('shows two name lines and three prompt lines with an expanded state', () => {
    expect(css).toMatch(/\.asset-manager \.asset-grid h2\s*\{[^}]*-webkit-line-clamp:\s*2/s)
    expect(css).toMatch(/\.asset-manager \.asset-grid article \.asset-prompt\s*\{[^}]*display:\s*-webkit-box[^}]*-webkit-line-clamp:\s*3/s)
    expect(css).toMatch(/\.asset-manager \.asset-grid article \.asset-prompt\.expanded\s*\{[^}]*display:\s*block[^}]*-webkit-line-clamp:\s*unset/s)
  })

  it('switches to one horizontal column before stacking cards on mobile', () => {
    expect(css).toMatch(/@media \(max-width:\s*1100px\)\s*\{[^}]*\.asset-manager \.asset-grid\s*\{[^}]*grid-template-columns:\s*1fr/s)
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.asset-manager \.asset-grid article\s*\{[^}]*display:\s*block/s)
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*?\.asset-manager\.asset-library\s*\{[^}]*padding:\s*18px 16px 32px[^}]*\}[\s\S]*?\.asset-results-toolbar\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s)
  })

  it('uses mobile-sized card and folder actions', () => {
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.mobile-folder-actions button\s*\{[^}]*width:\s*40px[^}]*height:\s*40px/s)
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.asset-manager \.asset-grid footer button\s*\{[^}]*width:\s*40px[^}]*height:\s*40px/s)
  })

  it('isolates the name editor from image container rules', () => {
    expect(css).toMatch(/\.asset-manager \.asset-name-editor\s*\{[^}]*aspect-ratio:\s*auto/s)
  })
})
