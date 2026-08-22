import http from 'node:http'

const port = Number(process.env.MOCK_IMAGE_API_PORT || 8787)
const host = process.env.MOCK_IMAGE_API_HOST || '127.0.0.1'
const defaultMode = process.env.MOCK_IMAGE_API_MODE || 'url-cors-block'

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const tinyPng = Buffer.from(tinyPngBase64, 'base64')

const pathModes = new Set([
  'api-no-cors',
  'alternating-http-error',
  'b64',
  'empty',
  'http-error',
  'invalid-json',
  'no-recognizable',
  'slow',
  'stream-error-object',
  'stream-failed-event',
  'stream-invalid-json',
  'stream-no-data',
  'stream-no-final',
  'stream-no-usable',
  'stream-unsupported',
  'url-404',
  'url-cors-block',
  'url-ok',
  'url-redirect-cors-block',
  'wrong-shape',
])

const alternatingModeCounters = new Map()

function appendCors(headers, enabled = true) {
  if (!enabled) return headers
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }
}

function send(res, status, headers, body) {
  res.writeHead(status, headers)
  res.end(body)
}

function sendJson(res, status, payload, options = {}) {
  const body = JSON.stringify(payload, null, options.pretty ? 2 : 0)
  send(res, status, appendCors({ 'Content-Type': 'application/json; charset=utf-8' }, options.cors !== false), body)
}

async function sendSse(res, events, options = {}) {
  res.writeHead(200, appendCors({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  }, options.cors !== false))

  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

function sendRawSse(res, body, options = {}) {
  send(res, 200, appendCors({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  }, options.cors !== false), body)
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) {
        resolve({ text: '', json: null })
        return
      }
      try {
        resolve({ text, json: JSON.parse(text) })
      } catch {
        resolve({ text, json: null })
      }
    })
    req.on('error', () => resolve({ text: '', json: null }))
  })
}

function getMode(url, body) {
  const queryMode = url.searchParams.get('mode')
  if (queryMode) return queryMode

  const firstSegment = url.pathname.split('/').filter(Boolean)[0]
  if (pathModes.has(firstSegment)) return firstSegment

  if (body && typeof body === 'object') {
    if (typeof body.mode === 'string' && body.mode.trim()) return body.mode.trim()
    if (typeof body.model === 'string') {
      const match = body.model.match(/^mock:(.+)$/)
      if (match) return match[1]
    }
  }

  return defaultMode
}

function getRequestedN(url, body) {
  const raw = url.searchParams.get('n') ?? (body && typeof body === 'object' ? body.n : undefined)
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.floor(n))) : 1
}

function shouldFailAlternating(mode, pathname) {
  if (mode !== 'alternating-http-error') return false
  const next = (alternatingModeCounters.get(pathname) || 0) + 1
  alternatingModeCounters.set(pathname, next)
  return next % 2 === 0
}

function getBaseUrl(req) {
  return `http://${req.headers.host || `${host}:${port}`}`
}

function getImageUrl(req, cors, index = 0) {
  return `${getBaseUrl(req)}/images/mock.png?cors=${cors ? '1' : '0'}&i=${index}&t=${Date.now()}`
}

function createRandomShape(req, cors, index = 0) {
  return {
    status: 'success',
    data: {
      id: 42 + index,
      name: `example-${index + 1}.jpg`,
      url: getImageUrl(req, cors, index),
      width: 1920,
      height: 1080,
      mime: 'image/png',
    },
  }
}

function createOpenAIResponse(req, mode, n = 1) {
  const created = Math.floor(Date.now() / 1000)

  if (mode === 'b64') {
    return {
      created,
      data: Array.from({ length: n }, (_, i) => ({ b64_json: tinyPngBase64, revised_prompt: `mock b64 image ${i + 1}` })),
    }
  }

  if (mode === 'empty') return { created, data: [] }
  if (mode === 'wrong-shape') return createRandomShape(req, false)
  if (mode === 'no-recognizable') return { created, data: Array.from({ length: n }, (_, i) => ({ id: 42 + i, name: `example-${i + 1}.jpg`, mime: 'image/png' })) }

  if (mode === 'url-404') {
    return { created, data: Array.from({ length: n }, (_, i) => ({ url: `${getBaseUrl(req)}/images/missing.png?cors=1&i=${i}` })) }
  }

  if (mode === 'url-redirect-cors-block') {
    return { created, data: Array.from({ length: n }, (_, i) => ({ url: `${getBaseUrl(req)}/images/redirect?cors=0&i=${i}` })) }
  }

  return {
    created,
    data: Array.from({ length: n }, (_, i) => ({ url: getImageUrl(req, mode === 'url-ok', i), revised_prompt: `mock ${mode} ${i + 1}` })),
  }
}

