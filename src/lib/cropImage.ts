import { loadImage } from './canvasImage'

export type CropAspect = 'original' | 'square' | 'landscape' | 'portrait'

export async function cropImageDataUrl(source: string, aspect: CropAspect): Promise<string> {
  const image = await loadImage(source)
  const sourceRatio = image.naturalWidth / Math.max(1, image.naturalHeight)
  const targetRatio = aspect === 'square' ? 1 : aspect === 'landscape' ? 4 / 3 : aspect === 'portrait' ? 3 / 4 : sourceRatio
  const cropWidth = targetRatio > sourceRatio ? image.naturalWidth : Math.round(image.naturalHeight * targetRatio)
  const cropHeight = targetRatio > sourceRatio ? Math.round(image.naturalWidth / targetRatio) : image.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = cropWidth
  canvas.height = cropHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  const offsetX = Math.round((image.naturalWidth - cropWidth) / 2)
  const offsetY = Math.round((image.naturalHeight - cropHeight) / 2)
  ctx.drawImage(image, offsetX, offsetY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
  return canvas.toDataURL('image/png')
}
