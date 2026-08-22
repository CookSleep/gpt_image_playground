import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type AppSettings, type ResponsesApiResponse, type ResponsesOutputItem, type TaskParams } from '../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { appendStreamingFormatHint, getApiErrorMessage, getResponsesImageResultBase64, maybeAppendStreamingHint, MIME_MAP, normalizeBase64Image, pickActualParams, PROMPT_REWRITE_GUARD_PREFIX } from './imageApiShared'
import { normalizeResponsesOutputItems } from './responsesOutputState'
import { isEventStreamResponse, readJsonServerSentEvents, throwIfAborted } from './serverSentEvents'

export interface AgentApiResultImage {
  toolCallId?: string
  action?: string
  dataUrl: string
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
}

export interface AgentApiImageToolFailure {
  toolCallId: string
  error: string
}

export interface AgentApiResult {
  responseId?: string
  text: string
  images: AgentApiResultImage[]
  outputItems: ResponsesApiResponse['output']
  rawResponsePayload?: string
}

const AGENT_IMAGE_INSTRUCTIONS = [
  'You are an image-generation assistant in a multi-turn gallery app.',
  '',
  '## Progressive Batch Generation',
  'For multi-image requests, use a progressive batching strategy to ensure consistency:',
  '  1. **Base Reference First:** If the images need to share a consistent style, character, or layout (e.g. PPT slides, storyboards), generate ONE primary image first to establish the visual baseline, then call continue_generation to get another round.',
  '  2. **Batch Remaining Tasks:** Once the base reference is available, list all remaining images to be generated. The app will generate them concurrently for you. In your descriptions, explicitly instruct to reference the base image to maintain consistency.',
  '  3. **Independent Images:** If the requested images are completely independent (e.g. "3 different cats"), generate them together in ONE response. Do NOT generate them one by one across multiple responses.',
  'As the turn continues, output a brief progress note before each tool call.',
  'For single-image requests, generate directly without any listing.',
  '',
  '## Generating images',
  '- One image_generation call per distinct image. Never collage.',
  '- Dependent images (a later image needs to reference an earlier one) → generate the prerequisite first, then call continue_generation. The next round will have the result available as `<ref id="..." />`.',
  '- Only generate when explicitly requested; otherwise reply with text.',
  '- Preserve the user\'s original intent faithfully. Never substitute requested subjects for copyright/trademark reasons.',
  '',
  '## Reference tags and generated images in context',
  'NEVER output `<ref>`, `<available_refs>`, `<removed_ref>`, or any XML reference tags in visible assistant text — the system injects them automatically and your raw output will be shown directly to the user.',
  '- Previously generated images are injected as user messages containing the actual image (input_image) followed by a `<ref id="round-N-image-M" prompt="..." />` tag identifying it.',
  '- Deleted images appear as `<removed_ref id="..." />` without an accompanying image — do not reference them.',
  '- In user messages: `<ref id="..." />` may also point to user-attached/cited images.',
  '- In generate_image_batch tool arguments, include matching `<ref id="..." />` tags inside each image prompt when the prompt refers to a reference image. Do not use separate bare reference ids.',
  'Resolve user mentions ("the first image") to the matching id. Only use existing ids in image_generation prompts and generate_image_batch prompts.',
].join('\n')

const AGENT_MATH_FORMATTING_INSTRUCTIONS = [
  '## Math formatting',
  '- When a response contains mathematical formulas, output them using Markdown math delimiters supported by this app.',
  '- Use `$...$` for inline formulas.',
  '- Use block math with opening and closing `$$` on their own lines for display formulas.',
  '- Do not use LaTeX delimiters like `\\(...\\)` or `\\[...\\]` in visible assistant text.',
].join('\n')