function isOpenAIImagesPath(pathname) {
  return pathname.endsWith('/v1/images/generations') || pathname.endsWith('/v1/images/edits')
}

function isOpenAIResponsesPath(pathname) {
  return pathname.endsWith('/v1/responses')
}

function isCustomPath(pathname) {
  return pathname === '/custom/random-image' || pathname === '/custom/generate'
}

function isCustomAsyncSubmitPath(pathname) {
  return pathname === '/custom/async-submit'
}

function isCustomAsyncPollPath(pathname) {
  return pathname.startsWith('/custom/tasks/')
}

function createImagesStreamEvents(req, mode, n, isEdit) {
  const created = Math.floor(Date.now() / 1000)
  const prefix = isEdit ? 'image_edit' : 'image_generation'
  const partialCount = mode === 'empty' ? 0 : 2
  const partials = Array.from({ length: partialCount }, (_, i) => ({
    type: `${prefix}.partial_image`,
    created_at: created,
    partial_image_index: i,
    b64_json: tinyPngBase64,
    output_format: 'png',
    quality: 'auto',
    size: '1024x1024',
  }))
  const completed = Array.from({ length: n }, () => ({
    type: `${prefix}.completed`,
    created_at: created,
    b64_json: tinyPngBase64,
    output_format: 'png',
    quality: 'auto',
    size: '1024x1024',
  }))
  if (mode === 'stream-no-final') return partials
  if (mode === 'stream-no-usable') {
    return [{
      type: `${prefix}.completed`,
      created_at: created,
      output_format: 'png',
      quality: 'auto',
      size: '1024x1024',
    }]
  }
  return [...partials, ...completed]
}

function createResponsesPayload(mode) {
  if (mode === 'empty') return { output: [] }
  if (mode === 'no-recognizable' || mode === 'wrong-shape') {
    return {
      output: [{
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: 'mock response without image data' }],
      }],
    }
  }
  if (mode === 'stream-no-usable') {
    return {
      output: [{
        type: 'image_generation_call',
        status: 'completed',
        result: '',
      }],
    }
  }

  return {
    output: [{
      type: 'image_generation_call',
      status: 'completed',
      revised_prompt: `mock ${mode} response image`,
      result: tinyPngBase64,
      output_format: 'png',
      quality: 'auto',
      size: '1024x1024',
    }],
  }
}

function createResponsesStreamEvents(mode) {
  const partials = mode === 'empty'
    ? []
    : [0, 1].map((index) => ({
        type: 'response.image_generation_call.partial_image',
        output_index: 0,
        item_id: 'mock-image-generation',
        partial_image_index: index,
        partial_image_b64: tinyPngBase64,
      }))

  if (mode === 'stream-no-final') return partials

  return [
    ...partials,
    {
      type: 'response.completed',
      response: createResponsesPayload(mode),
    },
  ]
}

async function maybeSendStreamFailure(res, mode, prefix = 'image_generation') {
  if (mode === 'stream-unsupported') {
    send(res, 400, appendCors({ 'Content-Type': 'text/plain; charset=utf-8' }), 'invalid character \':\' looking for beginning of value')
    return true
  }
  if (mode === 'stream-invalid-json') {
    sendRawSse(res, 'data: invalid character \':\' looking for beginning of value\n\n')
    return true
  }
  if (mode === 'stream-no-data') {
    sendRawSse(res, 'invalid character \':\' looking for beginning of value\n\n')
    return true
  }
  if (mode === 'stream-failed-event') {
    await sendSse(res, [{ type: `${prefix}.failed`, message: 'Mock streaming failure event' }])
    return true
  }
  if (mode === 'stream-error-object') {
    await sendSse(res, [{ error: { message: 'Mock streaming error object' } }])
    return true
  }
  return false
}

