import type { InputImage } from '../types'
import { composeMarkupDataUrl, toApiInputImageDataUrl } from './canvasImage'
import { storeImage } from './db'
import { cacheImage, ensureImageCached } from './imageCache'

/**
 * 保存提交用的参考图：标注合成进图片后再保存。
 * 接口只接受第一张图的 markup，keepFirstMarkup 时第一张保留标注层随请求发送。
 */
export async function persistTaskInputImages(images: InputImage[], keepFirstMarkup: boolean): Promise<InputImage[]> {
  const result: InputImage[] = []
  for (const [idx, img] of images.entries()) {
    if (!img.markupImageId || (keepFirstMarkup && idx === 0)) {
      await storeImage(img.dataUrl)
      result.push(img)
      continue
    }
    const markupDataUrl = await ensureImageCached(img.markupImageId)
    if (!markupDataUrl) throw new Error(`图${idx + 1}的标注已不存在，请重新绘制`)
    const dataUrl = await composeMarkupDataUrl(img.dataUrl, markupDataUrl)
    const id = await storeImage(dataUrl)
    cacheImage(id, dataUrl)
    result.push({ id, dataUrl })
  }
  return result
}

/** 已保存的图片加入参考图框：图像接口不接受 SVG 和 GIF，加入时就转成 PNG（GIF 取第一帧）另存 */
export async function toReferenceImage(id: string, dataUrl: string): Promise<InputImage> {
  const converted = await toApiInputImageDataUrl(dataUrl)
  if (converted === dataUrl) return { id, dataUrl }
  const convertedId = await storeImage(converted, 'upload')
  cacheImage(convertedId, converted)
  return { id: convertedId, dataUrl: converted }
}