function createAgentInstructions(settings: AppSettings, codexCliSize?: string) {
  const maxToolRounds = Number.isFinite(settings.agentMaxToolRounds)
    ? Math.max(1, Math.trunc(settings.agentMaxToolRounds))
    : DEFAULT_AGENT_MAX_TOOL_ROUNDS
  const imageToolInstruction = settings.agentApiConfigMode === 'hybrid'
    ? 'Use generate_image for single-image requests and generate_image_batch for concurrent multi-image requests. The built-in image_generation tool is not available in this session.'
    : 'Use image_generation for single-image requests and generate_image_batch for concurrent multi-image requests.'
  const imageInstructions = settings.agentApiConfigMode === 'hybrid'
    ? AGENT_IMAGE_INSTRUCTIONS.replace(/image_generation/g, 'generate_image')
    : AGENT_IMAGE_INSTRUCTIONS
  const instructions = [
    imageInstructions,
    '',
    '## Tool policy',
    `- Current maximum tool-use rounds for this Agent turn: ${maxToolRounds}.`,
    `- ${imageToolInstruction}`,
    '- Call continue_generation ONLY when you have generated a prerequisite image and need another round to generate dependent images. Do NOT call it when the task is complete.',
    '- When web_search is available, use it only when current external information would improve the answer or the user asks for research/news/facts.',
    '- When the requested task is complete, stop calling tools and provide the final response.',
  ]

  if (codexCliSize && codexCliSize !== 'auto') {
    instructions.push('', `- Start every image prompt with exactly "Generate at ${codexCliSize} resolution." followed by a space.`)
  }

  if (settings.agentMathFormattingPrompt) instructions.push('', AGENT_MATH_FORMATTING_INSTRUCTIONS)

  return instructions.join('\n')
}

const AGENT_TITLE_INSTRUCTIONS = [
  'Generate a concise conversation title from the first user message.',
  'Output exactly one XML element in this form: <title>short title</title>',
  'Do not output markdown, code fences, explanations, attributes, or additional XML elements.',
  'Use the main language of the user message. Chinese titles should be no more than 12 characters. English titles should be no more than 5 words.',
  'Escape XML special characters when necessary.',
].join('\n')

const AGENT_TITLE_MAX_LENGTH = 28

function createHeaders(profile: ApiProfile): Record<string, string> {
  return {
    Authorization: `Bearer ${profile.apiKey}`,
    'Content-Type': 'application/json',
  }
}

function createImageTool(params: TaskParams, profile: ApiProfile, maskDataUrl?: string): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: 'auto',
    output_format: params.output_format,
    moderation: params.moderation,
  }

  if (!profile.codexCli) {
    tool.size = params.size
  }

  tool.quality = params.quality

  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }

  if (profile.streamImages) {
    tool.partial_images = profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
  }

  if (maskDataUrl) {
    tool.input_image_mask = {
      image_url: maskDataUrl,
    }
  }

  return tool
}

function createGenerateImageFunctionTool() {
  return {
    type: 'function',
    name: 'generate_image',
    description: [
      'Generate one image through the app image API. Use this for single-image requests or prerequisite/base images that later images must reference.',
      'The prompt must be self-contained and include full visual style descriptions.',
      'If it refers to an existing image, include the corresponding XML tag, e.g. <ref id="round-1-image-1" />, inside the prompt so the app can attach the reference image automatically.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Short stable identifier for this image, e.g. "cover", "base_character", "scene_1".',
        },
        prompt: {
          type: 'string',
          description: 'Complete image generation prompt with all visual details. Include matching XML ref tags when referring to existing images.',
        },
      },
      required: ['id', 'prompt'],
      additionalProperties: false,
    },
    strict: true,
  }
}

function createAgentTools(params: TaskParams, profile: ApiProfile, settings: AppSettings, maskDataUrl?: string): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = settings.agentApiConfigMode === 'hybrid'
    ? [createGenerateImageFunctionTool()]
    : [createImageTool(params, profile, maskDataUrl)]
  const singleImageToolInstruction = settings.agentApiConfigMode === 'hybrid'
    ? 'For single images or prerequisite/base images, use the generate_image tool instead.'
    : 'For single images or prerequisite/base images, use the built-in image_generation tool instead.'

  // generate_image_batch: custom function tool for concurrent multi-image generation
  tools.push({
    type: 'function',
    name: 'generate_image_batch',
    description: [
      'Generate multiple images concurrently. Use this ONLY when:',
      '1. There are 2+ remaining images whose prerequisites (base references) are ALL already generated.',
      '2. These images are independent of each other (none references another image in this same batch).',
      singleImageToolInstruction,
      'Each image prompt must be self-contained and include full visual style descriptions.',
      'If an image needs to match a previously generated image, include the corresponding XML tag (e.g. <ref id="round-1-image-1" />) inside that image prompt so the app can attach the reference image automatically.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          description: 'Array of images to generate concurrently.',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Short stable identifier for this image, e.g. "slide_2_problem", "scene_3".',
              },
              prompt: {
                type: 'string',
                description: 'Complete image generation prompt with all visual details. If it refers to a previous image, include the matching XML tag, e.g. <ref id="round-1-image-1" />.',
              },
            },
            required: ['id', 'prompt'],
            additionalProperties: false,
          },
        },
      },
      required: ['images'],
      additionalProperties: false,
    },
    strict: true,
  })

  // continue_generation: model calls this to request another round (e.g. after generating a prerequisite image)
  tools.push({
    type: 'function',
    name: 'continue_generation',
    description: [
      'Request another round to continue generating images.',
      'Call this ONLY when you have just generated a prerequisite/base image and still need to generate dependent images that reference it.',
      'Do NOT call this when the task is already complete.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief explanation of why another round is needed and what will be generated next.',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    strict: true,
  })

  if (settings.agentWebSearch) {
    tools.push({ type: 'web_search' })
  }
  return tools
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value ? value : undefined
}

