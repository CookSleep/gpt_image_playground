import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGES,
  validateReferenceImages,
} from '../src/referenceImages.js'

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
const nginxSource = readFileSync(new URL('../../deploy/nginx.conf', import.meta.url), 'utf8')

function dataUrl(byteLength) {
  return `data:image/png;base64,${Buffer.alloc(byteLength, 1).toString('base64')}`
}

describe('reference image limits', () => {
  test('accepts sixteen images at or below four MiB', () => {
    const images = Array.from({ length: MAX_REFERENCE_IMAGES }, () => dataUrl(1))
    images[0] = dataUrl(MAX_REFERENCE_IMAGE_BYTES)

    expect(validateReferenceImages(images)).toEqual(images)
  })

  test('reserves enough request body capacity for sixteen four-MiB base64 images', () => {
    expect(appSource).toMatch(/bodyLimit:\s*92 \* 1024 \* 1024/)
    expect(nginxSource).toMatch(/client_max_body_size\s+92m;/)
  })
})
