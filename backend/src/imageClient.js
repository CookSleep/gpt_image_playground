function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function dataUrlToBytes(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('参考图格式不合法')
  const contentType = match[1] || 'application/octet-stream'
  const body = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]))
  return { body, contentType }
}

function contentTypeFromFormat(format) {
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return 'image/png'
}

function isEventStreamResponse(response) {
  return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false
}

async function readServerSentEvents(response, onEvent) {
  if (!response.body) throw new Error('流式接口没有返回可读取内容')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  function flushEvent(raw) {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return
    const event = JSON.parse(data)
    if (event?.error) throw new Error(event.error.message || JSON.stringify(event.error))
    onEvent(event)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\r?\n\r?\n/)
    buffer = parts.pop() ?? ''
    for (const part of parts) flushEvent(part)
  }
  buffer += decoder.decode()
  if (buffer.trim()) flushEvent(buffer)
}

function eventToImageItem(event) {
  return {
    b64_json: typeof event.b64_json === 'string' ? event.b64_json : undefined,
    url: typeof event.url === 'string' ? event.url : undefined,
    revised_prompt: typeof event.revised_prompt === 'string' ? event.revised_prompt : undefined,
  }
}

async function imageItemToOutput(item, fallbackContentType) {
  if (item.b64_json) {
    return { ...b64ToImage(item.b64_json, fallbackContentType), revisedPrompt: item.revised_prompt }
  }
  if (item.url) {
    return { ...await imageUrlToBytes(item.url), revisedPrompt: item.revised_prompt }
  }
  return null
}

async function parseError(response) {
  try {
    const payload = await response.json()
    return payload.error?.message || payload.message || JSON.stringify(payload)
  } catch {
    return await response.text()
  }
}

async function imageUrlToBytes(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`)
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'image/png',
  }
}

function b64ToImage(b64, fallbackContentType) {
  const dataUrlMatch = /^data:([^;,]+);base64,(.*)$/s.exec(b64)
  if (dataUrlMatch) {
    return {
      bytes: Buffer.from(dataUrlMatch[2], 'base64'),
      contentType: dataUrlMatch[1],
    }
  }
  return {
    bytes: Buffer.from(b64, 'base64'),
    contentType: fallbackContentType,
  }
}

export function createOpenAIImageClient(config) {
  return {
    async generate(input) {
      const fallbackContentType = contentTypeFromFormat(input.params.output_format)
      const apiKey = input.apiKey || config.apiKey
      if (!apiKey) throw new Error('缺少用于生成图片的 sub2api API Key')
      const headers = { Authorization: `Bearer ${apiKey}` }
      const controller = new AbortController()
      const timeoutMs = Number(config.timeoutMs || 0)
      const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null

      try {
        const response = input.inputImages?.length
          ? await callEdit(config, headers, input, controller.signal)
          : await callGeneration(config, headers, input, controller.signal)

        if (!response.ok) throw new Error(await parseError(response))

        const images = isEventStreamResponse(response)
          ? await parseImageStream(response, fallbackContentType)
          : await parseImageJson(await response.json(), fallbackContentType)
        if (!images.length) throw new Error('上游图片结果无法解析')
        return { images, upstream: { model: input.model, count: images.length } }
      } catch (err) {
        if (err?.name === 'AbortError') {
          throw new Error(`上游图片生成超时：${Math.round(timeoutMs / 1000)} 秒`)
        }
        throw err
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }
    },
  }
}

async function parseImageJson(payload, fallbackContentType) {
  const data = Array.isArray(payload.data) ? payload.data : []
  if (!data.length) throw new Error('上游未返回图片')

  const images = []
  for (const item of data) {
    const image = await imageItemToOutput(item, fallbackContentType)
    if (image) images.push(image)
  }
  return images
}

async function parseImageStream(response, fallbackContentType) {
  let resultPayload = null
  const completedItems = []

  await readServerSentEvents(response, (event) => {
    if (event.object === 'image.generation.result' || event.object === 'image.edit.result') {
      resultPayload = event
      return
    }
    if (event.type === 'image_generation.completed' || event.type === 'image_edit.completed') {
      completedItems.push(eventToImageItem(event))
    }
  })

  if (resultPayload) return parseImageJson(resultPayload, fallbackContentType)
  if (!completedItems.length) throw new Error('流式接口未返回最终图片数据')

  const images = []
  for (const item of completedItems) {
    const image = await imageItemToOutput(item, fallbackContentType)
    if (image) images.push(image)
  }
  return images
}

async function callGeneration(config, headers, input, signal) {
  const body = {
    model: input.model,
    prompt: input.prompt,
    size: input.params.size,
    quality: input.params.quality,
    output_format: input.params.output_format,
    n: input.params.n,
  }
  body.stream = true
  body.partial_images = config.partialImages ?? 2

  return fetch(joinUrl(config.baseUrl, '/images/generations'), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

async function callEdit(config, headers, input, signal) {
  const form = new FormData()
  form.set('model', input.model)
  form.set('prompt', input.prompt)
  form.set('size', input.params.size)
  form.set('quality', input.params.quality)
  form.set('output_format', input.params.output_format)
  form.set('n', String(input.params.n))
  form.set('stream', 'true')
  form.set('partial_images', String(config.partialImages ?? 2))
  input.inputImages.forEach((dataUrl, idx) => {
    const file = dataUrlToBytes(dataUrl)
    form.append('image', new Blob([file.body], { type: file.contentType }), `reference-${idx}.png`)
  })
  return fetch(joinUrl(config.baseUrl, '/images/edits'), {
    method: 'POST',
    headers,
    body: form,
    signal,
  })
}
