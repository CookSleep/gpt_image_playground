import type { AgentConversation, AgentMessage, AgentRound, TaskRecord } from '../types'
import { normalizeResponsesOutputItems } from './responsesOutputState'

const AGENT_ROUND_IMAGE_MENTION_RE = /@(?:第)?(\d+)轮图(\d+)/g

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function normalizeAgentRound(value: unknown, fallbackIndex: number): AgentRound | null {
  if (!isRecord(value)) return null
  const round = value as Partial<AgentRound>
  if (typeof round.id !== 'string' || !round.id) return null
  if (typeof round.userMessageId !== 'string' || !round.userMessageId) return null

  const status = round.status === 'running'
    ? 'error'
    : round.status === 'error' || round.status === 'done'
    ? round.status
    : 'done'
  const responseOutput = Array.isArray(round.responseOutput) ? normalizeResponsesOutputItems(round.responseOutput) : undefined

  return {
    id: round.id,
    index: typeof round.index === 'number' ? round.index : fallbackIndex + 1,
    parentRoundId: typeof round.parentRoundId === 'string' ? round.parentRoundId : null,
    userMessageId: round.userMessageId,
    ...(typeof round.assistantMessageId === 'string' ? { assistantMessageId: round.assistantMessageId } : {}),
    prompt: typeof round.prompt === 'string' ? round.prompt : '',
    inputImageIds: normalizeStringArray(round.inputImageIds),
    maskTargetImageId: typeof round.maskTargetImageId === 'string' ? round.maskTargetImageId : null,
    maskImageId: typeof round.maskImageId === 'string' ? round.maskImageId : null,
    outputTaskIds: normalizeStringArray(round.outputTaskIds),
    ...(typeof round.responseId === 'string' ? { responseId: round.responseId } : {}),
    ...(responseOutput ? { responseOutput } : {}),
    status,
    error: status === 'error'
      ? typeof round.error === 'string' ? round.error : '上次请求已中断'
      : null,
    createdAt: typeof round.createdAt === 'number' ? round.createdAt : Date.now(),
    finishedAt: typeof round.finishedAt === 'number' ? round.finishedAt : null,
  }
}

function normalizeAgentMessage(value: unknown): AgentMessage | null {
  if (!isRecord(value)) return null
  const message = value as Partial<AgentMessage>
  if (typeof message.id !== 'string' || !message.id) return null
  if (message.role !== 'user' && message.role !== 'assistant') return null
  if (typeof message.roundId !== 'string' || !message.roundId) return null

  return {
    id: message.id,
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    roundId: message.roundId,
    ...(Array.isArray(message.inputImageIds) ? { inputImageIds: normalizeStringArray(message.inputImageIds) } : {}),
    maskTargetImageId: typeof message.maskTargetImageId === 'string' ? message.maskTargetImageId : null,
    maskImageId: typeof message.maskImageId === 'string' ? message.maskImageId : null,
    ...(Array.isArray(message.outputTaskIds) ? { outputTaskIds: normalizeStringArray(message.outputTaskIds) } : {}),
    createdAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
  }
}

export function normalizeAgentConversations(value: unknown): AgentConversation[] {
  if (!Array.isArray(value)) return []

  const conversationIds = new Set<string>()
  return value
    .filter((item): item is Record<string, unknown> & { id: string } => {
      if (!isRecord(item)) return false
      const id = item.id
      if (typeof id !== 'string' || !id || conversationIds.has(id)) return false
      conversationIds.add(id)
      return true
    })
    .map((conversation) => {
      const roundIds = new Set<string>()
      const normalizedRounds = Array.isArray(conversation.rounds)
        ? conversation.rounds.map(normalizeAgentRound).filter((round): round is AgentRound => {
            if (!round || roundIds.has(round.id)) return false
            roundIds.add(round.id)
            return true
          })
        : []
      const hasBranchParents = normalizedRounds.some((round) => round.parentRoundId)
      const hasStoredActiveRound = typeof conversation.activeRoundId === 'string'
      const rounds = hasBranchParents || hasStoredActiveRound
        ? normalizedRounds
        : normalizedRounds.map((round, index) => ({
            ...round,
            parentRoundId: index > 0 ? normalizedRounds[index - 1].id : null,
          }))
      const messageIds = new Set<string>()
      const messages = Array.isArray(conversation.messages)
        ? conversation.messages
            .map(normalizeAgentMessage)
            .filter((message): message is AgentMessage => {
              if (!message || !roundIds.has(message.roundId) || messageIds.has(message.id)) return false
              messageIds.add(message.id)
              return true
            })
        : []
      return {
        id: conversation.id,
        title: typeof conversation.title === 'string' && conversation.title.trim() ? conversation.title : '新对话',
        activeRoundId: typeof conversation.activeRoundId === 'string' && roundIds.has(conversation.activeRoundId) ? conversation.activeRoundId : rounds[rounds.length - 1]?.id ?? null,
        createdAt: typeof conversation.createdAt === 'number' ? conversation.createdAt : Date.now(),
        updatedAt: typeof conversation.updatedAt === 'number' ? conversation.updatedAt : Date.now(),
        rounds,
        messages,
      }
    })
}

function getAgentRoundChildren(conversation: AgentConversation, parentRoundId: string | null) {
  return conversation.rounds.filter((round) => (round.parentRoundId ?? null) === parentRoundId)
}

function getLatestAgentLeafId(conversation: AgentConversation, startRoundId: string | null = null): string | null {
  let currentId = startRoundId
  if (!currentId) {
    const roots = getAgentRoundChildren(conversation, null)
    currentId = roots[roots.length - 1]?.id ?? null
  }

  const seen = new Set<string>()
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const children = getAgentRoundChildren(conversation, currentId)
    const nextId = children[children.length - 1]?.id ?? null
    if (!nextId) return currentId
    currentId = nextId
  }

  return null
}

