import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractAgentImagesFromHtml, fetchAgentImageAsDataUrl, searchAgentImages } from './agentImageSearch'

describe('agent image search', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('extracts character images from a source page before generic page art', () => {
    const html = `
      <html>
        <head>
          <title>長崎 そよ | Character</title>
          <meta property="og:image" content="/assets/images/common/ogp.png?2026" />
        </head>
        <body>
          <img src="/assets/images/common/logo.svg" alt="logo" />
          <img src="/assets/images/common/character/body_soyo.png" alt="長崎 そよ" width="900" height="1400" />
          <img src="/assets/images/common/character/thumb_tomori.png" alt="高松 燈" width="320" height="320" />
        </body>
      </html>
    `

    const results = extractAgentImagesFromHtml({
      html,
      pageUrl: 'https://anime.bang-dream.com/mygo/character/soyo/',
      query: '長崎 そよ Character',
      count: 4,
    })

    expect(results[0]).toMatchObject({
      title: '長崎 そよ',
      imageUrl: 'https://anime.bang-dream.com/assets/images/common/character/body_soyo.png',
      pageUrl: 'https://anime.bang-dream.com/mygo/character/soyo/',
      provider: 'webpage',
    })
    expect(results.map((item) => item.imageUrl)).not.toContain('https://anime.bang-dream.com/assets/images/common/logo.svg')
  })

  it('uses page URLs before falling back to open image indexes', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(`
        <html>
          <head><title>長崎 そよ | Character</title></head>
          <body><img src="/mygo/wordpress/wp-content/themes/mygo_v1/assets/images/common/character/body_soyo.png" alt="長崎 そよ" width="900" height="1400" /></body>
        </html>
      `, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-agent-fetch': 'ok' },
      }))

    const result = await searchAgentImages({
      query: '長崎 そよ 公式 立绘',
      pageUrls: ['https://anime.bang-dream.com/mygo/character/soyo/'],
      count: 1,
    })

    expect(result.source).toBe('webpage')
    expect(result.pageUrls).toEqual(['https://anime.bang-dream.com/mygo/character/soyo/'])
    expect(result.results[0]).toMatchObject({
      title: '長崎 そよ',
      imageUrl: 'https://anime.bang-dream.com/mygo/wordpress/wp-content/themes/mygo_v1/assets/images/common/character/body_soyo.png',
    })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('infers official MyGO source pages for Haruhikage character reference searches', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`
      <html>
        <head><title>長崎 そよ | Character</title></head>
        <body><img src="/mygo/wordpress/wp-content/themes/mygo_v1/assets/images/common/character/body_soyo.png" alt="" /></body>
      </html>
    `, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-agent-fetch': 'ok' },
    }))

    const result = await searchAgentImages({
      query: '春日影 MyGO 人物参考图',
      count: 2,
    })

    expect(result.source).toBe('webpage')
    expect(result.pageUrls?.[0]).toContain('anime.bang-dream.com/mygo/character/tomori/')
    expect(result.results[0].imageUrl).toContain('/character/body_soyo.png')
  })

  it('downloads images through the same-origin fetch proxy when available', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'image/png', 'x-agent-fetch': 'ok' },
    }))

    const dataUrl = await fetchAgentImageAsDataUrl('https://example.com/ref.png')

    expect(dataUrl).toBe('data:image/png;base64,AQIDBA==')
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('/agent-image-fetch?url='), expect.objectContaining({ cache: 'no-store' }))
  })
})
