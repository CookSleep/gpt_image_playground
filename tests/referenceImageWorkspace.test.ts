import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

describe('Aurora reference image workspace contract', () => {
  it('plans each selection against the sixteen-image capacity and appends accepted files', () => {
    expect(source).toContain('planReferenceFileSelection(inputImages.length, Array.from(files))')
    expect(source).toMatch(/setInputImages\(\(current\) => \[\.\.\.current, \.\.\.values\]\.slice\(0, MAX_REFERENCE_IMAGES\)\)/)
  })

  it('shows the sixteen-image and four-megabyte limits and disables adding at capacity', () => {
    expect(source).toContain('最多 {MAX_REFERENCE_IMAGES} 张 · 单张不超过 4MB')
    expect(source).toMatch(/disabled=\{inputImages\.length >= MAX_REFERENCE_IMAGES\}/)
  })

  it('keeps the thumbnail strip inside the creation panel', () => {
    expect(css).toMatch(/\.workspace-references > div\s*\{[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/s)
  })
})
