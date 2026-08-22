import type { TaskParams } from '../types'
import { loadImage } from './canvasImage'

export const GREEN_KEY_COLOR = '#00FF00'
export const MAGENTA_KEY_COLOR = '#FF00FF'

export interface TransparentOutputMeta {
  transparentOutput: true
  effectivePrompt: string
}

const KEY_COLOR_RGB = {
  [GREEN_KEY_COLOR]: { r: 0, g: 255, b: 0 },
  [MAGENTA_KEY_COLOR]: { r: 255, g: 0, b: 255 },
} as const

const TRANSPARENT_PROMPT_TEMPLATE = [
  '[背景指令]',
  '背景色选择规则：如果主体包含绿色系（绿、青绿、黄绿、草绿等）颜色，使用纯洋红色(#FF00FF)背景；否则一律使用纯绿色(#00FF00)背景。',
  '背景要求：整张画布仅由所选纯色填充，无任何渐变、纹理、阴影、光照变化、地面或环境元素。',
  '主体要求：单主体、完整呈现、轮廓清晰锐利。主体与背景之间保持干净的边缘分离，不要有颜色溢出或混合。',
  '禁止：主体本身、描边、光晕、投影或反射中不能出现所选背景色。',
].join('\n')

export function buildTransparentPrompt(prompt: string) {
  return `${prompt.trim()}\n\n${TRANSPARENT_PROMPT_TEMPLATE}`
}

export function getTransparentRequestParams(params: TaskParams): TaskParams {
  return {
    ...params,
    output_format: params.output_format === 'webp' ? 'webp' : 'png',
    output_compression: params.output_format === 'webp' ? params.output_compression : null,
    transparent_output: true,
  }
}

export function createTransparentOutputMeta(prompt: string): TransparentOutputMeta {
  return {
    transparentOutput: true,
    effectivePrompt: buildTransparentPrompt(prompt),
  }
}

export async function removeKeyedBackgroundFromDataUrl(
  dataUrl: string,
  keyColor?: string,
  outputFormat: 'png' | 'webp' = 'png',
  outputCompression?: number | null,
): Promise<string> {
  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('当前浏览器不支持 Canvas，无法执行透明背景后处理')

  ctx.drawImage(image, 0, 0)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const effectiveKeyColor = keyColor || detectKeyColorFromPixels(pixels.data, canvas.width, canvas.height)
  removeKeyedBackgroundFromPixels(pixels.data, canvas.width, canvas.height, effectiveKeyColor)
  ctx.putImageData(pixels, 0, 0)
  const quality = outputFormat === 'webp' && outputCompression != null
    ? Math.max(0, Math.min(1, 1 - outputCompression / 100))
    : undefined
  return canvas.toDataURL(`image/${outputFormat}`, quality)
}

export function detectKeyColorFromPixels(data: Uint8ClampedArray, width: number, height: number): string {
  // Sample border pixels (top/bottom rows, left/right columns)
  const borderIndices: number[] = []
  for (let x = 0; x < width; x += 1) {
    borderIndices.push(x) // top row
    borderIndices.push((height - 1) * width + x) // bottom row
  }
  for (let y = 1; y < height - 1; y += 1) {
    borderIndices.push(y * width) // left column
    borderIndices.push(y * width + width - 1) // right column
  }

  let greenScore = 0
  let magentaScore = 0
  const greenRgb = KEY_COLOR_RGB[GREEN_KEY_COLOR]
  const magentaRgb = KEY_COLOR_RGB[MAGENTA_KEY_COLOR]

  for (const index of borderIndices) {
    const offset = index * 4
    const r = data[offset]
    const g = data[offset + 1]
    const b = data[offset + 2]

    const greenDist = Math.sqrt((r - greenRgb.r) ** 2 + (g - greenRgb.g) ** 2 + (b - greenRgb.b) ** 2)
    const magentaDist = Math.sqrt((r - magentaRgb.r) ** 2 + (g - magentaRgb.g) ** 2 + (b - magentaRgb.b) ** 2)

    if (greenDist < 100) greenScore += 1
    if (magentaDist < 100) magentaScore += 1
  }

  return magentaScore > greenScore ? MAGENTA_KEY_COLOR : GREEN_KEY_COLOR
}

export function removeKeyedBackgroundFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keyColor: string,
) {
  if (data.length < width * height * 4) throw new Error('透明背景像素数据尺寸不匹配')
  const keyRgb = getKeyColorRgb(keyColor)
  const mask = buildBackgroundMask(data, width, height, keyRgb)
  writeTransparentPixels(data, mask, width, height, keyRgb)
  return data
}

function buildBackgroundMask(data: Uint8ClampedArray, width: number, height: number, keyRgb: Rgb) {
  const mask = buildConnectedBackgroundMask(data, width, height, keyRgb)
  addInteriorKeyColorIslands(data, width, height, keyRgb, mask)
  return mask
}

