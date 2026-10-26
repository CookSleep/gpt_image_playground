import { DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type AppSettings } from '../types'
import { createDefaultOpenAIProfile, getApiProviderLabel, getCustomProviderDefinition, normalizeSettings } from './apiProfiles'
import { normalizeBaseUrl } from './devProxy'
import { getPresetConfig } from './presetConfig'
import { readRuntimeEnv } from './runtimeEnv'
import { buildSettingsFromUrlParams, getExplicitUrlSettingsIds, getUrlSettingsPayload, hasUrlSettingParams } from './urlSettings'

/** 导入确认框中的一个参数变化：before 为删除行，after 为新增行，note 为不变的说明 */
export interface ImportLinkDiffRow {
  label: string
  before?: ImportLinkDiffValue
  after?: ImportLinkDiffValue
  note?: string
}

/**
 * 未标记的是配置中的字面值（地址、模型、名称等）；
 * hint 为说明性的占位值（如“链接中的 Key”“（空）”），fixed 为程序生成的固定标签（如“开启”“Images API”）
 */
export interface ImportLinkDiffValue {
  text: string
  hint?: boolean
  fixed?: boolean
}

export interface ImportLinkDiffGroup {
  title: string
  /** 地址变了而继续使用已保存的 Key，已保存的 Key 会被发往新地址 */
  keyReuse?: boolean
  rows: ImportLinkDiffRow[]
}

/** 本次运行中已提示过的导入链接，只保存在内存中；本机刚复制的导入链接也加入，切回窗口时不再提示 */
export const handledImportLinks = new Set<string>()

/** 客户端分享链接使用的网页版地址，构建时由 VITE_WEB_APP_URL 注入（客户端读取 src-tauri/.env），未设置时为空 */
export const WEB_APP_URL = readRuntimeEnv(import.meta.env.VITE_WEB_APP_URL).replace(/\/+$/, '')

export const DEEP_LINK_PROTOCOL = 'gpt-image-playground:'

