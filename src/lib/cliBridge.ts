import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { MAX_INPUT_IMAGES, type ApiProfile, type AppSettings, type InputImage, type TaskParams } from '../types'
import {
  createDefaultOpenAIProfile,
  getActiveApiProfile,
  getCustomProviderDefinition,
  normalizeSettings,
  splitModelList,
  switchApiProfileProvider,
  validateApiProfile,
} from './apiProfiles'
import { requestBrowserNotificationPermission } from './browserNotification'
import { ensureImageCached } from './imageCache'
import { getProxySetting, setProxySetting } from './networkProxy'
import { getPresetProfileIds, isPresetConfigOnlyEnabled, isPresetProfileLocked, isPresetProvider, isPresetProviderLocked } from './presetConfig'
import {
  buildCustomProvider,
  getApiProfileDeleteBlock,
  getCustomProviderDeleteBlock,
  newId,
  prepareSettingsForCommit,
  removeApiProfile,
  removeCustomProvider,
} from './settingsActions'
import { createInputImageFromFile, submitTask, useStore, waitForTaskSettled } from '../store'

// 仅客户端：执行命令行发来的命令（Rust 侧见 src-tauri/src/cli.rs）。
// 命令直接操作应用里的设置、参数和历史，与用户在界面上操作的效果相同，结果立即反映到界面

interface CliRequest {
  id: number
  tool: string
  arguments: Record<string, unknown>
}

/** text 给人看，data 是 --json 的输出；files 是结果图片在应用数据目录中的路径，命令行按 --output 以 name 另外复制 */
interface CliReply {
  text: string
  data: unknown
  files?: Array<{ path: string, name: string }>
}

// get_settings 返回、update_settings 可修改的设置项。旧版单配置字段以启用中的 API 配置为准，
// API 配置、自定义服务商和启用的配置由各自的参数或工具修改
const SETTING_KEYS = [
  'providerOrder', 'clearInputAfterSubmit', 'persistInputOnRestart', 'reuseTaskApiProfileTemporarily', 'alwaysShowRetryButton',
  'retryMode', 'allowPromptRewrite', 'taskCompletionNotification', 'autoCheckUpdate', 'writeLogFile', 'enterSubmit',
  'privacyModeShortcut', 'colorMode', 'uiFont', 'uiFontName', 'monoFont', 'monoFontName', 'showBatchPrompt', 'batchPromptEnabled',
  'batchPromptMode', 'batchPromptConcurrencyLimited', 'batchPromptConcurrency', 'referenceImageEditAction', 'zipDownloadRoutes',
  'saveLocationMode', 'agentScrollToBottomAfterSubmit', 'agentMaxToolRounds', 'agentWebSearch', 'agentMathFormattingPrompt',
  'agentApiConfigMode', 'agentTextProfileId', 'agentImageProfileId',
] satisfies Array<keyof AppSettings>

const PROFILE_FIELDS = new Set([
  'name', 'provider', 'baseUrl', 'apiKey', 'model', 'selectedModel', 'imageGenerationModel', 'timeout', 'apiMode',
  'reasoningEffort', 'codexCli', 'apiProxy', 'responseFormatB64Json', 'streamImages', 'streamPartialImages', 'transparentBackgroundMethod',
])

const QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
const OUTPUT_FORMATS = ['png', 'jpeg', 'webp']

const text = (value: string): CliReply => ({ text: value, data: { message: value } })
const json = (value: unknown): CliReply => ({ text: JSON.stringify(value, null, 2), data: value })

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getSettings() {
  return normalizeSettings(useStore.getState().settings)
}

/** 与设置页保存时相同：整理后交给 store，返回实际保存的设置 */
function commit(next: AppSettings) {
  useStore.getState().setSettings(prepareSettingsForCommit(next))
  return getSettings()
}

