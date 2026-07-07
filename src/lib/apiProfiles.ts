import type {
  ApiMode,
  ApiProfile,
  ApiProvider,
  AppSettings,
  AgentApiConfigMode,
  CustomProviderContentType,
  CustomProviderDefinition,
  CustomProviderFileMapping,
  CustomProviderPollMapping,
  CustomProviderRequestMethod,
  CustomProviderResultMapping,
  CustomProviderSubmitMapping,
  CustomProviderTemplate,
  ReferenceImageEditAction,
} from '../types'
import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_STREAM_PARTIAL_IMAGES, DEFAULT_ZIP_DOWNLOAD_ROUTES, ZIP_DOWNLOAD_ROUTE_VALUES } from '../types'
import { shouldUseApiProxy } from './devProxy'
import { normalizeStreamPartialImages, parseDefaultApiUrl } from './defaultApiUrl'
import { readRuntimeEnv } from './runtimeEnv'
import { isImportableConfigUrl } from './customProviderConfigUrl'

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const RAW_DEFAULT_API_URL = readRuntimeEnv(import.meta.env.VITE_DEFAULT_API_URL)
const DEFAULT_OPENAI_API_PROXY = readRuntimeEnv(import.meta.env.VITE_API_PROXY_AVAILABLE) === 'true'
const DOCKER_DEPLOYMENT = readRuntimeEnv(import.meta.env.VITE_DOCKER_DEPLOYMENT) === 'true'
const SHOW_DEFAULT_CONFIG_ONLY = readRuntimeEnv(import.meta.env.VITE_SHOW_DEFAULT_CONFIG_ONLY) === 'true'
const DEFAULT_API_URL_PATCH = isImportableConfigUrl(RAW_DEFAULT_API_URL)
  ? null
  : parseDefaultApiUrl(RAW_DEFAULT_API_URL || (DOCKER_DEPLOYMENT && DEFAULT_OPENAI_API_PROXY ? '' : OPENAI_DEFAULT_BASE_URL))
const DEFAULT_BASE_URL = DEFAULT_API_URL_PATCH?.baseUrl ?? ''
export const DEFAULT_IMAGES_MODEL = 'gpt-image-2'
export const DEFAULT_RESPONSES_MODEL = 'gpt-5.5'
export const DEFAULT_FAL_BASE_URL = 'https://fal.run'
export const DEFAULT_FAL_MODEL = 'openai/gpt-image-2'
export const ATLAS_CLOUD_PROVIDER_ID = 'custom-atlascloud'
export const ATLAS_CLOUD_BASE_URL = 'https://api.atlascloud.ai/api/v1'
export const ATLAS_CLOUD_IMAGE_MODEL = 'openai/gpt-image-2/text-to-image'
export const ATLAS_CLOUD_EDIT_MODEL = 'openai/gpt-image-2/edit'
export const ATLAS_CLOUD_DEFAULT_IMAGE_SIZE = '1024x1024'
export const ATLAS_CLOUD_DEFAULT_QUALITY = 'medium'
export const DEFAULT_OPENAI_PROFILE_ID = 'default-openai'
export const DEFAULT_API_TIMEOUT = 600

const BUILT_IN_PROVIDER_IDS = new Set<ApiProvider>(['openai', 'fal'])
const DEFAULT_CUSTOM_PROVIDER_PATHS = {
  generationPath: 'images/generations',
  editPath: 'images/edits',
  taskPath: 'images/tasks/{task_id}',
}
const DEFAULT_GENERATE_BODY = {
  model: '$profile.model',
  prompt: '$prompt',
  size: '$params.size',
  quality: '$params.quality',
  output_format: '$params.output_format',
  moderation: '$params.moderation',
  output_compression: '$params.output_compression',
  n: '$params.n',
}
const DEFAULT_EDIT_BODY = DEFAULT_GENERATE_BODY
const DEFAULT_OPENAI_RESULT: CustomProviderResultMapping = {
  imageUrlPaths: ['data.*.url'],
  b64JsonPaths: ['data.*.b64_json'],
}
const DEFAULT_EDIT_FILES: CustomProviderFileMapping[] = [
  { field: 'image[]', source: 'inputImages', array: true },
  { field: 'mask', source: 'mask' },
]

type ApiProfileProviderDraft = NonNullable<ApiProfile['providerDrafts']>[ApiProvider]

function getDefaultStreamImages(provider: ApiProvider, apiMode: ApiMode): boolean {
  return provider === 'openai' && apiMode === 'responses'
}

export { normalizeStreamPartialImages } from './defaultApiUrl'

export function normalizeAgentMaxToolRounds(value: unknown, fallback: number | undefined = DEFAULT_AGENT_MAX_TOOL_ROUNDS): number {
  const fallbackValue = fallback ?? DEFAULT_AGENT_MAX_TOOL_ROUNDS
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallbackValue
  return Math.min(50, Math.max(1, Math.trunc(numeric)))
}

export function isDefaultConfigOnlyEnabled(): boolean {
  return SHOW_DEFAULT_CONFIG_ONLY && (Boolean(RAW_DEFAULT_API_URL) || DEFAULT_OPENAI_API_PROXY)
}

function normalizeReferenceImageEditAction(value: unknown): ReferenceImageEditAction {
  return value === 'replace-reference' || value === 'add-mask' ? value : 'ask'
}

