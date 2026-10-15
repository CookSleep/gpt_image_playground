import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { splitBatchPrompts } from './batchPrompts'
import { getActiveApiProfile, normalizeSettings, resolveApiProfileModel, splitModelList, validateApiProfile } from './apiProfiles'
import { storeImage } from './db'
import { ensureImageCached } from './imageCache'
import { isPresetConfigOnlyEnabled, isPresetProfile } from './presetConfig'
import { retryTask, submitTask, useStore } from '../store'
import type { InputImage, TaskParams, TaskRecord } from '../types'

/** 仅客户端：本地 MCP 服务的设置，保存在本机数据库中，不随备份导出 */
export interface McpStatus {
  enabled: boolean
  port: number
  token: string
  /** 生图失败后的自动重试次数，0 为不重试 */
  maxRetries: number
  /** 两次重试之间等待的秒数 */
  retryInterval: number
  running: boolean
  error: string | null
}

export const getMcpStatus = () => invoke<McpStatus>('mcp_get')

export const setMcpStatus = (
  opts: Pick<McpStatus, 'enabled' | 'port' | 'maxRetries' | 'retryInterval'> & { regenerateToken?: boolean },
) => invoke<McpStatus>('mcp_set', { ...opts, regenerateToken: opts.regenerateToken ?? false })

interface McpRequest {
  id: number
  tool: string
  arguments: Record<string, unknown>
  /** Rust 侧在初始化时发放的会话 id；客户端没有带回时为 null */
  session: string | null
}

interface McpReply {
  text: string
  images: Array<{ mime: string; data: string }>
}

const MAX_IMAGES_PER_TASK = 4
const MAX_PROMPTS_PER_CALL = 8
const MAX_IMAGES_PER_CALL = 16

/** 重试也没用的错误：鉴权、额度、内容审核、配置缺失，直接把错误交给 Agent */
const NO_RETRY_PATTERN = /api key|apikey|unauthorized|forbidden|\b40[13]\b|billing|quota|insufficient|balance|safety|moderation|content[_ ]policy|policy violation|余额|额度|审核|违规|API 配置/i

const QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
const OUTPUT_FORMATS = ['png', 'jpeg', 'webp']

function splitDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s)
  return match ? { mime: match[1], data: match[2] } : null
}

/** 参数缺省或不是数字时用 fallback，否则取整并限制在范围内 */
function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const num = Number(value)
  if (value == null || !Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.floor(num)))
}

async function readImages(ids: string[]) {
  const images: McpReply['images'] = []
  for (const id of ids) {
    const dataUrl = await ensureImageCached(id)
    const parts = dataUrl && splitDataUrl(dataUrl)
    if (parts) images.push(parts)
  }
  return images
}

/** 每个 Agent 会话各自的覆盖：切换配置和默认参数只对该会话生效，不改应用里的设置；taskIds 是它自己生成的任务 */
interface Session {
  params: Partial<TaskParams>
  profileId?: string
  model?: string
  taskIds: Set<string>
}

const MAX_SESSIONS = 50
// 没带会话 id 的客户端共用 '' 这一份；超过上限时丢弃最早的会话
const sessions = new Map<string, Session>()

function getSession(id: string | null) {
  const key = id ?? ''
  let session = sessions.get(key)
  if (!session) {
    session = { params: {}, taskIds: new Set() }
    sessions.set(key, session)
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string)
  }
  return session
}

/** 本会话生效的设置：选了配置时只在这份副本里切换，不改应用里的设置；配置已被删除时清除选择并跟随应用 */
function getSessionSettings(session: Session) {
  const settings = normalizeSettings(useStore.getState().settings)
  if (!session.profileId) return settings
  if (!settings.profiles.some((item) => item.id === session.profileId)) {
    session.profileId = undefined
    session.model = undefined
    return settings
  }
  return normalizeSettings({
    ...settings,
    activeProfileId: session.profileId,
    profiles: session.model
      ? settings.profiles.map((item) => item.id === session.profileId ? { ...item, selectedModel: session.model } : item)
      : settings.profiles,
  })
}

function waitForTask(taskId: string) {
  const find = () => useStore.getState().tasks.find((task) => task.id === taskId)
  return new Promise<TaskRecord | undefined>((resolve) => {
    const settled = (task?: TaskRecord) => !task || task.status !== 'running'
    if (settled(find())) return resolve(find())
    const unsubscribe = useStore.subscribe(() => {
      if (!settled(find())) return
      unsubscribe()
      resolve(find())
    })
  })
}