function getNumberValue(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function escapeMarkdownLinkLabel(text: string) {
  return text.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
}

type ResponseTextAnnotation = NonNullable<NonNullable<ResponsesOutputItem['content']>[number]['annotations']>[number]

function applyUrlCitations(text: string, annotations: ResponseTextAnnotation[] | undefined) {
  const citations = (annotations ?? [])
    .filter((annotation) =>
      annotation.type === 'url_citation' &&
      typeof annotation.url === 'string' &&
      annotation.url.trim() &&
      typeof annotation.start_index === 'number' &&
      typeof annotation.end_index === 'number' &&
      annotation.start_index >= 0 &&
      annotation.end_index > annotation.start_index &&
      annotation.end_index <= text.length,
    )
    .sort((a, b) => (a.start_index ?? 0) - (b.start_index ?? 0))

  if (citations.length === 0) return text

  let cursor = 0
  let output = ''
  for (const citation of citations) {
    const start = citation.start_index ?? 0
    const end = citation.end_index ?? start
    if (start < cursor) continue

    output += text.slice(cursor, start)
    const label = text.slice(start, end) || citation.title || citation.url || 'source'
    output += `[${escapeMarkdownLinkLabel(label)}](${citation.url})`
    cursor = end
  }
  output += text.slice(cursor)
  return output
}

function getStreamEventErrorMessage(event: Record<string, unknown>): string | null {
  const error = event.error
  if (isRecordValue(error)) {
    const message = getStringValue(error, 'message')
    if (message) return message
  }
  if (typeof error === 'string' && error.trim()) return error

  const type = getStringValue(event, 'type')
  if (type?.endsWith('.failed')) return getStringValue(event, 'message') ?? 'Agent 流式请求失败'
  return null
}

function getErrorMessageFromValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!isRecordValue(value)) return null

  return getStringValue(value, 'message')
    ?? getStringValue(value, 'code')
    ?? null
}

function getImageToolFailureFromOutputItem(event: Record<string, unknown>, item?: ResponsesOutputItem): AgentApiImageToolFailure | null {
  if (item?.type !== 'image_generation_call' || item.status !== 'failed') return null

  const toolCallId = (typeof item?.id === 'string' && item.id)
    || getStringValue(event, 'item_id')
  if (!toolCallId) return null

  const itemRecord = item as Record<string, unknown> | undefined
  const error = getErrorMessageFromValue(itemRecord?.error)
    ?? getErrorMessageFromValue(event.error)
    ?? getStringValue(event, 'message')
    ?? '内置 image_generation 工具调用失败'

  return {
    toolCallId,
    error,
  }
}

function extractText(payload: ResponsesApiResponse) {
  const chunks: string[] = []

  for (const item of payload.output ?? []) {
    if (item.type !== 'message') continue
    for (const part of item.content ?? []) {
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        chunks.push(applyUrlCitations(part.text, part.annotations))
      } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
        chunks.push(part.refusal)
      }
    }
  }

  return chunks.join('\n').trim()
}