function normalizeZipDownloadRoutes(value: unknown) {
  if (!Array.isArray(value)) return [...DEFAULT_ZIP_DOWNLOAD_ROUTES]
  const allowed = new Set<string>(ZIP_DOWNLOAD_ROUTE_VALUES)
  return value.filter((item): item is typeof ZIP_DOWNLOAD_ROUTE_VALUES[number] => typeof item === 'string' && allowed.has(item))
}

function normalizeProviderOrder(value: unknown, customProviders: CustomProviderDefinition[]): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const providerIds = ['openai', 'fal', ...customProviders.map((provider) => provider.id)]
  const knownIds = new Set(providerIds)
  const ordered = value
    .map(String)
    .filter((id, idx, list) => knownIds.has(id) && list.indexOf(id) === idx)

  return [...ordered, ...providerIds.filter((id) => !ordered.includes(id))]
}

function normalizeAgentApiConfigMode(value: unknown): AgentApiConfigMode {
  return value === 'native' || value === 'hybrid' ? value : 'off'
}

export function isAgentTextApiProfile(profile: ApiProfile): boolean {
  return profile.provider === 'openai' && profile.apiMode === 'responses'
}

function isCustomProviderTemplate(value: unknown): value is CustomProviderTemplate {
  return value === 'http-image'
}

function normalizeProviderPath(value: unknown, fallback: string): string {
  return (typeof value === 'string' && value.trim() ? value : fallback).trim().replace(/^\/+/, '').replace(/^v1\//, '')
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined

  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string | number | boolean] =>
      typeof entry[0] === 'string' && ['string', 'number', 'boolean'].includes(typeof entry[1]),
    )
    .map(([key, item]) => [key, String(item)] as const)

  return entries.length ? Object.fromEntries(entries) : undefined
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRequestMethod(value: unknown, fallback: CustomProviderRequestMethod = 'POST'): CustomProviderRequestMethod {
  return value === 'GET' || value === 'POST' ? value : fallback
}

function normalizeContentType(value: unknown, fallback: CustomProviderContentType = 'json'): CustomProviderContentType {
  return value === 'multipart' ? 'multipart' : fallback
}

function normalizeBodyTemplate(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  return isRecord(value) ? value : fallback
}

function normalizeFileMappings(value: unknown, fallback: CustomProviderFileMapping[] = []): CustomProviderFileMapping[] {
  if (!Array.isArray(value)) return fallback
  const files = value
    .map((item): CustomProviderFileMapping | null => {
      if (!isRecord(item) || typeof item.field !== 'string' || !item.field.trim()) return null
      if (item.source !== 'inputImages' && item.source !== 'mask') return null
      return {
        field: item.field.trim(),
        source: item.source,
        array: Boolean(item.array),
      }
    })
    .filter((item): item is CustomProviderFileMapping => Boolean(item))
  return files.length ? files : fallback
}

function normalizeResultMapping(value: unknown, fallback: CustomProviderResultMapping = DEFAULT_OPENAI_RESULT): CustomProviderResultMapping {
  const record = isRecord(value) ? value : {}
  const imageUrlPaths = normalizeStringArray(record.imageUrlPaths, fallback.imageUrlPaths ?? [])
  const b64JsonPaths = normalizeStringArray(record.b64JsonPaths, fallback.b64JsonPaths ?? [])
  return {
    imageUrlPaths,
    b64JsonPaths,
  }
}

function normalizeSubmitMapping(value: unknown, fallback: CustomProviderSubmitMapping): CustomProviderSubmitMapping {
  const record = isRecord(value) ? value : {}
  const contentType = normalizeContentType(record.contentType, fallback.contentType ?? 'json')
  return {
    path: normalizeProviderPath(record.path, fallback.path),
    method: normalizeRequestMethod(record.method, fallback.method ?? 'POST'),
    contentType,
    query: normalizeStringRecord(record.query) ?? fallback.query,
    body: normalizeBodyTemplate(record.body, fallback.body ?? (contentType === 'multipart' ? DEFAULT_EDIT_BODY : DEFAULT_GENERATE_BODY)),
    files: contentType === 'multipart' ? normalizeFileMappings(record.files, fallback.files) : undefined,
    taskIdPath: typeof record.taskIdPath === 'string' && record.taskIdPath.trim() ? record.taskIdPath.trim() : fallback.taskIdPath,
    result: normalizeResultMapping(record.result, fallback.result ?? DEFAULT_OPENAI_RESULT),
  }
}

function normalizePollMapping(value: unknown, fallback?: CustomProviderPollMapping): CustomProviderPollMapping | undefined {
  if (!isRecord(value) && !fallback) return undefined
  const record = isRecord(value) ? value : {}
  const path = normalizeProviderPath(record.path, fallback?.path ?? DEFAULT_CUSTOM_PROVIDER_PATHS.taskPath)
  const statusPath = typeof record.statusPath === 'string' && record.statusPath.trim() ? record.statusPath.trim() : fallback?.statusPath
  if (!statusPath) return undefined

  return {
    path,
    method: normalizeRequestMethod(record.method, fallback?.method ?? 'GET'),
    query: normalizeStringRecord(record.query) ?? fallback?.query,
    intervalSeconds: typeof record.intervalSeconds === 'number' && Number.isFinite(record.intervalSeconds)
      ? Math.max(1, record.intervalSeconds)
      : fallback?.intervalSeconds ?? 5,
    statusPath,
    successValues: normalizeStringArray(record.successValues, fallback?.successValues ?? ['SUCCESS', 'succeeded', 'completed', 'COMPLETED']),
    failureValues: normalizeStringArray(record.failureValues, fallback?.failureValues ?? ['FAILURE', 'failed', 'error', 'FAILED', 'cancelled']),
    errorPath: typeof record.errorPath === 'string' && record.errorPath.trim() ? record.errorPath.trim() : fallback?.errorPath,
    result: normalizeResultMapping(record.result, fallback?.result ?? DEFAULT_OPENAI_RESULT),
  }
}

