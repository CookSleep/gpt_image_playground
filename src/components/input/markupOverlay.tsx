import { useEffect, useState } from 'react'
import { ensureImageCached, getCachedImage } from '../../lib/imageCache'

/** 叠加在参考图上的 markup 标注层；className 需与底图使用相同的裁切方式和圆角 */
export default function MarkupOverlay({ imageId, className = 'object-cover' }: { imageId: string, className?: string }) {
  const [src, setSrc] = useState(() => getCachedImage(imageId))

  useEffect(() => {
    let cancelled = false
    setSrc(getCachedImage(imageId))
    void ensureImageCached(imageId).then((dataUrl) => {
      if (!cancelled) setSrc(dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [imageId])

  if (!src) return null
  return <img src={src} alt="" className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} />
}