/** 客户端页面地址是 http://tauri.localhost，复制的导入链接改用网页版地址；未配置网页版地址时改用 deep link，其他客户端可直接打开或复制后切回客户端导入 */
export function getProfileImportBaseUrl(client: boolean, href: string, webAppUrl = WEB_APP_URL) {
  if (!client) return href
  return webAppUrl ? `${webAppUrl}/` : `${DEEP_LINK_PROTOCOL}//`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isHttpUrl(value: string | null) {
  if (!value) return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 判断一段文本是否为导入链接，是则返回其中的查询参数。
 * deep link 只要带有导入参数即可；网页链接可能来自任意域名，要求带有可解析的配置或合法的 apiUrl，避免普通网址被误判。
 */
export function parseImportLink(text: string): URLSearchParams | null {
  const value = text.trim()
  // 剪贴板里可能是大段文本，只识别单独的一条链接
  if (!value || value.length > 32768 || /\s/.test(value)) return null

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  const params = url.searchParams
  if (url.protocol === DEEP_LINK_PROTOCOL) return hasUrlSettingParams(params) ? params : null
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const payload = getUrlSettingsPayload(params)
  if (isRecord(payload) && Array.isArray(payload.profiles) && payload.profiles.length > 0) return params
  return isHttpUrl(params.get('apiUrl')) ? params : null
}

/** 生成导入确认对话框的说明。直接比较导入前后的设置，确认框描述的就是导入后的实际变化；所有展示文本都在这里经过安全处理，渲染层只按原样显示 */
export function describeImportLink(params: URLSearchParams, settings: AppSettings) {
  // 链接指向已删除的预置配置时，实际导入会先恢复它，预览也先补回再比较
  const ids = getExplicitUrlSettingsIds(params)
  const preset = getPresetConfig()
  const restoredProfiles = (preset?.profiles ?? []).filter((profile) =>
    ids.profileIds.includes(profile.id) && !settings.profiles.some((item) => item.id === profile.id))
  const restoredProviders = (preset?.customProviders ?? []).filter((provider) =>
    ids.providerIds.includes(provider.id) && !settings.customProviders.some((item) => item.id === provider.id))
  const current = restoredProfiles.length || restoredProviders.length
    ? normalizeSettings({
        ...settings,
        customProviders: [...settings.customProviders, ...restoredProviders],
        profiles: [...settings.profiles, ...restoredProfiles],
      })
    : settings
  const next = normalizeSettings({ ...current, ...buildSettingsFromUrlParams(current, params) })

  // 链接内容不可信：先把空白折叠成空格，防止伪造换行；名称等过长时截断，主机名始终完整显示
  const text = (value: string) => value.replace(/\s+/g, ' ').trim()
  const clip = (value: string, max = 80) => {
    const v = text(value)
    return v.length > max ? `${v.slice(0, max)}…` : v
  }
  const empty = { text: '（空）', hint: true }
  const name = (value: string) => clip(value) || '（空）'
  const literal = (value: string) => value ? { text: value } : empty
  const formatUrl = (value: string) => {
    try {
      // 输入和流程与 buildApiUrl 发请求时完全一致，不能先折叠空白：URL 解析会删除中间的 Tab 和换行，折叠成空格会让预览与实际主机不符
      const url = new URL(normalizeBaseUrl(value.trim()))
      return `${url.protocol}//${url.host}${clip(`${url.pathname}${url.search}`.replace(/^\/$/, ''), 40)}`
    } catch {
      // 无法解析时不截断，避免藏起真实地址
      return text(value)
    }
  }

  // 名称、地址、模型、Key 之外的配置字段，标签与设置界面一致；取值都转为可读文本并经过 clip
  const fixed = (value: string) => ({ text: value, fixed: true })
  const onOff = (value?: boolean) => fixed(value ? '开启' : '关闭')
  const fields: Array<[string, (profile: ApiProfile) => ImportLinkDiffValue]> = [
    // 自定义服务商的名称来自用户，按字面值显示
    ['服务商类型', (p) => getCustomProviderDefinition(next, p.provider) ? literal(clip(getApiProviderLabel(next, p.provider))) : fixed(getApiProviderLabel(next, p.provider))],
    ['API 代理', (p) => onOff(p.apiProxy)],
    ['API 接口', (p) => p.apiMode === 'responses' ? fixed('Responses API') : p.apiMode === 'images' ? fixed('Images API') : literal(clip(String(p.apiMode)))],
    ['首页选中的模型', (p) => literal(clip(p.selectedModel ?? ''))],
    ['在底部模型菜单中显示', (p) => onOff(p.showInModelPicker)],
    ['图像生成模型', (p) => literal(clip(p.imageGenerationModel ?? ''))],
    ['推理强度', (p) => p.reasoningEffort ? literal(clip(p.reasoningEffort)) : fixed('默认')],
    ['流式传输', (p) => onOff(p.streamImages)],
    ['请求中间步骤图像数', (p) => literal(String(p.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES))],
    ['透明背景实现方式', (p) => p.transparentBackgroundMethod === 'local' ? fixed('本地后处理') : p.transparentBackgroundMethod === 'api' ? fixed('API 原生') : literal(clip(String(p.transparentBackgroundMethod)))],
    ['返回 Base64 图片数据', (p) => onOff(p.responseFormatB64Json)],
    ['Codex CLI 兼容模式', (p) => onOff(p.codexCli)],
    ['请求超时 (秒)', (p) => literal(clip(String(p.timeout)))],
    ['配置说明', (p) => literal(clip(p.description ?? ''))],
  ]
  // 上面已逐项展示的字段；其余字段（如其他服务商的草稿，可能含地址）有变化时统一提示
  const shownKeys = new Set(['name', 'baseUrl', 'model', 'apiKey', 'provider', 'apiProxy', 'apiMode', 'selectedModel', 'showInModelPicker', 'imageGenerationModel', 'reasoningEffort', 'streamImages', 'streamPartialImages', 'transparentBackgroundMethod', 'responseFormatB64Json', 'codexCli', 'timeout', 'description'])
  const hidden = (profile: ApiProfile) => JSON.stringify(Object.entries(profile).filter(([key]) => !shownKeys.has(key)))
  // 新增配置只有 + 行，值为空的字段没有意义，不列出
  const fieldRows = (before: ApiProfile, after: ApiProfile, showBefore: boolean): ImportLinkDiffRow[] => fields
    .filter(([, get]) => JSON.stringify(get(before)) !== JSON.stringify(get(after)) && (showBefore || !get(after).hint))
    .map(([label, get]) => showBefore ? { label, before: get(before), after: get(after) } : { label, after: get(after) })

  const oldById = new Map(current.profiles.map((profile) => [profile.id, profile]))
  const added = next.profiles.filter((profile) => !oldById.has(profile.id))
  const modified = next.profiles.filter((profile) => {
    const old = oldById.get(profile.id)
    return old && JSON.stringify(old) !== JSON.stringify(profile)
  })
  const providerIds = new Set(current.customProviders.map((provider) => provider.id))
  const providerNames = next.customProviders.filter((provider) => !providerIds.has(provider.id)).map((provider) => name(provider.name))

  // 改了地址的修改项排在最前；所有项全部列出，过多时由确认框内容区滚动
  modified.sort((a, b) => Number(b.baseUrl !== oldById.get(b.id)!.baseUrl) - Number(a.baseUrl !== oldById.get(a.id)!.baseUrl))
  const groups: ImportLinkDiffGroup[] = [
    ...modified.map((profile) => {
      const old = oldById.get(profile.id)!
      const urlChanged = old.baseUrl !== profile.baseUrl
      const keyKept = old.apiKey === profile.apiKey && Boolean(profile.apiKey)
      const rows: ImportLinkDiffRow[] = []
      if (old.name !== profile.name) rows.push({ label: '名称', before: literal(clip(old.name)), after: literal(clip(profile.name)) })
      if (urlChanged) rows.push({ label: 'API 地址', before: literal(formatUrl(old.baseUrl)), after: literal(formatUrl(profile.baseUrl)) })
      if (old.model !== profile.model) rows.push({ label: '模型', before: literal(clip(old.model)), after: literal(clip(profile.model)) })
      rows.push(...fieldRows(old, profile, true))
      // 只描述 Key 的来源，不显示原文
      if (old.apiKey !== profile.apiKey) rows.push({ label: 'API Key', before: old.apiKey ? { text: '已保存的 Key', hint: true } : empty, after: profile.apiKey ? { text: '链接中的 Key', hint: true } : empty })
      else if (keyKept) rows.push({ label: 'API Key', note: urlChanged ? '将继续使用该配置已保存的 API Key，并发送到新的 API 地址' : '将继续使用该配置已保存的 API Key' })
      if (hidden(old) !== hidden(profile)) rows.push({ label: '其他设置', note: '将修改该配置的其他内部设置' })
      return {
        title: `修改配置「${name(old.name)}」`,
        // 地址变了而 Key 沿用时，已保存的 Key 会被发往新地址，标题旁显示提示
        keyReuse: urlChanged && keyKept ? true : undefined,
        rows,
      }
    }),
    ...added.map((profile) => {
      // 与只含基本字段的同服务商配置比较，列出链接实际设置了的其他字段；旧版地址参数创建的配置会带上默认图像生成模型，基准也带上
      const base = normalizeSettings({
        ...next,
        profiles: [{ id: profile.id, name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model, imageGenerationModel: createDefaultOpenAIProfile().imageGenerationModel }],
      }).profiles.find((item) => item.id === profile.id) ?? profile
      return {
        title: `新增配置「${name(profile.name)}」`,
        rows: [
          { label: 'API 地址', after: literal(formatUrl(profile.baseUrl)) },
          { label: '模型', after: literal(clip(profile.model)) },
          ...fieldRows(base, profile, false),
          profile.apiKey ? { label: 'API Key', after: { text: '链接中的 Key', hint: true } } : { label: 'API Key', note: '链接中未包含 API Key' },
        ],
      }
    }),
  ]
  const count = modified.length + added.length
  const restoredNames = [...restoredProviders, ...restoredProfiles].map((item) => name(item.name))

  const switched = next.activeProfileId !== current.activeProfileId
    ? next.profiles.find((profile) => profile.id === next.activeProfileId)
    : undefined
  // 只涉及一个配置时下方分组已说明一切，摘要只保留提醒；多个时数量为 0 的分类不写，两类都有时才补充总数
  const counts = [
    ...(modified.length ? [`修改 ${modified.length} 个`] : []),
    ...(added.length ? [`新增 ${added.length} 个`] : []),
  ]
  const summary = count === 1
    ? '请只导入来源可信的链接。'
    : count
      ? `链接将${counts.join('、')}配置${counts.length > 1 ? `，共 ${count} 个` : ''}。请只导入来源可信的链接。`
      : providerNames.length
        ? `链接将新增 ${providerNames.length} 个自定义服务商。请只导入来源可信的链接。`
        : switched
          ? `已存在相同的配置，导入后将切换到「${name(switched.name)}」。`
          : restoredNames.length
            ? '链接将恢复已删除的预置配置。'
            : '链接中的配置不会改变当前设置（已存在相同配置，或受当前部署限制）。'

  return {
    summary,
    notes: [
      ...(restoredNames.length ? [`将恢复预置配置：${restoredNames.join('、')}`] : []),
      ...(providerNames.length ? [`新增自定义服务商：${providerNames.join('、')}`] : []),
      // 只新增服务商时摘要描述服务商，切换信息放在附注中
      ...(!count && providerNames.length && switched ? [`导入后将切换到「${name(switched.name)}」`] : []),
    ],
    groups,
  }
}