function legacyCustomProviderToManifest(record: Record<string, unknown>): Record<string, unknown> | null {
  if (record.template !== 'openai-compatible' && record.template !== 'openai-compatible-async') return null
  const isAsync = record.template === 'openai-compatible-async'
  const taskResultPath = typeof record.taskResultPath === 'string' && record.taskResultPath.trim() ? record.taskResultPath.trim() : 'data.data'
  return {
    id: record.id,
    name: record.name,
    template: 'http-image',
    submit: {
      path: record.generationPath ?? DEFAULT_CUSTOM_PROVIDER_PATHS.generationPath,
      method: 'POST',
      contentType: 'json',
      query: isAsync ? normalizeStringRecord(record.submitQuery) ?? { async: 'true' } : undefined,
      body: DEFAULT_GENERATE_BODY,
      taskIdPath: isAsync ? (record.taskIdPath ?? 'data') : undefined,
      result: DEFAULT_OPENAI_RESULT,
    },
    editSubmit: {
      path: record.editPath ?? DEFAULT_CUSTOM_PROVIDER_PATHS.editPath,
      method: 'POST',
      contentType: 'multipart',
      query: isAsync ? normalizeStringRecord(record.submitQuery) ?? { async: 'true' } : undefined,
      body: DEFAULT_EDIT_BODY,
      files: DEFAULT_EDIT_FILES,
      taskIdPath: isAsync ? (record.taskIdPath ?? 'data') : undefined,
      result: DEFAULT_OPENAI_RESULT,
    },
    poll: isAsync ? {
      path: record.taskPath ?? DEFAULT_CUSTOM_PROVIDER_PATHS.taskPath,
      method: 'GET',
      statusPath: record.taskStatusPath ?? 'data.status',
      successValues: normalizeStringArray(record.taskSuccessValues, ['SUCCESS', 'succeeded', 'completed', 'COMPLETED']),
      failureValues: normalizeStringArray(record.taskFailureValues, ['FAILURE', 'failed', 'error', 'FAILED']),
      errorPath: 'data.fail_reason',
      intervalSeconds: typeof record.pollIntervalSeconds === 'number' ? record.pollIntervalSeconds : 5,
      result: {
        imageUrlPaths: [`${taskResultPath}.data.*.url`],
        b64JsonPaths: [`${taskResultPath}.data.*.b64_json`],
      },
    } : undefined,
  }
}

function createCustomProviderId(name: string, usedIds: Set<string>): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom'
  let id = `custom-${slug}`
  let index = 2
  while (usedIds.has(id) || BUILT_IN_PROVIDER_IDS.has(id)) {
    id = `custom-${slug}-${index}`
    index += 1
  }
  usedIds.add(id)
  return id
}

export function normalizeCustomProviderDefinition(input: unknown, usedIds = new Set<string>()): CustomProviderDefinition | null {
  if (!input || typeof input !== 'object') return null
  const rawRecord = input as Record<string, unknown>
  const record = legacyCustomProviderToManifest(rawRecord) ?? rawRecord
  const template = record.template == null ? 'http-image' : isCustomProviderTemplate(record.template) ? record.template : null
  if (!template || !isRecord(record.submit)) return null

  const rawName = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : '自定义服务商'
  const id = typeof record.id === 'string' && record.id.trim() && !BUILT_IN_PROVIDER_IDS.has(record.id.trim()) && !usedIds.has(record.id.trim())
    ? record.id.trim()
    : createCustomProviderId(rawName, usedIds)
  usedIds.add(id)

  return {
    id,
    name: rawName,
    template,
    submit: normalizeSubmitMapping(record.submit, {
      path: DEFAULT_CUSTOM_PROVIDER_PATHS.generationPath,
      method: 'POST',
      contentType: 'json',
      body: DEFAULT_GENERATE_BODY,
      result: DEFAULT_OPENAI_RESULT,
    }),
    editSubmit: isRecord(record.editSubmit) ? normalizeSubmitMapping(record.editSubmit, {
      path: DEFAULT_CUSTOM_PROVIDER_PATHS.editPath,
      method: 'POST',
      contentType: 'multipart',
      body: DEFAULT_EDIT_BODY,
      files: DEFAULT_EDIT_FILES,
      result: DEFAULT_OPENAI_RESULT,
    }) : undefined,
    poll: normalizePollMapping(record.poll),
  }
}

export function normalizeCustomProviderDefinitions(input: unknown): CustomProviderDefinition[] {
  const usedIds = new Set<string>()
  const list = Array.isArray(input) ? input : []
  return list
    .map((item) => normalizeCustomProviderDefinition(item, usedIds))
    .filter((item): item is CustomProviderDefinition => Boolean(item))
}