/** 输出的 API 配置：不含密钥，只说明是否已填写 */
function describeProfile(settings: AppSettings, profile: ApiProfile) {
  const { apiKey, providerDrafts, ...rest } = profile
  return {
    ...rest,
    apiKeySet: Boolean(apiKey.trim()),
    models: splitModelList(profile.model),
    active: profile.id === settings.activeProfileId,
    preset: getPresetProfileIds().has(profile.id),
    locked: isPresetProfileLocked(profile.id),
  }
}

/** 校验并解析生图参数，只返回传入的字段 */
function parseParams(args: Record<string, unknown>) {
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
    const value = args.output_compression
    if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100)) {
      throw new Error('output_compression 必须是 0–100 的整数或 null')
    }
    patch.output_compression = value
  }
  if (args.n !== undefined) {
    if (typeof args.n !== 'number' || !Number.isInteger(args.n) || args.n < 1) throw new Error('n 必须是正整数')
    patch.n = args.n
  }
  if (args.transparent_output !== undefined) {
    if (typeof args.transparent_output !== 'boolean') throw new Error('transparent_output 必须是 true 或 false')
    patch.transparent_output = args.transparent_output
  }
  const format = patch.output_format ?? useStore.getState().params.output_format
  if (patch.transparent_output && format !== 'png' && format !== 'webp') {
    throw new Error('透明背景只支持 png 或 webp 格式')
  }
  return patch
}

/** 图片文件在应用数据目录中的路径；name 是 --output 复制时用的文件名，同一任务多张时加序号 */
async function imageFiles(ids: string[], fileNameBase: string) {
  const paths = await invoke<Array<string | null>>('image_paths', { ids })
  return paths.flatMap((path, idx) => {
    if (!path) return []
    const order = ids.length > 1 ? `-${String(idx + 1).padStart(2, '0')}` : ''
    return [{ path, name: `${fileNameBase}${order}${path.slice(path.lastIndexOf('.'))}` }]
  })
}

async function generateImage(requestId: number, args: Record<string, unknown>): Promise<CliReply> {
  const prompts = (Array.isArray(args.prompts) ? args.prompts : [args.prompt])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!prompts.length) throw new Error('提示词不能为空')

  // submitTask 遇到这些情况只在界面上提示，这里先检查，把原因交给命令行
  const profileError = validateApiProfile(getActiveApiProfile(getSettings()))
  if (profileError) throw new Error(`应用启用的 API 配置不完整：${profileError}`)
  if (useStore.getState().batchProgress) throw new Error('应用正在批量提交任务，请等它完成后再试')

  const references = Array.isArray(args.reference_images) ? args.reference_images : []
  if (references.length > MAX_INPUT_IMAGES) throw new Error(`参考图最多 ${MAX_INPUT_IMAGES} 张`)
  const inputImages: InputImage[] = []
  for (const item of references) {
    if (typeof item !== 'string') throw new Error('参考图中有无法识别的项')
    if (item.startsWith('data:')) {
      // 与在应用里上传图片相同
      const blob = await (await fetch(item)).blob()
      const image = await createInputImageFromFile(new File([blob], 'image', { type: blob.type }))
      if (!image) throw new Error('参考图中有无法识别的图片')
      inputImages.push(image)
      continue
    }
    const dataUrl = await ensureImageCached(item)
    if (!dataUrl) throw new Error(`找不到参考图中的图片 ID：${item}`)
    inputImages.push({ id: item, dataUrl })
  }

  const params = parseParams(args)
  if (Object.keys(params).length) useStore.getState().setParams(params)
  const taskIds = await submitTask({ input: { prompts, inputImages } })
  if (!taskIds.length) throw new Error('应用没有创建任务，原因见应用中的提示')
  // 命令行中途被中断时，凭这些 ID 用 history 查结果
  await invoke('cli_progress', { id: requestId, text: `已提交任务：${taskIds.join('、')}` })
  await Promise.all(taskIds.map((id) => waitForTaskSettled(id, () => false)))
  const tasks = taskIds.map((id) => useStore.getState().tasks.find((task) => task.id === id))

  const files: Array<{ path: string, name: string }> = []
  const lines: string[] = []
  const results = []
  for (const [idx, task] of tasks.entries()) {
    const label = tasks.length > 1 ? `[${idx + 1}] ` : ''
    if (!task) {
      lines.push(`${label}任务 ${taskIds[idx]} 在完成前被删除`)
      results.push({ task_id: taskIds[idx], status: 'deleted' })
      continue
    }
    if (task.status === 'error' || !task.outputImages.length) {
      const error = task.error || '没有返回图片'
      lines.push(`${label}任务 ${task.id} 失败：${error}`)
      results.push({ task_id: task.id, status: 'error', error })
      continue
    }
    const taskFiles = await imageFiles(task.outputImages, `task-${task.id}`)
    files.push(...taskFiles)
    const failed = task.outputErrors?.length ? `；另有 ${task.outputErrors.length} 张失败` : ''
    lines.push(`${label}任务 ${task.id} 完成${failed}，图片：`, ...taskFiles.map((file) => `  ${file.path}`))
    results.push({ task_id: task.id, status: 'done', image_ids: task.outputImages, files: taskFiles.map((file) => file.path), failed_images: task.outputErrors?.length ?? 0 })
  }
  if (taskIds.length < prompts.length) lines.push(`批量提交被停止，只开始了 ${taskIds.length} / ${prompts.length} 条`)
  if (!files.length) throw new Error(lines.join('\n'))
  return { text: lines.join('\n'), data: { tasks: results, submitted: taskIds.length, requested: prompts.length, files: files.map((file) => file.path) }, files }
}