function buildConnectedBackgroundMask(data: Uint8ClampedArray, width: number, height: number, keyRgb: Rgb) {
  const pixelCount = width * height
  const mask = new Uint8Array(pixelCount)
  const visited = new Uint8Array(pixelCount)
  const queue = new Uint32Array(pixelCount)
  let queueStart = 0
  let queueEnd = 0

  const enqueue = (index: number) => {
    if (visited[index]) return
    visited[index] = 1
    if (getBackgroundConfidence(data, index, keyRgb) < 0.18) return
    mask[index] = 1
    queue[queueEnd] = index
    queueEnd += 1
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x)
    enqueue((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width)
    enqueue(y * width + width - 1)
  }

  while (queueStart < queueEnd) {
    const index = queue[queueStart]
    queueStart += 1
    const x = index % width
    const y = Math.floor(index / width)
    if (x > 0) enqueue(index - 1)
    if (x < width - 1) enqueue(index + 1)
    if (y > 0) enqueue(index - width)
    if (y < height - 1) enqueue(index + width)
  }

  return mask
}

function addInteriorKeyColorIslands(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keyRgb: Rgb,
  mask: Uint8Array,
) {
  const pixelCount = width * height
  const visited = new Uint8Array(pixelCount)
  const queue = new Uint32Array(pixelCount)
  const component = new Uint32Array(pixelCount)

  for (let seed = 0; seed < pixelCount; seed += 1) {
    if (mask[seed] || visited[seed]) continue
    if (getBackgroundConfidence(data, seed, keyRgb) < 0.68) continue

    let queueStart = 0
    let queueEnd = 0
    let componentLength = 0
    let confidenceSum = 0
    let strictCount = 0
    let strongCount = 0

    visited[seed] = 1
    queue[queueEnd] = seed
    queueEnd += 1

    const enqueueNeighbor = (neighborIndex: number) => {
      if (neighborIndex < 0 || mask[neighborIndex] || visited[neighborIndex]) return
      if (getBackgroundConfidence(data, neighborIndex, keyRgb) < 0.24) return
      visited[neighborIndex] = 1
      queue[queueEnd] = neighborIndex
      queueEnd += 1
    }

    while (queueStart < queueEnd) {
      const index = queue[queueStart]
      queueStart += 1
      const confidence = getBackgroundConfidence(data, index, keyRgb)
      component[componentLength] = index
      componentLength += 1
      confidenceSum += confidence
      if (confidence >= 0.68) strictCount += 1
      if (confidence >= 0.86) strongCount += 1

      const x = index % width
      const y = Math.floor(index / width)
      enqueueNeighbor(x > 0 ? index - 1 : -1)
      enqueueNeighbor(x < width - 1 ? index + 1 : -1)
      enqueueNeighbor(y > 0 ? index - width : -1)
      enqueueNeighbor(y < height - 1 ? index + width : -1)
    }

    const averageConfidence = confidenceSum / componentLength
    const strictRatio = strictCount / componentLength
    const strongRatio = strongCount / componentLength
    const shouldRemove =
      averageConfidence >= 0.42 ||
      strictRatio >= 0.18 ||
      strongRatio >= 0.05 ||
      (componentLength <= 3 && averageConfidence >= 0.34)

    if (shouldRemove) {
      for (let i = 0; i < componentLength; i += 1) {
        mask[component[i]] = 1
      }
    }
  }
}

function writeTransparentPixels(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  keyRgb: Rgb,
) {
  const distanceToBackground = computeDistanceToBackground(mask, width, height, 4)
  const pixelCount = width * height

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4
    const red = data[offset]
    const green = data[offset + 1]
    const blue = data[offset + 2]
    const confidence = getBackgroundConfidence(data, index, keyRgb)
    let alpha = 255

    if (mask[index]) {
      alpha = 0
    } else {
      const distance = distanceToBackground[index]
      if (distance > 0) {
        const transparency = getEdgeTransparency(red, green, blue, confidence, distance, keyRgb)
        if (transparency > 0) alpha = Math.round(255 * (1 - transparency))
        alpha = Math.max(alpha, distance === 1 ? 48 : distance === 2 ? 128 : 196)
      } else {
        const isolatedSpill = getKeyChannelMix(red, green, blue, keyRgb)
        if (confidence >= 0.46 && isolatedSpill >= 0.45) {
          alpha = Math.round(255 * (1 - isolatedSpill * 0.75))
          alpha = Math.max(alpha, 96)
        }
      }
    }

    const cleaned = removeColorSpill(
      red,
      green,
      blue,
      alpha,
      keyRgb,
      confidence,
      distanceToBackground[index],
    )
    data[offset] = cleaned.r
    data[offset + 1] = cleaned.g
    data[offset + 2] = cleaned.b
    data[offset + 3] = alpha
  }
}

