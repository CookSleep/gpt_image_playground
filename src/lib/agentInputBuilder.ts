import type { AgentConversation, AgentMessage, AgentRound, ResponsesOutputItem, TaskRecord } from '../types'
import { getAgentRoundPath } from './agentConversationState'
import {
  collectAgentRoundOutputImageSlots,
  getAgentCurrentReferenceId,
  getAgentGeneratedImageReferenceId,
  replaceAgentPromptImageReferencesForApi,
} from './agentImageReferences'
import { getAgentRoundResponseOutput, sanitizeResponseOutputForInput } from './agentResponseState'

type LoadImage = (id: string) => Promise<string | null | undefined>

interface BuildAgentApiInputOptions {
  conversation: AgentConversation
  currentRound: AgentRound
  tasks: TaskRecord[]
  loadImage: LoadImage
}

interface BuildAgentContinuationInputOptions {
  baseInput: unknown[]
  currentRound: AgentRound
  tasks: TaskRecord[]
  currentRoundOutput: ResponsesOutputItem[]
  functionCallOutputs?: ResponsesOutputItem[]
  batchTaskIds: string[]
  toolCallsUsed: number
  maxToolCalls: number
  loadImage: LoadImage
}

async function createUserInputItem(
  conversation: AgentConversation,
  round: AgentRound,
  message: AgentMessage,
  tasks: TaskRecord[],
  loadImage: LoadImage,
) {
  const imageDataUrls: string[] = []
  for (const id of round.inputImageIds) {
    const dataUrl = await loadImage(id)
    if (dataUrl) imageDataUrls.push(dataUrl)
  }
  const rounds = getAgentRoundPath(conversation, round.id)
  const text = replaceAgentPromptImageReferencesForApi(message.content, round, rounds, tasks)
  const referenceText = round.inputImageIds.length > 0
    ? `\n\n<available_refs>${round.inputImageIds.map((_, index) => `\n  <ref id="${getAgentCurrentReferenceId(round, index)}" />`).join('')}\n</available_refs>`
    : ''
  return {
    role: 'user',
    content: [
      { type: 'input_text', text: `${text}${referenceText}` },
      ...imageDataUrls.map((dataUrl) => ({ type: 'input_image', image_url: dataUrl })),
    ],
  }
}

function escapeXmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function createGeneratedImageReferencePart(round: AgentRound, task: TaskRecord, imageIndex: number) {
  const prompt = (typeof task.prompt === 'string' ? task.prompt : '').replace(/\s+/g, ' ').trim()
  const truncatedPrompt = prompt.length > 1200 ? `${prompt.slice(0, 1200)}...` : prompt
  const promptAttribute = truncatedPrompt ? ` prompt="${escapeXmlAttribute(truncatedPrompt)}"` : ''
  return {
    type: 'input_text',
    text: `<ref id="${getAgentGeneratedImageReferenceId(round, imageIndex)}"${promptAttribute} />`,
  }
}

async function createGeneratedImagesInputItem(round: AgentRound, tasks: TaskRecord[], loadImage: LoadImage) {
  const content: Array<{ type: string; text?: string; image_url?: string }> = []
  let imageIndex = 0
  for (const taskId of round.outputTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    if (!task) {
      content.push({ type: 'input_text', text: `<removed_ref id="${getAgentGeneratedImageReferenceId(round, imageIndex)}" />` })
      imageIndex += 1
      continue
    }
    for (const imageId of task.outputImages) {
      const dataUrl = await loadImage(imageId)
      if (dataUrl) content.push({ type: 'input_image', image_url: dataUrl })
      content.push(createGeneratedImageReferencePart(round, task, imageIndex))
      imageIndex += 1
    }
  }
  return content.length > 0 ? { role: 'user', content } : null
}

