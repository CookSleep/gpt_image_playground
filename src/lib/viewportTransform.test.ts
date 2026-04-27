import { describe, expect, it } from 'vitest'
import {
  clampViewTransform,
  clientPointToCanvasPoint,
  getComfortableInitialTransform,
  getPinchTransform,
  zoomAtPoint,
} from './viewportTransform'

describe('viewport transform helpers', () => {
  it('keeps an unzoomed canvas centered by clamping offsets to zero', () => {
    expect(clampViewTransform({ scale: 1, x: -80, y: 40 }, { width: 300, height: 200 })).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    })
  })

  it('zooms around the requested point instead of drifting to an edge', () => {
    expect(zoomAtPoint(
      { scale: 1, x: 0, y: 0 },
      { x: 150, y: 100 },
      2,
      { width: 300, height: 200 },
    )).toEqual({
      scale: 2,
      x: -150,
      y: -100,
    })
  })

  it('combines two-finger pinch zoom and pan around the original centroid', () => {
    expect(getPinchTransform({
      startTransform: { scale: 1, x: 0, y: 0 },
      startCentroid: { x: 150, y: 100 },
      nextCentroid: { x: 160, y: 120 },
      startDistance: 100,
      nextDistance: 200,
      viewportSize: { width: 300, height: 200 },
    })).toEqual({
      scale: 2,
      x: -140,
      y: -80,
    })
  })

  it('maps transformed client coordinates back to natural canvas pixels', () => {
    expect(clientPointToCanvasPoint(
      { left: 10, top: 20, width: 200, height: 100 },
      { x: 110, y: 70 },
      { width: 1000, height: 500 },
    )).toEqual({
      x: 500,
      y: 250,
    })
  })

  it('starts compact wide images zoomed enough to be drawable', () => {
    const transform = getComfortableInitialTransform(
      { width: 356, height: 116 },
      { width: 374, height: 642 },
      true,
    )

    expect(transform.scale).toBeCloseTo(2.32, 2)
    expect(transform.x).toBeCloseTo(-236, 0)
    expect(transform.y).toBeCloseTo(-77, 0)
  })

  it('keeps desktop initial view unzoomed', () => {
    expect(getComfortableInitialTransform(
      { width: 356, height: 116 },
      { width: 900, height: 620 },
      false,
    )).toEqual({ scale: 1, x: 0, y: 0 })
  })
})
