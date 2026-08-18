import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, type AgentConversation, type TaskRecord } from '../types'
import { getAgentConversationProjectId, getAgentConversationTitle, getChangedAgentConversationProjectIds, getProjectAgentConversations } from './agentConversationScope'

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conversation-a',
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
    ...overrides,
  }
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

describe('agent conversation project scope', () => {
  it('uses the first prompt as the conversation title', () => {
    const item = conversation({
      title: 'Generated title',
      rounds: [{ id: 'round-a', index: 0, prompt: '  first prompt  ', userMessageId: 'user-a', inputImageIds: [], outputTaskIds: [], status: 'done', error: null, createdAt: 1, finishedAt: 2 }],
    })

    expect(getAgentConversationTitle(item)).toBe('first prompt')
  })

  it('infers a legacy conversation project from its agent task', () => {
    const item = conversation({ id: 'legacy-chat' })
    const projectId = getAgentConversationProjectId(item, [task({ projectId: 'project-a', agentConversationId: item.id })])

    expect(projectId).toBe('project-a')
  })

  it('keeps unassigned legacy conversations in the local project', () => {
    const local = conversation({ id: 'local-chat' })
    const online = conversation({ id: 'online-chat', projectId: 'project-a' })

    expect(getProjectAgentConversations([local, online], [], '__local_project__', '__all_projects__', '__local_project__')).toEqual([local])
  })

  it('includes inferred legacy conversations in the matching project', () => {
    const item = conversation({ id: 'legacy-chat' })
    const tasks = [task({ projectId: 'project-a', agentConversationId: item.id })]

    expect(getProjectAgentConversations([item], tasks, 'project-a', '__all_projects__', '__local_project__')).toEqual([item])
  })

  it('syncs only projects whose agent conversations changed', () => {
    const unchanged = conversation({ id: 'unchanged-chat', projectId: 'project-a' })
    const changed = conversation({ id: 'changed-chat', projectId: 'project-b' })
    const added = conversation({ id: 'added-chat', projectId: 'project-c' })

    const projectIds = getChangedAgentConversationProjectIds(
      [unchanged, changed],
      [unchanged, { ...changed, title: 'Changed' }, added],
      [],
    )

    expect([...projectIds]).toEqual(['project-b', 'project-c'])
  })

  it('syncs both projects when a conversation moves or is deleted', () => {
    const moved = conversation({ id: 'moved-chat', projectId: 'project-a' })
    const removed = conversation({ id: 'removed-chat', projectId: 'project-c' })

    const projectIds = getChangedAgentConversationProjectIds(
      [moved, removed],
      [{ ...moved, projectId: 'project-b' }],
      [],
    )

    expect([...projectIds]).toEqual(['project-a', 'project-b', 'project-c'])
  })
})