async function listHistory(args: Record<string, unknown>) {
  const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit) || 10)))
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
  const ids = Array.isArray(args.task_ids) ? args.task_ids.map(String) : null
  const all = useStore.getState().tasks
  const tasks = ids ? all.filter((task) => ids.includes(task.id)) : all.slice(offset, offset + limit)
  const missing = ids?.filter((id) => !all.some((task) => task.id === id)) ?? []
  return json({
    total: all.length,
    ...(missing.length ? { missing } : {}),
    tasks: await Promise.all(tasks.map(async (task) => ({
      task_id: task.id,
      status: task.status,
      prompt: task.prompt,
      params: task.params,
      profile: task.apiProfileName,
      model: task.apiModel,
      created_at: new Date(task.createdAt).toISOString(),
      reference_image_ids: task.inputImageIds,
      image_ids: task.outputImages,
      files: (await imageFiles(task.outputImages, `task-${task.id}`)).map((file) => file.path),
      error: task.error,
    }))),
  })
}

async function getImage(args: Record<string, unknown>): Promise<CliReply> {
  const imageId = typeof args.image_id === 'string' ? args.image_id.trim() : ''
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
  const tasks = useStore.getState().tasks
  const task = imageId ? tasks.find((item) => item.outputImages.includes(imageId)) : tasks.find((item) => item.id === taskId)
  const ids = imageId ? [imageId] : task?.outputImages ?? []
  const files = await imageFiles(ids, task ? `task-${task.id}` : `image-${imageId.slice(0, 12)}`)
  if (!files.length) throw new Error(imageId || !taskId ? '找不到这张图片' : '找不到这个任务，或它没有图片')
  return { text: files.map((file) => file.path).join('\n'), data: { image_ids: ids, files: files.map((file) => file.path) }, files }
}

async function describeSettings() {
  const settings = getSettings()
  return {
    settings: Object.fromEntries(SETTING_KEYS.map((key) => [key, settings[key] ?? null])),
    params: useStore.getState().params,
    active_profile_id: settings.activeProfileId,
    profiles: settings.profiles.map((profile) => describeProfile(settings, profile)),
    custom_providers: settings.customProviders,
    proxy: await getProxySetting(),
    preset_config_only: isPresetConfigOnlyEnabled(),
  }
}

