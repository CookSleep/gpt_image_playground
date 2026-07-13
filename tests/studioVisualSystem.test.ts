import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

describe('Aurora studio visual system', () => {
  it('defines shared control and spacing tokens', () => {
    expect(css).toMatch(/\.immersive-studio,\s*\.immersive-auth\s*\{[^}]*--ui-control-compact:\s*28px[^}]*--ui-control-standard:\s*36px[^}]*--ui-control-input:\s*40px[^}]*--ui-control-primary:\s*44px[^}]*--ui-space-1:\s*8px[^}]*--ui-space-2:\s*12px[^}]*--ui-space-3:\s*16px/s)
  })

  it('aligns the topbar account controls to one height and rhythm', () => {
    expect(css).toMatch(/\.immersive-account\s*\{[^}]*gap:\s*var\(--ui-space-1\)/s)
    expect(css).toMatch(/\.immersive-account > span\s*\{[^}]*min-height:\s*var\(--ui-control-standard\)[^}]*align-items:\s*center/s)
    expect(css).toMatch(/\.theme-switcher\s*\{[^}]*height:\s*var\(--ui-control-standard\)[^}]*align-items:\s*center/s)
    expect(css).toMatch(/\.immersive-settings,\s*\.immersive-logout\s*\{[^}]*width:\s*var\(--ui-control-standard\)[^}]*height:\s*var\(--ui-control-standard\)/s)
  })

  it('keeps the mobile header compact after desktop account alignment', () => {
    const alignedAccountLabel = css.lastIndexOf('.immersive-account > span { min-height:')
    const mobileHiddenAccountLabel = css.lastIndexOf('.immersive-account > span { display: none; }')

    expect(mobileHiddenAccountLabel).toBeGreaterThan(alignedAccountLabel)
  })

  it('resets inherited padding on every icon-only control', () => {
    expect(css).toMatch(/\.theme-switcher button,\s*\.immersive-settings,\s*\.immersive-logout,\s*\.aurora-settings-modal header > button,\s*\.prompt-optimizer-modal header > button,\s*\.aurora-modal-close,\s*\.folder-row > button:not\(:first-child\),\s*\.folder-editor button,\s*\.asset-name-editor button,\s*\.asset-manager \.asset-grid footer button,\s*\.mobile-folder-actions button\s*\{[^}]*padding:\s*0/s)
    expect(css).toMatch(/\.theme-switcher button\s*\{[^}]*display:\s*grid[^}]*place-items:\s*center/s)
  })

  it('lets generation rows grow with their content', () => {
    expect(css).toMatch(/\.version-list > button\s*\{[^}]*height:\s*auto[^}]*min-height:\s*82px/s)
  })
})
