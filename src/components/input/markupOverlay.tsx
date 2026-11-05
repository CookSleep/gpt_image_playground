import { useEffect, useState } from 'react'
import { ensureImageCached, getCachedImage } from '../../lib/imageCache'

/** 叠加在参考图缩略图上的 markup 标注层，与底图使用相同的裁切方式 */
export default function MarkupOverlay({ imageId }: { imageId: string }) {
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
  return <img src={src} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover" />
}
