import { describe, expect, it, vi } from 'vitest'
import type { AgentConversation, AgentMessage, AgentRound, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { getSelectedImageMentionLabel } from './promptImageMentions'
import { buildAgentApiInput, buildAgentContinuationInput } from './agentInputBuilder'

function round(id: string, index: number, patch: Partial<AgentRound> = {}): AgentRound {
  return {
    id,
    index,
    parentRoundId: index > 1 ? `round-${index - 1}` : null,
    userMessageId: `user-${id}`,
    prompt: id,
    inputImageIds: [],
    outputTaskIds: [],
    status: 'done',
    error: null,
    createdAt: index,
    finishedAt: index,
    ...patch,
  }
}

function message(round: AgentRound, content: string, patch: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: round.userMessageId,
    role: 'user',
    content,
    roundId: round.id,
    createdAt: round.createdAt,
    ...patch,
  }
}

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: id,
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...patch,
  }
}

function conversation(rounds: AgentRound[], messages: AgentMessage[]): AgentConversation {
  return {
    id: 'conversation-a',
    title: '对话',
    activeRoundId: rounds[rounds.length - 1]?.id ?? null,
    createdAt: 1,
    updatedAt: 2,
    rounds,
    messages,
  }
}

const noImage = async () => undefined

describe('agent input builder', () => {
  it('builds a normal current-round user input', async () => {
    const currentRound = round('round-1', 1, { status: 'running', finishedAt: null })

    const input = await buildAgentApiInput({
      conversation: conversation([currentRound], [message(currentRound, '画一只猫')]),
      currentRound,
      tasks: [],
      loadImage: noImage,
    })

    expect(input).toEqual([{
      role: 'user',
      content: [{ type: 'input_text', text: '画一只猫' }],
    }])
  })

  it('uses only the current branch path', async () => {
    const first = round('round-1', 1, { assistantMessageId: 'assistant-1' })
    const branchA = round('round-2-a', 2, { parentRoundId: first.id, assistantMessageId: 'assistant-2-a' })
    const branchB = round('round-2-b', 2, { parentRoundId: first.id, assistantMessageId: 'assistant-2-b' })
    const currentRound = round('round-3', 3, { parentRoundId: branchB.id, status: 'running', finishedAt: null })
    const messages = [
      message(first, '根消息'),
      message(first, '根回复', { id: 'assistant-1', role: 'assistant' }),
      message(branchA, '分支 A'),
      message(branchA, 'A 回复', { id: 'assistant-2-a', role: 'assistant' }),
      message(branchB, '分支 B'),
      message(branchB, 'B 回复', { id: 'assistant-2-b', role: 'assistant' }),
      message(currentRound, '当前消息'),
    ]

    const input = await buildAgentApiInput({
      conversation: conversation([first, branchA, branchB, currentRound], messages),
      currentRound,
      tasks: [],
      loadImage: noImage,
    })
    const serialized = JSON.stringify(input)

    expect(serialized).toContain('根消息')
    expect(serialized).toContain('分支 B')
    expect(serialized).toContain('当前消息')
    expect(serialized).not.toContain('分支 A')
    expect(serialized).not.toContain('A 回复')
  })

  it('replaces image mentions and appends matching image and XML references', async () => {
    const currentRound = round('round-3', 3, {
      parentRoundId: null,
      inputImageIds: ['image-a', 'image-b'],
      status: 'running',
      finishedAt: null,
    })
    const loadImage = vi.fn(async (id: string) => `data:${id}`)

    const input = await buildAgentApiInput({
      conversation: conversation([currentRound], [message(currentRound, `参考 ${getSelectedImageMentionLabel(1)} 生成`)]),
      currentRound,
      tasks: [],
      loadImage,
    })
    const serialized = JSON.stringify(input)

    expect(serialized).toContain('参考 <ref id=\\"round-3-reference-2\\" /> 生成')
    expect(serialized).toContain('<available_refs>')
    expect(serialized).toContain('data:image-a')
    expect(serialized).toContain('data:image-b')
    expect(loadImage).toHaveBeenCalledTimes(2)
  })

  it('keeps declared references when an input image is missing', async () => {
    const currentRound = round('round-1', 1, { inputImageIds: ['missing-image'], status: 'running', finishedAt: null })

    const input = await buildAgentApiInput({
      conversation: conversation([currentRound], [message(currentRound, '继续')]),
      currentRound,
      tasks: [],
      loadImage: noImage,
    })
    const serialized = JSON.stringify(input)

    expect(serialized).toContain('<ref id=\\"round-1-reference-1\\" />')
    expect(serialized).not.toContain('input_image')
  })

  it('propagates image loading failures', async () => {
    const currentRound = round('round-1', 1, { inputImageIds: ['broken-image'], status: 'running', finishedAt: null })

    await expect(buildAgentApiInput({
      conversation: conversation([currentRound], [message(currentRound, '继续')]),
      currentRound,
      tasks: [],
      loadImage: async () => {
        throw new Error('image read failed')
      },
    })).rejects.toThrow('image read failed')
  })

  it('restores historical output from a legacy task payload and stored generated image', async () => {
    const previous = round('round-1', 1, { outputTaskIds: ['legacy-task'], assistantMessageId: 'assistant-1' })
    const currentRound = round('round-2', 2, { parentRoundId: previous.id, status: 'running', finishedAt: null })
    const legacyTask = task('legacy-task', {
      prompt: '猫 & "光"',
      outputImages: ['generated-image'],
      rawResponsePayload: JSON.stringify({
        output: [
          { type: 'message', content: [{ type: 'output_text', text: '历史回复' }] },
          { type: 'image_generation_call', result: 'legacy-base64' },
        ],
      }),
    })

    const input = await buildAgentApiInput({
      conversation: conversation([previous, currentRound], [
        message(previous, '历史请求'),
        message(previous, '历史回复', { id: 'assistant-1', role: 'assistant' }),
        message(currentRound, '继续'),
      ]),
      currentRound,
      tasks: [legacyTask],
      loadImage: async (id) => id === 'generated-image' ? 'data:restored-image' : undefined,
    })
    const serialized = JSON.stringify(input)

    expect(serialized.match(/历史回复/g)).toHaveLength(1)
    expect(serialized).toContain('data:restored-image')
    expect(serialized).toContain('round-1-image-1')
    expect(serialized).toContain('猫 &amp; &quot;光&quot;')
    expect(serialized).not.toContain('image_generation_call')
    expect(serialized).not.toContain('legacy-base64')
  })

  it('builds input safely from malformed legacy response output', async () => {
    const previous = round('round-1', 1, { outputTaskIds: ['legacy-task'] })
    const currentRound = round('round-2', 2, { parentRoundId: previous.id, status: 'running', finishedAt: null })
    const legacyTask = task('legacy-task', {
      rawResponsePayload: JSON.stringify({
        output: [
          { type: 'message', content: [
            null,
            { type: 'output_text', text: 123 },
            { type: 'output_text', text: '安全历史回复' },
            { type: 'refusal', refusal: '历史拒绝回复' },
            { type: 'future_content_part', payload: true },
          ] },
          { type: 'function_call', call_id: 'bad-call', name: 'tool', arguments: null },
          { type: 'function_call_output', call_id: 'bad-call', output: null },
          { type: 'function_call', call_id: 'paired', name: 'tool', arguments: '{}' },
          { type: 'function_call_output', call_id: 'paired', output: '{}' },
          { type: 'function_call', call_id: 'content-output', name: 'tool', arguments: '{}' },
          { type: 'function_call_output', call_id: 'content-output', output: [
            { type: 'input_text', text: '数组工具输出' },
            { type: 'future_input_part', payload: true },
          ] },
          { type: 'future_response_item', payload: true },
        ],
      }),
    })

    const input = await buildAgentApiInput({
      conversation: conversation([previous, currentRound], [message(previous, '历史请求'), message(currentRound, '继续')]),
      currentRound,
      tasks: [legacyTask],
      loadImage: noImage,
    })
    const serialized = JSON.stringify(input)

    expect(serialized).toContain('安全历史回复')
    expect(serialized).toContain('历史拒绝回复')
    expect(serialized).toContain('数组工具输出')
    expect(serialized).toContain('future_input_part')
    expect(serialized).toContain('future_response_item')
    expect(serialized).toContain('paired')
    expect(serialized).not.toContain('bad-call')
    expect(input).toContainEqual({
      role: 'assistant',
      content: [
        { type: 'output_text', text: '安全历史回复' },
        { type: 'output_text', text: '历史拒绝回复' },
      ],
    })
    expect(serialized).not.toContain('"type":"refusal"')
  })

  it('marks deleted historical output slots without restoring deleted payloads', async () => {
    const previous = round('round-1', 1, {
      outputTaskIds: ['deleted-task', 'live-task'],
      responseOutput: [
        { type: 'message', content: [{ type: 'output_text', text: '完成两张图' }] },
        { type: 'image_generation_call', id: 'deleted-call', result: 'deleted-payload' },
        { type: 'image_generation_call', id: 'live-call', result: 'live-payload' },
      ],
    })
    const currentRound = round('round-2', 2, { parentRoundId: previous.id, status: 'running', finishedAt: null })

    const input = await buildAgentApiInput({
      conversation: conversation([previous, currentRound], [message(previous, '生成'), message(currentRound, '继续')]),
      currentRound,
      tasks: [task('live-task', { outputImages: ['live-image'] })],
      loadImage: async (id) => id === 'live-image' ? 'data:live-image' : undefined,
    })
    const serialized = JSON.stringify(input)

    expect(serialized).toContain('<removed_ref id=\\"round-1-image-1\\" />')
    expect(serialized).toContain('<ref id=\\"round-1-image-2\\"')
    expect(serialized).toContain('data:live-image')
    expect(serialized).not.toContain('deleted-payload')
    expect(serialized).not.toContain('image_generation_call')
  })

  it('treats a missing legacy task prompt as an empty reference prompt', async () => {
    const previous = round('round-1', 1, { outputTaskIds: ['legacy-task'] })
    const currentRound = round('round-2', 2, { parentRoundId: previous.id, status: 'running', finishedAt: null })
    const legacyTask = {
      ...task('legacy-task', { outputImages: ['legacy-image'] }),
      prompt: undefined,
    } as unknown as TaskRecord

    const input = await buildAgentApiInput({
      conversation: conversation([previous, currentRound], [message(previous, '历史请求'), message(currentRound, '继续')]),
      currentRound,
      tasks: [legacyTask],
      loadImage: async () => 'data:legacy-image',
    })

    expect(input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '历史请求' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: '[No text response]' }] },
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:legacy-image' },
          { type: 'input_text', text: '<ref id="round-1-image-1" />' },
        ],
      },
      { role: 'user', content: [{ type: 'input_text', text: '继续' }] },
    ])
  })

  it('builds the exact active-path continuation with historical and batch images', async () => {
    const first = round('round-1', 1, {
      assistantMessageId: 'assistant-1',
      outputTaskIds: ['base-task'],
      responseOutput: [{ type: 'message', content: [{ type: 'output_text', text: '基础完成' }] }],
    })
    const sibling = round('round-2-a', 2, { parentRoundId: first.id })
    const currentRound = round('round-2-b', 2, {
      parentRoundId: first.id,
      outputTaskIds: ['existing-task', 'batch-done', 'batch-running'],
      status: 'running',
      finishedAt: null,
    })
    const tasks = [
      task('base-task', { prompt: '基础图', outputImages: ['base-image'] }),
      task('existing-task', { outputImages: ['existing-image'] }),
      task('batch-done', { prompt: '批量图', outputImages: ['batch-image'], agentBatchCallId: 'batch-call' }),
      task('batch-running', { status: 'running', outputImages: ['partial-image'], agentBatchCallId: 'batch-call' }),
    ]
    const baseInput = await buildAgentApiInput({
      conversation: conversation([first, sibling, currentRound], [
        message(first, '生成基础'),
        message(first, '消息中的回退回复', { id: 'assistant-1', role: 'assistant' }),
        message(sibling, '分支 A'),
        message(currentRound, '分支 B 批量继续'),
      ]),
      currentRound,
      tasks,
      loadImage: async (id) => `data:${id}`,
    })
    const functionCall = {
      type: 'function_call' as const,
      name: 'generate_image_batch',
      call_id: 'batch-call',
      arguments: '{"images":[{"id":"batch","prompt":"批量图"}]}',
    }
    const functionOutput = {
      type: 'function_call_output' as const,
      call_id: 'batch-call',
      output: '{"images":[{"id":"batch","status":"done"}]}',
    }

    const input = await buildAgentContinuationInput({
      baseInput,
      currentRound,
      tasks,
      currentRoundOutput: [functionCall],
      functionCallOutputs: [functionOutput],
      batchTaskIds: ['batch-done', 'batch-running'],
      toolCallsUsed: 1,
      maxToolCalls: 3,
      loadImage: async (id) => `data:${id}`,
    })

    expect(input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '生成基础' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: '基础完成' }] },
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:base-image' },
          { type: 'input_text', text: '<ref id="round-1-image-1" prompt="基础图" />' },
        ],
      },
      { role: 'user', content: [{ type: 'input_text', text: '分支 B 批量继续' }] },
      functionCall,
      functionOutput,
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:batch-image' },
          { type: 'input_text', text: '<ref id="round-2-image-2" prompt="批量图" />' },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'input_text',
          text: [
            '[System] The app has saved your generated outputs and is continuing the same Agent turn.',
            'The following image ref ids are now available for you to reference in subsequent image_generation prompts: <ref id="round-2-image-1" />, <ref id="round-2-image-2" />, <ref id="round-2-image-3" />',
            'Continue generating. Do NOT repeat what you already said in earlier responses.',
            'If you still need another round after this (e.g. more dependent images), call continue_generation.',
            'Tool-call budget: 1/3 used.',
          ].join('\n'),
        }],
      },
    ])
  })

  it('builds continuation with sanitized output and function results before the system message', async () => {
    const currentRound = round('round-1', 1, { status: 'running', finishedAt: null })
    const functionOutput = { type: 'function_call_output' as const, call_id: 'continue-call', output: '{"status":"continued"}' }

    const input = await buildAgentContinuationInput({
      baseInput: [{ role: 'user', content: [{ type: 'input_text', text: '开始' }] }],
      currentRound,
      tasks: [],
      currentRoundOutput: [
        { type: 'web_search_call', id: 'web-call' },
        { type: 'image_generation_call', id: 'image-call', result: 'payload' },
        { type: 'function_call', name: 'continue_generation', call_id: 'continue-call', arguments: '{}' },
        { type: 'function_call_output', call_id: 'continue-call', output: '{"status":"stale"}' },
      ],
      functionCallOutputs: [functionOutput],
      batchTaskIds: [],
      toolCallsUsed: 2,
      maxToolCalls: 2,
      loadImage: noImage,
    })
    const serialized = JSON.stringify(input)

    expect(serialized).toContain('continue_generation')
    expect(serialized).toContain('function_call_output')
    expect(serialized).not.toContain('web-call')
    expect(serialized).not.toContain('image-call')
    expect(serialized).not.toContain('payload')
    expect(serialized).not.toContain('stale')
    expect(input[input.length - 2]).toEqual(functionOutput)
    expect(JSON.stringify(input[input.length - 1])).toContain('Tool-call budget: 2/2 used.')
  })
})
