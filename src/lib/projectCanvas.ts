import type { ProjectCanvasCrop, ProjectCanvasItem, ProjectCanvasOperator, ProjectCanvasState, ProjectCanvasViewport } from '../types'

export const PROJECT_CANVAS_VERSION = 1
export const DEFAULT_CANVAS_VIEWPORT: ProjectCanvasViewport = { x: 32, y: 32, scale: 1 }
export const DEFAULT_CANVAS_ITEM_WIDTH = 240
export const MIN_CANVAS_SCALE = 0.01
export const MAX_CANVAS_SCALE = 10

const ITEM_GAP = 32
const DEFAULT_COLUMNS = 4

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeFavoriteCollectionIds(value: unknown) {
  if (!Array.isArray(value)) return undefined
  return Array.from(new Set(value.filter((id): id is string => typeof id === 'string' && Boolean(id))))
}

function normalizeRotation(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const normalized = value % 360
  return normalized < 0 ? normalized + 360 : normalized
}

function normalizeCrop(value: unknown): ProjectCanvasCrop | undefined {
  if (!isRecord(value)) return undefined
  const x = Math.min(0.99, Math.max(0, finiteNumber(value.x, 0)))
  const y = Math.min(0.99, Math.max(0, finiteNumber(value.y, 0)))
  const width = Math.min(1 - x, Math.max(0.01, finiteNumber(value.width, 1)))
  const height = Math.min(1 - y, Math.max(0.01, finiteNumber(value.height, 1)))
  return { x, y, width, height }
}

function normalizeCanvasItemName(value: unknown) {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  return name || undefined
}

function normalizeOperator(value: unknown): ProjectCanvasOperator | undefined {
  if (!isRecord(value)) return undefined
  const originalWidth = finiteNumber(value.originalWidth, 0)
  const scale = finiteNumber(value.scale, 0)
  const rotation = normalizeRotation(value.rotation)
  const flipX = value.flipX === true
  const flipY = value.flipY === true
  const crop = normalizeCrop(value.crop)
  if (originalWidth <= 0 && scale <= 0 && rotation === undefined && !flipX && !flipY && !crop) return undefined
  return {
    ...(originalWidth > 0 ? { originalWidth } : {}),
    ...(scale > 0 ? { scale } : {}),
    ...(rotation !== undefined ? { rotation } : {}),
    ...(flipX ? { flipX: true } : {}),
    ...(flipY ? { flipY: true } : {}),
    ...(crop ? { crop } : {}),
  }
}

export function clampCanvasScale(scale: number) {
  return Math.min(MAX_CANVAS_SCALE, Math.max(MIN_CANVAS_SCALE, scale))
}

export function normalizeProjectCanvas(value: unknown): ProjectCanvasState | undefined {
  if (!isRecord(value)) return undefined
  const rawViewport = isRecord(value.viewport) ? value.viewport : {}
  const rawItems = isRecord(value.items) ? value.items : {}
  const items: Record<string, ProjectCanvasItem> = {}

  for (const [imageId, rawItem] of Object.entries(rawItems)) {
    if (!imageId || !isRecord(rawItem)) continue
    const width = Math.max(80, finiteNumber(rawItem.width, DEFAULT_CANVAS_ITEM_WIDTH))
    const rotation = normalizeRotation(rawItem.rotation)
    const name = normalizeCanvasItemName(rawItem.name)
    const operator = normalizeOperator(rawItem.operator)
    const effectiveRotation = rotation ?? operator?.rotation
    items[imageId] = {
      ...(name ? { name } : {}),
      x: finiteNumber(rawItem.x, 0),
      y: finiteNumber(rawItem.y, 0),
      width,
      z: Math.max(0, Math.floor(finiteNumber(rawItem.z, 0))),
      ...(effectiveRotation !== undefined ? { rotation: effectiveRotation } : {}),
      ...(operator ? { operator } : {}),
      ...(normalizeFavoriteCollectionIds(rawItem.favoriteCollectionIds) !== undefined
        ? { favoriteCollectionIds: normalizeFavoriteCollectionIds(rawItem.favoriteCollectionIds) }
        : {}),
    }
  }

  return {
    version: PROJECT_CANVAS_VERSION,
    viewport: {
      x: finiteNumber(rawViewport.x, DEFAULT_CANVAS_VIEWPORT.x),
      y: finiteNumber(rawViewport.y, DEFAULT_CANVAS_VIEWPORT.y),
      scale: clampCanvasScale(finiteNumber(rawViewport.scale, DEFAULT_CANVAS_VIEWPORT.scale)),
    },
    items,
  }
}

export function getDefaultCanvasItem(index: number, total = index + 1): ProjectCanvasItem {
  const columns = Math.min(DEFAULT_COLUMNS, Math.max(1, total))
  const rows = Math.ceil(total / columns)
  const row = Math.floor(index / columns)
  const column = index % columns
  const rowCount = Math.min(columns, Math.max(1, total - row * columns))
  const step = DEFAULT_CANVAS_ITEM_WIDTH + ITEM_GAP
  return {
    x: (column - (rowCount - 1) / 2) * step,
    y: (row - (rows - 1) / 2) * step,
    width: DEFAULT_CANVAS_ITEM_WIDTH,
    z: index,
  }
}

function rectanglesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  gap: number,
) {
  return a.x - gap < b.x + b.width && a.x + a.width + gap > b.x && a.y - gap < b.y + b.height && a.y + a.height + gap > b.y
}

