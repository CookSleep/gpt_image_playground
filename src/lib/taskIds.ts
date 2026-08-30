import type { TaskRecord } from '../types'

export function getTaskIds(task: TaskRecord) {
  return [...new Set([
    task.compositeRequestId,
    task.falRequestId,
    task.customTaskId,
    ...(task.imageStatusRequestIds ?? []),
  ].map((id) => id?.trim()).filter((id): id is string => Boolean(id)))]
}
