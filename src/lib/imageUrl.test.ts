import { describe, expect, it } from 'vitest'
import { extractPastedImageUrl } from './imageUrl'

describe('extractPastedImageUrl', () => {
  it('识别带图片扩展名的 http(s) 链接', () => {
    expect(extractPastedImageUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(extractPastedImageUrl('  https://example.com/dir/b.JPEG  ')).toBe('https://example.com/dir/b.JPEG')
    expect(extractPastedImageUrl('http://example.com/c.webp')).toBe('http://example.com/c.webp')
  })

  it('识别带签名参数的图片链接（扩展名在 pathname 上）', () => {
    const url = 'https://cdn.example.com/img/task_x/0.png?e=1791988881&token=abc:def='
    expect(extractPastedImageUrl(url)).toBe(url)
  })

  it('对普通文本与普通网页链接返回 null', () => {
    expect(extractPastedImageUrl('这是一段中文提示词，不要被当成链接')).toBeNull()
    expect(extractPastedImageUrl('https://example.com/page')).toBeNull()
    expect(extractPastedImageUrl('https://example.com/no-extension/abc123')).toBeNull()
    expect(extractPastedImageUrl('https://example.com/a.png 后面还有文字')).toBeNull()
    expect(extractPastedImageUrl('ftp://example.com/a.png')).toBeNull()
    expect(extractPastedImageUrl('')).toBeNull()
    expect(extractPastedImageUrl('www.example.com/a.png')).toBeNull()
  })
})
