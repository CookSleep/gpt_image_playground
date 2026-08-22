import { describe, expect, it } from 'vitest'
import { buildApiUrl, normalizeBaseUrl } from './devProxy'

describe('normalizeBaseUrl', () => {
  it('preserves a trailing slash used for direct endpoint joining', () => {
    expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com/')
    expect(normalizeBaseUrl('api.example.com/custom/')).toBe('https://api.example.com/custom/')
    expect(normalizeBaseUrl('https://api.example.com/custom///')).toBe('https://api.example.com/custom/')
  })

  it('keeps the existing normalization when there is no trailing slash', () => {
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com')
    expect(normalizeBaseUrl('https://api.example.com/custom')).toBe('https://api.example.com/custom/v1')
  })
})

describe('buildApiUrl', () => {
  it('uses the same-origin proxy prefix when API proxy is enabled', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'images/edits', null, true)).toBe(
      '/api-proxy/images/edits',
    )
  })

  it('leaves API versioning to the proxy target when proxying', () => {
    expect(buildApiUrl('http://api.example.com', 'images/generations', null, true)).toBe(
      '/api-proxy/images/generations',
    )
  })

  it('uses a configured proxy prefix when one is available', () => {
    expect(
      buildApiUrl(
        'http://api.example.com/v1',
        'responses',
        {
          enabled: true,
          prefix: '/openai-proxy',
          target: 'http://api.example.com/v1',
          changeOrigin: true,
          secure: false,
        },
        true,
      ),
    ).toBe('/openai-proxy/responses')
  })

  it('uses the configured API URL directly when API proxy is disabled', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'responses', null, false)).toBe(
      'http://api.example.com/v1/responses',
    )
  })

  it('joins the endpoint directly when the API URL ends with a slash', () => {
    expect(buildApiUrl('https://api.example.com/', '/custom/image-tasks', null, false)).toBe(
      'https://api.example.com/custom/image-tasks',
    )
  })

  it('preserves a base path when directly joining an API URL', () => {
    expect(buildApiUrl('api.example.com/custom/', 'tasks/123', null, false)).toBe(
      'https://api.example.com/custom/tasks/123',
    )
  })

  it('normalizes an API URL before directly joining an endpoint', () => {
    expect(buildApiUrl('https://user:password@api.example.com/', 'responses', null, false)).toBe(
      'https://api.example.com/responses',
    )
  })

  it('directly joins an OpenAI endpoint when its API URL ends with a slash', () => {
    expect(buildApiUrl('https://api.example.com/', 'responses', null, false)).toBe(
      'https://api.example.com/responses',
    )
  })
})