function decodeXmlText(text: string) {
  return text.replace(/&(?:#(\d+)|#x([\da-fA-F]+)|amp|lt|gt|quot|apos);/g, (entity, decimal: string | undefined, hex: string | undefined) => {
    if (decimal) return String.fromCodePoint(Number(decimal))
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
    switch (entity) {
      case '&amp;': return '&'
      case '&lt;': return '<'
      case '&gt;': return '>'
      case '&quot;': return '"'
      case '&apos;': return "'"
      default: return entity
    }
  })
}

function parseAgentConversationTitleXml(text: string) {
  const match = text.match(/<title>([\s\S]*?)<\/title>/i)
  const title = match ? decodeXmlText(match[1]).trim() : ''
  const chars = Array.from(title)
  if (chars.length <= AGENT_TITLE_MAX_LENGTH) return title
  return `${chars.slice(0, AGENT_TITLE_MAX_LENGTH - 3).join('')}...`
}

function extractImages(payload: ResponsesApiResponse, fallbackMime: string): AgentApiResultImage[] {
  const images: AgentApiResultImage[] = []

  for (const item of payload.output ?? []) {
    if (item.type !== 'image_generation_call') continue

    const b64 = getResponsesImageResultBase64(item.result)
    if (!b64) continue
    images.push({
      toolCallId: typeof item.id === 'string' ? item.id : undefined,
      action: typeof item.action === 'string' ? item.action : undefined,
      dataUrl: normalizeBase64Image(b64, fallbackMime),
      actualParams: pickActualParams(item),
      revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
    })
  }

  return images
}

function extractImageFromOutputItem(item: ResponsesOutputItem, fallbackMime: string): AgentApiResultImage | null {
  if (item.type !== 'image_generation_call') return null

  const b64 = getResponsesImageResultBase64(item.result)
  if (!b64) return null
  return {
    toolCallId: typeof item.id === 'string' ? item.id : undefined,
    action: typeof item.action === 'string' ? item.action : undefined,
    dataUrl: normalizeBase64Image(b64, fallbackMime),
    actualParams: pickActualParams(item),
    revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
  }
}

function normalizeResponsePayload(value: unknown): ResponsesApiResponse | null {
  if (!isRecordValue(value)) return null
  return {
    ...value,
    ...(typeof value.id === 'string' ? { id: value.id } : { id: undefined }),
    output: normalizeResponsesOutputItems(value.output),
  }
}

function getStreamResponsePayload(event: Record<string, unknown>): ResponsesApiResponse | null {
  const response = event.response
  const payload = normalizeResponsePayload(response)
  if (payload) return payload

  const item = event.item
  const output = normalizeResponsesOutputItems([item])
  if (output.length) return { output }

  return null
}

