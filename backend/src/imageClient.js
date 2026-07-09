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
      const headers = { Authorization: `Bearer ${config.apiKey}` }
      const response = input.inputImages?.length
        ? await callEdit(config, headers, input)
        : await callGeneration(config, headers, input)

      if (!response.ok) throw new Error(await parseError(response))
      const payload = await response.json()
      const data = Array.isArray(payload.data) ? payload.data : []
      if (!data.length) throw new Error('上游未返回图片')

      const images = []
      for (const item of data) {
        if (item.b64_json) {
          images.push({ ...b64ToImage(item.b64_json, fallbackContentType), revisedPrompt: item.revised_prompt })
        } else if (item.url) {
          images.push({ ...await imageUrlToBytes(item.url), revisedPrompt: item.revised_prompt })
        }
      }
      if (!images.length) throw new Error('上游图片结果无法解析')
      return { images, upstream: { model: input.model, count: images.length } }
    },
  }
}

async function callGeneration(config, headers, input) {
  return fetch(joinUrl(config.baseUrl, '/images/generations'), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      size: input.params.size,
      quality: input.params.quality,
      output_format: input.params.output_format,
      n: input.params.n,
      response_format: 'b64_json',
    }),
  })
}

async function callEdit(config, headers, input) {
  const form = new FormData()
  form.set('model', input.model)
  form.set('prompt', input.prompt)
  form.set('size', input.params.size)
  form.set('quality', input.params.quality)
  form.set('output_format', input.params.output_format)
  form.set('n', String(input.params.n))
  form.set('response_format', 'b64_json')
  input.inputImages.forEach((dataUrl, idx) => {
    const file = dataUrlToBytes(dataUrl)
    form.append('image', new Blob([file.body], { type: file.contentType }), `reference-${idx}.png`)
  })
  return fetch(joinUrl(config.baseUrl, '/images/edits'), {
    method: 'POST',
    headers,
    body: form,
  })
}
