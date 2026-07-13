function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function readError(response) {
  const text = await response.text()
  try {
    const payload = JSON.parse(text)
    return payload.error?.message || payload.message || text
  } catch {
    return text
  }
}

function outputText(payload) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim()
  const texts = []
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') texts.push(content.text)
    }
  }
  return texts.join('\n').trim()
}

const OPTIMIZE_INSTRUCTIONS = `你是专业的图片生成提示词编辑器。保留用户原始意图和事实，不擅自改变主体；补足有助于图片生成的主体细节、场景、构图、光线、色彩、材质和风格。只返回一段可直接用于图片生成的优化提示词，不要解释，不要使用 Markdown，不要添加标题。`

export function createOpenAITextClient(config) {
  return {
    async optimize(input) {
      if (!input.apiKey) throw new Error('缺少用于提示词优化的 API Key')
      const controller = new AbortController()
      const timeoutMs = Number(config.timeoutMs || 0)
      const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
      try {
        const response = await fetch(joinUrl(config.baseUrl, '/responses'), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${input.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: input.model,
            instructions: OPTIMIZE_INSTRUCTIONS,
            input: input.prompt,
          }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(await readError(response) || `提示词优化失败：HTTP ${response.status}`)
        const result = outputText(await response.json())
        if (!result) throw new Error('提示词优化接口未返回文本')
        return result
      } catch (err) {
        if (err?.name === 'AbortError') throw new Error(`提示词优化超时：${Math.round(timeoutMs / 1000)} 秒`)
        throw err
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }
    },
  }
}