function submitJob(session: Session, prompt: string, params: Partial<TaskParams>, inputImages: InputImage[]) {
  if (useStore.getState().batchProgress) throw new Error('应用正在批量提交任务，请稍后重试')
  // 直接把输入交给提交流程，不填充应用的输入框，也不切换应用当前的配置
  return submitTask({ input: { prompt, inputImages, params, settings: getSessionSettings(session) } })
}

interface JobResult {
  task?: TaskRecord
  retries: number
  error?: string
}

/** 提交一个任务并等它结束；失败时按设置原地重试，鉴权、额度、审核类错误不重试 */
async function runJob(
  session: Session,
  prompt: string,
  params: Partial<TaskParams>,
  inputImages: InputImage[],
  maxRetries: number,
  retryInterval: number,
): Promise<JobResult> {
  let retries = 0
  try {
    let taskId = await submitJob(session, prompt, params, inputImages)
    if (!taskId) throw new Error('应用没有创建任务，请检查应用中的提示或 API 配置')
    session.taskIds.add(taskId)
    for (;;) {
      const task = await waitForTask(taskId)
      if (!task) throw new Error('任务在完成前被删除')
      if (task.status !== 'error' && task.outputImages.length) return { task, retries }
      const error = task.error || '生成失败，没有返回图片'
      const retryable = retries < maxRetries && !task.falRecoverable && !task.customRecoverable && !NO_RETRY_PATTERN.test(error)
      if (!retryable) return { task, retries, error }
      retries += 1
      await new Promise((resolve) => setTimeout(resolve, retryInterval * 1000))
      const next = await retryTask(task, { overwrite: true, settings: getSessionSettings(session) })
      if (!next) throw new Error('任务在重试前被删除')
      taskId = next
    }
  } catch (err) {
    return { retries, error: err instanceof Error ? err.message : String(err) }
  }
}

async function generateImage(session: Session, args: Record<string, unknown>): Promise<McpReply> {
  const fromList = Array.isArray(args.prompts)
    ? args.prompts.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
  const single = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  const prompts = fromList.length ? fromList : single ? [single] : []
  if (!prompts.length) throw new Error('prompt 或 prompts 不能为空')
  if (prompts.length > MAX_PROMPTS_PER_CALL) throw new Error(`prompts 最多 ${MAX_PROMPTS_PER_CALL} 条`)

  const settings = normalizeSettings(useStore.getState().settings)
  const profileError = validateApiProfile(getActiveApiProfile(getSessionSettings(session)))
  if (profileError) throw new Error(`应用中的 API 配置不完整：${profileError}`)
  if (settings.showBatchPrompt && settings.batchPromptEnabled && prompts.some((item) => splitBatchPrompts(item).length > 1)) {
    throw new Error('应用开启了批量提示词，提示词中的分隔符会被拆成多个任务；请去掉分隔符后重试，或改用 prompts 传多条')
  }

  // 应用当前值 < 本会话覆盖 < 本次调用的参数；张数不沿用应用的设置，省略时为 1
  const params = { n: 1, ...session.params, ...parseParams(args) }
  checkTransparent(params)
  if (prompts.length * params.n > MAX_IMAGES_PER_CALL) {
    throw new Error(`一次调用最多生成 ${MAX_IMAGES_PER_CALL} 张图片（prompts 条数 × n），请拆成多次调用`)
  }

  const references = Array.isArray(args.reference_images) ? args.reference_images : []
  const inputImages: InputImage[] = []
  for (const item of references) {
    if (typeof item !== 'string') throw new Error('reference_images 中有无法识别的图片')
    if (splitDataUrl(item)) {
      inputImages.push({ id: await storeImage(item), dataUrl: item })
      continue
    }
    // 不是 data URL 时按历史记录里的 image id 处理，省去重新上传
    const dataUrl = await ensureImageCached(item)
    if (!dataUrl) throw new Error(`reference_images 中的 image id 找不到图片：${item}`)
    inputImages.push({ id: item, dataUrl })
  }

  const status = await getMcpStatus()
  const maxRetries = clampInt(args.max_retries, 0, 20, status.maxRetries)
  const retryInterval = clampInt(args.retry_interval, 1, 600, status.retryInterval)
  const results = await Promise.all(prompts.map((prompt) => runJob(session, prompt, params, inputImages, maxRetries, retryInterval)))

  const images: McpReply['images'] = []
  const lines: string[] = []
  for (const [idx, result] of results.entries()) {
    const label = prompts.length > 1 ? `[${idx + 1}] ` : ''
    const retried = result.retries ? `（自动重试 ${result.retries} 次）` : ''
    if (result.task?.outputImages.length && result.task.status !== 'error') {
      const taskImages = await readImages(result.task.outputImages)
      images.push(...taskImages)
      const failed = result.task.outputErrors?.length ? `；另有 ${result.task.outputErrors.length} 张失败` : ''
      lines.push(`${label}任务 ${result.task.id} 完成${retried}，共 ${taskImages.length} 张${failed}。image id：${result.task.outputImages.join('、')}`)
    } else {
      lines.push(`${label}失败${retried}：${result.error}${result.task ? `（任务 ${result.task.id}）` : ''}`)
    }
  }
  if (!images.length) throw new Error(lines.join('\n'))
  return { text: lines.join('\n'), images }
}

