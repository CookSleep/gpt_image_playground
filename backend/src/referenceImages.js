export const MAX_REFERENCE_IMAGES = 16
export const MAX_REFERENCE_IMAGE_BYTES = 4 * 1024 * 1024

function dataUrlByteLength(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('参考图格式不合法')

  if (match[2]) {
    const payload = match[3]
    if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
      throw new Error('参考图格式不合法')
    }
    return Buffer.from(payload, 'base64').length
  }

  try {
    return Buffer.byteLength(decodeURIComponent(match[3]))
  } catch {
    throw new Error('参考图格式不合法')
  }
}

export function validateReferenceImages(value) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('参考图格式不合法')
  if (value.length > MAX_REFERENCE_IMAGES) throw new Error(`参考图最多 ${MAX_REFERENCE_IMAGES} 张`)

  value.forEach((dataUrl) => {
    if (typeof dataUrl !== 'string') throw new Error('参考图格式不合法')
    if (dataUrlByteLength(dataUrl) > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error('参考图单张不能超过 4MB')
    }
  })
  return value
}
