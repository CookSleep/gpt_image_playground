import { describe, expect, it } from 'vitest'
import type { AgentConversation, AgentRound, ResponsesOutputItem, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import {
  canonicalizeBatchFunctionCallArguments,
  countResponseToolCalls,
  createReadyAgentRecoveredToolState,
  getAgentRecoveredFailureError,
  getAgentRecoveredToolCallCount,
  getAgentRoundResponseOutput,
  getPersistableAgentConversations,
  getPersistableRawResponsePayload,
  mergeResponseOutputItems,
  sanitizeResponseOutputForInput,
  scrubResponseOutputForDeletedAgentTasks,
  scrubTaskRawResponsePayloadForDeletedTasks,
  stripPersistedAgentConversations,
} from './agentResponseState'

function round(overrides: Partial<AgentRound> = {}): AgentRound {
  return {
    id: 'round-a',
    index: 1,
    parentRoundId: null,
    userMessageId: 'user-a',
    prompt: 'prompt',
    inputImageIds: [],
    outputTaskIds: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    ...overrides,
  }
}

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: id,
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: ['output-image'],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

function conversation(responseOutput: ResponsesOutputItem[]): AgentConversation {
  return {
    id: 'conversation-a',
    title: '对话',
    activeRoundId: 'round-a',
    createdAt: 1,
    updatedAt: 2,
    rounds: [round({ responseOutput })],
    messages: [],
  }
}

describe('agent response persistence', () => {
  it('strips image payload fields without mutating live output', () => {
    const output = [
      { type: 'message', content: [{ type: 'output_text', text: '完成' }] },
      { type: 'image_generation_call', id: 'string-result', result: 'large-string' },
      {
        type: 'image_generation_call',
        id: 'object-result',
        result: {
          b64_json: 'large-b64',
          base64: 'large-base64',
          image: 'large-image',
          data: 'large-data',
          detail: 'keep',
        },
      } as unknown as ResponsesOutputItem,
    ]
    const live = conversation(output)

    const persisted = getPersistableAgentConversations([live])

    expect(persisted[0].rounds[0].responseOutput).toEqual([
      output[0],
      { type: 'image_generation_call', id: 'string-result' },
      { type: 'image_generation_call', id: 'object-result', result: { detail: 'keep' } },
    ])
    expect(live.rounds[0].responseOutput).toBe(output)
    expect(JSON.stringify(live)).toContain('large-string')
    expect(getPersistableAgentConversations(persisted)).toEqual(persisted)
  })

  it('cleans legacy unknown state and task payloads while dropping malformed output items', () => {
    const responseOutput: unknown[] = [
      { type: 'image_generation_call', result: { base64: 'legacy-base64' } },
      'unknown-item',
    ]
    const legacy = [{
      id: 'conversation-a',
      rounds: [{
        id: 'round-a',
        responseOutput,
      }, 'unknown-round'],
    }]
    const payload = JSON.stringify({ id: 'response-a', output: responseOutput })

    expect(JSON.stringify(stripPersistedAgentConversations(legacy))).not.toContain('legacy-base64')
    expect(stripPersistedAgentConversations({ rounds: [] })).toEqual({ rounds: [] })
    expect(getPersistableRawResponsePayload(payload)).toBe(JSON.stringify({
      id: 'response-a',
      output: [{ type: 'image_generation_call' }],
    }, null, 2))
    expect(getPersistableRawResponsePayload('{bad json')).toBe('{bad json')
    expect(getPersistableRawResponsePayload('{"output":null}')).toBe('{"output":null}')
  })
})

describe('agent response input and merging', () => {
  it('removes image and web payloads, normalizes messages, and keeps only paired function items', () => {
    const output: ResponsesOutputItem[] = [
      { type: 'image_generation_call', id: 'image-a', result: 'large-image' },
      { type: 'web_search_call', id: 'search-a' },
      { type: 'message', content: [
        { type: 'output_text', text: '第一段', annotations: [{ type: 'url_citation' }] },
        { type: 'text', text: '第二段' },
        { type: 'output_text', text: '拒绝内容' },
      ] },
      { type: 'function_call', call_id: 'paired', name: 'tool' },
      { type: 'function_call', call_id: 'orphan-call', name: 'tool' },
      { type: 'function_call', name: 'missing-id' },
      { type: 'function_call_output', call_id: 'paired', output: 'ok' },
      { type: 'function_call_output', call_id: 'orphan-output', output: 'orphan' },
      { type: 'function_call_output', output: 'missing-id' },
    ]

    expect(sanitizeResponseOutputForInput(output)).toEqual([
      { role: 'assistant', content: [
        { type: 'output_text', text: '第一段' },
        { type: 'output_text', text: '第二段' },
        { type: 'output_text', text: '拒绝内容' },
      ] },
      output[3],
      output[6],
    ])
    expect(sanitizeResponseOutputForInput(output, { allowPendingFunctionCalls: true })).toEqual([
      { role: 'assistant', content: [
        { type: 'output_text', text: '第一段' },
        { type: 'output_text', text: '第二段' },
        { type: 'output_text', text: '拒绝内容' },
      ] },
      ...output.slice(3),
    ])
  })

  it('canonicalizes missing and duplicate historical batch ids idempotently', () => {
    const output: ResponsesOutputItem[] = [{
      type: 'function_call',
      name: 'generate_image_batch',
      call_id: 'batch-a',
      arguments: JSON.stringify({ mode: 'legacy', images: [
        { id: ' duplicate ', prompt: ' first prompt ' },
        { id: 'duplicate', prompt: 'second prompt' },
        { prompt: 'missing id' },
        { id: 'ignored', prompt: '   ' },
      ] }),
    }]

    const canonical = canonicalizeBatchFunctionCallArguments(output)

    expect(JSON.parse(canonical[0].arguments ?? '{}')).toEqual({
      mode: 'legacy',
      images: [
        { id: 'duplicate', prompt: 'first prompt' },
        { id: 'duplicate_2', prompt: 'second prompt' },
        { id: 'image_3', prompt: 'missing id' },
      ],
    })
    expect(canonicalizeBatchFunctionCallArguments(canonical)).toBe(canonical)
  })

  it('replaces identified items and appends missing or duplicate ids in response order', () => {
    const previous: ResponsesOutputItem[] = [
      { id: 'message-a', type: 'message', status: 'in_progress' },
      { type: 'message', status: 'anonymous-old' },
    ]
    const merged = mergeResponseOutputItems(previous, [
      { id: 'message-a', type: 'message', status: 'done' },
      { type: 'message', status: 'anonymous-new' },
      { id: 'message-a', type: 'message', status: 'completed' },
    ])

    expect(merged).toEqual([
      { id: 'message-a', type: 'message', status: 'completed' },
      previous[1],
      { type: 'message', status: 'anonymous-new' },
    ])
    expect(previous[0].status).toBe('in_progress')
  })

  it('prefers round output and otherwise reads the first valid task payload', () => {
    const stored = [{ type: 'message', id: 'stored' }]
    const fallback = [{ type: 'message', id: 'fallback', content: [] }]
    const tasks = [
      task('missing-output', { rawResponsePayload: '{"output":null}' }),
      task('valid-output', { rawResponsePayload: JSON.stringify({ output: fallback }) }),
    ]

    expect(getAgentRoundResponseOutput(round({ outputTaskIds: tasks.map((item) => item.id), responseOutput: stored }), tasks)).toBe(stored)
    expect(getAgentRoundResponseOutput(round({ outputTaskIds: tasks.map((item) => item.id) }), tasks)).toEqual(fallback)
    expect(getAgentRoundResponseOutput(round({ outputTaskIds: ['missing-output'] }), tasks)).toBeNull()
  })
})

describe('deleted Agent task response scrubbing', () => {
  it('removes identified and anonymous image outputs by their task mapping', () => {
    const live = task('task-live', { agentRoundId: 'round-a', agentToolCallId: 'live-call' })
    const deleted = task('task-deleted', { agentRoundId: 'round-a' })
    const value = round({ outputTaskIds: [live.id, deleted.id] })
    const output: ResponsesOutputItem[] = [
      { type: 'image_generation_call', id: 'live-call', result: 'live-result' },
      { type: 'image_generation_call', result: 'anonymous-deleted-result' },
    ]

    expect(scrubResponseOutputForDeletedAgentTasks(value, output, [deleted], [live, deleted])).toEqual([output[0]])
  })

  it('removes both sides of deleted single and complete batch function calls', () => {
    const single = task('single', { agentRoundId: 'round-a', agentToolCallId: 'single-call' })
    const batchA = task('batch-a', { agentRoundId: 'round-a', agentToolCallId: 'image-a', agentBatchCallId: 'batch-call' })
    const batchB = task('batch-b', { agentRoundId: 'round-a', agentToolCallId: 'image-b', agentBatchCallId: 'batch-call' })
    const output: ResponsesOutputItem[] = [
      { type: 'function_call', call_id: 'single-call', name: 'generate_image' },
      { type: 'function_call_output', call_id: 'single-call', output: '{}' },
      { type: 'function_call', call_id: 'batch-call', name: 'generate_image_batch', arguments: JSON.stringify({ images: [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }] }) },
      { type: 'function_call_output', call_id: 'batch-call', output: JSON.stringify({ images: [{ id: 'a' }, { id: 'b' }] }) },
      { type: 'message', id: 'keep' },
    ]
    const value = round({ outputTaskIds: [single.id, batchA.id, batchB.id] })

    expect(scrubResponseOutputForDeletedAgentTasks(value, output, [single, batchA, batchB], [single, batchA, batchB])).toEqual([output[4]])
  })

  it.each([
    { deletedIndex: 0, liveId: 'duplicate_2', livePrompt: 'second prompt' },
    { deletedIndex: 1, liveId: 'duplicate', livePrompt: 'first prompt' },
  ])('scrubs one historical batch occurrence with duplicate ids at index $deletedIndex', ({ deletedIndex, liveId, livePrompt }) => {
    const functionCall: ResponsesOutputItem = {
      type: 'function_call',
      name: 'generate_image_batch',
      call_id: 'legacy-batch-call',
      arguments: JSON.stringify({ images: [
        { id: ' duplicate ', prompt: ' first prompt ' },
        { id: 'duplicate', prompt: 'second prompt' },
        { prompt: 'missing prompt' },
        { id: 'ignored', prompt: '   ' },
      ] }),
    }
    const functionOutput: ResponsesOutputItem = {
      type: 'function_call_output',
      call_id: 'legacy-batch-call',
      output: JSON.stringify({ images: [
        { id: 'duplicate', status: 'done' },
        { id: 'duplicate', status: 'done' },
        { id: 'image_3', status: 'done' },
      ] }),
    }
    const tasks = ['first prompt', 'second prompt', 'missing prompt'].map((prompt, index) => task(`task-${index}`, {
      prompt,
      agentRoundId: 'round-a',
      agentToolCallId: `image-call-${index}`,
      agentBatchCallId: 'legacy-batch-call',
    }))
    const value = round({ outputTaskIds: tasks.map((item) => item.id) })

    const scrubbed = scrubResponseOutputForDeletedAgentTasks(value, [functionCall, functionOutput], [tasks[deletedIndex]], tasks)

    expect(JSON.parse(scrubbed[0].arguments ?? '{}').images).toEqual([
      { id: liveId, prompt: livePrompt },
      { id: 'image_3', prompt: 'missing prompt' },
    ])
    expect(JSON.parse(typeof scrubbed[1].output === 'string' ? scrubbed[1].output : '{}').images).toEqual([
      { id: liveId, status: 'done' },
      { id: 'image_3', status: 'done' },
    ])
    expect(scrubResponseOutputForDeletedAgentTasks(value, scrubbed, [tasks[deletedIndex]], tasks)).toBe(scrubbed)
  })

  it('uses agentBatchItemId when batch arguments and task counts differ', () => {
    const live = task('task-live', {
      agentRoundId: 'round-a',
      agentBatchCallId: 'batch-call',
      agentBatchItemId: 'item-a',
    })
    const deleted = task('task-deleted', {
      agentRoundId: 'round-a',
      agentBatchCallId: 'batch-call',
      agentBatchItemId: 'item-b',
    })
    const output: ResponsesOutputItem[] = [
      {
        type: 'function_call',
        name: 'generate_image_batch',
        call_id: 'batch-call',
        arguments: JSON.stringify({ images: [
          { id: 'item-a', prompt: 'first' },
          { id: 'item-b', prompt: 'second' },
          { id: 'item-c', prompt: 'missing task' },
        ] }),
      },
      {
        type: 'function_call_output',
        call_id: 'batch-call',
        output: JSON.stringify({ images: [
          { id: 'item-a', status: 'done' },
          { id: 'item-b', status: 'done' },
          { id: 'item-c', status: 'error' },
        ] }),
      },
    ]
    const value = round({ outputTaskIds: [live.id, deleted.id] })

    const scrubbed = scrubResponseOutputForDeletedAgentTasks(value, output, [deleted], [live, deleted])

    expect(JSON.parse(scrubbed[0].arguments ?? '{}').images).toEqual([
      { id: 'item-a', prompt: 'first' },
      { id: 'item-c', prompt: 'missing task' },
    ])
    expect(JSON.parse(typeof scrubbed[1].output === 'string' ? scrubbed[1].output : '{}').images).toEqual([
      { id: 'item-a', status: 'done' },
      { id: 'item-c', status: 'error' },
    ])
  })

  it('scrubs raw payloads without changing malformed or already clean tasks', () => {
    const deleted = task('deleted', { agentRoundId: 'round-a', agentToolCallId: 'deleted-call' })
    const live = task('live', { agentRoundId: 'round-a', agentToolCallId: 'live-call' })
    const value = round({ outputTaskIds: [deleted.id, live.id] })
    const output = [
      { type: 'image_generation_call', id: 'deleted-call', result: 'deleted' },
      { type: 'image_generation_call', id: 'live-call', result: 'live' },
    ]
    const payloadTask = task('payload', { rawResponsePayload: JSON.stringify({ id: 'response-a', output }) })
    const malformed = task('malformed', { rawResponsePayload: '{bad json' })

    const scrubbed = scrubTaskRawResponsePayloadForDeletedTasks(payloadTask, value, [deleted], [deleted, live])

    expect(JSON.parse(scrubbed.rawResponsePayload ?? '{}')).toEqual({ id: 'response-a', output: [output[1]] })
    expect(scrubTaskRawResponsePayloadForDeletedTasks(malformed, value, [deleted], [deleted, live])).toBe(malformed)
    expect(scrubTaskRawResponsePayloadForDeletedTasks(scrubbed, value, [deleted], [deleted, live])).toBe(scrubbed)
  })
})

