export const MAX_REFERENCE_IMAGES = 16
export const MAX_REFERENCE_IMAGE_BYTES = 4 * 1024 * 1024

type ReferenceFile = {
  name: string
  size: number
}

export function planReferenceFileSelection<T extends ReferenceFile>(currentCount: number, files: T[]) {
  const oversized = files.filter((file) => file.size > MAX_REFERENCE_IMAGE_BYTES)
  const valid = files.filter((file) => file.size <= MAX_REFERENCE_IMAGE_BYTES)
  const available = Math.max(0, MAX_REFERENCE_IMAGES - Math.max(0, currentCount))

  return {
    accepted: valid.slice(0, available),
    oversized,
    overflow: valid.slice(available),
  }
}
