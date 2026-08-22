import { describe, expect, it } from 'vitest'
import type { AgentConversation, AgentRound } from '../types'
import { getAgentBranchLeafId, getAgentRoundPath, getConversationSearchText, normalizeAgentConversations } from './agentConversationState'

function round(id: string, parentRoundId: string | null, index: number): AgentRound {
  return {
    id,
    index,
    parentRoundId,
    userMessageId: `user-${id}`,
    prompt: id,
    inputImageIds: [],
    outputTaskIds: [],
    status: 'done',
    error: null,
    createdAt: index,
    finishedAt: index,
  }
}

function conversation(rounds: AgentRound[], activeRoundId: string | null): AgentConversation {
  return {
    id: 'conversation-a',
    title: '对话',
    activeRoundId,
    createdAt: 1,
    updatedAt: 1,
    rounds,
    messages: [],
  }
}

describe('agent conversation state', () => {
  it('stops traversing cyclic parent relationships', () => {
    const value = conversation([
      round('round-a', 'round-b', 1),
      round('round-b', 'round-a', 2),
    ], 'round-a')

    expect(getAgentRoundPath(value, 'round-a').map((item) => item.id)).toEqual(['round-b', 'round-a'])
    expect(getAgentBranchLeafId(value, 'round-a')).toBe('round-a')
  })

  it.each([
    {
      name: '缺失 activeRoundId 的旧线性格式',
      activeRoundId: undefined,
      parentRoundIds: [undefined, undefined],
      expectedActiveRoundId: 'round-b',
      expectedParentRoundIds: [null, 'round-a'],
    },
    {
      name: '有效 activeRoundId 的分支格式',
      activeRoundId: 'round-a',
      parentRoundIds: [undefined, undefined],
      expectedActiveRoundId: 'round-a',
      expectedParentRoundIds: [null, null],
    },
    {
      name: '失效 activeRoundId 的分支格式',
      activeRoundId: 'round-missing',
      parentRoundIds: [undefined, undefined],
      expectedActiveRoundId: 'round-b',
      expectedParentRoundIds: [null, null],
    },
    {
      name: '带 parent 的分支格式',
      activeRoundId: undefined,
      parentRoundIds: [null, 'round-a'],
      expectedActiveRoundId: 'round-b',
      expectedParentRoundIds: [null, 'round-a'],
    },
  ])('normalizes $name compatibly', ({ activeRoundId, parentRoundIds, expectedActiveRoundId, expectedParentRoundIds }) => {
    const normalized = normalizeAgentConversations([{
      id: 'conversation-a',
      title: '对话',
      ...(activeRoundId === undefined ? {} : { activeRoundId }),
      rounds: parentRoundIds.map((parentRoundId, index) => ({
        ...round(`round-${index === 0 ? 'a' : 'b'}`, null, index + 1),
        parentRoundId,
      })),
      messages: [],
      createdAt: 1,
      updatedAt: 2,
    }])

    expect(normalized[0].activeRoundId).toBe(expectedActiveRoundId)
    expect(normalized[0].rounds.map((item) => item.parentRoundId)).toEqual(expectedParentRoundIds)
  })

  it('filters malformed and orphaned records while preserving legacy field defaults', () => {
    const normalized = normalizeAgentConversations([null, {}, { id: '' }, {
      id: 'conversation-a',
      title: '',
      rounds: [
        null,
        { id: 'bad-round' },
        { ...round('round-a', null, 1), parentRoundId: undefined, status: 'running' },
      ],
      messages: [
        null,
        { id: 'bad-role', role: 'system', content: '丢弃', roundId: 'round-a', createdAt: 1 },
        { id: 'orphan', role: 'assistant', content: '丢弃', roundId: 'missing', createdAt: 2 },
        { id: 'user-round-a', role: 'user', content: '保留', roundId: 'round-a', createdAt: 3 },
      ],
      createdAt: 1,
      updatedAt: 2,
    }])

    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      title: '新对话',
      activeRoundId: 'round-a',
      rounds: [{ id: 'round-a', parentRoundId: null, status: 'error', error: '上次请求已中断' }],
    })
    expect(normalized[0].messages.map((message) => message.id)).toEqual(['user-round-a'])
  })

  it('filters malformed response output items while preserving unknown typed items', () => {
    const normalized = normalizeAgentConversations([{
      id: 'conversation-a',
      rounds: [{
        ...round('round-a', null, 1),
        responseOutput: [
          null,
          [],
          'invalid',
          {},
          { type: '' },
          { type: '   ' },
          { type: 'future_response_item', custom: { enabled: true } },
          { type: 'message', content: [] },
        ],
      }],
      messages: [],
    }])

    expect(normalized[0].rounds[0].responseOutput).toEqual([
      { type: 'future_response_item', custom: { enabled: true } },
      { type: 'message', content: [] },
    ])
  })

  it('keeps the first entity when persisted IDs are duplicated', () => {
    const normalized = normalizeAgentConversations([{
      id: 'conversation-a',
      title: '第一个对话',
      rounds: [
        round('round-a', null, 1),
        { ...round('round-a', null, 2), prompt: '重复轮次' },
      ],
      messages: [
        { id: 'message-a', role: 'user', content: '第一条', roundId: 'round-a', createdAt: 1 },
        { id: 'message-a', role: 'assistant', content: '重复消息', roundId: 'round-a', createdAt: 2 },
      ],
      createdAt: 1,
      updatedAt: 1,
    }, {
      id: 'conversation-a',
      title: '重复对话',
      rounds: [],
      messages: [],
      createdAt: 2,
      updatedAt: 2,
    }])

    expect(normalized).toHaveLength(1)
    expect(normalized[0].title).toBe('第一个对话')
    expect(normalized[0].rounds.map((item) => item.prompt)).toEqual(['round-a'])
    expect(normalized[0].messages.map((message) => message.content)).toEqual(['第一条'])
  })

  it('builds case-insensitive search text from conversation content', () => {
    const value = conversation([round('round-a', null, 1)], 'round-a')
    value.title = 'Project ALPHA'
    value.rounds[0].prompt = 'Round Prompt'
    value.messages = [{ id: 'user-round-a', role: 'user', content: 'Message Body', roundId: 'round-a', createdAt: 1 }]

    expect(getConversationSearchText(value)).toBe('project alpha\nmessage body\nround prompt')
  })
})
