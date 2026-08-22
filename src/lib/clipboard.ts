export async function copyTextToClipboard(text: string) {
  let asyncClipboardError: unknown = null

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch (err) {
      asyncClipboardError = err
    }
  }

  if (copyTextWithExecCommand(text)) return

  throw asyncClipboardError ?? new Error('Clipboard API is not available')
}

export async function copyImageSourceToClipboard(src: string | Promise<string | undefined>) {
  if (!canCopyImageToClipboard()) {
    throw new Error('Clipboard image API is not available')
  }

  const resolvedSrc = await Promise.resolve(src)
  if (!resolvedSrc) throw new Error('Image source is not available')
  const res = await fetch(resolvedSrc)
  const blob = await res.blob()
  await writeImageBlobToClipboard(blob)
}

export function canCopyImageToClipboard() {
  return window.isSecureContext && Boolean(navigator.clipboard?.write) && typeof ClipboardItem !== 'undefined'
}

export function getClipboardFailureMessage(fallback: string, err: unknown) {
  if (isEmbeddedPage() && isClipboardPermissionError(err)) {
    return '复制失败：内嵌页面未授予剪贴板权限'
  }

  if (err instanceof Error && err.message.startsWith('当前浏览器不支持')) {
    return `复制失败：${err.message}`
  }

  return fallback
}

function copyTextWithExecCommand(text: string) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'

  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}

async function writeImageBlobToClipboard(blob: Blob) {
  if (!blob.type.startsWith('image/')) throw new Error('Clipboard item is not an image')

  const clipboardItems: Record<string, Blob | Promise<Blob>> = {}
  const customType = `web ${blob.type}`

  if (isClipboardTypeSupported(customType)) {
    clipboardItems[customType] = blob
  }

  if (blob.type === 'image/png') {
    clipboardItems['image/png'] = blob
  } else if (isClipboardTypeSupported('image/png')) {
    clipboardItems['image/png'] = imageBlobToPngBlob(blob)
  }

  if (Object.keys(clipboardItems).length === 0) {
    throw new Error('当前浏览器不支持图像剪贴板写入')
  }

  await navigator.clipboard.write([
    new ClipboardItem(clipboardItems),
  ])
}

function isClipboardTypeSupported(type: string) {
  const supports = (ClipboardItem as typeof ClipboardItem & { supports?: (type: string) => boolean }).supports
  return supports ? supports(type) : type === 'image/png'
}

async function imageBlobToPngBlob(blob: Blob): Promise<Blob> {
  const image = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas is not available')
    ctx.drawImage(image, 0, 0)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob)
        else reject(new Error('Image conversion failed'))
      }, 'image/png')
    })
  } finally {
    image.close()
  }
}

function isEmbeddedPage() {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

function isClipboardPermissionError(err: unknown) {
  if (!(err instanceof Error)) return false

  return (
    err.name === 'NotAllowedError' ||
    /permission|permissions policy|not allowed|denied/i.test(err.message)
  )
}