function computeDistanceToBackground(mask: Uint8Array, width: number, height: number, maxDistance: number) {
  const pixelCount = width * height
  const distance = new Uint8Array(pixelCount)
  let frontier: number[] = []

  for (let index = 0; index < pixelCount; index += 1) {
    if (mask[index]) continue
    const x = index % width
    const y = Math.floor(index / width)
    const touchesBackground =
      (x > 0 && mask[index - 1]) ||
      (x < width - 1 && mask[index + 1]) ||
      (y > 0 && mask[index - width]) ||
      (y < height - 1 && mask[index + width])

    if (touchesBackground) {
      distance[index] = 1
      frontier.push(index)
    }
  }

  for (let currentDistance = 1; currentDistance < maxDistance; currentDistance += 1) {
    const nextFrontier: number[] = []
    for (const index of frontier) {
      const x = index % width
      const y = Math.floor(index / width)
      addDistanceNeighbor(distance, mask, nextFrontier, x > 0 ? index - 1 : -1, currentDistance)
      addDistanceNeighbor(distance, mask, nextFrontier, x < width - 1 ? index + 1 : -1, currentDistance)
      addDistanceNeighbor(distance, mask, nextFrontier, y > 0 ? index - width : -1, currentDistance)
      addDistanceNeighbor(distance, mask, nextFrontier, y < height - 1 ? index + width : -1, currentDistance)
    }
    frontier = nextFrontier
    if (!frontier.length) break
  }

  return distance
}

function addDistanceNeighbor(
  distance: Uint8Array,
  mask: Uint8Array,
  nextFrontier: number[],
  neighborIndex: number,
  currentDistance: number,
) {
  if (neighborIndex < 0 || mask[neighborIndex] || distance[neighborIndex] !== 0) return
  distance[neighborIndex] = currentDistance + 1
  nextFrontier.push(neighborIndex)
}

function getBackgroundConfidence(data: Uint8ClampedArray, index: number, keyRgb: Rgb) {
  const offset = index * 4
  const colorDistance = Math.sqrt(
    (data[offset] - keyRgb.r) ** 2 +
    (data[offset + 1] - keyRgb.g) ** 2 +
    (data[offset + 2] - keyRgb.b) ** 2,
  )
  return clamp01((150 - colorDistance) / 150)
}

function getEdgeTransparency(
  red: number,
  green: number,
  blue: number,
  confidence: number,
  distance: number,
  keyRgb: Rgb,
) {
  const edgeStrength = distance <= 1 ? 1 : distance === 2 ? 0.75 : distance === 3 ? 0.45 : 0.25
  const distanceEstimate = clamp01(((confidence - 0.08) / 0.84) * edgeStrength)
  const channelEstimate = getKeyChannelMix(red, green, blue, keyRgb) * edgeStrength
  return clamp01(Math.max(distanceEstimate, channelEstimate))
}

function getKeyChannelMix(red: number, green: number, blue: number, keyRgb: Rgb) {
  if (keyRgb.g === 255) return clamp01((green - Math.min(red, blue)) / 255)
  return clamp01((Math.min(red, blue) - green * 0.65) / 255)
}

function removeColorSpill(
  red: number,
  green: number,
  blue: number,
  alpha: number,
  keyRgb: Rgb,
  confidence: number,
  distanceToBackground: number,
): Rgb {
  if (alpha === 0) return { r: red, g: green, b: blue }

  const edgeStrength = distanceToBackground <= 0
    ? confidence >= 0.46 ? 0.35 : 0
    : distanceToBackground === 1
      ? 0.55
      : distanceToBackground === 2
        ? 0.32
        : 0.16
  const spillMix = getKeyChannelMix(red, green, blue, keyRgb) * edgeStrength
  const backgroundMix = clamp01(Math.max((255 - alpha) / 255, ((confidence - 0.1) / 0.9) * edgeStrength, spillMix))
  if (backgroundMix <= 0) return { r: red, g: green, b: blue }

  const foregroundMix = Math.max(0.08, 1 - backgroundMix)
  return {
    r: clampByte((red - keyRgb.r * backgroundMix) / foregroundMix),
    g: clampByte((green - keyRgb.g * backgroundMix) / foregroundMix),
    b: clampByte((blue - keyRgb.b * backgroundMix) / foregroundMix),
  }
}

function getKeyColorRgb(keyColor: string): Rgb {
  const rgb = KEY_COLOR_RGB[keyColor.toUpperCase() as keyof typeof KEY_COLOR_RGB]
  if (!rgb) throw new Error('透明背景键色不支持')
  return rgb
}

interface Rgb {
  r: number
  g: number
  b: number
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)))
}
