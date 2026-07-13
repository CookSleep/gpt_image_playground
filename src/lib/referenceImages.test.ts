import { describe, expect, it } from 'vitest'

import {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGES,
  planReferenceFileSelection,
} from './referenceImages'

function file(name: string, size: number) {
  return { name, size }
}

describe('reference image selection planning', () => {
  it('accepts files at the 4 MiB boundary and fills the remaining capacity', () => {
    const result = planReferenceFileSelection(14, [
      file('one.png', MAX_REFERENCE_IMAGE_BYTES),
      file('two.webp', 1),
      file('three.jpg', 1),
    ])

    expect(MAX_REFERENCE_IMAGES).toBe(16)
    expect(result.accepted.map((item) => item.name)).toEqual(['one.png', 'two.webp'])
    expect(result.oversized).toEqual([])
    expect(result.overflow.map((item) => item.name)).toEqual(['three.jpg'])
  })

  it('skips oversized files while continuing to accept valid files', () => {
    const result = planReferenceFileSelection(0, [
      file('too-large.png', MAX_REFERENCE_IMAGE_BYTES + 1),
      file('valid.png', MAX_REFERENCE_IMAGE_BYTES),
    ])

    expect(result.accepted.map((item) => item.name)).toEqual(['valid.png'])
    expect(result.oversized.map((item) => item.name)).toEqual(['too-large.png'])
    expect(result.overflow).toEqual([])
  })

  it('accepts nothing after the reference list reaches sixteen images', () => {
    const result = planReferenceFileSelection(MAX_REFERENCE_IMAGES, [file('extra.png', 1)])

    expect(result.accepted).toEqual([])
    expect(result.overflow.map((item) => item.name)).toEqual(['extra.png'])
  })
})