async function parseAgentStreamResponse(
  response: Response,
  mime: string,
  signal?: AbortSignal,
  callerSignal?: AbortSignal,
  onTextDelta?: (delta: string) => void,
  onOutputItems?: (outputItems: ResponsesOutputItem[]) => void,
  onImageToolStarted?: (event: { toolCallId: string; outputIndex?: number }) => void | Promise<void>,
  onImagePartialImage?: (event: { toolCallId: string; image: string; partialImageIndex?: number; outputIndex?: number }) => void | Promise<void>,
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>,
  onImageToolFailed?: (event: AgentApiImageToolFailure) => void | Promise<void>,
): Promise<AgentApiResult> {
  let completedPayload: ResponsesApiResponse | null = null
  const outputItems: ResponsesOutputItem[] = []
  let streamedText = ''

  const publishOutputItems = (items: ResponsesOutputItem[], outputIndices?: Array<number | undefined>) => {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      const outputIndex = outputIndices?.[i]
      let index = item.id ? outputItems.findIndex((existing) => existing.id === item.id) : -1
      // `response.completed` snapshots can omit item ids; match by output slot before appending.
      if (index < 0 && !item.id && typeof outputIndex === "number" && outputIndex >= 0 && outputIndex < outputItems.length) {
        const candidate = outputItems[outputIndex]
        if (candidate?.type === item.type) index = outputIndex
      }
      if (index < 0 && !item.id && item.type) {
        // Fallback for snapshots that do not expose output indices.
        const sameTypeIndices = outputItems
          .map((existing, idx) => existing.type === item.type ? idx : -1)
          .filter((idx) => idx >= 0)
        if (sameTypeIndices.length === 1) index = sameTypeIndices[0]
      }
      if (index >= 0) outputItems[index] = item
      else outputItems.push(item)
    }
    onOutputItems?.([...outputItems])
  }

  const publishWebSearchStatus = (event: Record<string, unknown>, status: string, actionType?: string) => {
    const id = getStringValue(event, 'item_id')
    if (!id) return

    const index = outputItems.findIndex((item) => item.id === id)
    const current = index >= 0 ? outputItems[index] : { id, type: 'web_search_call' }
    const next: ResponsesOutputItem = {
      ...current,
      id,
      type: 'web_search_call',
      status,
      ...(actionType ? { action: { type: actionType } } : {}),
    }
    if (index >= 0) outputItems[index] = next
    else outputItems.push(next)
    onOutputItems?.([...outputItems])
  }

  await readJsonServerSentEvents(response, async (event) => {
    const type = getStringValue(event, 'type')

    if (type === 'response.image_generation_call.partial_image') {
      const toolCallId = getStringValue(event, 'item_id')
      const b64 = getStringValue(event, 'partial_image_b64')
      if (toolCallId && b64) {
        await onImagePartialImage?.({
          toolCallId,
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
          outputIndex: getNumberValue(event, 'output_index'),
        })
      }
      return
    }

    if (type === 'response.web_search_call.searching') {
      publishWebSearchStatus(event, 'in_progress', 'search')
      return
    }
    if (type === 'response.web_search_call.completed') {
      publishWebSearchStatus(event, 'completed')
      return
    }
    if (type === 'response.web_search_call.failed') {
      publishWebSearchStatus(event, 'failed')
      return
    }
    if (type === 'response.web_search_call.in_progress') {
      publishWebSearchStatus(event, 'in_progress')
      return
    }

    if (type === 'response.output_text.delta') {
      const delta = getStringValue(event, 'delta')
      if (delta) {
        streamedText += delta
        onTextDelta?.(delta)
      }
      return
    }

    const payload = getStreamResponsePayload(event)
    if (!payload) return

    if (Array.isArray(payload.output)) {
      // `response.completed` uses the output array position as the implicit output index.
      const indices = type === "response.completed" ? payload.output.map((_, idx) => idx) : undefined
      publishOutputItems(payload.output, indices)
    }

    if (type === 'response.output_item.added') {
      const item = payload.output?.[0]
      if (item?.type === 'image_generation_call' && typeof item.id === 'string' && item.id) {
        await onImageToolStarted?.({
          toolCallId: item.id,
          outputIndex: getNumberValue(event, 'output_index'),
        })
      }
      return
    }

    if (type === 'response.output_item.done') {
      const item = payload.output?.[0]
      const imageFailure = getImageToolFailureFromOutputItem(event, item)
      if (imageFailure) {
        await onImageToolFailed?.(imageFailure)
        return
      }

      const image = item ? extractImageFromOutputItem(item, mime) : null
      if (image) await onImageToolCompleted?.(image)
      return
    }

    if (type === 'response.completed' || isRecordValue(event.response)) {
      completedPayload = payload
    }
  }, {
    signals: [signal, callerSignal],
    formatErrorMessage: appendStreamingFormatHint,
    getEventErrorMessage: getStreamEventErrorMessage,
  })

  throwIfAborted(signal, callerSignal)
  const payload: ResponsesApiResponse | null = completedPayload ?? (outputItems.length ? { output: outputItems } : null)
  if (!payload) throw new Error('Agent 流式接口未返回最终响应数据')

  const text = extractText(payload) || streamedText.trim()
  return {
    responseId: payload.id,
    text,
    images: extractImages(payload, mime),
    outputItems: payload.output ?? [],
    rawResponsePayload: JSON.stringify(payload, null, 2),
  }
}

