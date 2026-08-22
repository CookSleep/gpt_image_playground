import { describe, expect, it, vi } from 'vitest'
import { isEventStreamResponse, parseServerSentEventBlock, readJsonServerSentEvents } from './serverSentEvents'

describe('serverSentEvents', () => {
  it('detects event-stream content types', () => {
    expect(isEventStreamResponse(new Response('', {
      headers: { 'Content-Type': 'Text/Event-Stream; Charset=UTF-8' },
    }))).toBe(true)
    expect(isEventStreamResponse(new Response('', {
      headers: { 'Content-Type': 'application/json' },
    }))).toBe(false)
  })

  it('parses CRLF and joins multiple data lines', () => {
    expect(parseServerSentEventBlock(': comment\r\ndata: {"message":\r\ndata: "hello"}\r\n')).toBe('{"message":\n"hello"}')
  })

  it('ignores DONE and blocks without data', () => {
    expect(parseServerSentEventBlock('data: [DONE]\r\n')).toBeNull()
    expect(parseServerSentEventBlock('event: ping\n: comment')).toBeNull()
  })

  it('reads JSON events and ignores DONE', async () => {
    const events: Array<Record<string, unknown>> = []
    const response = new Response('data: {"type":"first",\r\ndata: "value":1}\r\n\r\ndata: [DONE]\r\n\r\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })

    await readJsonServerSentEvents(response, (event) => {
      events.push(event)
    })

    expect(events).toEqual([{ type: 'first', value: 1 }])
  })

  it('reads byte chunks split across SSE syntax, UTF-8 characters, and the final block', async () => {
    const encoder = new TextEncoder()
    const source = 'data: {"type":"第一"}\r\n\r\ndata: {"type":"第二"}\r\n\r\ndata: {"type":"末尾"}'
    const bytes = encoder.encode(source)
    const firstBlockEnd = encoder.encode('data: {"type":"第一"}').length
    const cuts = [
      2,
      9,
      encoder.encode('data: {"type":"').length + 1,
      firstBlockEnd + 1,
      firstBlockEnd + 3,
      firstBlockEnd + 4 + encoder.encode('data: {"ty').length,
    ]
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        let start = 0
        for (const end of cuts) {
          controller.enqueue(bytes.slice(start, end))
          start = end
        }
        controller.enqueue(bytes.slice(start))
        controller.close()
      },
    }))
    const order: string[] = []
    let releaseFirst: () => void
    const firstEventPending = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const reading = readJsonServerSentEvents(response, async (event) => {
      order.push(event.type as string)
      if (event.type === '第一') await firstEventPending
    })

    await vi.waitFor(() => expect(order).toEqual(['第一']))
    releaseFirst!()
    await reading

    expect(order).toEqual(['第一', '第二', '末尾'])
  })

  it('rejects event errors before invoking the callback', async () => {
    const onEvent = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"error":"生成失败"}\n\n'))
        controller.close()
      },
    }))

    await expect(readJsonServerSentEvents(response, onEvent, {
      getEventErrorMessage: (event) => typeof event.error === 'string' ? event.error : null,
    })).rejects.toThrow('生成失败')
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('formats invalid JSON errors at the caller boundary', async () => {
    const response = new Response('data: invalid json\n\n')

    await expect(readJsonServerSentEvents(response, vi.fn(), {
      formatErrorMessage: (message) => `格式错误：${message}`,
    })).rejects.toThrow('格式错误：invalid json')
  })

  it('rejects streams without data blocks', async () => {
    const response = new Response('event: ping\r\n\r\n')

    await expect(readJsonServerSentEvents(response, vi.fn())).rejects.toThrow('未从流式响应中解析到有效的 data 事件')
  })

  it('cancels the reader when any signal aborts', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"first"}\n\n'))
      },
      cancel,
    }))
    const firstController = new AbortController()
    const secondController = new AbortController()

    await expect(readJsonServerSentEvents(response, () => {
      secondController.abort()
    }, {
      signals: [firstController.signal, secondController.signal],
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
