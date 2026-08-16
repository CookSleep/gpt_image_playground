import { afterEach, describe, expect, it, vi } from 'vitest'
import { authFetch } from '../auth/api'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { queryImageStatuses } from './imageStatusApi'

vi.mock('../auth/api', () => ({
  authFetch: vi.fn(),
}))

describe('queryImageStatuses', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('queries image statuses in chunks of at most 100 ids', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({ baseUrl: 'https://api.example.com/v1', apiKey: 'test-key' })
    const ids = Array.from({ length: 101 }).map((_, idx) => `img_${idx}`)

    await queryImageStatuses(profile, ids)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]))
    const secondUrl = new URL(String(fetchMock.mock.calls[1][0]))
    expect(firstUrl.searchParams.get('request_ids')?.split(',')).toHaveLength(100)
    expect(secondUrl.searchParams.get('request_ids')?.split(',')).toHaveLength(1)
  })

  it('parses status texts for Agent display', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: [{
        request_id: 'img_text',
        status: 'succeeded',
        texts: ['Generated the image and adjusted the prompt.'],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({ baseUrl: 'https://api.example.com/v1', apiKey: 'test-key' })

    const result = await queryImageStatuses(profile, ['img_text'])

    expect(result.records[0].texts).toEqual(['Generated the image and adjusted the prompt.'])
  })

  it('queries statuses through the authenticated backend when requested', async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ request_id: 'img_backend', status: 'running' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({ baseUrl: 'https://api.example.com/v1', apiKey: 'oidc-api-key' })

    const result = await queryImageStatuses(profile, ['img_backend'], { viaBackend: true })

    expect(authFetch).toHaveBeenCalledWith('/api/v1/images/status', {
      method: 'POST',
      body: JSON.stringify({ api_key: 'oidc-api-key', request_ids: ['img_backend'] }),
      cache: 'no-store',
    })
    expect(result.records).toEqual([expect.objectContaining({ requestId: 'img_backend', status: 'running' })])
  })
})