function listHistory(session: Session, args: Record<string, unknown>): McpReply {
  const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit) || 10)))
  // 默认只列出本会话自己生成的任务，all 为 true 时列出应用里的全部历史（含用户自己生成的）
  const tasks = useStore.getState().tasks.filter((task) => args.all === true || session.taskIds.has(task.id))
  const items = tasks.slice(0, limit).map((task) => ({
    task_id: task.id,
    status: task.status,
    prompt: task.prompt,
    size: task.params.size,
    quality: task.params.quality,
    model: task.apiModel,
    created_at: new Date(task.createdAt).toISOString(),
    image_ids: task.outputImages,
    error: task.error,
  }))
  return { text: JSON.stringify(items, null, 2), images: [] }
}

async function getImage(args: Record<string, unknown>): Promise<McpReply> {
  const imageId = typeof args.image_id === 'string' ? args.image_id.trim() : ''
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
  const ids = imageId ? [imageId] : useStore.getState().tasks.find((task) => task.id === taskId)?.outputImages ?? []
  const images = await readImages(ids)
  if (!images.length) throw new Error(imageId || !taskId ? '找不到这张图片' : '找不到这个任务，或它没有图片')
  return { text: `image id：${ids.join('、')}`, images }
}

async function getState(session: Session): Promise<McpReply> {
  const { settings, params } = useStore.getState()
  const normalized = normalizeSettings(settings)
  const profile = getActiveApiProfile(getSessionSettings(session))
  const mcp = await getMcpStatus()
  const state = {
    active_profile: profile.name,
    api_profiles: normalized.profiles.map((item) => ({
      id: item.id,
      name: item.name,
      provider: item.provider,
      models: splitModelList(item.model),
      api_mode: item.apiMode,
      active: item.id === profile.id,
    })),
    provider: profile.provider,
    model: profile.model,
    api_mode: profile.apiMode,
    default_params: { ...params, ...session.params },
    session_overrides: { profile: session.profileId ?? null, model: session.model ?? null, params: session.params },
    auto_retry: { max_retries: mcp.maxRetries, retry_interval_seconds: mcp.retryInterval },
  }
  return { text: JSON.stringify(state, null, 2), images: [] }
}

function setActiveProfile(session: Session, args: Record<string, unknown>): McpReply {
  if (args.reset === true) {
    session.profileId = undefined
    session.model = undefined
    return { text: '已恢复为跟随应用当前启用的 API 配置', images: [] }
  }
  const query = typeof args.profile === 'string' ? args.profile.trim() : ''
  const settings = normalizeSettings(useStore.getState().settings)
  const profile = settings.profiles.find((item) => item.id === query)
    ?? settings.profiles.find((item) => item.name.trim().toLowerCase() === query.toLowerCase())
  if (!query || !profile) {
    throw new Error(`找不到 API 配置「${query}」，可用的有：${settings.profiles.map((item) => item.name).join('、')}`)
  }
  if (isPresetConfigOnlyEnabled() && !isPresetProfile(profile.id)) throw new Error('应用只允许使用预置的 API 配置')
  const model = typeof args.model === 'string' ? args.model.trim() : ''
  if (model && !splitModelList(profile.model).includes(model)) {
    throw new Error(`配置「${profile.name}」没有模型「${model}」，可用的有：${splitModelList(profile.model).join('、')}`)
  }
  session.profileId = profile.id
  session.model = model || undefined
  const active = getActiveApiProfile(getSessionSettings(session))
  return { text: `本会话已切换到 API 配置「${active.name}」，模型 ${active.model}（不影响应用界面和其他会话）`, images: [] }
}

