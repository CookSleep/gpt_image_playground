import type { AgentConversation, TaskRecord } from '../types'

export function getAgentConversationTitle(conversation: AgentConversation) {
  return conversation.rounds[0]?.prompt.trim()
    || conversation.messages.find((message) => message.role === 'user')?.content.trim()
    || conversation.title.trim()
    || '新对话'
}

export function getAgentConversationProjectIds(conversations: AgentConversation[], tasks: TaskRecord[]) {
  const projectIds = new Map<string, string>()
  const taskProjectIds = new Map<string, string>()

  for (const task of tasks) {
    if (!task.projectId) continue
    taskProjectIds.set(task.id, task.projectId)
    if (task.agentConversationId) projectIds.set(task.agentConversationId, task.projectId)
  }

  for (const conversation of conversations) {
    if (conversation.projectId || projectIds.has(conversation.id)) continue
    const taskIds = [
      ...conversation.rounds.flatMap((round) => round.outputTaskIds),
      ...conversation.messages.flatMap((message) => message.outputTaskIds ?? []),
    ]
    const projectId = taskIds
      .map((taskId) => taskProjectIds.get(taskId))
      .find((id): id is string => Boolean(id))
    if (projectId) projectIds.set(conversation.id, projectId)
  }

  return projectIds
}

export function getProjectAgentConversations(
  conversations: AgentConversation[],
  tasks: TaskRecord[],
  projectId: string | null,
  allProjectsId: string,
  localProjectId: string,
) {
  if (!projectId || projectId === allProjectsId) return conversations

  const projectIds = getAgentConversationProjectIds(conversations, tasks)
  if (projectId === localProjectId) {
    return conversations.filter((conversation) => !conversation.projectId && !projectIds.has(conversation.id))
  }
  return conversations.filter((conversation) => (conversation.projectId ?? projectIds.get(conversation.id)) === projectId)
}

export function getAgentConversationProjectId(conversation: AgentConversation, tasks: TaskRecord[]) {
  if (conversation.projectId) return conversation.projectId
  const roundIds = new Set(conversation.rounds.map((round) => round.id))
  const taskIds = new Set([
    ...conversation.rounds.flatMap((round) => round.outputTaskIds),
    ...conversation.messages.flatMap((message) => message.outputTaskIds ?? []),
  ])
  return tasks.find((task) =>
    task.projectId && (
      task.agentConversationId === conversation.id
      || (task.agentRoundId ? roundIds.has(task.agentRoundId) : false)
      || taskIds.has(task.id)
    ),
  )?.projectId
}
