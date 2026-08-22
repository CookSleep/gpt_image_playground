import type { AgentConversation, AgentRound, ResponsesApiResponse, ResponsesOutputItem, TaskRecord } from '../types'
import { parseBatchImageCallArguments } from './agentApi'
import { normalizeResponsesOutputItems } from './responsesOutputState'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getPersistableResponseOutputItem(item: ResponsesOutputItem): ResponsesOutputItem {
  if (item.type !== 'image_generation_call' || item.result == null) return item

  if (typeof item.result === 'string') {
    const { result: _result, ...rest } = item
    return rest
  }

  if (!isRecord(item.result)) return item
  const { b64_json: _b64Json, base64: _base64, image: _image, data: _data, ...restResult } = item.result
  if (Object.keys(restResult).length === 0) {
    const { result: _result, ...rest } = item
    return rest
  }

  return { ...item, result: restResult }
}

export function getPersistableAgentConversations(conversations: AgentConversation[]): AgentConversation[] {
  return conversations.map((conversation) => ({
    ...conversation,
    rounds: conversation.rounds.map((round) => round.responseOutput?.length
      ? {
          ...round,
          responseOutput: round.responseOutput.map(getPersistableResponseOutputItem),
        }
      : round,
    ),
  }))
}

export function stripPersistedAgentConversations(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((conversation) => {
    if (!isRecord(conversation) || !Array.isArray(conversation.rounds)) return conversation
    return {
      ...conversation,
      rounds: conversation.rounds.map((round) => {
        if (!isRecord(round) || !Array.isArray(round.responseOutput)) return round
        return {
          ...round,
          responseOutput: normalizeResponsesOutputItems(round.responseOutput).map(getPersistableResponseOutputItem),
        }
      }),
    }
  })
}

export function getPersistableRawResponsePayload(rawResponsePayload?: string) {
  if (!rawResponsePayload) return rawResponsePayload
  try {
    const payload = JSON.parse(rawResponsePayload) as { output?: unknown }
    if (!Array.isArray(payload.output)) return rawResponsePayload
    const output = normalizeResponsesOutputItems(payload.output).map(getPersistableResponseOutputItem)
    return JSON.stringify({ ...payload, output }, null, 2)
  } catch {
    return rawResponsePayload
  }
}

function parseResponseOutputFromPayload(rawResponsePayload?: string): ResponsesOutputItem[] | null {
  if (!rawResponsePayload) return null
  try {
    const payload = JSON.parse(rawResponsePayload) as { output?: unknown }
    return Array.isArray(payload.output) ? normalizeResponsesOutputItems(payload.output) : null
  } catch {
    return null
  }
}

function sanitizeResponseOutputItemForInput(item: ResponsesOutputItem): unknown | null {
  if (item.type === 'web_search_call') return null
  if (item.type === 'image_generation_call') return null

  if (item.type === 'message') {
    const content = (item.content ?? [])
      .map((part) => {
        if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
          return { type: 'output_text', text: part.text }
        }
        if (part.type === 'refusal' && typeof part.refusal === 'string') {
          return { type: 'output_text', text: part.refusal }
        }
        return null
      })
      .filter((part): part is { type: string; text: string } => Boolean(part))

    return content.length > 0 ? { role: 'assistant', content } : null
  }

  return item
}

export function sanitizeResponseOutputForInput(output: ResponsesOutputItem[], options: { allowPendingFunctionCalls?: boolean } = {}) {
  const items = output
    .map(sanitizeResponseOutputItemForInput)
    .filter((item): item is unknown => item != null)
  if (options.allowPendingFunctionCalls) return items

  const functionCallIds = new Set<string>()
  const functionOutputCallIds = new Set<string>()
  for (const item of items) {
    if (!isRecord(item)) continue
    const callId = typeof item.call_id === 'string' ? item.call_id : ''
    if (!callId) continue
    if (item.type === 'function_call') functionCallIds.add(callId)
    if (item.type === 'function_call_output') functionOutputCallIds.add(callId)
  }

  return items.filter((item) => {
    if (!isRecord(item)) return true
    const callId = typeof item.call_id === 'string' ? item.call_id : ''
    if (item.type === 'function_call') return callId && functionOutputCallIds.has(callId)
    if (item.type === 'function_call_output') return callId && functionCallIds.has(callId)
    return true
  })
}

