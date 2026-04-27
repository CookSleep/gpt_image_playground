import { describe, expect, it } from 'vitest'
import { calculateMaskWorkingSize, replaceMaskTargetImage } from './maskPreprocess'
import type { InputImage } from '../types'

function image(id: string): InputImage {
  return { id, dataUrl: `data:image/png;base64,${id}` }
}

describe('calculateMaskWorkingSize', () => {
  it('keeps images at or below the mask working edge unchanged', () => {
    expect(calculateMaskWorkingSize(1080, 1920)).toEqual({
      width: 1080,
      height: 1920,
      scale: 1,
      wasResized: false,
    })
  })

  it('scales oversized portrait images proportionally to the mask working edge', () => {
    expect(calculateMaskWorkingSize(3024, 4032)).toEqual({
      width: 1440,
      height: 1920,
      scale: 1920 / 4032,
      wasResized: true,
    })
  })

  it('rounds resized dimensions down to multiples of 16', () => {
    expect(calculateMaskWorkingSize(5000, 3333)).toEqual({
      width: 1920,
      height: 1264,
      scale: 1920 / 5000,
      wasResized: true,
    })
  })
})

describe('replaceMaskTargetImage', () => {
  it('replaces the selected mask target with the prepared working image', () => {
    expect(replaceMaskTargetImage([image('original'), image('ref')], 'original', image('working'))).toEqual([
      image('working'),
      image('ref'),
    ])
  })

  it('deduplicates when the prepared working image is already present', () => {
    expect(replaceMaskTargetImage([image('original'), image('working'), image('ref')], 'original', image('working'))).toEqual([
      image('working'),
      image('ref'),
    ])
  })
})
