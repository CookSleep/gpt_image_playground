export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface ViewTransform {
  scale: number
  x: number
  y: number
}

export interface ClientRectLike {
  left: number
  top: number
  width: number
  height: number
}

const MIN_SCALE = 1
const MAX_SCALE = 6

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function clampViewTransform(transform: ViewTransform, viewportSize: Size): ViewTransform {
  const scale = clamp(transform.scale, MIN_SCALE, MAX_SCALE)

  if (scale === MIN_SCALE) {
    return { scale, x: 0, y: 0 }
  }

  return {
    scale,
    x: clamp(transform.x, viewportSize.width * (1 - scale), 0),
    y: clamp(transform.y, viewportSize.height * (1 - scale), 0),
  }
}

export function zoomAtPoint(
  transform: ViewTransform,
  point: Point,
  nextScale: number,
  viewportSize: Size,
): ViewTransform {
  const localPoint = {
    x: (point.x - transform.x) / transform.scale,
    y: (point.y - transform.y) / transform.scale,
  }
  const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE)

  return clampViewTransform({
    scale,
    x: point.x - localPoint.x * scale,
    y: point.y - localPoint.y * scale,
  }, viewportSize)
}

export function getPinchTransform(input: {
  startTransform: ViewTransform
  startCentroid: Point
  nextCentroid: Point
  startDistance: number
  nextDistance: number
  viewportSize: Size
}): ViewTransform {
  const localPoint = {
    x: (input.startCentroid.x - input.startTransform.x) / input.startTransform.scale,
    y: (input.startCentroid.y - input.startTransform.y) / input.startTransform.scale,
  }
  const distanceRatio = input.startDistance > 0 ? input.nextDistance / input.startDistance : 1
  const scale = clamp(input.startTransform.scale * distanceRatio, MIN_SCALE, MAX_SCALE)

  return clampViewTransform({
    scale,
    x: input.nextCentroid.x - localPoint.x * scale,
    y: input.nextCentroid.y - localPoint.y * scale,
  }, input.viewportSize)
}

export function clientPointToCanvasPoint(rect: ClientRectLike, point: Point, canvasSize: Size): Point {
  return {
    x: ((point.x - rect.left) / rect.width) * canvasSize.width,
    y: ((point.y - rect.top) / rect.height) * canvasSize.height,
  }
}

export function getComfortableInitialTransform(
  imageViewportSize: Size,
  editorViewportSize: Size,
  isCompactLayout: boolean,
): ViewTransform {
  if (!isCompactLayout || imageViewportSize.width <= 0 || imageViewportSize.height <= 0) {
    return { scale: MIN_SCALE, x: 0, y: 0 }
  }

  const targetHeight = editorViewportSize.height * 0.42
  const scale = clamp(targetHeight / imageViewportSize.height, MIN_SCALE, 3)
  return zoomAtPoint(
    { scale: MIN_SCALE, x: 0, y: 0 },
    { x: imageViewportSize.width / 2, y: imageViewportSize.height / 2 },
    scale,
    imageViewportSize,
  )
}
