export interface ReadJsonServerSentEventsOptions {
  signals?: Array<AbortSignal | undefined>
  formatErrorMessage?: (message: string) => string
  getEventErrorMessage?: (event: Record<string, unknown>) => string | null
}

export function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream') ?? false
}

export function parseServerSentEventBlock(block: string): string | null {
  const dataLines: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    dataLines.push(line.slice(5).replace(/^ /, ''))
  }

  const data = dataLines.join('\n').trim()
  if (!data || data === '[DONE]') return null
  return data
}

export function throwIfAborted(...signals: Array<AbortSignal | undefined>) {
  const signal = signals.find((signal) => signal?.aborted)
  if (!signal) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException('请求已停止', 'AbortError')
}

export async function readJsonServerSentEvents(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void | Promise<void>,
  options: ReadJsonServerSentEventsOptions = {},
): Promise<void> {
  if (!response.body) throw new Error('接口未返回可读取的流式响应')

  const signals = options.signals ?? []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let hasDataLine = false
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined)
  }
  throwIfAborted(...signals)
  for (const signal of signals) signal?.addEventListener('abort', cancelReader, { once: true })

  const processBlock = async (block: string) => {
    if (block.split(/\r?\n/).some((line) => line.startsWith('data:'))) hasDataLine = true
    const data = parseServerSentEventBlock(block)
    if (!data) return

    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      throw new Error(options.formatErrorMessage?.(data) ?? data)
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return

    const errorMessage = options.getEventErrorMessage?.(event as Record<string, unknown>)
    if (errorMessage) throw new Error(errorMessage)

    throwIfAborted(...signals)
    await onEvent(event as Record<string, unknown>)
    throwIfAborted(...signals)
  }

  try {
    while (true) {
      throwIfAborted(...signals)
      const { value, done } = await reader.read()
      throwIfAborted(...signals)
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separatorIndex = buffer.search(/\r?\n\r?\n/)
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex)
        const separator = buffer.match(/\r?\n\r?\n/)?.[0] ?? '\n\n'
        buffer = buffer.slice(separatorIndex + separator.length)
        await processBlock(block)
        separatorIndex = buffer.search(/\r?\n\r?\n/)
      }
    }

    buffer += decoder.decode()
    throwIfAborted(...signals)
    if (buffer.trim()) await processBlock(buffer)
    if (!hasDataLine) {
      const message = '未从流式响应中解析到有效的 data 事件'
      throw new Error(options.formatErrorMessage?.(message) ?? message)
    }
  } finally {
    for (const signal of signals) signal?.removeEventListener('abort', cancelReader)
  }
}
