import type { AgentRound, ResponsesApiResponse, ResponsesOutputItem, TaskRecord } from '../types'
import { normalizeResponsesOutputItems } from './responsesOutputState'

export interface AgentWebSearchCallSummary {
  id?: string
  status?: string
  actionType: string
}

export interface AgentWebSearchStatus {
  text: string
  completed: boolean
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getWebSearchActionType(action: unknown) {
  if (typeof action === 'string' && action.trim()) return action
  if (!isRecordValue(action)) return 'search'
  return getStringValue(action, 'type') ?? 'search'
}

function getRunningStatusText(actionType: string) {
  if (actionType === 'open_page') return '正在读取网页'
  if (actionType === 'find_in_page') return '正在查找内容'
  return '正在搜索网页'
}

export function collectWebSearchCalls(output: ResponsesOutputItem[] | undefined): AgentWebSearchCallSummary[] {
  return (output ?? [])
    .filter((item) => item.type === 'web_search_call')
    .map((item) => ({
      ...(item.id ? { id: item.id } : {}),
      ...(item.status ? { status: item.status } : {}),
      actionType: getWebSearchActionType(item.action),
    }))
}

export function getWebSearchStatusForCalls(calls: AgentWebSearchCallSummary[]): AgentWebSearchStatus | null {
  const latestCall = calls[calls.length - 1]
  if (!latestCall) return null
  if (calls.some((call) => call.status === 'failed')) return { text: '搜索失败', completed: true }
  const completed = calls.every((call) => call.status === 'completed')
  return {
    text: completed ? '完成搜索' : getRunningStatusText(latestCall.actionType),
    completed,
  }
}

export function getAgentRoundOutputItems(round: AgentRound | null, tasks: TaskRecord[]): ResponsesOutputItem[] {
  if (!round) return []
  if (round.responseOutput?.length) return round.responseOutput

  for (const taskId of round.outputTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    if (!task?.rawResponsePayload) continue
    try {
      const payload = JSON.parse(task.rawResponsePayload) as ResponsesApiResponse
      const output = normalizeResponsesOutputItems(payload.output)
      if (output.length) return output
    } catch {
      continue
    }
  }

  return []
}
