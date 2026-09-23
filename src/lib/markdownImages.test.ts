import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractMarkdownImageSources, removeMarkdownImages, resolveMarkdownImages } from './markdownImages'

describe('markdownImages', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('extracts only supported images among surrounding rich Markdown content', () => {
    const text = [
      '# 生成结果',
      '',
      '这是 **加粗**、*斜体* 和 [说明链接](https://docs.example.com) 前的文字。',
      '',
      '![任意名称](data:image/jpeg;base64,aW1hZ2U=)',
      '',
      '- 列表中的 `inline code` 与 [普通链接](https://example.com/page) 必须保留。',
      '- ![另一个](<https://example.com/image.png> "标题")',
      '',
      '```text',
      '![代码块内容](data:image/png;base64,should-not-be-special)',
      '```',
      '',
      '尾部 `![行内示例](data:image/webp;base64,example)` 和 ![忽略](javascript:alert(1)) 也必须保留。',
    ].join('\n')

    expect(extractMarkdownImageSources(text)).toEqual([
      {
        url: 'data:image/jpeg;base64,aW1hZ2U=',
        markdown: '![任意名称](data:image/jpeg;base64,aW1hZ2U=)',
      },
      {
        url: 'https://example.com/image.png',
        markdown: '![另一个](<https://example.com/image.png> "标题")',
      },
    ])
    expect(removeMarkdownImages(text)).toBe([
      '# 生成结果',
      '',
      '这是 **加粗**、*斜体* 和 [说明链接](https://docs.example.com) 前的文字。',
      '',
      '- 列表中的 `inline code` 与 [普通链接](https://example.com/page) 必须保留。',
      '-',
      '',
      '```text',
      '![代码块内容](data:image/png;base64,should-not-be-special)',
      '```',
      '',
      '尾部 `![行内示例](data:image/webp;base64,example)` 和 ![忽略](javascript:alert(1)) 也必须保留。',
    ].join('\n'))
  })

  it('keeps an unreachable remote image URL while returning other resolved images', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(resolveMarkdownImages([
      '![Base64](data:image/png;base64,aW1hZ2U=)',
      '![远程图](https://example.com/image.png)',
    ].join('\n'), 'image/jpeg')).resolves.toEqual({
      images: [{ dataUrl: 'data:image/png;base64,aW1hZ2U=' }],
      unresolvedImageUrls: ['https://example.com/image.png'],
    })
  })

  it('downloads remote Markdown images as local data URLs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/webp' },
    }))

    await expect(resolveMarkdownImages('![远程图](https://example.com/image.webp)', 'image/png')).resolves.toEqual({
      images: [{
        dataUrl: 'data:image/webp;base64,AQID',
        rawImageUrl: 'https://example.com/image.webp',
      }],
      unresolvedImageUrls: [],
    })
  })
})
