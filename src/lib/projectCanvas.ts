import type { ProjectCanvasItem, ProjectCanvasState, ProjectCanvasViewport } from '../types'

export const PROJECT_CANVAS_VERSION = 1
export const DEFAULT_CANVAS_VIEWPORT: ProjectCanvasViewport = { x: 32, y: 32, scale: 1 }
export const DEFAULT_CANVAS_ITEM_WIDTH = 240
export const MIN_CANVAS_SCALE = 0.2
export const MAX_CANVAS_SCALE = 4

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

function normalizeCanvasItemName(value: unknown) {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  return name || undefined
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
    items[imageId] = {
      ...(name ? { name } : {}),
      x: finiteNumber(rawItem.x, 0),
      y: finiteNumber(rawItem.y, 0),
      width,
      z: Math.max(0, Math.floor(finiteNumber(rawItem.z, 0))),
      ...(rotation !== undefined ? { rotation } : {}),
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

export function ensureProjectCanvas(
  canvas: ProjectCanvasState | undefined,
  imageIds: string[],
  legacyFavoriteIdsByImage: Record<string, string[]> = {},
  zByImage: Record<string, number> = {},
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