describe('Agent response recovery derivation', () => {
  it('derives single and historical batch outputs without duplicating completed calls', () => {
    const single = task('single', { agentRoundId: 'round-a', agentToolCallId: 'single-call' })
    const batchA = task('batch-a', { agentRoundId: 'round-a', agentBatchCallId: 'batch-call' })
    const batchB = task('batch-b', { agentRoundId: 'round-a', agentBatchCallId: 'batch-call', status: 'error', outputImages: [], error: '第二张失败' })
    const value = round({
      outputTaskIds: [single.id, batchA.id, batchB.id],
      responseOutput: [
        { type: 'function_call', name: 'generate_image', call_id: 'single-call', arguments: JSON.stringify({ id: ' single-id ' }) },
        { type: 'function_call', name: 'generate_image_batch', call_id: 'batch-call', arguments: JSON.stringify({ images: [
          { id: 'duplicate', prompt: 'first' },
          { id: 'duplicate', prompt: 'second' },
        ] }) },
      ],
    })

    const recovered = createReadyAgentRecoveredToolState(value, [single, batchA, batchB])

    expect(recovered?.recoveredTaskIds).toEqual([single.id, batchA.id, batchB.id])
    expect(recovered?.allSuccessful).toBe(false)
    expect(recovered?.additions.map((item) => JSON.parse(typeof item.output === 'string' ? item.output : '{}'))).toEqual([
      { id: 'single-id', status: 'done' },
      { images: [
        { id: 'duplicate', status: 'done' },
        { id: 'duplicate_2', status: 'error', error: '第二张失败' },
      ] },
    ])
  })

  it('waits for pending recoverable tasks and accepts an already paired completed state', () => {
    const pending = task('pending', {
      agentRoundId: 'round-a',
      agentToolCallId: 'single-call',
      status: 'running',
      outputImages: [],
      finishedAt: null,
      elapsed: null,
      falRecoverable: true,
    })
    const pendingRound = round({
      outputTaskIds: [pending.id],
      responseOutput: [{ type: 'function_call', name: 'generate_image', call_id: 'single-call' }],
    })
    expect(createReadyAgentRecoveredToolState(pendingRound, [pending])).toBeNull()

    const done = task('done', { agentRoundId: 'round-a', agentToolCallId: 'single-call' })
    const completedRound = round({
      outputTaskIds: [done.id],
      responseOutput: [
        { type: 'function_call', name: 'generate_image', call_id: 'single-call' },
        { type: 'function_call_output', call_id: 'single-call', output: '{"status":"done"}' },
      ],
    })
    expect(createReadyAgentRecoveredToolState(completedRound, [done])).toEqual({
      additions: [],
      recoveredTaskIds: [done.id],
      allSuccessful: true,
    })
  })

  it('waits when a completed recovery item is paired but another call is recoverable', () => {
    const completed = task('completed', { agentRoundId: 'round-a', agentToolCallId: 'completed-call' })
    const pending = task('pending', {
      agentRoundId: 'round-a',
      agentToolCallId: 'pending-call',
      status: 'running',
      outputImages: [],
      finishedAt: null,
      elapsed: null,
      customRecoverable: true,
    })
    const value = round({
      outputTaskIds: [completed.id, pending.id],
      responseOutput: [
        { type: 'function_call', name: 'generate_image', call_id: 'completed-call' },
        { type: 'function_call_output', call_id: 'completed-call', output: '{"status":"done"}' },
        { type: 'function_call', name: 'generate_image', call_id: 'pending-call' },
      ],
    })

    expect(createReadyAgentRecoveredToolState(value, [completed, pending])).toBeNull()
  })

  it('counts recovered calls defensively and derives stable failure messages', () => {
    const output: ResponsesOutputItem[] = [
      { type: 'function_call_output', output: '{"status":"done"}' },
      { type: 'function_call_output', output: '{"images":[{"status":"done"},{"status":"error"}]}' },
      { type: 'function_call_output', output: '{bad json' },
      { type: 'function_call_output', output: [{ type: 'input_text', text: '{"status":"done"}' }] },
      { type: 'image_generation_call' },
    ]
    const doneTasks = [task('done-a'), task('done-b'), task('done-c'), task('done-d')]
    expect(countResponseToolCalls(output)).toBe(1)
    expect(getAgentRecoveredToolCallCount(output, doneTasks)).toBe(4)
    expect(getAgentRecoveredToolCallCount([{ type: 'function_call_output', output: [{ type: 'input_text', text: '{"status":"done"}' }] }], [])).toBe(0)

    const failedA = task('failed-a', { status: 'error', outputImages: [], error: '明确失败' })
    const failedB = task('failed-b', { status: 'error', outputImages: [], error: null })
    expect(getAgentRecoveredFailureError(round({ outputTaskIds: [failedA.id] }), [failedA])).toBe('明确失败')
    expect(getAgentRecoveredFailureError(round({ outputTaskIds: [failedA.id, failedB.id] }), [failedA, failedB])).toBe('部分图像生成任务失败。')
    expect(getAgentRecoveredFailureError(round(), [])).toBe('图像生成失败')
  })
})
