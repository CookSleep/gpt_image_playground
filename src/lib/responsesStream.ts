export interface ResponsesStreamEvent {
  event: string
  data: string
}

export type ResponsesStreamPayloadSource = 'partial' | 'final' | 'completed' | 'latest'

export interface ResponsesStreamPayloadResult {
  payload: unknown | null
  source: ResponsesStreamPayloadSource
}

export function parseServerSentEvent(rawEvent: string): ResponsesStreamEvent {
  const lines = rawEvent.split(/\r?\n/)
  const dataLines: string[] = []
  let event = ''

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
  }

  return {
    event,
    data: dataLines.join('\n'),
  }
}

export function parseJsonOrNull(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function getDirectImageBase64(record: Record<string, unknown>): string | null {
  const result = readString(record, 'result')
  if (result) return result

  const partialImage = readString(record, 'partial_image_b64')
  if (partialImage) return partialImage

  const b64Json = readString(record, 'b64_json')
  if (b64Json) return b64Json

  return null
}

export function extractGeneratedImageBase64(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null

  const record = payload as Record<string, unknown>
  const directImage = getDirectImageBase64(record)
  if (directImage) return directImage

  const itemImage = extractGeneratedImageBase64(record.item)
  if (itemImage) return itemImage

  const responseImage = extractGeneratedImageBase64(record.response)
  if (responseImage) return responseImage

  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      const outputImage = extractGeneratedImageBase64(item)
      if (outputImage) return outputImage
    }
  }

  return null
}

function hasFinalImagePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  return Boolean(readString(record, 'result') || readString(record, 'b64_json'))
}

export function findGeneratedImagePayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null

  const record = payload as Record<string, unknown>
  const itemPayload = findGeneratedImagePayload(record.item)
  if (itemPayload) return itemPayload

  const responsePayload = findGeneratedImagePayload(record.response)
  if (responsePayload) return responsePayload

  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      const outputPayload = findGeneratedImagePayload(item)
      if (outputPayload) return outputPayload
    }
  }

  if (extractGeneratedImageBase64(record)) return record

  return null
}

function pickCompletedPayload(event: ResponsesStreamEvent, payload: unknown): unknown | null {
  if (!payload || typeof payload !== 'object') return null

  const record = payload as Record<string, unknown>
  if (event.event === 'response.completed' || record.type === 'response.completed') {
    return record.response || record
  }

  return null
}

function chooseStreamPayload(
  partialPayload: unknown | null,
  finalPayload: unknown | null,
  completedPayload: unknown | null,
  latestPayload: unknown | null,
): ResponsesStreamPayloadResult {
  if (finalPayload) return { payload: finalPayload, source: 'final' }
  if (completedPayload && extractGeneratedImageBase64(completedPayload)) return { payload: completedPayload, source: 'completed' }
  if (partialPayload) return { payload: partialPayload, source: 'partial' }
  if (completedPayload) return { payload: completedPayload, source: 'completed' }
  return { payload: latestPayload, source: 'latest' }
}

export async function readResponsesStreamPayload(response: Response): Promise<ResponsesStreamPayloadResult> {
  if (!response.body) return { payload: null, source: 'latest' }

  const decoder = new TextDecoder()
  let buffer = ''
  let latestPayload: unknown | null = null
  let completedPayload: unknown | null = null
  let partialPayload: unknown | null = null
  let finalPayload: unknown | null = null

  const processRawEvent = (rawEvent: string) => {
    const event = parseServerSentEvent(rawEvent)
    if (!event.data || event.data === '[DONE]') return

    const payload = parseJsonOrNull(event.data)
    if (!payload) return

    latestPayload = payload

    if (extractGeneratedImageBase64(payload)) {
      if (hasFinalImagePayload(findGeneratedImagePayload(payload))) {
        finalPayload = payload
      } else {
        partialPayload = payload
      }
    }

    const completed = pickCompletedPayload(event, payload)
    if (completed) {
      completedPayload = completed
    }
  }

  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    const parts = buffer.split(/\r?\n\r?\n/)
    buffer = parts.pop() || ''

    for (const part of parts) {
      processRawEvent(part)
    }
  }

  const trailing = decoder.decode()
  if (trailing) buffer += trailing

  if (buffer.trim()) {
    processRawEvent(buffer)
  }

  return chooseStreamPayload(partialPayload, finalPayload, completedPayload, latestPayload)
}