async function updateSettings(args: Record<string, unknown>) {
  const settings = getSettings()
  const patch = isObject(args.settings) ? args.settings : {}
  const unknown = Object.keys(patch).filter((key) => !(SETTING_KEYS as string[]).includes(key))
  if (unknown.length) throw new Error(`没有这些设置项，或不能在这里修改：${unknown.join('、')}`)
  const activeId = typeof args.active_profile_id === 'string' ? args.active_profile_id : undefined
  if (activeId !== undefined) {
    if (!settings.profiles.some((profile) => profile.id === activeId)) throw new Error(`找不到 API 配置：${activeId}`)
    if (isPresetConfigOnlyEnabled() && !getPresetProfileIds().has(activeId)) throw new Error('应用只允许使用预置的 API 配置')
  }
  // 与设置页相同：开启任务完成通知前先取得通知权限
  if (patch.taskCompletionNotification === true && !settings.taskCompletionNotification) {
    const result = await requestBrowserNotificationPermission()
    if (!result.ok) throw new Error('系统没有允许通知，无法开启任务完成通知')
  }
  const params = isObject(args.params) ? parseParams(args.params) : {}
  if (isObject(args.proxy)) {
    const proxy = { ...await getProxySetting(), ...args.proxy }
    if (proxy.mode !== 'system' && proxy.mode !== 'none' && proxy.mode !== 'custom') throw new Error('proxy.mode 只能是 system、none、custom')
    if (typeof proxy.url !== 'string') throw new Error('proxy.url 必须是字符串')
    await setProxySetting({ mode: proxy.mode, url: proxy.url })
  }

  if (Object.keys(patch).length || activeId !== undefined) {
    if (activeId !== undefined) useStore.getState().setReusedTaskApiProfile(null)
    commit({ ...settings, ...patch, ...(activeId !== undefined ? { activeProfileId: activeId } : {}) } as AppSettings)
  }
  if (Object.keys(params).length) useStore.getState().setParams(params)

  const saved = await describeSettings()
  return json({
    settings: Object.fromEntries(Object.keys(patch).map((key) => [key, saved.settings[key as keyof typeof saved.settings]])),
    params: saved.params,
    active_profile_id: saved.active_profile_id,
    proxy: saved.proxy,
  })
}

function saveApiProfile(args: Record<string, unknown>) {
  if (!isObject(args.profile)) throw new Error('profile 必须是对象')
  const fields = args.profile
  const unknown = Object.keys(fields).filter((key) => !PROFILE_FIELDS.has(key))
  if (unknown.length) throw new Error(`API 配置没有这些字段，或不能修改：${unknown.join('、')}`)
  const settings = getSettings()
  const id = typeof args.id === 'string' ? args.id : ''
  const existing = settings.profiles.find((profile) => profile.id === id)
  if (id && !existing) throw new Error(`找不到 API 配置：${id}`)
  if (!existing && isPresetConfigOnlyEnabled()) throw new Error('应用只允许使用预置的 API 配置，不能新建')
  // 锁定的预置配置在设置页也只能填写 API Key 和切换模型
  if (existing && isPresetProfileLocked(existing.id) && Object.keys(fields).some((key) => key !== 'apiKey' && key !== 'selectedModel')) {
    throw new Error('这个预置的 API 配置已锁定，只能修改 apiKey 和 selectedModel')
  }

  const base = existing ?? createDefaultOpenAIProfile({ id: newId('openai'), name: '新配置' })
  const provider = typeof fields.provider === 'string' ? fields.provider : base.provider
  const customProvider = getCustomProviderDefinition(settings, provider)
  if (!['openai', 'sb2api-async', 'fal', 'grok'].includes(provider) && !customProvider) throw new Error(`没有这个服务商：${provider}`)
  const switched = provider === base.provider ? base : switchApiProfileProvider(base, provider, customProvider ?? undefined)
  const profile = { ...switched, ...fields, provider } as ApiProfile
  if (fields.selectedModel !== undefined && !splitModelList(profile.model).includes(String(fields.selectedModel))) {
    throw new Error(`selectedModel 必须是这个配置的模型之一：${splitModelList(profile.model).join('、')}`)
  }

  const activate = args.activate === true || (!existing && args.activate !== false)
  if (activate) useStore.getState().setReusedTaskApiProfile(null)
  const saved = commit({
    ...settings,
    profiles: existing ? settings.profiles.map((item) => item.id === profile.id ? profile : item) : [...settings.profiles, profile],
    activeProfileId: activate ? profile.id : settings.activeProfileId,
  })
  const result = saved.profiles.find((item) => item.id === profile.id)
  if (!result) throw new Error('应用没有保存这个 API 配置')
  return json(describeProfile(saved, result))
}