async function handleApi(req, res, url) {
  const body = req.method === 'GET' ? { json: null } : await readBody(req)
  const mode = getMode(url, body.json)
  const n = getRequestedN(url, body.json)

  if (mode === 'slow') {
    const delayMs = Math.max(1, Number(url.searchParams.get('delayMs') || 15000))
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  if (mode === 'api-no-cors') {
    sendJson(res, 200, createOpenAIResponse(req, 'url-ok', n), { cors: false })
    return
  }

  if (shouldFailAlternating(mode, url.pathname)) {
    sendJson(res, 500, { error: { message: 'Mock alternating HTTP failure' } })
    return
  }

  if (mode === 'http-error') {
    sendJson(res, 500, { error: { message: 'Mock HTTP failure from local test API' } })
    return
  }

  if (mode === 'invalid-json') {
    send(res, 200, appendCors({ 'Content-Type': 'application/json; charset=utf-8' }), '{ invalid json')
    return
  }

  const wantsStream = (body.json && typeof body.json === 'object' && body.json.stream === true) ||
    /name="stream"[\s\S]*?\r?\n\r?\ntrue/.test(body.text)
  if (wantsStream) {
    const streamPrefix = url.pathname.endsWith('/v1/images/edits') ? 'image_edit' : 'image_generation'
    if (await maybeSendStreamFailure(res, mode, streamPrefix)) return
    await sendSse(res, createImagesStreamEvents(req, mode, n, url.pathname.endsWith('/v1/images/edits')))
    return
  }

  sendJson(res, 200, createOpenAIResponse(req, mode, n))
}

async function handleResponses(req, res, url) {
  const body = req.method === 'GET' ? { json: null } : await readBody(req)
  const mode = getMode(url, body.json)

  if (shouldFailAlternating(mode, url.pathname)) {
    sendJson(res, 500, { error: { message: 'Mock alternating HTTP failure' } })
    return
  }

  if (mode === 'http-error') {
    sendJson(res, 500, { error: { message: 'Mock Responses API failure' } })
    return
  }

  if (body.json && typeof body.json === 'object' && body.json.stream === true) {
    if (await maybeSendStreamFailure(res, mode, 'response')) return
    await sendSse(res, createResponsesStreamEvents(mode))
    return
  }

  sendJson(res, 200, createResponsesPayload(mode))
}

async function handleCustom(req, res, url) {
  const body = req.method === 'GET' ? { json: null } : await readBody(req)
  const mode = getMode(url, body.json)
  const n = getRequestedN(url, body.json)

  if (mode === 'http-error') {
    sendJson(res, 500, { error: { message: 'Mock custom provider failure' } })
    return
  }

  if (shouldFailAlternating(mode, url.pathname)) {
    sendJson(res, 500, { error: { message: 'Mock alternating custom provider failure' } })
    return
  }

  if (mode === 'empty' || mode === 'no-recognizable') {
    sendJson(res, 200, { status: 'success', data: { id: 42, name: 'example.jpg', mime: 'image/png' } })
    return
  }

  if (n > 1) {
    sendJson(res, 200, {
      status: 'success',
      data: {
        images: Array.from({ length: n }, (_, i) => createRandomShape(req, mode === 'url-ok' || mode === 'b64', i).data),
      },
    })
    return
  }

  sendJson(res, 200, createRandomShape(req, mode === 'url-ok' || mode === 'b64'))
}

async function handleCustomAsyncSubmit(req, res, url) {
  const body = req.method === 'GET' ? { json: null } : await readBody(req)
  const mode = getMode(url, body.json)

  if (mode === 'http-error') {
    sendJson(res, 500, { error: { message: 'Mock async submit failure' } })
    return
  }

  if (mode === 'async-no-task-id') {
    sendJson(res, 200, { status: 'success', data: { message: 'task id intentionally omitted' } })
    return
  }

  sendJson(res, 200, { data: `mock:${mode}:${Date.now()}` })
}

function getModeFromCustomTaskPath(pathname) {
  const taskId = decodeURIComponent(pathname.split('/').filter(Boolean).at(-1) || '')
  const match = taskId.match(/^mock:(.+):\d+$/)
  return match ? match[1] : defaultMode
}

function handleCustomAsyncPoll(req, res, url) {
  const mode = getModeFromCustomTaskPath(url.pathname)

  if (mode === 'async-failure') {
    sendJson(res, 200, { data: { status: 'FAILURE', fail_reason: 'Mock async task failure' } })
    return
  }

  if (mode === 'async-empty' || mode === 'async-no-recognizable' || mode === 'no-recognizable') {
    sendJson(res, 200, { data: { status: 'SUCCESS', data: { data: [{ id: 42, name: 'example.jpg', mime: 'image/png' }] } } })
    return
  }

  const image = mode === 'b64'
    ? { b64_json: tinyPngBase64 }
    : { url: getImageUrl(req, mode === 'url-ok', 0) }
  sendJson(res, 200, { data: { status: 'SUCCESS', data: { data: [image] } } })
}

function handleImage(req, res, url) {
  const cors = url.searchParams.get('cors') === '1'
  const headers = appendCors({
    'Cache-Control': 'no-store',
    'Content-Type': 'image/png',
    'Content-Length': String(tinyPng.length),
  }, cors)

  if (url.pathname === '/images/redirect') {
    send(res, 302, appendCors({ Location: `/images/mock.png?cors=${cors ? '1' : '0'}` }, cors), '')
    return
  }

  if (url.pathname === '/images/missing.png') {
    send(res, 404, appendCors({ 'Content-Type': 'text/plain; charset=utf-8' }, cors), 'mock image missing')
    return
  }

  if (req.method === 'HEAD') {
    send(res, 200, headers, '')
    return
  }

  send(res, 200, headers, tinyPng)
}

function handleIndex(req, res) {
  sendJson(res, 200, {
    name: 'gpt-image-playground mock image API',
    openaiCompatibleBaseUrls: [
      `${getBaseUrl(req)}/url-cors-block`,
      `${getBaseUrl(req)}/url-ok`,
      `${getBaseUrl(req)}/b64`,
      `${getBaseUrl(req)}/wrong-shape`,
      `${getBaseUrl(req)}/api-no-cors`,
    ],
    customEndpoint: `${getBaseUrl(req)}/custom/random-image`,
    customAsyncEndpoint: `${getBaseUrl(req)}/custom/async-submit`,
    modes: [...pathModes].sort(),
  }, { pretty: true })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', getBaseUrl(req))
  const mode = getMode(url, null)
  const allowCors = mode !== 'api-no-cors' && !url.pathname.startsWith('/images/')

  if (req.method === 'OPTIONS') {
    send(res, 204, appendCors({}, allowCors), '')
    return
  }

  try {
    if (isOpenAIImagesPath(url.pathname)) {
      await handleApi(req, res, url)
      return
    }

    if (isOpenAIResponsesPath(url.pathname)) {
      await handleResponses(req, res, url)
      return
    }

    if (isCustomPath(url.pathname)) {
      await handleCustom(req, res, url)
      return
    }

    if (isCustomAsyncSubmitPath(url.pathname)) {
      await handleCustomAsyncSubmit(req, res, url)
      return
    }

    if (isCustomAsyncPollPath(url.pathname)) {
      handleCustomAsyncPoll(req, res, url)
      return
    }

    if (url.pathname.startsWith('/images/')) {
      handleImage(req, res, url)
      return
    }

    handleIndex(req, res)
  } catch (err) {
    sendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } })
  }
})

server.listen(port, host, () => {
  console.log(`Mock image API listening at http://${host}:${port}`)
  console.log(`OpenAI-compatible CORS image failure: http://${host}:${port}/url-cors-block`)
  console.log(`Custom non-OpenAI JSON endpoint: http://${host}:${port}/custom/random-image`)
  console.log(`Custom async JSON endpoint: http://${host}:${port}/custom/async-submit`)
})
