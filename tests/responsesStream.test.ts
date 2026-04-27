import { strict as assert } from 'node:assert'
import test from 'node:test'
import { extractGeneratedImageBase64, findGeneratedImagePayload, readResponsesStreamPayload } from '../src/lib/responsesStream.ts'

function responseFromSse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
  )
}

test('falls back to partial image when completed output is empty', async () => {
  const result = await readResponsesStreamPayload(
    responseFromSse([
      'event: response.image_generation_call.partial_image\n',
      'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"partial-one"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"output":[]}}\n\n',
    ]),
  )

  assert.equal(result.source, 'partial')
  assert.equal(extractGeneratedImageBase64(result.payload), 'partial-one')
})

test('extracts image data from output_item.done events', async () => {
  const result = await readResponsesStreamPayload(
    responseFromSse([
      'event: response.output_item.done\n',
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"final-image"}}\n\n',
      'data: [DONE]\n\n',
    ]),
  )

  assert.equal(result.source, 'final')
  assert.equal(extractGeneratedImageBase64(result.payload), 'final-image')
})

test('finds the concrete image payload nested inside output_item.done', async () => {
  const result = await readResponsesStreamPayload(
    responseFromSse([
      'event: response.output_item.done\n',
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"final-image","quality":"high"}}\n\n',
    ]),
  )

  assert.deepEqual(findGeneratedImagePayload(result.payload), {
    type: 'image_generation_call',
    result: 'final-image',
    quality: 'high',
  })
})

test('prefers final image over earlier partial image', async () => {
  const result = await readResponsesStreamPayload(
    responseFromSse([
      'event: response.image_generation_call.partial_image\n',
      'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"partial-one"}\n\n',
      'event: response.output_item.done\n',
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"final-image"}}\n\n',
    ]),
  )

  assert.equal(result.source, 'final')
  assert.equal(extractGeneratedImageBase64(result.payload), 'final-image')
})

test('handles SSE event split across chunks', async () => {
  const result = await readResponsesStreamPayload(
    responseFromSse([
      'event: response.output_item.done\n',
      'data: {"type":"response.output_item.done","item":',
      '{"type":"image_generation_call","result":"final-image"}}\n\n',
    ]),
  )

  assert.equal(result.source, 'final')
  assert.equal(extractGeneratedImageBase64(result.payload), 'final-image')
})

test('extracts image data from completed output when present', () => {
  const base64 = extractGeneratedImageBase64({
    output: [{ type: 'image_generation_call', result: 'completed-image' }],
  })

  assert.equal(base64, 'completed-image')
})

test('extracts image data from b64_json compatibility payloads', () => {
  const base64 = extractGeneratedImageBase64({
    type: 'image_generation.completed',
    b64_json: 'completed-image',
  })

  assert.equal(base64, 'completed-image')
})
