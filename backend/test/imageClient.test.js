import { afterEach, describe, expect, test, vi } from 'vitest'

import { createOpenAIImageClient } from '../src/imageClient.js'

describe('OpenAI image client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('always requests streaming images even when legacy config disables it', async () => {
    let requestBody
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requestBody = JSON.parse(init.body)
      return new Response(
        `data: ${JSON.stringify({ object: 'image.generation.result', data: [{ b64_json: 'aGVsbG8=' }] })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }))

    const client = createOpenAIImageClient({
      baseUrl: 'https://example.com/v1',
      streamImages: false,
    })
    const result = await client.generate({
      apiKey: 'test-key',
      model: 'gpt-image-2',
      prompt: 'test prompt',
      inputImages: [],
      params: { size: '1024x1024', quality: 'high', output_format: 'png', n: 1 },
    })

    expect(requestBody).toMatchObject({ stream: true, partial_images: 2 })
    expect(requestBody.response_format).toBeUndefined()
    expect(result.images).toHaveLength(1)
  })
})
