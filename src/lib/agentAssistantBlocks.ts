import type { AgentRound, ResponsesOutputItem, TaskRecord } from '../types'
import { collectWebSearchCalls, getAgentRoundOutputItems, getWebSearchStatusForCalls, type AgentWebSearchStatus } from './agentWebSearch'

const AGENT_STOPPED_MESSAGE = '已停止生成。'

export type AgentAssistantBlock =
  | { type: 'web-search'; status: AgentWebSearchStatus; key: string }
  | { type: 'batch-params'; status: AgentWebSearchStatus; key: string }
  | { type: 'image-task'; task: TaskRecord; key: string }
  | { type: 'deleted-image-task'; taskId: string; key: string }
  | { type: 'text'; key: string; content?: string }

export interface AgentRoundTaskSlot {
  taskId: string
  task: TaskRecord | null
}

function isAgentRoundInterrupted(round: AgentRound | null) {
  return round?.status === 'error' && round.error === AGENT_STOPPED_MESSAGE
}

function markToolStatusStopped(status: AgentWebSearchStatus): AgentWebSearchStatus {
  if (status.completed) return status
  return { text: status.text.replace(/^正在/, '已停止'), completed: true }
}

function taskMatchesImageOutputItem(task: TaskRecord, item: ResponsesOutputItem) {
  if (item.type === 'image_generation_call') {
    return Boolean(task.agentToolCallId && task.agentToolCallId === item.id)
  }
  if (item.type === 'function_call' && item.name === 'generate_image' && item.call_id) {
    return task.agentToolCallId === item.call_id
  }
  if (item.type === 'function_call' && item.name === 'generate_image_batch' && item.call_id) {
    return task.agentBatchCallId === item.call_id
  }
  return false
}

function getBatchImageCount(item: ResponsesOutputItem) {
  if (item.type !== 'function_call' || item.name !== 'generate_image_batch' || !item.arguments) return 0
  try {
    const parsed = JSON.parse(item.arguments) as { images?: unknown }
    if (!Array.isArray(parsed.images)) return 0
    return parsed.images.filter((value) => {
      if (!value || typeof value !== 'object') return false
      const prompt = (value as Record<string, unknown>).prompt
      return typeof prompt === 'string' && Boolean(prompt.trim())
    }).length
  } catch {
    return 0
  }
}