export function canonicalizeBatchFunctionCallArguments(output: ResponsesOutputItem[]) {
  let changed = false
  const canonical = output.map((item) => {
    if (item.type !== 'function_call' || item.name !== 'generate_image_batch') return item
    const batchItems = parseBatchImageCallArguments(item.arguments ?? '')
    if (!batchItems) return item
    try {
      const parsed = JSON.parse(item.arguments ?? '{}')
      if (!isRecord(parsed)) return item
      const args = JSON.stringify({ ...parsed, images: batchItems })
      if (args === item.arguments) return item
      changed = true
      return { ...item, arguments: args }
    } catch {
      return item
    }
  })
  return changed ? canonical : output
}

export function scrubResponseOutputForDeletedAgentTasks(round: AgentRound, output: ResponsesOutputItem[], deletedTasks: TaskRecord[], roundTasks: TaskRecord[]) {
  const deletedTaskIds = new Set(deletedTasks.map((task) => task.id))
  const deletedToolCallIds = new Set(
    deletedTasks
      .filter((task) => task.agentRoundId === round.id && task.agentToolCallId)
      .map((task) => task.agentToolCallId!),
  )
  if (deletedTaskIds.size === 0) return output

  const removedFunctionCallIds = new Set(
    deletedTasks
      .filter((task) => task.agentToolCallId && !task.agentBatchCallId)
      .map((task) => task.agentToolCallId!),
  )
  const tasksById = new Map(roundTasks.map((task) => [task.id, task]))
  const batchItemsByCallId = new Map<string, Array<{ id: string; prompt: string }>>()
  for (const item of output) {
    if (item.type !== 'function_call' || item.name !== 'generate_image_batch' || !item.call_id) continue
    const batchItems = parseBatchImageCallArguments(item.arguments ?? '')
    if (batchItems) batchItemsByCallId.set(item.call_id, batchItems)
  }
  const deletedBatchItemIds = new Map<string, Set<string>>()
  const batchTasksByCallId = new Map<string, TaskRecord[]>()
  for (const batchCallId of new Set(deletedTasks.map((task) => task.agentBatchCallId).filter((id): id is string => Boolean(id)))) {
    const batchTasks = round.outputTaskIds
      .map((taskId) => tasksById.get(taskId))
      .filter((task): task is TaskRecord => task?.agentBatchCallId === batchCallId)
    batchTasksByCallId.set(batchCallId, batchTasks)
    if (batchTasks.length > 0 && batchTasks.every((task) => deletedTaskIds.has(task.id))) {
      removedFunctionCallIds.add(batchCallId)
      continue
    }
    const batchItemIds = (batchItemsByCallId.get(batchCallId) ?? []).map((item) => item.id)
    const ids = new Set<string>()
    for (let index = 0; index < batchTasks.length; index++) {
      const task = batchTasks[index]
      if (!deletedTaskIds.has(task.id)) continue
      const itemId = batchItemIds.length === batchTasks.length ? batchItemIds[index] : task.agentBatchItemId
      if (itemId) ids.add(itemId)
    }
    if (ids.size > 0) deletedBatchItemIds.set(batchCallId, ids)
  }

  let imageIndex = 0
  let changed = false
  const scrubbed: ResponsesOutputItem[] = []
  for (const item of output) {
    if (item.type === 'image_generation_call') {
      const taskId = round.outputTaskIds[imageIndex]
      imageIndex += 1
      if ((item.id && deletedToolCallIds.has(item.id)) || (!item.id && deletedTaskIds.has(taskId))) {
        changed = true
        continue
      }
      scrubbed.push(item)
      continue
    }

    const callId = item.call_id ?? ''
    if (callId && removedFunctionCallIds.has(callId) && (item.type === 'function_call' || item.type === 'function_call_output')) {
      changed = true
      continue
    }

    const itemIds = callId ? deletedBatchItemIds.get(callId) : undefined
    if (!itemIds?.size || (item.type !== 'function_call' && item.type !== 'function_call_output')) {
      scrubbed.push(item)
      continue
    }

    if (item.type === 'function_call') {
      try {
        const parsed = JSON.parse(item.arguments ?? '{}') as Record<string, unknown>
        const batchItems = batchItemsByCallId.get(callId)
        if (!batchItems) {
          scrubbed.push(item)
          continue
        }
        const args = JSON.stringify({ ...parsed, images: batchItems.filter((batchItem) => !itemIds.has(batchItem.id)) })
        if (args === item.arguments) {
          scrubbed.push(item)
          continue
        }
        changed = true
        scrubbed.push({ ...item, arguments: args })
      } catch {
        scrubbed.push(item)
      }
      continue
    }

    if (typeof item.output !== 'string') {
      scrubbed.push(item)
      continue
    }
    try {
      const parsed = JSON.parse(item.output) as { images?: unknown[] }
      if (!Array.isArray(parsed.images)) {
        scrubbed.push(item)
        continue
      }
      const batchItems = batchItemsByCallId.get(callId)
      const batchTasks = batchTasksByCallId.get(callId)
      const canonicalImages = batchItems && batchTasks?.length === batchItems.length && parsed.images.length === batchItems.length
        ? parsed.images.map((image, index) => isRecord(image) ? { ...image, id: batchItems[index].id } : image)
        : parsed.images
      const images = canonicalImages.filter((image) => !isRecord(image) || typeof image.id !== 'string' || !itemIds.has(image.id))
      const value = JSON.stringify({ ...parsed, images })
      if (value === item.output) {
        scrubbed.push(item)
        continue
      }
      changed = true
      scrubbed.push({ ...item, output: value })
    } catch {
      scrubbed.push(item)
    }
  }
  return changed ? scrubbed : output
}