export async function callAgentResponsesApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  imageProfile?: ApiProfile
  params: TaskParams
  input: unknown
  maskDataUrl?: string
  signal?: AbortSignal
  onTextDelta?: (delta: string) => void
  onOutputItems?: (outputItems: ResponsesOutputItem[]) => void
  onImageToolStarted?: (event: { toolCallId: string; outputIndex?: number }) => void | Promise<void>
  onImagePartialImage?: (event: { toolCallId: string; image: string; partialImageIndex?: number; outputIndex?: number }) => void | Promise<void>
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>
  onImageToolFailed?: (event: AgentApiImageToolFailure) => void | Promise<void>
}): Promise<AgentApiResult> {
  const { settings, profile, imageProfile, params, input, maskDataUrl, signal, onTextDelta, onOutputItems, onImageToolStarted, onImagePartialImage, onImageToolCompleted, onImageToolFailed } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const body: Record<string, unknown> = {
      model: profile.model || settings.model,
      instructions: createAgentInstructions(settings, (imageProfile ?? profile).codexCli ? params.size : undefined),
      input,
      tools: createAgentTools(params, profile, settings, maskDataUrl),
    }
    if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }
    if (profile.streamImages) {
      body.stream = true
    }

    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: createHeaders(profile),
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorMessage = await getApiErrorMessage(response)
      throw new Error(maybeAppendStreamingHint(errorMessage, response.status, profile.streamImages))
    }

    if (profile.streamImages && isEventStreamResponse(response)) {
      return parseAgentStreamResponse(response, mime, controller.signal, signal, onTextDelta, onOutputItems, onImageToolStarted, onImagePartialImage, onImageToolCompleted, onImageToolFailed)
    }

    const rawPayload = await response.json() as unknown
    const payload = normalizeResponsePayload(rawPayload)
    if (!payload) throw new Error('Agent 接口返回格式无效')
    throwIfAborted(controller.signal, signal)
    return {
      responseId: payload.id,
      text: extractText(payload),
      images: extractImages(payload, mime),
      outputItems: payload.output,
      rawResponsePayload: JSON.stringify(payload, null, 2),
    }
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function callAgentConversationTitleApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  prompt: string
  imageDataUrls?: string[]
  signal?: AbortSignal
}): Promise<string> {
  const { settings, profile, prompt, imageDataUrls, signal } = opts
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const content: Array<Record<string, string>> = [
      { type: 'input_text', text: `The following is the first message the user sent in a conversation. Generate a title for this conversation.\n\n${prompt}` },
    ]
    for (const dataUrl of imageDataUrls ?? []) {
      content.push({ type: 'input_image', image_url: dataUrl })
    }

    const body: Record<string, unknown> = {
      model: profile.model || settings.model,
      instructions: AGENT_TITLE_INSTRUCTIONS,
      input: [{ role: 'user', content }],
    }
    if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }

    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: createHeaders(profile),
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    const payload = normalizeResponsePayload(await response.json())
    if (!payload) throw new Error('Agent 标题接口返回格式无效')
    return parseAgentConversationTitleXml(extractText(payload))
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

// ---------------------------------------------------------------------------
// Batch image generation: execute a single image via Responses API.
// Uses the same pattern as gallery Responses API mode.
// ---------------------------------------------------------------------------

export interface BatchImageCallResult {
  /** The batch item id from the model's function call */
  batchItemId: string
  image: AgentApiResultImage | null
  error: string | null
  rawResponsePayload?: string
}

/**
 * Generate a single image using Responses API.
 * This mirrors the gallery mode's callResponsesImageApiSingle pattern.
 */
