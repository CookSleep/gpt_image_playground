import type { ResponsesInputContentItem, ResponsesOutputItem } from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function deleteInvalidString(record: Record<string, unknown>, key: string) {
  if (record[key] !== undefined && typeof record[key] !== 'string') delete record[key]
}

function normalizeCommon(item: Record<string, unknown>, type: string): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...item, type }
  deleteInvalidString(normalized, 'id')
  deleteInvalidString(normalized, 'status')
  return normalized
}

function normalizeAnnotations(value: unknown) {
  if (!Array.isArray(value)) return undefined
  return value
    .filter(isRecord)
    .map((annotation) => {
      const normalized: Record<string, unknown> = { ...annotation }
      deleteInvalidString(normalized, 'type')
      deleteInvalidString(normalized, 'url')
      deleteInvalidString(normalized, 'title')
      if (normalized.start_index !== undefined && (typeof normalized.start_index !== 'number' || !Number.isFinite(normalized.start_index))) delete normalized.start_index
      if (normalized.end_index !== undefined && (typeof normalized.end_index !== 'number' || !Number.isFinite(normalized.end_index))) delete normalized.end_index
      return normalized
    })
}

function normalizeMessageContent(value: unknown) {
  if (!Array.isArray(value)) return null
  const content: NonNullable<ResponsesOutputItem['content']> = []
  for (const part of value) {
    if (!isRecord(part) || typeof part.type !== 'string' || !part.type.trim()) continue
    if (part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text !== 'string') continue
      const annotations = normalizeAnnotations(part.annotations)
      const normalized: Record<string, unknown> = { ...part, type: part.type, text: part.text }
      if (annotations) normalized.annotations = annotations
      else delete normalized.annotations
      content.push(normalized)
      continue
    }
    if (part.type === 'refusal') {
      if (typeof part.refusal !== 'string') continue
      content.push({ ...part, type: part.type, refusal: part.refusal })
      continue
    }
    content.push({ ...part, type: part.type })
  }
  return content
}

function normalizeAction(value: unknown) {
  if (typeof value === 'string') return value
  return isRecord(value) ? { ...value } : undefined
}

function normalizeImageResult(value: unknown) {
  if (value === null) return null
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined
  const result: Record<string, unknown> = { ...value }
  deleteInvalidString(result, 'b64_json')
  deleteInvalidString(result, 'base64')
  deleteInvalidString(result, 'image')
  deleteInvalidString(result, 'data')
  return result
}

function normalizeFunctionOutputContent(value: unknown): ResponsesInputContentItem[] | null {
  if (!Array.isArray(value)) return null
  const content: ResponsesInputContentItem[] = []
  for (const part of value) {
    if (!isRecord(part) || typeof part.type !== 'string' || !part.type.trim()) continue
    if (part.type === 'input_text') {
      if (typeof part.text !== 'string') continue
      content.push({ ...part, type: part.type, text: part.text })
      continue
    }
    if (part.type === 'input_image') {
      const imageUrl = typeof part.image_url === 'string' && part.image_url.trim() ? part.image_url : undefined
      const fileId = typeof part.file_id === 'string' && part.file_id.trim() ? part.file_id : undefined
      if (!imageUrl && !fileId) continue
      const normalized: Record<string, unknown> = { ...part, type: part.type }
      if (imageUrl) normalized.image_url = imageUrl
      else delete normalized.image_url
      if (fileId) normalized.file_id = fileId
      else delete normalized.file_id
      deleteInvalidString(normalized, 'detail')
      content.push(normalized)
      continue
    }
    if (part.type === 'input_file') {
      const normalized: Record<string, unknown> = { ...part, type: part.type }
      for (const key of ['file_data', 'file_id', 'file_url', 'filename']) deleteInvalidString(normalized, key)
      const hasSource = ['file_data', 'file_id', 'file_url'].some((key) => typeof normalized[key] === 'string' && Boolean((normalized[key] as string).trim()))
      if (!hasSource) continue
      content.push(normalized)
      continue
    }
    content.push({ ...part, type: part.type })
  }
  return content
}

export function normalizeResponsesOutputItems(value: unknown): ResponsesOutputItem[] {
  if (!Array.isArray(value)) return []
  const normalized: ResponsesOutputItem[] = []

  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== 'string' || !item.type.trim()) continue
    const type = item.type
    const common = normalizeCommon(item, type)

    if (type === 'message') {
      const content = normalizeMessageContent(item.content)
      if (!content) continue
      normalized.push({ ...common, content } as ResponsesOutputItem)
      continue
    }

    if (type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id.trim()) continue
      if (typeof item.name !== 'string' || !item.name.trim()) continue
      if (typeof item.arguments !== 'string') continue
      normalized.push({ ...common, call_id: item.call_id, name: item.name, arguments: item.arguments } as ResponsesOutputItem)
      continue
    }

    if (type === 'function_call_output') {
      if (typeof item.call_id !== 'string' || !item.call_id.trim()) continue
      const output = typeof item.output === 'string' ? item.output : normalizeFunctionOutputContent(item.output)
      if (output === null) continue
      normalized.push({ ...common, call_id: item.call_id, output } as ResponsesOutputItem)
      continue
    }

    if (type === 'image_generation_call') {
      const action = normalizeAction(item.action)
      const result = normalizeImageResult(item.result)
      const imageItem: Record<string, unknown> = { ...common }
      if (action !== undefined) imageItem.action = action
      else delete imageItem.action
      if (result !== undefined) imageItem.result = result
      else delete imageItem.result
      normalized.push(imageItem as ResponsesOutputItem)
      continue
    }

    if (type === 'web_search_call') {
      const action = normalizeAction(item.action)
      const searchItem: Record<string, unknown> = { ...common }
      if (action !== undefined) searchItem.action = action
      else delete searchItem.action
      normalized.push(searchItem as ResponsesOutputItem)
      continue
    }

    normalized.push(common as ResponsesOutputItem)
  }

  return normalized
}