export function scrubTaskRawResponsePayloadForDeletedTasks(task: TaskRecord, round: AgentRound, deletedTasks: TaskRecord[], roundTasks: TaskRecord[]) {
  if (!task.rawResponsePayload) return task

  try {
    const payload = JSON.parse(task.rawResponsePayload) as ResponsesApiResponse
    if (!Array.isArray(payload.output)) return task
    const normalizedOutput = normalizeResponsesOutputItems(payload.output)
    const output = scrubResponseOutputForDeletedAgentTasks(round, normalizedOutput, deletedTasks, roundTasks)
    if (JSON.stringify(output) === JSON.stringify(payload.output)) return task
    return { ...task, rawResponsePayload: JSON.stringify({ ...payload, output }, null, 2) }
  } catch {
    return task
  }
}

export function mergeResponseOutputItems(previous: ResponsesOutputItem[], next: ResponsesOutputItem[]) {
  const merged = [...previous]
  for (const item of next) {
    const index = item.id ? merged.findIndex((existing) => existing.id === item.id) : -1
    if (index >= 0) merged[index] = item
    else merged.push(item)
  }
  return merged
}

export function countResponseToolCalls(output: ResponsesOutputItem[]) {
  return output.filter((item) => item.type === 'image_generation_call').length
}

export function getAgentRoundResponseOutput(round: AgentRound, tasks: TaskRecord[]): ResponsesOutputItem[] | null {
  if (round.responseOutput?.length) return round.responseOutput

  for (const taskId of round.outputTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    const output = parseResponseOutputFromPayload(task?.rawResponsePayload)
    if (output?.length) return output
  }

  return null
}

export function getAgentFunctionOutputCallIds(output: ResponsesOutputItem[]) {
  return new Set(output
    .filter((item) => item.type === 'function_call_output' && item.call_id)
    .map((item) => item.call_id!))
}