export async function callBatchImageSingle(opts: {
  profile: ApiProfile
  params: TaskParams
  batchItemId: string
  prompt: string
  referenceImageDataUrls: string[]
  referenceIds?: string[]
  allowPromptRewrite?: boolean
  signal?: AbortSignal
  onImageToolStarted?: () => void | Promise<void>
  onPartialImage?: (event: { image: string; partialImageIndex?: number }) => void | Promise<void>
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>
}): Promise<BatchImageCallResult> {
  const { profile, params, batchItemId, prompt, referenceImageDataUrls, referenceIds, allowPromptRewrite, signal, onImageToolStarted, onPartialImage, onImageToolCompleted } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const referenceMapping = referenceImageDataUrls.length > 0
      ? `Attached reference images correspond to these ids, in order: ${(referenceIds ?? []).map((id) => `<ref id="${id}" />`).join(', ') || 'reference images'}.`
      : ''
    const promptText = allowPromptRewrite ? prompt : `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
    const guardedPrompt = [referenceMapping, promptText].filter(Boolean).join('\n\n')
    let input: unknown
    if (referenceImageDataUrls.length > 0) {
      input = [{
        role: 'user',
        content: [
          { type: 'input_text', text: guardedPrompt },
          ...referenceImageDataUrls.map((dataUrl) => ({
            type: 'input_image',
            image_url: dataUrl,
          })),
        ],
      }]
    } else {
      input = guardedPrompt
    }

    // Build image_generation tool with current params
    const tool: Record<string, unknown> = {
      type: 'image_generation',
      action: referenceImageDataUrls.length > 0 ? 'auto' : 'generate',
      output_format: params.output_format,
      moderation: params.moderation,
      quality: params.quality,
    }
    if (!profile.codexCli) {
      tool.size = params.size
    }
    if (params.output_format !== 'png' && params.output_compression != null) {
      tool.output_compression = params.output_compression
    }
    if (profile.streamImages) {
      tool.partial_images = profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
    }

    const body: Record<string, unknown> = {
      model: profile.model,
      input,
      tools: [tool],
      tool_choice: 'required',
    }
    if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }
    if (profile.streamImages) {
      body.stream = true
    }

    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: createHeaders(profile),
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorMsg = await getApiErrorMessage(response)
      return { batchItemId, image: null, error: maybeAppendStreamingHint(errorMsg, response.status, profile.streamImages) }
    }

    // Handle streaming
    if (profile.streamImages && isEventStreamResponse(response)) {
      await onImageToolStarted?.()
      let completedImage: AgentApiResultImage | null = null
      let rawPayload: string | undefined

      await readJsonServerSentEvents(response, async (event) => {
        const type = getStringValue(event, 'type')

        if (type === 'response.image_generation_call.partial_image') {
          const b64 = getStringValue(event, 'partial_image_b64')
          if (b64) {
            await onPartialImage?.({
              image: normalizeBase64Image(b64, mime),
              partialImageIndex: getNumberValue(event, 'partial_image_index'),
            })
          }
          return
        }

        if (type === 'response.output_item.done') {
          const payload = getStreamResponsePayload(event)
          const item = payload?.output?.[0]
          if (item) {
            const img = extractImageFromOutputItem(item, mime)
            if (img) {
              completedImage = img
              await onImageToolCompleted?.(img)
            }
          }
          return
        }

        if (type === 'response.completed' || isRecordValue(event.response)) {
          const payload = getStreamResponsePayload(event)
          if (payload) rawPayload = JSON.stringify(payload, null, 2)
          if (!completedImage && payload) {
            const images = extractImages(payload, mime)
            if (images.length > 0) {
              completedImage = images[0]
              await onImageToolCompleted?.(completedImage)
            }
          }
        }
      }, {
        signals: [controller.signal, signal],
        formatErrorMessage: appendStreamingFormatHint,
        getEventErrorMessage: getStreamEventErrorMessage,
      })

      return {
        batchItemId,
        image: completedImage,
        error: completedImage ? null : '流式响应未返回图片',
        rawResponsePayload: rawPayload,
      }
    }

    // Non-streaming
    const payload = normalizeResponsePayload(await response.json())
    if (!payload) throw new Error('图像接口返回格式无效')
    const images = extractImages(payload, mime)
    const image = images[0] ?? null
    if (image) await onImageToolCompleted?.(image)
    return {
      batchItemId,
      image,
      error: image ? null : '接口未返回图片数据',
      rawResponsePayload: JSON.stringify(payload, null, 2),
    }
  } catch (err) {
    if (controller.signal.aborted || signal?.aborted) {
      return { batchItemId, image: null, error: '请求已取消' }
    }
    return { batchItemId, image: null, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

/** Parse the arguments of a generate_image_batch function call */
export function parseBatchImageCallArguments(args: string): Array<{ id: string; prompt: string }> | null {
  try {
    const parsed = JSON.parse(args) as { images?: unknown }
    if (!parsed || !Array.isArray(parsed.images)) return null
    const items: Array<{ id: string; prompt: string }> = []
    const ids = new Set<string>()
    for (const raw of parsed.images) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
      if (!prompt) continue
      const baseId = (typeof item.id === 'string' ? item.id.trim() : '') || `image_${items.length + 1}`
      let id = baseId
      for (let suffix = 2; ids.has(id); suffix++) id = `${baseId}_${suffix}`
      ids.add(id)
      items.push({ id, prompt })
    }
    return items.length > 0 ? items : null
  } catch {
    return null
  }
}
