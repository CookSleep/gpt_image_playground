import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CANVAS_ITEM_WIDTH,
  ensureProjectCanvas,
  findAvailableCanvasItemPosition,
  isCanvasRectVisible,
  normalizeProjectCanvas,
  removeCanvasFavoriteCollection,
  zoomCanvasViewport,
} from './projectCanvas'

describe('project canvas helpers', () => {
  it('normalizes malformed persisted canvas values', () => {
    expect(normalizeProjectCanvas({
      viewport: { x: 'bad', y: 12, scale: 99 },
      items: {
        imageA: { x: 5, y: 8, width: -1, z: 2.8, favoriteCollectionIds: ['a', 'a', ''] },
        invalid: null,
      },
    })).toEqual({
      version: 1,
      viewport: { x: 32, y: 12, scale: 10 },
      items: {
        imageA: { x: 5, y: 8, width: 80, z: 2, favoriteCollectionIds: ['a'] },
      },
    })
  })

  it('restores rotation stored in the image operator', () => {
    expect(normalizeProjectCanvas({ items: { imageA: { x: 0, y: 0, width: 240, z: 0, operator: { originalWidth: 1024, scale: 0.5, rotation: -45 } } } })).toEqual({
      version: 1,
      viewport: { x: 32, y: 32, scale: 1 },
      items: {
        imageA: {
          x: 0,
          y: 0,
          width: 240,
          z: 0,
          rotation: 315,
          operator: { originalWidth: 1024, scale: 0.5, rotation: 315 },
        },
      },
    })
  })

  it('normalizes crop data stored in the image operator', () => {
    expect(normalizeProjectCanvas({ items: { imageA: { x: 0, y: 0, width: 240, z: 0, operator: { crop: { x: -0.2, y: 0.25, width: 2, height: 0.5 } } } } })).toEqual({
      version: 1,
      viewport: { x: 32, y: 32, scale: 1 },
      items: {
        imageA: {
          x: 0,
          y: 0,
          width: 240,
          z: 0,
          operator: { crop: { x: 0, y: 0.25, width: 1, height: 0.5 } },
        },
      },
    })
  })

  it('keeps known positions, adds deterministic positions, and drops stale items', () => {
    const canvas = ensureProjectCanvas({
      version: 1,
      viewport: { x: 10, y: 20, scale: 1 },
      items: {
        imageA: { x: 100, y: 120, width: 300, z: 4 },
        stale: { x: 0, y: 0, width: 200, z: 0 },
      },
    }, ['imageA', 'imageB'], { imageB: ['favorites'] })

    expect(canvas.items.imageA).toEqual({ name: '图片 1', x: 100, y: 120, width: 300, z: 4 })
    expect(canvas.items.imageB?.x).toBe((DEFAULT_CANVAS_ITEM_WIDTH + 32) / 2)
    expect(canvas.items.imageB).toEqual({
      name: '图片 2',
      x: (DEFAULT_CANVAS_ITEM_WIDTH + 32) / 2,
      y: 0,
      width: DEFAULT_CANVAS_ITEM_WIDTH,
      z: 1,
      favoriteCollectionIds: ['favorites'],
    })
    expect(canvas.items.stale).toBeUndefined()
  })

  it('preserves persisted non-image node keys when explicitly provided', () => {
    const canvas = ensureProjectCanvas({
      version: 1,
      viewport: { x: 0, y: 0, scale: 1 },
      items: {
        'task-a:error:1': { name: '占位图2', x: 120, y: 80, width: 1024, z: 0 },
      },
    }, [], {}, {}, ['task-a:error:1'])

    expect(canvas.items['task-a:error:1']).toEqual({ name: '占位图2', x: 120, y: 80, width: 1024, z: 0 })
  })

  it('zooms around the requested viewport point', () => {
    expect(zoomCanvasViewport({ x: 20, y: 30, scale: 1 }, { x: 120, y: 130 }, 2)).toEqual({
      x: -80,
      y: -70,
      scale: 2,
    })
  })

  it('culls canvas rectangles outside the viewport overscan', () => {
    const viewport = { x: 0, y: 0, scale: 1 }
    const size = { width: 800, height: 600 }
    expect(isCanvasRectVisible({ x: 100, y: 100, width: 200 }, 200, viewport, size, 0)).toBe(true)
    expect(isCanvasRectVisible({ x: 900, y: 100, width: 200 }, 200, viewport, size, 0)).toBe(false)
  })

  it('finds a nearby non-overlapping position around the viewport center', () => {
    const position = findAvailableCanvasItemPosition(
      { existing: { x: -120, y: -120, width: 240 } },
      { x: 400, y: 300, scale: 1 },
      { width: 800, height: 600 },
      { width: 240, height: 240 },
    )

    expect(position).toEqual({ x: -120, y: -392 })
  })

  it('uses existing image heights when finding a free position', () => {
    const position = findAvailableCanvasItemPosition(
      { existing: { x: -120, y: -120, width: 240, height: 480 } },
      { x: 400, y: 300, scale: 1 },
      { width: 800, height: 600 },
      { width: 240, height: 240 },
    )

    expect(position).toEqual({ x: -120, y: -392 })
  })

  it('removes one collection without changing sibling image favorites', () => {
    const canvas = ensureProjectCanvas(undefined, ['image-a', 'image-b'], {
      'image-a': ['collection-a', 'collection-b'],
      'image-b': ['collection-a'],
    })
    const result = removeCanvasFavoriteCollection(canvas, 'collection-a', new Set(['collection-b']), true)

    expect(result.canvas.items['image-a'].favoriteCollectionIds).toEqual(['collection-b'])
    expect(result.canvas.items['image-b'].favoriteCollectionIds).toEqual([])
    expect(result.imageIdsToDelete).toEqual(['image-b'])
  })
})
