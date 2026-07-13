import { beforeEach, describe, expect, test, vi } from 'vitest'

const send = vi.fn()

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send(command) { return send(command) }
  },
  GetObjectCommand: class { constructor(input) { this.input = input } },
  PutObjectCommand: class { constructor(input) { this.input = input } },
  DeleteObjectCommand: class { constructor(input) { this.input = input } },
}))

import { createS3Storage } from '../src/s3Storage.js'

beforeEach(() => send.mockReset())

describe('S3 storage deletion', () => {
  test('deletes the exact object key', async () => {
    send.mockResolvedValue({})
    const storage = createS3Storage({
      endpoint: 'https://s3.example.com', region: 'auto', bucket: 'images', accessKeyId: 'id', secretAccessKey: 'secret', forcePathStyle: true,
    })

    await storage.deleteObject('generations/1/0.png')

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ input: { Bucket: 'images', Key: 'generations/1/0.png' } }))
  })
})
