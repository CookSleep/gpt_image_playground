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

export async function copyBlobToClipboard(blob: Blob) {
  const mimeType = normalizeImageMimeType(blob.type)

  if (window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    await navigator.clipboard.write([
      new ClipboardItem({ [mimeType]: blob }, { presentationStyle: 'inline' }),
    ])
    return
  }

  if (await copyBlobWithExecCommand(blob, mimeType)) return

  throw new Error('当前页面不是安全上下文，无法直接复制图片，请改用 HTTPS 或 localhost 访问后重试')
}

export function getClipboardFailureMessage(fallback: string, err: unknown) {
  if (!window.isSecureContext) {
    return '复制失败：当前页面不是安全上下文，请改用 HTTPS 或 localhost 访问后重试'
  }

  if (isEmbeddedPage() && isClipboardPermissionError(err)) {
    return '复制失败：内嵌页面未授予剪贴板权限'
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

async function copyBlobWithExecCommand(blob: Blob, mimeType: string) {
  const objectUrl = URL.createObjectURL(blob)
  const host = document.createElement('div')
  const image = document.createElement('img')
  const selection = window.getSelection()
  const fileName = `image-${Date.now()}.${getImageFileExtension(mimeType)}`
  const file = new File([blob], fileName, { type: mimeType })

  host.contentEditable = 'true'
  host.setAttribute('aria-hidden', 'true')
  host.style.position = 'fixed'
  host.style.left = '-9999px'
  host.style.top = '0'
  host.style.width = '1px'
  host.style.height = '1px'
  host.style.overflow = 'hidden'
  host.style.opacity = '0'

  image.src = objectUrl
  image.alt = ''
  image.draggable = false

  host.appendChild(image)
  document.body.appendChild(host)

  const onCopy = (event: ClipboardEvent) => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    try {
      clipboardData.items.add(file)
    } catch {
      clipboardData.setData('text/html', `<img src="${objectUrl}" alt="">`)
      clipboardData.setData('text/plain', objectUrl)
    }

    event.preventDefault()
  }

  try {
    document.addEventListener('copy', onCopy)
    const range = document.createRange()
    range.selectNode(image)
    selection?.removeAllRanges()
    selection?.addRange(range)
    host.focus()

    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.removeEventListener('copy', onCopy)
    selection?.removeAllRanges()
    document.body.removeChild(host)
    URL.revokeObjectURL(objectUrl)
  }
}

function normalizeImageMimeType(mimeType: string) {
  if (mimeType) return mimeType
  return 'image/png'
}

function getImageFileExtension(mimeType: string) {
  const type = mimeType.toLowerCase()
  if (type === 'image/jpeg') return 'jpg'
  if (type === 'image/webp') return 'webp'
  if (type === 'image/gif') return 'gif'
  if (type === 'image/bmp') return 'bmp'
  if (type === 'image/svg+xml') return 'svg'
  return 'png'
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