export function findAvailableCanvasItemPosition(
  items: Record<string, Pick<ProjectCanvasItem, 'x' | 'y' | 'width'> & { height?: number }>,
  viewport: ProjectCanvasViewport,
  size: { width: number; height: number },
  item: { width: number; height: number },
  gap = ITEM_GAP,
) {
  const centerX = (size.width / 2 - viewport.x) / viewport.scale
  const centerY = (size.height / 2 - viewport.y) / viewport.scale
  const stepX = item.width + gap
  const stepY = item.height + gap
  const candidates: Array<[number, number]> = [[0, 0]]
  for (let radius = 1; radius <= 12; radius++) {
    candidates.push([0, -radius], [radius, 0], [0, radius], [-radius, 0])
    for (let offset = -radius; offset <= radius; offset++) {
      if (offset !== 0 && offset !== -radius && offset !== radius) candidates.push([offset, -radius], [offset, radius], [-radius, offset], [radius, offset])
    }
  }

  for (const [offsetX, offsetY] of candidates) {
    const candidate = {
      x: centerX - item.width / 2 + offsetX * stepX,
      y: centerY - item.height / 2 + offsetY * stepY,
      width: item.width,
      height: item.height,
    }
    const overlaps = Object.values(items).some((existing) => rectanglesOverlap(candidate, {
      x: existing.x,
      y: existing.y,
      width: existing.width,
      height: existing.height ?? existing.width,
    }, gap))
    if (!overlaps) return { x: candidate.x, y: candidate.y }
  }

  return {
    x: centerX - item.width / 2 + 13 * stepX,
    y: centerY - item.height / 2,
  }
}

export function ensureProjectCanvas(
  canvas: ProjectCanvasState | undefined,
  imageIds: string[],
  legacyFavoriteIdsByImage: Record<string, string[]> = {},
  zByImage: Record<string, number> = {},
  extraItemIds: string[] = [],
): ProjectCanvasState {
  const normalized = normalizeProjectCanvas(canvas) ?? {
    version: PROJECT_CANVAS_VERSION,
    viewport: { ...DEFAULT_CANVAS_VIEWPORT },
    items: {},
  }
  const ids = Array.from(new Set(imageIds.filter(Boolean)))
  const items: Record<string, ProjectCanvasItem> = {}
  const usedNames = new Set<string>()

  for (let index = 0; index < ids.length; index++) {
    const imageId = ids[index]
    const existing = normalized.items[imageId]
    const existingName = normalizeCanvasItemName(existing?.name)
    let name = existingName ?? `图片 ${index + 1}`
    let suffix = index + 1
    while (usedNames.has(name)) {
      suffix += 1
      name = `图片 ${suffix}`
    }
    usedNames.add(name)
    const favoriteCollectionIds = existing?.favoriteCollectionIds ?? normalizeFavoriteCollectionIds(legacyFavoriteIdsByImage[imageId])
    items[imageId] = {
      ...(existing ?? getDefaultCanvasItem(index, ids.length)),
      name,
      ...(Number.isFinite(zByImage[imageId]) ? { z: zByImage[imageId] } : {}),
      ...(favoriteCollectionIds !== undefined ? { favoriteCollectionIds } : {}),
    }
  }

  for (const itemId of extraItemIds) {
    if (items[itemId] || !normalized.items[itemId]) continue
    items[itemId] = normalized.items[itemId]
  }

  return { ...normalized, version: PROJECT_CANVAS_VERSION, items }
}

export function removeCanvasFavoriteCollection(
  canvas: ProjectCanvasState,
  collectionId: string,
  validCollectionIds: Set<string>,
  deleteImages: boolean,
) {
  const items: Record<string, ProjectCanvasItem> = {}
  const imageIdsToDelete: string[] = []

  for (const [imageId, item] of Object.entries(canvas.items)) {
    const currentIds = item.favoriteCollectionIds ?? []
    const belongsToCollection = currentIds.includes(collectionId)
    const favoriteCollectionIds = currentIds.filter((id) => id !== collectionId && validCollectionIds.has(id))
    if (belongsToCollection && deleteImages && favoriteCollectionIds.length === 0) {
      imageIdsToDelete.push(imageId)
    }
    items[imageId] = { ...item, favoriteCollectionIds }
  }

  return {
    canvas: { ...canvas, items },
    imageIdsToDelete,
  }
}

export function zoomCanvasViewport(
  viewport: ProjectCanvasViewport,
  point: { x: number; y: number },
  nextScale: number,
): ProjectCanvasViewport {
  const scale = clampCanvasScale(nextScale)
  const worldX = (point.x - viewport.x) / viewport.scale
  const worldY = (point.y - viewport.y) / viewport.scale
  return {
    x: point.x - worldX * scale,
    y: point.y - worldY * scale,
    scale,
  }
}

export function isCanvasRectVisible(
  item: Pick<ProjectCanvasItem, 'x' | 'y' | 'width'>,
  height: number,
  viewport: ProjectCanvasViewport,
  size: { width: number; height: number },
  overscan = 320,
) {
  const left = item.x * viewport.scale + viewport.x
  const top = item.y * viewport.scale + viewport.y
  const right = left + item.width * viewport.scale
  const bottom = top + height * viewport.scale
  return right >= -overscan && bottom >= -overscan && left <= size.width + overscan && top <= size.height + overscan
}
