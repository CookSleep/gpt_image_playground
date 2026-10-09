/**
 * 判断粘贴的文本是否为单条图片链接。
 * 返回原链接，供「以链接添加参考图」使用；不是图片链接时返回 null。
 */
export function extractPastedImageUrl(text: string): string | null {
  const value = text.trim()
  if (!/^https?:\/\/\S+$/i.test(value)) return null

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }

  return /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(parsed.pathname) ? value : null
}
