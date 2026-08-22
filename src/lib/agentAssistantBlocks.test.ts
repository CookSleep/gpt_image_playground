import { describe, expect, it } from 'vitest'
import type { AgentRound, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import {
  getAgentAssistantBlocks,
  getAgentAssistantCopyContent,
  getRoundTaskSlots,
  type AgentAssistantBlock,
} from './agentAssistantBlocks'
import { normalizeResponsesOutputItems } from './responsesOutputState'

const round = (patch: Partial<AgentRound> = {}): AgentRound => ({
  id: patch.id ?? 'round-1',
  index: patch.index ?? 1,
  parentRoundId: patch.parentRoundId ?? null,
  userMessageId: patch.userMessageId ?? 'user-1',
  prompt: patch.prompt ?? 'prompt',
  inputImageIds: patch.inputImageIds ?? [],
  outputTaskIds: patch.outputTaskIds ?? [],
  status: patch.status ?? 'done',
  error: patch.error ?? null,
  createdAt: patch.createdAt ?? 1,
  finishedAt: patch.finishedAt ?? 2,
  ...(patch.responseOutput ? { responseOutput: patch.responseOutput } : {}),
})

const task = (id: string, patch: Partial<TaskRecord> = {}): TaskRecord => ({
  id,
  prompt: patch.prompt ?? 'prompt',
  params: patch.params ?? { ...DEFAULT_PARAMS },
  inputImageIds: patch.inputImageIds ?? [],
  maskTargetImageId: patch.maskTargetImageId ?? null,
  maskImageId: patch.maskImageId ?? null,
  outputImages: patch.outputImages ?? [],
  status: patch.status ?? 'done',
  error: patch.error ?? null,
  createdAt: patch.createdAt ?? 1,
  finishedAt: patch.finishedAt ?? 2,
  elapsed: patch.elapsed ?? 1,
  ...(patch.agentToolCallId ? { agentToolCallId: patch.agentToolCallId } : {}),
  ...(patch.agentBatchCallId ? { agentBatchCallId: patch.agentBatchCallId } : {}),
})

const blockOrder = (blocks: AgentAssistantBlock[]) => blocks.map((block) => {
  if (block.type === 'text') return `text:${block.content}`
  if (block.type === 'image-task') return `image:${block.task.id}`
  if (block.type === 'deleted-image-task') return `deleted:${block.taskId}`
  return block.type
})

const batchCall = (callId: string, count: number) => ({
  type: 'function_call',
  name: 'generate_image_batch',
  call_id: callId,
  arguments: JSON.stringify({
    images: Array.from({ length: count }, (_, index) => ({ id: `image-${index + 1}`, prompt: `prompt-${index + 1}` })),
  }),
})

describe('agent assistant blocks', () => {
  it('projects normalized external message content without throwing', () => {
    const currentRound = round({
      responseOutput: normalizeResponsesOutputItems([
        { type: 'message', content: [
          null,
          'invalid',
          { type: 'output_text', text: 123 },
          { type: 'output_text', text: '安全文本' },
          { type: 'refusal', refusal: '拒绝文本' },
          { type: 'future_content_part', payload: true },
        ] },
        { type: 'function_call', call_id: 'bad-call', name: 'tool', arguments: null },
        { type: 'future_response_item', payload: true },
      ]),
    })

    expect(() => getAgentAssistantBlocks(currentRound, [], [], true)).not.toThrow()
    expect(getAgentAssistantBlocks(currentRound, [], [], true)).toEqual([
      { type: 'text', key: 'text:0:0', content: '安全文本\n拒绝文本' },
    ])
  })

  it('preserves response output order', () => {
    const imageTask = task('task-1', { agentToolCallId: 'image-1' })
    const currentRound = round({
      outputTaskIds: [imageTask.id],
      responseOutput: [
        { type: 'web_search_call', id: 'search-1', status: 'completed', action: { type: 'search' } },
        { type: 'message', id: 'message-1', content: [{ type: 'output_text', text: '搜索结果' }] },
        { type: 'image_generation_call', id: 'image-1' },
        { type: 'message', id: 'message-2', content: [{ type: 'output_text', text: '生成完成' }] },
      ],
    })

    const blocks = getAgentAssistantBlocks(currentRound, getRoundTaskSlots(currentRound, [imageTask]), [imageTask], true)

    expect(blocks.map((block) => block.type)).toEqual(['web-search', 'text', 'image-task', 'text'])
    expect(blocks.filter((block) => block.type === 'text').map((block) => block.content)).toEqual(['搜索结果', '生成完成'])
  })

  it('keeps deleted task placeholders in round slot order', () => {
    const liveTask = task('task-live')
    const currentRound = round({ outputTaskIds: ['task-deleted', liveTask.id] })
    const slots = getRoundTaskSlots(currentRound, [liveTask])

    expect(slots).toEqual([
      { taskId: 'task-deleted', task: null },
      { taskId: liveTask.id, task: liveTask },
    ])
    expect(getAgentAssistantBlocks(currentRound, slots, [liveTask], true).map((block) =>
      block.type === 'image-task' ? block.task.id : block.type === 'deleted-image-task' ? block.taskId : block.type,
    )).toEqual(['text', 'task-deleted', 'task-live'])
  })

  it('keeps a deleted generate_image task between surrounding text', () => {
    const currentRound = round({
      outputTaskIds: ['task-deleted'],
      responseOutput: [
        { type: 'message', id: 'message-before', content: [{ type: 'output_text', text: '生成前' }] },
        { type: 'function_call', name: 'generate_image', call_id: 'image-call-1', arguments: '{}' },
        { type: 'function_call_output', call_id: 'image-call-1', output: '{}' },
        { type: 'message', id: 'message-after', content: [{ type: 'output_text', text: '生成后' }] },
      ],
    })

    const blocks = getAgentAssistantBlocks(currentRound, getRoundTaskSlots(currentRound, []), [], true)

    expect(blocks.map((block) => block.type)).toEqual(['text', 'deleted-image-task', 'text'])
    expect(blocks.filter((block) => block.type === 'text').map((block) => block.content)).toEqual(['生成前', '生成后'])
    expect(blocks.find((block) => block.type === 'deleted-image-task')).toMatchObject({ taskId: 'task-deleted' })
  })

  it('groups consecutive searches and gives every rendered block a stable unique key', () => {
    const currentRound = round({
      responseOutput: [
        { type: 'web_search_call', id: 'search-1', status: 'completed', action: { type: 'search' } },
        { type: 'web_search_call', id: 'search-2', status: 'completed', action: { type: 'open_page' } },
        { type: 'message', id: 'duplicate-id', content: [{ type: 'output_text', text: '中间文本' }] },
        { type: 'web_search_call', id: 'search-3', status: 'completed', action: { type: 'search' } },
        { type: 'message', id: 'duplicate-id', content: [{ type: 'output_text', text: '末尾文本' }] },
      ],
    })

    const blocks = getAgentAssistantBlocks(currentRound, [], [], true)
    const keys = blocks.map((block) => block.key)

    expect(blocks.map((block) => block.type)).toEqual(['web-search', 'text', 'web-search', 'text'])
    expect(new Set(keys).size).toBe(keys.length)
    expect(getAgentAssistantBlocks(currentRound, [], [], true).map((block) => block.key)).toEqual(keys)
  })

  it('appends unmatched tasks and de-duplicates repeated calls and task slots', () => {
    const matchedTask = task('task-matched', { agentToolCallId: 'image-call-1' })
    const unmatchedTask = task('task-unmatched', { agentToolCallId: 'missing-call' })
    const currentRound = round({
      outputTaskIds: [matchedTask.id, matchedTask.id, unmatchedTask.id],
      responseOutput: [
        { type: 'function_call', name: 'generate_image', call_id: 'image-call-1', arguments: '{}' },
        { type: 'function_call', name: 'generate_image', call_id: 'image-call-1', arguments: '{}' },
        { type: 'message', content: [{ type: 'output_text', text: '完成' }] },
      ],
    })
    const tasks = [matchedTask, unmatchedTask]

    const blocks = getAgentAssistantBlocks(currentRound, getRoundTaskSlots(currentRound, tasks), tasks, true)

    expect(blocks.map((block) => block.type === 'image-task' ? block.task.id : block.type)).toEqual([
      matchedTask.id,
      'text',
      unmatchedTask.id,
    ])
  })

  it.each([
    {
      name: 'deleted then live',
      taskIds: ['task-deleted', 'task-live'],
      expected: ['text:生成前', 'deleted:task-deleted', 'image:task-live', 'text:生成后'],
    },
    {
      name: 'live then deleted',
      taskIds: ['task-live', 'task-deleted'],
      expected: ['text:生成前', 'image:task-live', 'deleted:task-deleted', 'text:生成后'],
    },
  ])('projects partial batch slots in original order: $name', ({ taskIds, expected }) => {
    const liveTask = task('task-live', { agentBatchCallId: 'batch-1' })
    const currentRound = round({
      outputTaskIds: taskIds,
      responseOutput: [
        { type: 'message', content: [{ type: 'output_text', text: '生成前' }] },
        batchCall('batch-1', 2),
        { type: 'message', content: [{ type: 'output_text', text: '生成后' }] },
      ],
    })

    const blocks = getAgentAssistantBlocks(currentRound, getRoundTaskSlots(currentRound, [liveTask]), [liveTask], true)

    expect(blockOrder(blocks)).toEqual(expected)
  })

  it('renders an entirely deleted batch at the batch output position', () => {
    const currentRound = round({
      outputTaskIds: ['task-deleted-1', 'task-deleted-2'],
      responseOutput: [
        { type: 'message', content: [{ type: 'output_text', text: '生成前' }] },
        batchCall('batch-1', 2),
        { type: 'message', content: [{ type: 'output_text', text: '生成后' }] },
      ],
    })

    const blocks = getAgentAssistantBlocks(currentRound, getRoundTaskSlots(currentRound, []), [], true)

    expect(blockOrder(blocks)).toEqual([
      'text:生成前',
      'deleted:task-deleted-1',
      'deleted:task-deleted-2',
      'text:生成后',
    ])
  })

  it('de-duplicates repeated batch calls and task slots', () => {
    const liveTask = task('task-live', { agentBatchCallId: 'batch-1' })
    const call = batchCall('batch-1', 2)
    const currentRound = round({
      outputTaskIds: ['task-deleted', liveTask.id, 'task-deleted', liveTask.id],
      responseOutput: [call, call],
    })

    const blocks = getAgentAssistantBlocks(currentRound, getRoundTaskSlots(currentRound, [liveTask]), [liveTask], false)

    expect(blockOrder(blocks)).toEqual(['deleted:task-deleted', 'image:task-live'])
  })

  it('places scrubbed built-in image slots around the nearest surviving call', () => {
    const liveTask = task('task-live', { agentToolCallId: 'image-live' })
    const currentRound = round({
      outputTaskIds: ['task-deleted-before', liveTask.id, 'task-deleted-after'],
      responseOutput: [
        { type: 'message', content: [{ type: 'output_text', text: '生成前' }] },
        { type: 'image_generation_call', id: 'image-live' },
        { type: 'message', content: [{ type: 'output_text', text: '生成后' }] },
      ],
    })

    const blocks = getAgentAssistantBlocks(currentRound, getRoundTaskSlots(currentRound, [liveTask]), [liveTask], true)

    expect(blockOrder(blocks)).toEqual([
      'text:生成前',
      'deleted:task-deleted-before',
      'image:task-live',
      'deleted:task-deleted-after',
      'text:生成后',
    ])
  })

  it('appends scrubbed built-in slots in task order when no output anchor remains', () => {
    const currentRound = round({
      outputTaskIds: ['task-deleted-1', 'task-deleted-2'],
      responseOutput: [
        { type: 'message', content: [{ type: 'output_text', text: '生成前' }] },
        { type: 'message', content: [{ type: 'output_text', text: '生成后' }] },
      ],
    })

    const blocks = getAgentAssistantBlocks(currentRound, getRoundTaskSlots(currentRound, []), [], true)

    expect(blockOrder(blocks)).toEqual([
      'text:生成前',
      'text:生成后',
      'deleted:task-deleted-1',
      'deleted:task-deleted-2',
    ])
  })

  it('marks running web searches as stopped when the round is interrupted', () => {
    const output = [{ type: 'web_search_call', id: 'search-1', status: 'in_progress', action: { type: 'search' } }]
    const runningBlocks = getAgentAssistantBlocks(round({ status: 'running', finishedAt: null, responseOutput: output }), [], [], false)
    const stoppedBlocks = getAgentAssistantBlocks(round({ status: 'error', error: '已停止生成。', responseOutput: output }), [], [], false)

    expect(runningBlocks[0]).toMatchObject({ type: 'web-search', status: { text: '正在搜索网页', completed: false } })
    expect(stoppedBlocks[0]).toMatchObject({ type: 'web-search', status: { text: '已停止搜索网页', completed: true } })
  })

  it('shows interrupted batch parameter collection as stopped', () => {
    const currentRound = round({
      status: 'error',
      error: '已停止生成。',
      responseOutput: [{ type: 'function_call', name: 'generate_image_batch', call_id: 'batch-1' }],
    })

    expect(getAgentAssistantBlocks(currentRound, [], [], false)[0]).toMatchObject({
      type: 'batch-params',
      status: { text: '已停止填写并发图像生成参数', completed: true },
    })
  })

  it('copies ordered block text while retaining the fallback for text-only output', () => {
    const mixedBlocks: AgentAssistantBlock[] = [
      { type: 'text', key: 'text:1', content: ' 第一段 ' },
      { type: 'image-task', key: 'image:1', task: task('task-1') },
      { type: 'text', key: 'text:2', content: '第二段' },
    ]

    expect(getAgentAssistantCopyContent('回退文本', mixedBlocks)).toBe('第一段\n\n第二段')
    expect(getAgentAssistantCopyContent('保留原始格式', [{ type: 'text', key: 'text:fallback' }])).toBe('保留原始格式')
  })
})
