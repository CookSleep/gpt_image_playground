import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const workspace = source.slice(
  source.indexOf('<form className="creation-panel studio-glass"'),
  source.indexOf('<section className={`workspace-canvas'),
)

describe('workspace settings placement', () => {
  it('places the required settings entry before the prompt editor', () => {
    const headingIndex = workspace.indexOf('<h1>')
    const settingsIndex = workspace.indexOf('className="workspace-config-required"')
    const promptIndex = workspace.indexOf('className="workspace-prompt"')

    expect(settingsIndex).toBeGreaterThan(headingIndex)
    expect(settingsIndex).toBeLessThan(promptIndex)
  })

  it('centers all settings content inside an adaptive-height entry', () => {
    expect(css).toMatch(/\.workspace-config-required\s*\{[^}]*height:\s*auto[^}]*min-height:\s*58px[^}]*margin:\s*0 0 var\(--ui-space-2\)/s)
  })
})