export function getAgentRoundPath(conversation: AgentConversation, roundId: string | null): AgentRound[] {
  if (!roundId) return []
  const byId = new Map(conversation.rounds.map((round) => [round.id, round]))
  const path: AgentRound[] = []
  const seen = new Set<string>()
  let current = byId.get(roundId) ?? null

  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current)
    current = current.parentRoundId ? byId.get(current.parentRoundId) ?? null : null
  }

  return path
}

export function getActiveAgentRounds(conversation: AgentConversation): AgentRound[] {
  const activeRoundId = conversation.activeRoundId && conversation.rounds.some((round) => round.id === conversation.activeRoundId)
    ? conversation.activeRoundId
    : getLatestAgentLeafId(conversation)
  return getAgentRoundPath(conversation, activeRoundId ?? null)
}

function reindexAgentRounds(conversation: AgentConversation): AgentConversation {
  const indexById = new Map<string, number>()
  const seen = new Set<string>()
  const visit = (parentRoundId: string | null, depth: number) => {
    for (const child of getAgentRoundChildren(conversation, parentRoundId)) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      indexById.set(child.id, depth)
      visit(child.id, depth + 1)
    }
  }
  visit(null, 1)
  return {
    ...conversation,
    rounds: conversation.rounds.map((round) => ({
      ...round,
      index: indexById.get(round.id) ?? round.index,
    })),
  }
}

export function remapAgentRoundMentionsForPathChange(content: string, oldPath: AgentRound[], newPath: AgentRound[]) {
  if (!content || oldPath.length === 0) return content
  const newIndexByRoundId = new Map(newPath.map((round, index) => [round.id, index + 1]))
  return content.replace(AGENT_ROUND_IMAGE_MENTION_RE, (match, roundNumber: string, imageNumber: string) => {
    const oldRound = oldPath[Number(roundNumber) - 1]
    if (!oldRound) return match
    const newRoundIndex = newIndexByRoundId.get(oldRound.id)
    if (!newRoundIndex) return `@已删除轮次图${imageNumber}`
    return `@第${newRoundIndex}轮图${imageNumber}`
  })
}

export function deleteAgentRoundFromConversation(conversation: AgentConversation, roundId: string, now = Date.now()): AgentConversation {
  const targetRound = conversation.rounds.find((round) => round.id === roundId)
  if (!targetRound) return conversation

  const oldPathByRoundId = new Map(conversation.rounds.map((round) => [round.id, getAgentRoundPath(conversation, round.id)]))
  const rounds = conversation.rounds
    .filter((candidate) => candidate.id !== roundId)
    .map((candidate) =>
      candidate.parentRoundId === roundId
        ? { ...candidate, parentRoundId: targetRound.parentRoundId ?? null }
        : candidate,
    )
  const messages = conversation.messages.filter((candidate) => candidate.roundId !== roundId)
  const nextConversation = reindexAgentRounds({
    ...conversation,
    rounds,
    messages,
    activeRoundId: conversation.activeRoundId === roundId ? null : conversation.activeRoundId ?? null,
  })
  const newPathByRoundId = new Map(nextConversation.rounds.map((round) => [round.id, getAgentRoundPath(nextConversation, round.id)]))
  const remappedMessages = nextConversation.messages.map((message) => {
    const oldPath = oldPathByRoundId.get(message.roundId) ?? []
    const newPath = newPathByRoundId.get(message.roundId) ?? []
    const content = remapAgentRoundMentionsForPathChange(message.content, oldPath, newPath)
    return content === message.content ? message : { ...message, content }
  })
  const withRemappedMessages = { ...nextConversation, messages: remappedMessages }
  const activeRounds = getActiveAgentRounds(withRemappedMessages)
  return {
    ...withRemappedMessages,
    activeRoundId: withRemappedMessages.activeRoundId ?? activeRounds[activeRounds.length - 1]?.id ?? null,
    updatedAt: now,
  }
}

export function getAgentSiblingRounds(conversation: AgentConversation, round: AgentRound) {
  return getAgentRoundChildren(conversation, round.parentRoundId ?? null)
}

export function getAgentBranchLeafId(conversation: AgentConversation, roundId: string) {
  return getLatestAgentLeafId(conversation, roundId) ?? roundId
}

export function uniqueIds(ids: string[]) {
  return Array.from(new Set(ids.filter(Boolean)))
}

export function getAgentRoundTaskIds(round: AgentRound, tasks: TaskRecord[]) {
  const existingTaskIds = new Set(tasks.map((task) => task.id))
  return uniqueIds([
    ...round.outputTaskIds,
    ...tasks
      .filter((task) => task.agentRoundId === round.id)
      .map((task) => task.id),
  ]).filter((taskId) => existingTaskIds.has(taskId))
}

export function getAgentConversationTaskIds(conversation: AgentConversation | null | undefined, tasks: TaskRecord[]) {
  if (!conversation) return []
  const existingTaskIds = new Set(tasks.map((task) => task.id))
  const roundIds = new Set(conversation.rounds.map((round) => round.id))
  return uniqueIds([
    ...conversation.rounds.flatMap((round) => round.outputTaskIds),
    ...tasks
      .filter((task) => task.agentConversationId === conversation.id || Boolean(task.agentRoundId && roundIds.has(task.agentRoundId)))
      .map((task) => task.id),
  ]).filter((taskId) => existingTaskIds.has(taskId))
}

export function getConversationSearchText(conversation: AgentConversation) {
  return [
    conversation.title,
    ...conversation.messages.map((message) => message.content),
    ...conversation.rounds.map((round) => round.prompt),
  ].join('\n').toLocaleLowerCase()
}
