import { fetchImageUrlAsDataUrl, isHttpUrl, normalizeBase64Image } from './imageApiShared'

export interface MarkdownImageSource {
  url: string
  markdown: string
}

export interface ResolvedMarkdownImages {
  images: Array<{ dataUrl: string; rawImageUrl?: string }>
  unresolvedImageUrls: string[]
}

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g

export function extractMarkdownImageSources(text: string): MarkdownImageSource[] {
  const images: MarkdownImageSource[] = []

  for (const match of text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const url = (match[1] ?? match[2] ?? '').trim()
    if (!/^data:image\/[\w.+-]+;base64,/i.test(url) && !isHttpUrl(url)) continue
    images.push({ url, markdown: match[0] })
  }

  return images
}

export function removeMarkdownImages(text: string): string {
  return text.replace(MARKDOWN_IMAGE_PATTERN, (markdown) => {
    const [source] = extractMarkdownImageSources(markdown)
    return source ? '' : markdown
  }).replace(/\n{3,}/g, '\n\n').trim()
}

export async function resolveMarkdownImages(text: string, fallbackMime: string, signal?: AbortSignal): Promise<ResolvedMarkdownImages> {
  const images: Array<{ dataUrl: string; rawImageUrl?: string }> = []
  const unresolvedImageUrls: string[] = []

  for (const source of extractMarkdownImageSources(text)) {
    if (/^data:image\/[\w.+-]+;base64,/i.test(source.url)) {
      images.push({ dataUrl: normalizeBase64Image(source.url, fallbackMime) })
      continue
    }

    try {
      images.push({
        dataUrl: await fetchImageUrlAsDataUrl(source.url, fallbackMime, signal),
        rawImageUrl: source.url,
      })
    } catch (err) {
      console.warn('Markdown 图片链接下载失败，已保留原始链接', err)
      unresolvedImageUrls.push(source.url)
    }
  }

  return { images, unresolvedImageUrls }
}
