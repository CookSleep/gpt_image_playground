import type { TaskParams, TaskRecord } from '../types'
import { getImageModelFamily } from './imageModels'
import { getActualRatioAndResolution } from './size'

/** 图片属性只由保存的图片计算，接口中的尺寸字段可能是档位或请求值。 */
export function getImageActualParams(task: TaskRecord, imageSize: string, actualParams = task.actualParams): Partial<TaskParams> {
  const size = imageSize ? imageSize.replace('×', 'x') : undefined
  const family = getImageModelFamily({ provider: task.apiProvider ?? 'openai', apiMode: task.apiMode ?? 'images', model: task.apiModel ?? '' })
  return {
    ...actualParams,
    size,
    aspect_ratio: undefined,
    resolution: undefined,
    ...(family || task.params.aspect_ratio || task.params.resolution ? getActualRatioAndResolution(size, task.params) : {}),
  }
}