function createAgentRecoveredToolOutputs(round: AgentRound, tasks: TaskRecord[]) {
  const output = round.responseOutput ?? []
  if (output.length === 0) return null

  const existingOutputCallIds = getAgentFunctionOutputCallIds(output)
  const additions: ResponsesOutputItem[] = []
  const recoveredTaskIds: string[] = []
  let hasPendingRecoverableCall = false
  let allSuccessful = true

  for (const item of output) {
    if (item.type !== 'function_call' || !item.call_id || existingOutputCallIds.has(item.call_id)) continue

    if (item.name === 'generate_image') {
      const imageId = (() => {
        try {
          const value = JSON.parse(item.arguments ?? '{}') as Record<string, unknown>
          return typeof value.id === 'string' && value.id.trim() ? value.id.trim() : 'image'
        } catch {
          return 'image'
        }
      })()
      const task = tasks.find((task) => task.agentRoundId === round.id && task.agentToolCallId === item.call_id)
      if (!task || task.status === 'running' || task.falRecoverable || task.customRecoverable) {
        hasPendingRecoverableCall = true
        continue
      }

      recoveredTaskIds.push(task.id)
      const ok = task.status === 'done' && task.outputImages.length > 0
      if (!ok) allSuccessful = false
      additions.push({
        type: 'function_call_output',
        call_id: item.call_id,
        output: JSON.stringify({
          id: imageId,
          status: ok ? 'done' : 'error',
          ...(ok ? {} : { error: task.error || '图像生成失败' }),
        }),
      })
      continue
    }

    if (item.name === 'generate_image_batch') {
      const batchItems = parseBatchImageCallArguments(item.arguments ?? '')
      if (!batchItems?.length) continue

      const batchTasks = round.outputTaskIds
        .map((taskId) => tasks.find((task) => task.id === taskId))
        .filter((task): task is TaskRecord => Boolean(task && task.agentBatchCallId === item.call_id))
      if (batchTasks.length < batchItems.length || batchTasks.some((task) => task.status === 'running' || task.falRecoverable || task.customRecoverable)) {
        hasPendingRecoverableCall = true
        continue
      }

      recoveredTaskIds.push(...batchTasks.map((task) => task.id))
      const images = batchItems.map((batchItem, index) => {
        const task = batchTasks[index]
        const ok = task?.status === 'done' && task.outputImages.length > 0
        if (!ok) allSuccessful = false
        return {
          id: batchItem.id,
          status: ok ? 'done' : 'error',
          ...(ok ? {} : { error: task?.error || '图像生成失败' }),
        }
      })
      additions.push({
        type: 'function_call_output',
        call_id: item.call_id,
        output: JSON.stringify({ images }),
      })
    }
  }

  if (hasPendingRecoverableCall || additions.length === 0) return null
  return { additions, recoveredTaskIds, allSuccessful }
}

export function createReadyAgentRecoveredToolState(round: AgentRound, tasks: TaskRecord[]) {
  const recovered = createAgentRecoveredToolOutputs(round, tasks)
  if (recovered) return recovered
  if (!round.responseOutput?.length || round.outputTaskIds.length === 0) return null

  const outputCallIds = getAgentFunctionOutputCallIds(round.responseOutput)
  const pendingFunctionCall = round.responseOutput.some((item) =>
    item.type === 'function_call' &&
    (item.name === 'generate_image' || item.name === 'generate_image_batch') &&
    item.call_id &&
    !outputCallIds.has(item.call_id),
  )
  if (pendingFunctionCall) return null

  const roundTasks = round.outputTaskIds
    .map((taskId) => tasks.find((task) => task.id === taskId))
    .filter((task): task is TaskRecord => Boolean(task))
  if (roundTasks.length === 0 || roundTasks.some((task) => task.status === 'running' || task.falRecoverable || task.customRecoverable)) return null

  return {
    additions: [] as ResponsesOutputItem[],
    recoveredTaskIds: roundTasks.map((task) => task.id),
    allSuccessful: roundTasks.every((task) => task.status === 'done' && task.outputImages.length > 0),
  }
}

export function getAgentRecoveredToolCallCount(output: ResponsesOutputItem[], tasks: TaskRecord[]) {
  const functionOutputs = output.filter((item) => item.type === 'function_call_output')
  const functionCallCount = functionOutputs.reduce((count, item) => {
    if (typeof item.output !== 'string' || !item.output) return count
    try {
      const payload = JSON.parse(item.output) as { images?: unknown[]; status?: string }
      if (Array.isArray(payload.images)) return count + payload.images.filter((image) => isRecord(image) && image.status === 'done').length
      return payload.status === 'done' ? count + 1 : count
    } catch {
      return count
    }
  }, 0)
  const builtInCount = countResponseToolCalls(output)
  const doneTaskCount = tasks.filter((task) => task.status === 'done').length
  return Math.max(functionCallCount + builtInCount, doneTaskCount)
}

export function getAgentRecoveredFailureError(round: AgentRound, tasks: TaskRecord[]) {
  const failedTasks = round.outputTaskIds
    .map((taskId) => tasks.find((item) => item.id === taskId))
    .filter((task): task is TaskRecord => Boolean(task && task.status === 'error' && !task.falRecoverable && !task.customRecoverable))

  if (failedTasks.length === 0) return '图像生成失败'
  if (failedTasks.length === 1) return failedTasks[0].error || '图像生成失败'
  return '部分图像生成任务失败。'
}
