import { describe, expect, it } from 'vitest'
import { getApiErrorMessage, redactApiErrorText } from './imageApiShared'

describe('API error diagnostics', () => {
  it('includes HTTP status, provider error, and request identifiers', async () => {
    const response = new Response(JSON.stringify({ error: { message: 'generation rejected' } }), {
      status: 403,
      statusText: 'Forbidden',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': 'req-123',
        'CF-Ray': 'ray-456',
      },
    })

    await expect(getApiErrorMessage(response)).resolves.toBe([
      'HTTP 403 Forbidden',
      'generation rejected',
      '请求标识：x-request-id=req-123，cf-ray=ray-456',
    ].join('\n'))
  })

  it('summarizes HTML gateway errors instead of returning the full page', async () => {
    const response = new Response('<!doctype html><html><head><title>524: A timeout occurred</title></head><body><h1>A timeout occurred</h1><p>The origin web server timed out.</p></body></html>', {
      status: 524,
      headers: { 'Content-Type': 'text/html' },
    })

    const message = await getApiErrorMessage(response)
    expect(message).toContain('HTTP 524')
    expect(message).toContain('524: A timeout occurred')
    expect(message).toContain('The origin web server timed out.')
    expect(message).not.toContain('<!doctype html>')
  })

  it('redacts API keys and bearer tokens', () => {
    expect(redactApiErrorText('Bearer abc.def-123 sk-1234567890abcdef')).toBe('Bearer [REDACTED] sk-[REDACTED]')
  })
})