function deleteApiProfile(args: Record<string, unknown>) {
  const id = String(args.id ?? '')
  const settings = getSettings()
  const block = getApiProfileDeleteBlock(settings, id)
  if (block) throw new Error(block)
  const state = useStore.getState()
  if (id === state.reusedTaskApiProfileId) state.setReusedTaskApiProfile(null)
  if (getPresetProfileIds().has(id)) state.dismissPresetProfile(id)
  const saved = commit(removeApiProfile(settings, id))
  return text(`已删除 API 配置，当前启用：${getActiveApiProfile(saved).name}（${saved.activeProfileId}）`)
}

function saveCustomProvider(args: Record<string, unknown>) {
  if (!isObject(args.provider)) throw new Error('provider 必须是对象')
  const settings = getSettings()
  const id = typeof args.id === 'string' ? args.id : null
  if (id && !settings.customProviders.some((item) => item.id === id)) throw new Error(`找不到自定义服务商：${id}`)
  if (isPresetConfigOnlyEnabled() || (id && isPresetProviderLocked(id))) throw new Error('预置的服务商不能修改')
  const provider = buildCustomProvider(args.provider, settings.customProviders, id)
  if (!id) useStore.getState().restorePresetProvider(provider.id)
  commit({
    ...settings,
    customProviders: id
      ? settings.customProviders.map((item) => item.id === id ? provider : item)
      : [...settings.customProviders, provider],
  })
  return text(`已保存自定义服务商「${provider.name}」，id：${provider.id}`)
}

function deleteCustomProvider(args: Record<string, unknown>) {
  const id = String(args.id ?? '')
  const settings = getSettings()
  const block = getCustomProviderDeleteBlock(settings, id)
  if (block) throw new Error(block)
  if (isPresetProvider(id)) useStore.getState().dismissPresetProvider(id)
  commit(removeCustomProvider(settings, id))
  return text('已删除自定义服务商，使用它的 API 配置已切回 OpenAI 兼容接口')
}

async function runTool(request: CliRequest): Promise<CliReply> {
  const args = isObject(request.arguments) ? request.arguments : {}
  switch (request.tool) {
    case 'generate_image':
      return generateImage(request.id, args)
    case 'list_history':
      return listHistory(args)
    case 'get_image':
      return getImage(args)
    case 'get_settings':
      return json(await describeSettings())
    case 'update_settings':
      return updateSettings(args)
    case 'save_api_profile':
      return saveApiProfile(args)
    case 'delete_api_profile':
      return deleteApiProfile(args)
    case 'save_custom_provider':
      return saveCustomProvider(args)
    case 'delete_custom_provider':
      return deleteCustomProvider(args)
    default:
      throw new Error(`未知命令：${request.tool}`)
  }
}

/** 接收 Rust 侧转来的命令行命令，执行后回传结果；返回注销监听的函数 */
export function installCliBridge() {
  const unlisten = listen<CliRequest>('cli-request', ({ payload }) => {
    runTool(payload).then(
      (result) => invoke('cli_respond', { id: payload.id, result }),
      (err) => invoke('cli_respond', { id: payload.id, error: err instanceof Error ? err.message : String(err) }),
    ).catch((err) => console.error('回传命令行结果失败：', err))
  })
  unlisten
    .then(() => invoke('cli_ready', { ready: true }))
    .catch((err) => console.error('注册命令行请求监听失败：', err))
  return () => {
    void unlisten.then((stop) => stop())
  }
}