export function createAtlasCloudProviderDefinition(): CustomProviderDefinition {
  const result: CustomProviderResultMapping = {
    imageUrlPaths: ['outputs.*'],
    b64JsonPaths: [],
  }

  return {
    id: ATLAS_CLOUD_PROVIDER_ID,
    name: 'Atlas Cloud',
    template: 'http-image',
    submit: {
      path: 'model/generateImage',
      method: 'POST',
      contentType: 'json',
      body: {
        model: '$profile.model',
        prompt: '$prompt',
        size: '$params.size',
        quality: '$params.quality',
        output_format: '$params.output_format',
        moderation: '$params.moderation',
        enable_base64_output: false,
        enable_sync_mode: false,
      },
      taskIdPath: 'id',
      result,
    },
    editSubmit: {
      path: 'model/generateImage',
      method: 'POST',
      contentType: 'json',
      body: {
        model: ATLAS_CLOUD_EDIT_MODEL,
        prompt: '$prompt',
        images: '$inputImages.dataUrls',
        size: '$params.size',
        quality: '$params.quality',
        output_format: '$params.output_format',
        moderation: '$params.moderation',
        enable_base64_output: false,
        enable_sync_mode: false,
      },
      taskIdPath: 'id',
      result,
    },
    poll: {
      path: 'model/result/{task_id}',
      method: 'GET',
      intervalSeconds: 5,
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      errorPath: 'error',
      result,
    },
  }
}

function getCustomProviderProfileDefaults(customProvider: CustomProviderDefinition) {
  if (customProvider.id !== ATLAS_CLOUD_PROVIDER_ID) return null
  return {
    baseUrl: ATLAS_CLOUD_BASE_URL,
    model: ATLAS_CLOUD_IMAGE_MODEL,
  }
}

export function createDefaultOpenAIProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  const apiMode = overrides.apiMode ?? DEFAULT_API_URL_PATCH?.apiMode ?? 'images'
  const streamImages = overrides.streamImages ?? DEFAULT_API_URL_PATCH?.streamImages ?? getDefaultStreamImages('openai', apiMode)

  return {
    id: DEFAULT_OPENAI_PROFILE_ID,
    name: DEFAULT_API_URL_PATCH?.name ?? '默认',
    provider: 'openai',
    baseUrl: DEFAULT_BASE_URL,
    apiKey: DEFAULT_API_URL_PATCH?.apiKey ?? '',
    model: DEFAULT_API_URL_PATCH?.model ?? DEFAULT_IMAGES_MODEL,
    timeout: DEFAULT_API_TIMEOUT,
    codexCli: DEFAULT_API_URL_PATCH?.codexCli ?? false,
    apiProxy: DEFAULT_OPENAI_API_PROXY,
    streamPartialImages: DEFAULT_API_URL_PATCH?.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES,
    ...overrides,
    apiMode,
    streamImages,
  }
}