function getTextFromOutputItem(item: ResponsesOutputItem) {
  if (item.type !== 'message') return ''
  return (item.content ?? [])
    .map((part) => {
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') return part.text
      if (part.type === 'refusal' && typeof part.refusal === 'string') return part.refusal
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function getAgentAssistantBlocks(round: AgentRound | null, taskSlots: AgentRoundTaskSlot[], allTasks: TaskRecord[], hasText: boolean): AgentAssistantBlock[] {
  const outputItems = getAgentRoundOutputItems(round, allTasks)
  const slotIds = new Set<string>()
  const uniqueTaskSlots = taskSlots.filter((slot) => {
    if (slotIds.has(slot.taskId)) return false
    slotIds.add(slot.taskId)
    return true
  })
  const roundInterrupted = isAgentRoundInterrupted(round)
  const blocks: AgentAssistantBlock[] = []
  const renderedTaskIds = new Set<string>()
  const pushTaskSlot = (slot: AgentRoundTaskSlot) => {
    if (renderedTaskIds.has(slot.taskId)) return
    renderedTaskIds.add(slot.taskId)
    blocks.push(slot.task
      ? { type: 'image-task', task: slot.task, key: `image:${slot.taskId}` }
      : { type: 'deleted-image-task', taskId: slot.taskId, key: `deleted-image:${slot.taskId}` })
  }

  if (outputItems.length === 0) {
    if (hasText) blocks.push({ type: 'text', key: 'text:fallback' })
    for (const slot of uniqueTaskSlots) pushTaskSlot(slot)
    return blocks
  }

  const imageCallProjections: Array<{
    outputIndex: number
    start: number
    end: number
    before: AgentRoundTaskSlot[]
    slots: AgentRoundTaskSlot[]
    after: AgentRoundTaskSlot[]
  }> = []
  const duplicateImageCallIndexes = new Set<number>()
  const imageCallKeys = new Set<string>()
  let nextSlotIndex = 0

  for (const [outputIndex, item] of outputItems.entries()) {
    const singleImageCall = item.type === 'image_generation_call' || (item.type === 'function_call' && item.name === 'generate_image')
    const batchImageCall = item.type === 'function_call' && item.name === 'generate_image_batch'
    if (!singleImageCall && !batchImageCall) continue

    const imageCallKey = item.type === 'image_generation_call' && item.id
      ? `image_generation_call:${item.id}`
      : item.type === 'function_call' && item.call_id
      ? `${item.name}:${item.call_id}`
      : null
    if (imageCallKey && imageCallKeys.has(imageCallKey)) {
      duplicateImageCallIndexes.add(outputIndex)
      continue
    }
    if (imageCallKey) imageCallKeys.add(imageCallKey)

    const matchingIndexes = uniqueTaskSlots
      .map((slot, index) => slot.task && taskMatchesImageOutputItem(slot.task, item) ? index : -1)
      .filter((index) => index >= 0)
    const expectedTaskCount = singleImageCall ? 1 : Math.max(getBatchImageCount(item), matchingIndexes.length)
    const taskCount = expectedTaskCount > uniqueTaskSlots.length && matchingIndexes.length > 0
      ? matchingIndexes.length
      : expectedTaskCount
    if (taskCount === 0 || taskCount > uniqueTaskSlots.length) continue

    let start = -1
    for (let candidate = nextSlotIndex; candidate + taskCount <= uniqueTaskSlots.length; candidate += 1) {
      const candidateSlots = uniqueTaskSlots.slice(candidate, candidate + taskCount)
      if (candidateSlots.some((slot) => slot.task && !taskMatchesImageOutputItem(slot.task, item))) continue
      if (matchingIndexes.some((index) => index < candidate || index >= candidate + taskCount)) continue
      start = candidate
      break
    }
    if (start < 0) continue

    const end = start + taskCount
    imageCallProjections.push({
      outputIndex,
      start,
      end,
      before: [],
      slots: uniqueTaskSlots.slice(start, end),
      after: [],
    })
    nextSlotIndex = end
  }

  const projectedTaskIds = new Set(imageCallProjections.flatMap((projection) => projection.slots.map((slot) => slot.taskId)))
  // 被清洗的内置调用已无精确位置：中间和尾部槽贴前一调用，首段槽贴下一调用。
  for (const [slotIndex, slot] of uniqueTaskSlots.entries()) {
    if (slot.task || projectedTaskIds.has(slot.taskId)) continue
    let previous: (typeof imageCallProjections)[number] | undefined
    for (const projection of imageCallProjections) {
      if (projection.end > slotIndex) break
      previous = projection
    }
    if (previous) {
      previous.after.push(slot)
      projectedTaskIds.add(slot.taskId)
      continue
    }
    const next = imageCallProjections.find((projection) => projection.start > slotIndex)
    if (next) {
      next.before.push(slot)
      projectedTaskIds.add(slot.taskId)
    }
  }

  const imageCallProjectionByOutputIndex = new Map(imageCallProjections.map((projection) => [projection.outputIndex, projection]))
  let renderedTextBlocks = 0
  let webSearchGroup: ResponsesOutputItem[] = []
  let webSearchGroupStart = -1

  const flushWebSearchGroup = () => {
    if (webSearchGroup.length === 0) return
    const status = getWebSearchStatusForCalls(collectWebSearchCalls(webSearchGroup))
    if (status) blocks.push({ type: 'web-search', status: roundInterrupted ? markToolStatusStopped(status) : status, key: `web-search:${webSearchGroupStart}` })
    webSearchGroup = []
    webSearchGroupStart = -1
  }

  for (const [outputIndex, item] of outputItems.entries()) {
    if (item.type === 'web_search_call') {
      if (webSearchGroup.length === 0) webSearchGroupStart = outputIndex
      webSearchGroup.push(item)
      continue
    }

    flushWebSearchGroup()

    const singleImageCall = item.type === 'image_generation_call' || (item.type === 'function_call' && item.name === 'generate_image')
    const batchImageCall = item.type === 'function_call' && item.name === 'generate_image_batch'
    if (duplicateImageCallIndexes.has(outputIndex)) continue

    const projection = imageCallProjectionByOutputIndex.get(outputIndex)
    if (projection) {
      for (const slot of [...projection.before, ...projection.slots, ...projection.after]) pushTaskSlot(slot)
      continue
    }
    if (singleImageCall) continue

    if ((round?.status === 'running' || roundInterrupted) && batchImageCall) {
      blocks.push({
        type: 'batch-params',
        status: roundInterrupted
          ? markToolStatusStopped({ text: '正在填写并发图像生成参数', completed: false })
          : { text: '正在填写并发图像生成参数', completed: false },
        key: `batch-params:${item.call_id ?? item.id ?? outputIndex}:${outputIndex}`,
      })
      continue
    }

    if (item.type === 'message') {
      const content = getTextFromOutputItem(item)
      if (content) {
        renderedTextBlocks += 1
        blocks.push({ type: 'text', key: `text:${item.id ?? outputIndex}:${outputIndex}`, content })
      }
    }
  }

  flushWebSearchGroup()

  if (hasText && renderedTextBlocks === 0) blocks.push({ type: 'text', key: 'text:fallback' })
  for (const slot of uniqueTaskSlots) pushTaskSlot(slot)
  return blocks
}

export function getAgentAssistantCopyContent(fallbackContent: string, blocks: AgentAssistantBlock[]) {
  if (!blocks.some((block) => block.type !== 'text')) return fallbackContent

  const parts = blocks
    .filter((block): block is Extract<AgentAssistantBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.content ?? '')
    .map((content) => content.trim())
    .filter(Boolean)

  return parts.length > 0 ? parts.join('\n\n') : fallbackContent
}

export function getRoundTaskSlots(round: AgentRound | null, tasks: TaskRecord[]): AgentRoundTaskSlot[] {
  if (!round) return []
  return round.outputTaskIds.map((taskId) => ({
    taskId,
    task: tasks.find((task) => task.id === taskId) ?? null,
  }))
}