async function createBatchImagesInputItem(round: AgentRound, tasks: TaskRecord[], batchTaskIds: string[], loadImage: LoadImage) {
  const content: Array<{ type: string; text?: string; image_url?: string }> = []
  let baseImageIndex = 0
  for (const taskId of round.outputTaskIds) {
    if (batchTaskIds.includes(taskId)) break
    const task = tasks.find((item) => item.id === taskId)
    baseImageIndex += task ? task.outputImages.length : 1
  }

  let imageIndex = baseImageIndex
  for (const taskId of batchTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    if (!task || task.status !== 'done') continue
    for (const imageId of task.outputImages) {
      const dataUrl = await loadImage(imageId)
      if (dataUrl) content.push({ type: 'input_image', image_url: dataUrl })
      content.push(createGeneratedImageReferencePart(round, task, imageIndex))
      imageIndex += 1
    }
  }
  return content.length > 0 ? { role: 'user', content } : null
}

function createAssistantFallbackItem(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  }
}

export async function buildAgentApiInput(options: BuildAgentApiInputOptions): Promise<unknown[]> {
  const input: unknown[] = []
  const rounds = getAgentRoundPath(options.conversation, options.currentRound.id)

  for (const round of rounds) {
    const userMessage = options.conversation.messages.find((message) => message.id === round.userMessageId)
    if (!userMessage) continue

    input.push(await createUserInputItem(options.conversation, round, userMessage, options.tasks, options.loadImage))
    if (round.id === options.currentRound.id) continue

    const output = getAgentRoundResponseOutput(round, options.tasks)
    if (output?.length) {
      const sanitizedOutput = sanitizeResponseOutputForInput(output)
      if (sanitizedOutput.length > 0) {
        input.push(...sanitizedOutput)
      } else {
        const assistantMessage = round.assistantMessageId
          ? options.conversation.messages.find((message) => message.id === round.assistantMessageId)
          : null
        input.push(createAssistantFallbackItem(assistantMessage?.content || '图像已生成。'))
      }
    } else {
      const assistantMessage = round.assistantMessageId
        ? options.conversation.messages.find((message) => message.id === round.assistantMessageId)
        : null
      input.push(createAssistantFallbackItem(assistantMessage?.content || '[No text response]'))
    }

    if (round.outputTaskIds.length > 0) {
      const imagesItem = await createGeneratedImagesInputItem(round, options.tasks, options.loadImage)
      if (imagesItem) input.push(imagesItem)
    }
  }

  return input
}

export async function buildAgentContinuationInput(options: BuildAgentContinuationInputOptions): Promise<unknown[]> {
  const functionCallOutputIds = new Set((options.functionCallOutputs ?? [])
    .filter((item) => item.type === 'function_call_output' && item.call_id)
    .map((item) => item.call_id!))
  const currentRoundOutput = options.currentRoundOutput.filter(
    (item) => item.type !== 'function_call_output' || !item.call_id || !functionCallOutputIds.has(item.call_id),
  )
  const input = [
    ...options.baseInput,
    ...sanitizeResponseOutputForInput(currentRoundOutput, { allowPendingFunctionCalls: true }),
    ...(options.functionCallOutputs ?? []),
  ]
  const batchImagesItem = await createBatchImagesInputItem(options.currentRound, options.tasks, options.batchTaskIds, options.loadImage)
  if (batchImagesItem) input.push(batchImagesItem)

  const newImageRefs = collectAgentRoundOutputImageSlots(options.currentRound, options.tasks)
    .map((imageId, index) => imageId ? `<ref id="${getAgentGeneratedImageReferenceId(options.currentRound, index)}" />` : null)
    .filter((ref): ref is string => Boolean(ref))
  const lines = ['[System] The app has saved your generated outputs and is continuing the same Agent turn.']
  if (newImageRefs.length > 0) {
    lines.push(`The following image ref ids are now available for you to reference in subsequent image_generation prompts: ${newImageRefs.join(', ')}`)
  }
  lines.push(
    'Continue generating. Do NOT repeat what you already said in earlier responses.',
    'If you still need another round after this (e.g. more dependent images), call continue_generation.',
    `Tool-call budget: ${options.toolCallsUsed}/${options.maxToolCalls} used.`,
  )
  input.push({
    role: 'user',
    content: [{ type: 'input_text', text: lines.join('\n') }],
  })
  return input
}
