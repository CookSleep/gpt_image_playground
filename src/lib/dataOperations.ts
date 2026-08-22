import type { AgentConversation, TaskRecord } from '../types'

export function hasActiveDataOperations(tasks: TaskRecord[], agentConversations: AgentConversation[]) {
  return tasks.some((task) => task.status === 'running' || task.falRecoverable || task.customRecoverable)
    || agentConversations.some((conversation) => conversation.rounds.some((round) => round.status === 'running'))
}
