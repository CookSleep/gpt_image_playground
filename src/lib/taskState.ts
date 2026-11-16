import type { ApiProvider, TaskParams, TaskRecord } from '../types'

type TaskLifecyclePatch = Pick<TaskRecord, 'status' | 'error' | 'finishedAt' | 'elapsed'>
type ActualParams = Partial<TaskParams>

export function createTaskDonePatch(task: Pick<TaskRecord, 'createdAt' | 'startedAt'>, now: number): TaskLifecyclePatch {
  return {
    status: 'done',
    error: null,
    finishedAt: now,
    elapsed: now - (task.startedAt ?? task.createdAt),
  }
}

export function createTaskErrorPatch(task: Pick<TaskRecord, 'createdAt' | 'startedAt'>, error: string, now: number): TaskLifecyclePatch {
  return {
    status: 'error',
    error,
    finishedAt: now,
    elapsed: now - (task.startedAt ?? task.createdAt),
  }
}

export function markInterruptedOpenAIRunningTasks(tasks: TaskRecord[], now: number) {
  const interruptedTasks: TaskRecord[] = []
  const updatedTasks = tasks.map((task) => {
    const isOpenAITask = (task.apiProvider ?? 'openai') !== 'fal'
    if (task.status !== 'running' || !isOpenAITask || task.customTaskId) return task

    const updated: TaskRecord = {
      ...task,
      ...createTaskErrorPatch(task, '请求中断', now),
      falRecoverable: false,
      elapsed: Math.max(0, now - (task.startedAt ?? task.createdAt)),
    }
    interruptedTasks.push(updated)
    return updated
  })

  return { tasks: updatedTasks, interruptedTasks }
}

export function hasActualParams(params: ActualParams | undefined): params is ActualParams {
  return Boolean(params && Object.keys(params).length > 0)
}

export function firstActualParams(paramsList: Array<ActualParams | undefined> | undefined): ActualParams | undefined {
  return paramsList?.map(normalizeActualParams).find(hasActualParams)
}

export function mapActualParamsByImage(outputIds: string[], paramsList: Array<ActualParams | undefined> | undefined) {
  const mapped = paramsList?.reduce<Record<string, ActualParams>>((acc, params, index) => {
    const imgId = outputIds[index]
    const actual = normalizeActualParams(params)
    if (imgId && actual) acc[imgId] = actual
    return acc
  }, {})
  return mapped && Object.keys(mapped).length > 0 ? mapped : undefined
}

/** 尺寸类属性由图片宽高推算，响应参数只保留其他属性。 */
export function normalizeActualParams(params: ActualParams | undefined): ActualParams | undefined {
  if (!params) return undefined
  if (!('size' in params) && !('aspect_ratio' in params) && !('resolution' in params)) return hasActualParams(params) ? params : undefined
  const actual = { ...params }
  delete actual.size
  delete actual.aspect_ratio
  delete actual.resolution
  return hasActualParams(actual) ? actual : undefined
}

export function normalizeTaskActualParams(task: TaskRecord): TaskRecord {
  const actualParams = normalizeActualParams(task.actualParams)
  const entries = Object.entries(task.actualParamsByImage ?? {})
  const changed = entries.some(([, params]) => normalizeActualParams(params) !== params)
  const actualParamsByImage = changed
    ? mapActualParamsByImage(entries.map(([id]) => id), entries.map(([, params]) => params))
    : task.actualParamsByImage
  if (actualParams === task.actualParams && actualParamsByImage === task.actualParamsByImage) return task
  return { ...task, actualParams, actualParamsByImage }
}

export function deriveAgentImageActualParams(params: ActualParams | undefined): ActualParams {
  return {
    ...normalizeActualParams(params),
    n: 1,
  }
}

export function deriveGalleryActualParams(
  provider: ApiProvider,
  isAsyncCustomTask: boolean,
  resultParams: ActualParams | undefined,
  paramsList: Array<ActualParams | undefined> | undefined,
  outputCount: number,
): ActualParams | undefined {
  if (provider === 'fal' || isAsyncCustomTask) return firstActualParams(paramsList)
  return {
    ...normalizeActualParams(resultParams),
    n: outputCount,
  }
}

export function mapRevisedPromptsByImage(outputIds: string[], revisedPrompts: Array<string | undefined> | undefined) {
  const mapped = revisedPrompts?.reduce<Record<string, string>>((acc, prompt, index) => {
    const imgId = outputIds[index]
    if (imgId && prompt?.trim()) acc[imgId] = prompt
    return acc
  }, {})
  return mapped && Object.keys(mapped).length > 0 ? mapped : undefined
}
