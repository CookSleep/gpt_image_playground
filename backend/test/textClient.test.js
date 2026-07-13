import { afterEach, describe, expect, test, vi } from 'vitest'
import { createOpenAITextClient } from '../src/textClient.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAI-compatible text client', () => {
  test('uses the selected prompt key and gpt-5.5 Responses API', async () => {
    const requests = []
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ output_text: '电影感雨夜未来城市，广角构图，霓虹反射' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const client = createOpenAITextClient({ baseUrl: 'https://api.example.com/v1', timeoutMs: 1000 })

    const result = await client.optimize({ prompt: '未来城市', apiKey: 'sk-text-secret', model: 'gpt-5.5' })

    expect(result).toBe('电影感雨夜未来城市，广角构图，霓虹反射')
    expect(requests[0].url).toBe('https://api.example.com/v1/responses')
    expect(requests[0].init.headers.Authorization).toBe('Bearer sk-text-secret')
    expect(requests[0].body).toMatchObject({ model: 'gpt-5.5', input: '未来城市' })
    expect(requests[0].body.instructions).toContain('图片生成')
  })

  test('reads text from nested Responses output items', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: '优化后的提示词' }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createOpenAITextClient({ baseUrl: 'https://api.example.com/v1' })

    await expect(client.optimize({ prompt: '原文', apiKey: 'sk-text', model: 'gpt-5.5' })).resolves.toBe('优化后的提示词')
  })
})