/** 校验并解析生图参数，只返回传入的字段；generate_image 和 set_default_params 共用 */
function parseParams(args: Record<string, unknown>): Partial<TaskParams> {
  const patch: Partial<TaskParams> = {}
  if (args.size !== undefined) {
    if (typeof args.size !== 'string' || !args.size.trim()) throw new Error('size 必须是非空字符串')
    patch.size = args.size.trim()
  }
  if (args.quality !== undefined) {
    if (typeof args.quality !== 'string' || !QUALITIES.includes(args.quality)) throw new Error(`quality 只能是 ${QUALITIES.join('、')}`)
    patch.quality = args.quality as TaskParams['quality']
  }
  if (args.output_format !== undefined) {
    if (typeof args.output_format !== 'string' || !OUTPUT_FORMATS.includes(args.output_format)) throw new Error(`output_format 只能是 ${OUTPUT_FORMATS.join('、')}`)
    patch.output_format = args.output_format as TaskParams['output_format']
  }
  if (args.moderation !== undefined) {
    if (args.moderation !== 'auto' && args.moderation !== 'low') throw new Error('moderation 只能是 auto、low')
    patch.moderation = args.moderation
  }
  if (args.output_compression !== undefined) {
    patch.output_compression = args.output_compression === null ? null : clampInt(args.output_compression, 0, 100, 100)
  }
  if (args.n !== undefined) patch.n = clampInt(args.n, 1, MAX_IMAGES_PER_TASK, 1)
  if (args.transparent_output !== undefined) {
    if (typeof args.transparent_output !== 'boolean') throw new Error('transparent_output 必须是 true 或 false')
    patch.transparent_output = args.transparent_output
  }
  return patch
}

/** 透明背景只支持 png 或 webp；格式未指定时看应用当前格式 */
function checkTransparent(params: Partial<TaskParams>) {
  const format = params.output_format ?? useStore.getState().params.output_format
  if (params.transparent_output && format !== 'png' && format !== 'webp') {
    throw new Error('透明背景只支持 png 或 webp 格式，请同时指定 output_format')
  }
}

function setDefaultParams(session: Session, args: Record<string, unknown>): McpReply {
  if (args.reset === true) {
    session.params = {}
    return { text: '已清除本会话的默认参数覆盖，恢复跟随应用当前设置', images: [] }
  }
  const patch = parseParams(args)
  if (!Object.keys(patch).length) throw new Error('没有要修改的参数')
  const next = { ...session.params, ...patch }
  checkTransparent(next)
  session.params = next
  return { text: `已更新本会话的默认参数（不影响应用界面和其他会话）：${JSON.stringify({ ...useStore.getState().params, ...next }, null, 2)}`, images: [] }
}

async function runTool(request: McpRequest): Promise<McpReply> {
  const session = getSession(request.session)
  switch (request.tool) {
    case 'generate_image':
      return generateImage(session, request.arguments)
    case 'list_history':
      return listHistory(session, request.arguments)
    case 'get_image':
      return getImage(request.arguments)
    case 'get_state':
      return getState(session)
    case 'set_active_profile':
      return setActiveProfile(session, request.arguments)
    case 'set_default_params':
      return setDefaultParams(session, request.arguments)
    default:
      throw new Error(`未知工具：${request.tool}`)
  }
}

/** 启动时调用一次：接收 Rust 侧转来的 MCP 调用，执行后回传结果 */
export function installMcpBridge() {
  void listen<McpRequest>('mcp-request', ({ payload }) => {
    const run = async () => {
      try {
        const result = await runTool(payload)
        await invoke('mcp_respond', { id: payload.id, result })
      } catch (err) {
        await invoke('mcp_respond', { id: payload.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    run().catch((err) => console.error('回传 MCP 结果失败：', err))
  }).catch((err) => console.error('注册 MCP 请求监听失败：', err))
}
