import type { TaskRecord } from '../types'

export function getTaskOutputImageSlots(task: Pick<TaskRecord, 'outputImages' | 'outputImageSlots'>) {
  return task.outputImageSlots ?? task.outputImages
}

export function removeTaskOutputImage(task: TaskRecord, imageId: string) {
  const outputIndex = task.outputImages.indexOf(imageId)
  if (outputIndex < 0) return null

  const outputImages = task.outputImages.filter((id) => id !== imageId)
  const outputImageSlots = [...getTaskOutputImageSlots(task)]
  const slotIndex = outputImageSlots.indexOf(imageId)
  if (slotIndex >= 0) outputImageSlots[slotIndex] = null

  const transparentOriginalImages = task.transparentOriginalImages
    ? task.transparentOriginalImages.filter((_, index) => index !== outputIndex)
    : undefined
  const originalImageId = task.transparentOriginalImages?.[outputIndex] || undefined
  const actualParamsByImage = task.actualParamsByImage ? { ...task.actualParamsByImage } : undefined
  const revisedPromptByImage = task.revisedPromptByImage ? { ...task.revisedPromptByImage } : undefined
  if (actualParamsByImage) delete actualParamsByImage[imageId]
  if (revisedPromptByImage) delete revisedPromptByImage[imageId]
  const rawImageUrls = task.rawImageUrls?.filter((_, index) => index !== outputIndex)
  const outputErrors = task.outputErrors?.map((error) => ({
    ...error,
    requestIndex: slotIndex >= 0 && error.requestIndex > slotIndex ? error.requestIndex - 1 : error.requestIndex,
  }))

  return {
    task: {
      ...task,
      outputImages,
      outputImageSlots,
      transparentOriginalImages: transparentOriginalImages?.length ? transparentOriginalImages : undefined,
      actualParamsByImage: actualParamsByImage && Object.keys(actualParamsByImage).length ? actualParamsByImage : undefined,
      revisedPromptByImage: revisedPromptByImage && Object.keys(revisedPromptByImage).length ? revisedPromptByImage : undefined,
      rawImageUrls: rawImageUrls?.length ? rawImageUrls : undefined,
      outputErrors,
    },
    removedImageIds: [imageId, ...(originalImageId ? [originalImageId] : [])],
  }
}
