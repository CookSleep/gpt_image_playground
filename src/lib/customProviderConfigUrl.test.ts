import { describe, expect, it } from 'vitest'
import {
  getCustomProviderConfigUrl,
  hasEmbeddedDefaultConfig,
  isImportableConfigUrl,
  loadCustomProviderSettingsFromUrl,
  loadEmbeddedDefaultConfig,
} from './customProviderConfigUrl'

describe('custom provider config URL', () => {
  it('does not expose a JSON config URL to the browser loader', () => {
    expect(getCustomProviderConfigUrl('https://example.com/custom-provider.json'))
      .toBe('')
  })

  it('returns empty when default API URL is a normal API endpoint', () => {
    expect(getCustomProviderConfigUrl('https://api.example.com/v1'))
      .toBe('')
  })

  it('detects importable URL values', () => {
    expect(isImportableConfigUrl('https://example.com/provider.json')).toBe(true)
    expect(isImportableConfigUrl('https://example.com/?settings={}')).toBe(true)
    expect(isImportableConfigUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('returns null for empty URL', async () => {
    const result = await loadCustomProviderSettingsFromUrl('')

    expect(result).toBeNull()
  })

  it('loads an embedded default config without fetching a URL', () => {
    const payload = JSON.stringify({
      customProviders: [{ id: 'embedded', name: '内嵌服务商', submit: { path: 'generate' } }],
      profiles: [],
    })
    const bytes = new TextEncoder().encode(payload)
    const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))

    expect(hasEmbeddedDefaultConfig(`embedded-config:${base64}`)).toBe(true)
    expect(loadEmbeddedDefaultConfig(`embedded-config:${base64}`)?.customProviders[0]).toMatchObject({
      id: 'embedded',
      name: '内嵌服务商',
    })
  })

  it('accepts an empty embedded deployment snapshot', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ customProviders: [], profiles: [] }))
    const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))

    expect(loadEmbeddedDefaultConfig(`embedded-config:${base64}`)).toEqual({
      customProviders: [],
      profiles: [],
    })
  })

  it('imports settings directly from URL settings param', async () => {
    const settings = {
      customProviders: [{
        id: 'custom-share-url',
        name: 'Share URL Custom',
        submit: {
          path: 'images/generations',
          method: 'POST',
          contentType: 'json',
          body: { model: '$profile.model', prompt: '$prompt' },
          result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: [] },
        },
      }],
      profiles: [{
        id: 'share-url-profile',
        name: 'Share URL Profile',
        provider: 'custom-share-url',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'share-url-key',
        model: 'share-url-model',
        timeout: 300,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
    }
    const url = `https://example.com/?settings=${encodeURIComponent(JSON.stringify({ version: 1, settings }))}`

    const result = await loadCustomProviderSettingsFromUrl(url)

    expect(result?.customProviders[0]).toMatchObject({ id: 'custom-share-url', name: 'Share URL Custom' })
    expect(result?.profiles[0]).toMatchObject({ id: 'share-url-profile', provider: 'custom-share-url' })
  })
})