export function createDefaultFalProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: `fal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: '新配置',
    provider: 'fal',
    baseUrl: DEFAULT_FAL_BASE_URL,
    apiKey: '',
    model: DEFAULT_FAL_MODEL,
    timeout: DEFAULT_API_TIMEOUT,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    streamImages: false,
    streamPartialImages: DEFAULT_STREAM_PARTIAL_IMAGES,
    ...overrides,
  }
}

export function switchApiProfileProvider(profile: ApiProfile, provider: ApiProvider, customProvider?: CustomProviderDefinition): ApiProfile {
  const providerDrafts = {
    ...profile.providerDrafts,
    [profile.provider]: {
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiMode: profile.apiMode,
      codexCli: profile.codexCli,
      apiProxy: profile.apiProxy,
      responseFormatB64Json: profile.responseFormatB64Json,
      streamImages: profile.streamImages,
      streamPartialImages: profile.streamPartialImages,
    },
  }
  const savedDraft = providerDrafts[provider]

  if (provider === 'fal') {
    return {
      ...profile,
      provider,
      baseUrl: savedDraft?.baseUrl ?? DEFAULT_FAL_BASE_URL,
      model: savedDraft?.model ?? DEFAULT_FAL_MODEL,
      apiMode: 'images',
      codexCli: false,
      apiProxy: false,
      responseFormatB64Json: savedDraft?.responseFormatB64Json,
      streamImages: false,
      streamPartialImages: savedDraft?.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES,
      providerDrafts,
    }
  }

  if (customProvider) {
    const shouldUseOpenAIDefaults = profile.provider === 'fal'
    const customProviderDefaults = getCustomProviderProfileDefaults(customProvider)
    return {
      ...profile,
      provider: customProvider.id,
      baseUrl: savedDraft?.baseUrl ?? customProviderDefaults?.baseUrl ?? (shouldUseOpenAIDefaults ? DEFAULT_BASE_URL : profile.baseUrl || DEFAULT_BASE_URL),
      model: savedDraft?.model ?? customProviderDefaults?.model ?? (shouldUseOpenAIDefaults ? DEFAULT_IMAGES_MODEL : profile.model || DEFAULT_IMAGES_MODEL),
      apiMode: 'images',
      codexCli: false,
      apiProxy: false,
      responseFormatB64Json: savedDraft?.responseFormatB64Json,
      streamImages: false,
      streamPartialImages: savedDraft?.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES,
      providerDrafts,
    }
  }

  const nextApiMode = savedDraft?.apiMode ?? profile.apiMode
  const nextStreamImages = savedDraft?.streamImages ?? (profile.provider === 'openai'
    ? profile.streamImages
    : getDefaultStreamImages(provider, nextApiMode))
  const nextStreamPartialImages = savedDraft?.streamPartialImages ?? (profile.provider === 'openai'
    ? profile.streamPartialImages
    : DEFAULT_STREAM_PARTIAL_IMAGES)

  return {
    ...profile,
    provider,
    baseUrl: savedDraft?.baseUrl ?? DEFAULT_BASE_URL,
    model: savedDraft?.model ?? DEFAULT_IMAGES_MODEL,
    apiMode: nextApiMode,
    codexCli: savedDraft?.codexCli ?? profile.codexCli,
    apiProxy: savedDraft?.apiProxy ?? DEFAULT_OPENAI_API_PROXY,
    responseFormatB64Json: savedDraft?.responseFormatB64Json,
    streamImages: nextStreamImages,
    streamPartialImages: nextStreamPartialImages,
    providerDrafts,
  }
}

function normalizeProviderDraft(input: unknown, provider: ApiProvider, customProviderIds: Set<string>): ApiProfileProviderDraft {
  if (!isRecord(input)) return undefined
  const fallback = provider === 'fal' ? createDefaultFalProfile() : createDefaultOpenAIProfile()
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : undefined
  const model = typeof input.model === 'string' && input.model.trim() ? input.model : undefined
  const apiMode = input.apiMode === 'responses' ? 'responses' : input.apiMode === 'images' ? 'images' : undefined
  const knownProvider = provider === 'fal' || provider === 'openai' || customProviderIds.has(provider)
  if (!knownProvider) return undefined

  return {
    baseUrl: provider === 'fal'
      ? baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_FAL_BASE_URL
      : baseUrl,
    model,
    apiMode,
    codexCli: typeof input.codexCli === 'boolean' ? input.codexCli : fallback.codexCli,
    apiProxy: typeof input.apiProxy === 'boolean' ? input.apiProxy : fallback.apiProxy,
    responseFormatB64Json: input.responseFormatB64Json === true ? true : undefined,
    streamImages: typeof input.streamImages === 'boolean' ? input.streamImages : fallback.streamImages,
    streamPartialImages: normalizeStreamPartialImages(input.streamPartialImages, fallback.streamPartialImages),
  }
}

function normalizeProviderDrafts(input: unknown, customProviderIds: Set<string>): ApiProfile['providerDrafts'] {
  if (!isRecord(input)) return undefined
  const entries = Object.entries(input)
    .map(([provider, draft]) => [provider, normalizeProviderDraft(draft, provider, customProviderIds)] as const)
    .filter((entry): entry is [ApiProvider, NonNullable<ApiProfileProviderDraft>] => Boolean(entry[1]))

  return entries.length ? Object.fromEntries(entries) : undefined
}

export function normalizeApiProfile(input: unknown, fallback?: Partial<ApiProfile>, customProviderIds = new Set<string>()): ApiProfile {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const rawProvider = typeof record.provider === 'string' ? record.provider : ''
  const provider: ApiProvider = rawProvider === 'fal' || customProviderIds.has(rawProvider) ? rawProvider : 'openai'
  const apiMode: ApiMode = provider === 'openai' && record.apiMode === 'responses' ? 'responses' : 'images'
  const defaults = provider === 'fal'
    ? createDefaultFalProfile(fallback)
    : createDefaultOpenAIProfile({ ...fallback, apiMode })
  const rawBaseUrl = typeof record.baseUrl === 'string' ? record.baseUrl : defaults.baseUrl
  const streamImages = provider === 'openai'
    ? typeof record.streamImages === 'boolean' ? record.streamImages : defaults.streamImages
    : false

  return {
    ...defaults,
    id: typeof record.id === 'string' && record.id.trim() ? record.id : defaults.id,
    name: typeof record.name === 'string' && record.name.trim() ? record.name : defaults.name,
    provider,
    baseUrl: provider === 'fal' ? rawBaseUrl.trim().replace(/\/+$/, '') || DEFAULT_FAL_BASE_URL : rawBaseUrl,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : defaults.apiKey,
    model: typeof record.model === 'string' && record.model.trim() ? record.model : defaults.model,
    timeout: typeof record.timeout === 'number' && Number.isFinite(record.timeout) ? record.timeout : defaults.timeout,
    apiMode,
    codexCli: Boolean(record.codexCli),
    apiProxy: typeof record.apiProxy === 'boolean' ? record.apiProxy : defaults.apiProxy,
    responseFormatB64Json: record.responseFormatB64Json === true ? true : undefined,
    streamImages,
    streamPartialImages: normalizeStreamPartialImages(record.streamPartialImages, defaults.streamPartialImages),
    providerDrafts: normalizeProviderDrafts(record.providerDrafts, customProviderIds),
  }
}

function validateImportedProfileRecord(input: unknown) {
  if (!isRecord(input)) return

  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  if (baseUrl && (baseUrl.startsWith('[') || baseUrl.includes(']('))) {
    throw new Error('JSON 包含 Markdown 链接，请粘贴纯文本')
  }

  if (typeof input.apiMode === 'string' && input.apiMode !== 'images' && input.apiMode !== 'responses') {
    throw new Error('apiMode 格式无效，应为 images 或 responses')
  }
}

export function normalizeSettings(input: Partial<AppSettings> | unknown): AppSettings {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const customProviders = normalizeCustomProviderDefinitions(record.customProviders)
  const customProviderIds = new Set(customProviders.map((provider) => provider.id))
  const legacyApiMode: ApiMode = record.apiMode === 'responses' ? 'responses' : 'images'
  const legacyProfile = createDefaultOpenAIProfile({
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : DEFAULT_BASE_URL,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
    model: typeof record.model === 'string' && record.model.trim() ? record.model : DEFAULT_IMAGES_MODEL,
    timeout: typeof record.timeout === 'number' && Number.isFinite(record.timeout) ? record.timeout : DEFAULT_API_TIMEOUT,
    apiMode: legacyApiMode,
    codexCli: Boolean(record.codexCli),
    apiProxy: typeof record.apiProxy === 'boolean' ? record.apiProxy : DEFAULT_OPENAI_API_PROXY,
    responseFormatB64Json: record.responseFormatB64Json === true ? true : undefined,
    streamImages: typeof record.streamImages === 'boolean' ? record.streamImages : undefined,
    streamPartialImages: normalizeStreamPartialImages(record.streamPartialImages),
  })
  const profiles = Array.isArray(record.profiles) && record.profiles.length
    ? record.profiles.map((profile) => normalizeApiProfile(profile, undefined, customProviderIds))
    : [legacyProfile]
  const activeProfileId = typeof record.activeProfileId === 'string' && profiles.some((p) => p.id === record.activeProfileId)
    ? record.activeProfileId
    : profiles[0].id
  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0]
  const agentApiConfigMode = normalizeAgentApiConfigMode(record.agentApiConfigMode)
  const firstAgentTextProfile = profiles.find(isAgentTextApiProfile)
  const agentTextProfileId = typeof record.agentTextProfileId === 'string' && profiles.some((p) => p.id === record.agentTextProfileId && isAgentTextApiProfile(p))
    ? record.agentTextProfileId
    : (isAgentTextApiProfile(active) ? active.id : firstAgentTextProfile?.id ?? null)
  const agentImageProfileId = typeof record.agentImageProfileId === 'string' && profiles.some((p) => p.id === record.agentImageProfileId)
    ? record.agentImageProfileId
    : active.id

  return {
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model,
    timeout: active.timeout,
    apiMode: active.apiMode,
    codexCli: active.codexCli,
    apiProxy: active.apiProxy,
    streamImages: active.streamImages,
    streamPartialImages: active.streamPartialImages,
    customProviders,
    providerOrder: normalizeProviderOrder(record.providerOrder, customProviders),
    clearInputAfterSubmit: typeof record.clearInputAfterSubmit === 'boolean' ? record.clearInputAfterSubmit : false,
    persistInputOnRestart: typeof record.persistInputOnRestart === 'boolean' ? record.persistInputOnRestart : true,
    reuseTaskApiProfileTemporarily: typeof record.reuseTaskApiProfileTemporarily === 'boolean' ? record.reuseTaskApiProfileTemporarily : false,
    alwaysShowRetryButton: typeof record.alwaysShowRetryButton === 'boolean' ? record.alwaysShowRetryButton : false,
    allowPromptRewrite: typeof record.allowPromptRewrite === 'boolean' ? record.allowPromptRewrite : false,
    taskCompletionNotification: typeof record.taskCompletionNotification === 'boolean' ? record.taskCompletionNotification : false,
    enterSubmit: typeof record.enterSubmit === 'boolean' ? record.enterSubmit : false,
    referenceImageEditAction: normalizeReferenceImageEditAction(record.referenceImageEditAction),
    zipDownloadRoutes: normalizeZipDownloadRoutes(record.zipDownloadRoutes),
    agentScrollToBottomAfterSubmit: typeof record.agentScrollToBottomAfterSubmit === 'boolean' ? record.agentScrollToBottomAfterSubmit : true,
    agentMaxToolRounds: normalizeAgentMaxToolRounds(record.agentMaxToolRounds),
    agentWebSearch: typeof record.agentWebSearch === 'boolean' ? record.agentWebSearch : false,
    agentMathFormattingPrompt: typeof record.agentMathFormattingPrompt === 'boolean' ? record.agentMathFormattingPrompt : true,
    agentApiConfigMode,
    agentTextProfileId,
    agentImageProfileId,
    profiles,
    activeProfileId,
  }
}

export function getAgentTextApiProfile(settings: Partial<AppSettings> | unknown): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  if (normalized.agentApiConfigMode === 'off') return getActiveApiProfile(normalized)
  return normalized.profiles.find((profile) => profile.id === normalized.agentTextProfileId) ?? null
}

export function getAgentImageApiProfile(settings: Partial<AppSettings> | unknown): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  if (normalized.agentApiConfigMode !== 'hybrid') return getAgentTextApiProfile(normalized)
  return normalized.profiles.find((profile) => profile.id === normalized.agentImageProfileId) ?? null
}

export function getCustomProviderDefinition(settings: Partial<AppSettings> | unknown, provider: ApiProvider): CustomProviderDefinition | null {
  const normalized = normalizeSettings(settings)
  return normalized.customProviders.find((item) => item.id === provider) ?? null
}

export function getApiProviderLabel(settings: Partial<AppSettings> | unknown, provider: ApiProvider): string {
  if (provider === 'fal') return 'fal.ai'
  if (provider === 'openai') return 'OpenAI'
  return getCustomProviderDefinition(settings, provider)?.name ?? provider
}

export function isOpenAICompatibleProvider(settings: Partial<AppSettings> | unknown, provider: ApiProvider): boolean {
  return provider === 'openai' || Boolean(getCustomProviderDefinition(settings, provider))
}

export interface ImportedProviderSettings {
  customProviders: CustomProviderDefinition[]
  profiles: ApiProfile[]
}

function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/)
  return match ? match[1].trim() : trimmed
}

export function importCustomProviderSettingsFromJson(
  jsonText: string,
  existingProviders: CustomProviderDefinition[] = [],
): ImportedProviderSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripMarkdownCodeFence(jsonText))
  } catch {
    throw new Error('JSON 格式无效')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON 根节点必须是对象')
  }

  const record = parsed as Record<string, unknown>

  // 包裹结构：{customProviders: [...], profiles: [...]}
  if (Array.isArray(record.customProviders)) {
    const customProviders = normalizeCustomProviderDefinitions(record.customProviders)
    if (customProviders.length === 0) {
      throw new Error('customProviders 数组中没有有效的服务商配置')
    }
    const customProviderIds = new Set(customProviders.map((provider) => provider.id))
    const profiles = Array.isArray(record.profiles)
      ? record.profiles
        .map((item) => {
          validateImportedProfileRecord(item)
          return item
        })
        .map((item) => normalizeApiProfile(item, undefined, customProviderIds))
        .filter((profile) => customProviderIds.has(profile.provider))
      : []
    return { customProviders, profiles }
  }

  // 单个 Manifest 对象：{name, submit, ...}
  const usedIds = new Set(existingProviders.map((provider) => provider.id))
  const direct = normalizeCustomProviderDefinition(parsed, usedIds)
  if (direct) return { customProviders: [direct], profiles: [] }

  throw new Error('无法识别该 JSON。请粘贴自定义服务商配置。')
}

export function importCustomProviderDefinitionFromJson(jsonText: string, existingProviders: CustomProviderDefinition[] = []): CustomProviderDefinition {
  const result = importCustomProviderSettingsFromJson(jsonText, existingProviders)
  return result.customProviders[0]
}

export function getActiveApiProfile(settings: Partial<AppSettings> | unknown): ApiProfile {
  const record = settings && typeof settings === 'object' ? settings as Record<string, unknown> : {}
  const normalized = normalizeSettings(settings)
  const profile = normalized.profiles.find((p) => p.id === normalized.activeProfileId) ?? normalized.profiles[0] ?? createDefaultOpenAIProfile()
  const apiMode = profile.provider === 'openai' && (record.apiMode === 'images' || record.apiMode === 'responses')
    ? record.apiMode
    : profile.apiMode

  return {
    ...profile,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : profile.baseUrl,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : profile.apiKey,
    model: typeof record.model === 'string' && record.model.trim() ? record.model : profile.model,
    timeout: typeof record.timeout === 'number' && Number.isFinite(record.timeout) ? record.timeout : profile.timeout,
    apiMode,
    codexCli: typeof record.codexCli === 'boolean' ? record.codexCli : profile.codexCli,
    apiProxy: typeof record.apiProxy === 'boolean' ? record.apiProxy : profile.apiProxy,
    streamImages: profile.provider === 'openai' && typeof record.streamImages === 'boolean' ? record.streamImages : profile.streamImages,
    streamPartialImages: normalizeStreamPartialImages(record.streamPartialImages, profile.streamPartialImages),
  }
}

export function validateApiProfile(profile: ApiProfile): string | null {
  if (!profile.name.trim()) return '缺少名称'
  if (profile.provider !== 'fal' && !profile.baseUrl.trim() && !shouldUseApiProxy(profile.apiProxy)) return '缺少 API URL'
  if (!profile.apiKey.trim()) return '缺少 API Key'
  if (!profile.model.trim()) return '缺少模型 ID'
  return null
}

function isDefaultOpenAIProfile(profile: ApiProfile): boolean {
  return profile.id === DEFAULT_OPENAI_PROFILE_ID &&
    profile.name === '默认' &&
    profile.provider === 'openai' &&
    profile.baseUrl === DEFAULT_BASE_URL &&
    profile.apiKey === '' &&
    profile.model === DEFAULT_IMAGES_MODEL &&
    profile.timeout === DEFAULT_API_TIMEOUT &&
    profile.apiMode === 'images' &&
    profile.codexCli === false &&
    profile.apiProxy === DEFAULT_OPENAI_API_PROXY &&
    profile.streamImages === false &&
    profile.streamPartialImages === DEFAULT_STREAM_PARTIAL_IMAGES
}

function hasOnlyDefaultProfiles(settings: AppSettings): boolean {
  return settings.customProviders.length === 0 &&
    settings.profiles.length === 1 &&
    settings.activeProfileId === DEFAULT_OPENAI_PROFILE_ID &&
    isDefaultOpenAIProfile(settings.profiles[0])
}

function createImportedProfileId(provider: ApiProvider, usedIds: Set<string>): string {
  let id = `${provider}-imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  while (usedIds.has(id)) {
    id = `${provider}-imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  }
  usedIds.add(id)
  return id
}

function getApiProfileDedupKey(profile: ApiProfile): string {
  return JSON.stringify([
    profile.provider,
    profile.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
    profile.apiKey.trim(),
    profile.model.trim(),
    profile.apiMode,
  ])
}

function getApiProfileConnectionKey(profile: ApiProfile): string {
  return JSON.stringify([
    profile.provider,
    profile.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
    profile.model.trim(),
    profile.apiMode,
  ])
}

function hasEquivalentApiProfile(existingProfiles: ApiProfile[], importedProfile: ApiProfile): boolean {
  const dedupKey = getApiProfileDedupKey(importedProfile)
  if (existingProfiles.some((profile) => getApiProfileDedupKey(profile) === dedupKey)) return true

  // LLM-generated imports intentionally omit API Key. Reuse an existing keyed profile
  // when the provider, URL, model, and mode are otherwise identical.
  if (importedProfile.apiKey.trim()) return false
  const connectionKey = getApiProfileConnectionKey(importedProfile)
  return existingProfiles.some((profile) => getApiProfileConnectionKey(profile) === connectionKey)
}

function dedupeApiProfiles(profiles: ApiProfile[]): ApiProfile[] {
  const seen = new Set<string>()
  return profiles.filter((profile) => {
    const key = getApiProfileDedupKey(profile)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function getCustomProviderDedupKey(provider: CustomProviderDefinition): string {
  return JSON.stringify([
    provider.name,
    provider.template ?? 'http-image',
    provider.submit,
    provider.editSubmit ?? null,
    provider.poll ?? null,
  ])
}

function mergeImportedCustomProviders(currentProviders: CustomProviderDefinition[], importedProviders: CustomProviderDefinition[]) {
  const providers = [...currentProviders]
  const providerIdMap = new Map<string, string>()
  const usedIds = new Set(providers.map((provider) => provider.id))
  const existingKeys = new Map(providers.map((provider) => [getCustomProviderDedupKey(provider), provider.id] as const))

  for (const provider of importedProviders) {
    const existingId = existingKeys.get(getCustomProviderDedupKey(provider))
    if (existingId) {
      providerIdMap.set(provider.id, existingId)
      continue
    }

    const normalized = normalizeCustomProviderDefinition(provider, usedIds)
    if (!normalized) continue
    providerIdMap.set(provider.id, normalized.id)
    providers.push(normalized)
    existingKeys.set(getCustomProviderDedupKey(normalized), normalized.id)
  }

  return { providers, providerIdMap }
}

export function findEquivalentApiProfile(
  settings: Partial<AppSettings> | unknown,
  importedProfile: ApiProfile,
  importedProviders: CustomProviderDefinition[] = [],
): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  const importedProvider = importedProviders.find((provider) => provider.id === importedProfile.provider)
  const provider = importedProvider
    ? normalized.customProviders.find((provider) => getCustomProviderDedupKey(provider) === getCustomProviderDedupKey(importedProvider))?.id ?? importedProfile.provider
    : importedProfile.provider
  const profile = { ...importedProfile, provider }
  const dedupKey = getApiProfileDedupKey(profile)
  const exact = normalized.profiles.find((item) => getApiProfileDedupKey(item) === dedupKey)
  if (exact) return exact

  if (profile.apiKey.trim()) return null
  const connectionKey = getApiProfileConnectionKey(profile)
  return normalized.profiles.find((item) => getApiProfileConnectionKey(item) === connectionKey) ?? null
}

export function mergeImportedSettings(currentSettings: Partial<AppSettings> | unknown, importedSettings: Partial<AppSettings> | unknown): AppSettings {
  const current = normalizeSettings(currentSettings)
  const normalizedImported = normalizeSettings(importedSettings)
  const imported = normalizeSettings({
    ...normalizedImported,
    profiles: dedupeApiProfiles(normalizedImported.profiles),
  })

  if (hasOnlyDefaultProfiles(current)) {
    return imported
  }

  const usedIds = new Set(current.profiles.map((profile) => profile.id))
  const existingKeys = new Set(current.profiles.map(getApiProfileDedupKey))
  const { providers: customProviders, providerIdMap } = mergeImportedCustomProviders(current.customProviders, imported.customProviders)
  const importedProfiles = imported.profiles
    .map((profile) => providerIdMap.has(profile.provider)
      ? { ...profile, provider: providerIdMap.get(profile.provider) ?? profile.provider }
      : profile,
    )
    .filter((profile) => !existingKeys.has(getApiProfileDedupKey(profile)) && !hasEquivalentApiProfile(current.profiles, profile))
    .map((profile) => ({
      ...profile,
      id: createImportedProfileId(profile.provider, usedIds),
    }))
  const profiles = [...current.profiles, ...importedProfiles]

  return normalizeSettings({
    ...current,
    customProviders,
    profiles,
    activeProfileId: current.activeProfileId,
  })
}

export const DEFAULT_SETTINGS: AppSettings = normalizeSettings({
  baseUrl: DEFAULT_BASE_URL,
  apiKey: DEFAULT_API_URL_PATCH?.apiKey ?? '',
  model: DEFAULT_API_URL_PATCH?.model ?? DEFAULT_IMAGES_MODEL,
  timeout: DEFAULT_API_TIMEOUT,
  apiMode: DEFAULT_API_URL_PATCH?.apiMode ?? 'images',
  codexCli: DEFAULT_API_URL_PATCH?.codexCli ?? false,
  apiProxy: DEFAULT_OPENAI_API_PROXY,
  streamImages: DEFAULT_API_URL_PATCH?.streamImages ?? getDefaultStreamImages('openai', DEFAULT_API_URL_PATCH?.apiMode ?? 'images'),
  streamPartialImages: DEFAULT_API_URL_PATCH?.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES,
  customProviders: [],
  clearInputAfterSubmit: false,
  persistInputOnRestart: true,
  reuseTaskApiProfileTemporarily: false,
  alwaysShowRetryButton: false,
  allowPromptRewrite: false,
  taskCompletionNotification: false,
  enterSubmit: false,
  referenceImageEditAction: 'ask',
  zipDownloadRoutes: DEFAULT_ZIP_DOWNLOAD_ROUTES,
  agentScrollToBottomAfterSubmit: true,
  agentMaxToolRounds: DEFAULT_AGENT_MAX_TOOL_ROUNDS,
  agentWebSearch: false,
  agentMathFormattingPrompt: true,
  agentApiConfigMode: 'off',
  agentTextProfileId: null,
  agentImageProfileId: null,
})
