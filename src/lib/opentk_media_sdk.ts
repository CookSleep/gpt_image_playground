// opentk_media_sdk —— 参考 fal_client 复刻的最小媒体生成客户端
//
// 仅实现本项目实际用到的能力：客户端配置、代理转发中间件、队列提交/状态轮询/
// 取结果、订阅（subscribe = 提交 + 轮询 + 取结果），以及提交前对输入中的二进制
// 文件做存储上传。接口与 fal 官方 JS 客户端保持兼容，可作为其直接替代。
//
// 协议参考：
//   - 同步运行：    https://fal.run/{appId}
//   - 队列提交：    https://queue.fal.run/{appId}
//   - 队列状态：    https://queue.fal.run/{owner}/{alias}/requests/{id}/status
//   - 队列结果：    https://queue.fal.run/{owner}/{alias}/requests/{id}
//   - 存储上传：    https://rest.fal.ai/storage/upload/initiate

const REST_API_URL = 'https://rest.fal.ai'
const TARGET_URL_HEADER = 'x-fal-target-url'
const REQUEST_ID_HEADER = 'x-fal-request-id'
const REQUEST_TIMEOUT_TYPE_HEADER = 'x-fal-request-timeout-type'
const QUEUE_PRIORITY_HEADER = 'x-fal-queue-priority'
const DEFAULT_POLL_INTERVAL = 500

export interface RetryOptions {
  maxRetries: number
  baseDelay: number
  maxDelay: number
  backoffMultiplier: number
  retryableStatusCodes: number[]
  enableJitter: boolean
}

const DEFAULT_RETRYABLE_STATUS_CODES = [429, 502, 503, 504]

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  retryableStatusCodes: DEFAULT_RETRYABLE_STATUS_CODES,
  enableJitter: true,
}

// 队列提交：写操作，重试更保守
const QUEUE_RETRY_CONFIG: Partial<RetryOptions> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 60000,
  retryableStatusCodes: DEFAULT_RETRYABLE_STATUS_CODES,
}

// 状态查询：只读，可更激进重试（含 500）
const QUEUE_STATUS_RETRY_CONFIG: Partial<RetryOptions> = {
  maxRetries: 5,
  baseDelay: 1000,
  maxDelay: 30000,
  retryableStatusCodes: [...DEFAULT_RETRYABLE_STATUS_CODES, 500],
}

export type ProxyWhen = 'always' | 'browser'
export type ProxyConfig = string | { url: string; when?: ProxyWhen }

export interface MediaClientConfig {
  credentials?: string | (() => string | undefined)
  suppressLocalCredentialsWarning?: boolean
  proxyUrl?: ProxyConfig
  fetch?: typeof fetch
  retry?: Partial<RetryOptions>
}

interface RequestSpec {
  method: string
  url: string
  headers?: Record<string, string>
}

type RequestMiddleware = (spec: RequestSpec) => Promise<RequestSpec>
type ResponseHandler<T> = (response: Response) => Promise<T>

interface ResolvedConfig {
  credentials?: string | (() => string | undefined)
  suppressLocalCredentialsWarning: boolean
  requestMiddleware: RequestMiddleware
  responseHandler: ResponseHandler<unknown>
  retry: RetryOptions
  fetch: typeof fetch
}

// fal 应用 id 形如 owner/alias 或 namespace/owner/alias，也兼容 123-alias 短格式
interface AppId {
  owner: string
  alias: string
  path?: string
  namespace?: string
}

const ENDPOINT_NAMESPACES = ['workflows', 'comfy']

function ensureEndpointIdFormat(id: string): string {
  const parts = id.split('/')
  if (parts.length > 1) return id

  const match = /^([0-9]+)-([a-zA-Z0-9-]+)$/.exec(id)
  if (match) return `${match[1]}/${match[2]}`

  throw new Error(`Invalid app id: ${id}. Must be in the format <appOwner>/<appId>`)
}

function parseEndpointId(id: string): AppId {
  const parts = ensureEndpointIdFormat(id).split('/')
  if (ENDPOINT_NAMESPACES.includes(parts[0])) {
    return {
      namespace: parts[0],
      owner: parts[1],
      alias: parts[2],
      path: parts.slice(3).join('/') || undefined,
    }
  }
  return {
    owner: parts[0],
    alias: parts[1],
    path: parts.slice(2).join('/') || undefined,
  }
}

// 已经是 fal.ai/fal.run 的完整 URL 则直接使用
function isValidUrl(url: string): boolean {
  try {
    return /(fal\.(ai|run))$/.test(new URL(url).host)
  } catch {
    return false
  }
}

interface BuildUrlOptions {
  method?: string
  path?: string
  subdomain?: string
  query?: Record<string, string>
}

function buildUrl(id: string, options: BuildUrlOptions = {}): string {
  const path = (options.path ?? '').replace(/^\//, '').replace(/\/{2,}/, '/')
  const query = options.query ?? {}
  const queryParams = Object.keys(query).length > 0
    ? `?${new URLSearchParams(query).toString()}`
    : ''

  if (isValidUrl(id)) {
    const url = id.endsWith('/') ? id : `${id}/`
    return `${url}${path}${queryParams}`
  }

  const appId = ensureEndpointIdFormat(id)
  const subdomain = options.subdomain ? `${options.subdomain}.` : ''
  const url = `https://${subdomain}fal.run/${appId}/${path}`
  return `${url.replace(/\/$/, '')}${queryParams}`
}

export class ApiError<B = unknown> extends Error {
  status: number
  body: B
  requestId: string
  timeoutType?: string

  constructor(opts: { message: string; status: number; body?: B; requestId?: string; timeoutType?: string }) {
    super(opts.message)
    this.name = 'ApiError'
    this.status = opts.status
    this.body = opts.body as B
    this.requestId = opts.requestId ?? ''
    this.timeoutType = opts.timeoutType
  }

  // 用户显式设置的超时（504 + timeoutType=user）不应被重试
  get isUserTimeout(): boolean {
    return this.status === 504 && this.timeoutType === 'user'
  }
}

export class ValidationError extends ApiError<{ detail?: unknown }> {
  constructor(opts: { message: string; status: number; body?: { detail?: unknown }; requestId?: string; timeoutType?: string }) {
    super(opts)
    this.name = 'ValidationError'
  }
}

async function defaultResponseHandler(response: Response): Promise<unknown> {
  const contentType = response.headers.get('Content-Type') ?? ''
  const requestId = response.headers.get(REQUEST_ID_HEADER) || undefined
  const timeoutType = response.headers.get(REQUEST_TIMEOUT_TYPE_HEADER) || undefined

  if (!response.ok) {
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as { message?: string; detail?: unknown }
      const ErrorType = response.status === 422 ? ValidationError : ApiError
      throw new ErrorType({
        message: body.message || response.statusText,
        status: response.status,
        body,
        requestId,
        timeoutType,
      })
    }
    throw new ApiError({
      message: `HTTP ${response.status}: ${response.statusText}`,
      status: response.status,
      requestId,
      timeoutType,
    })
  }

  if (contentType.includes('application/json')) return response.json()
  if (contentType.includes('text/html')) return response.text()
  if (contentType.includes('application/octet-stream')) return response.arrayBuffer()
  return response.text()
}

export interface Result<T = unknown> {
  data: T
  requestId: string
}

async function resultResponseHandler(response: Response): Promise<Result> {
  const data = await defaultResponseHandler(response)
  return { data, requestId: response.headers.get(REQUEST_ID_HEADER) || '' }
}

function isRetryableError(error: unknown, retryableStatusCodes: number[]): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.isUserTimeout) return false
  return retryableStatusCodes.includes(error.status)
}

function calculateBackoffDelay(attempt: number, opts: RetryOptions): number {
  const exponential = Math.min(opts.baseDelay * Math.pow(opts.backoffMultiplier, attempt), opts.maxDelay)
  if (!opts.enableJitter) return exponential
  // ±25% 抖动，避免惊群
  const jitter = 0.25 * exponential * (Math.random() * 2 - 1)
  return Math.max(0, exponential + jitter)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const isBrowser = (): boolean => typeof window !== 'undefined' && typeof window.document !== 'undefined'

// 代理中间件：浏览器（或 when='always'）下，把请求改发到代理地址，
// 原始目标地址放入 x-fal-target-url 头，由代理服务端转发。
function withProxy(proxy: { url: string; when?: ProxyWhen }): RequestMiddleware {
  const shouldProxy = (): boolean => {
    if (proxy.when === 'always') return true
    if (proxy.when === 'browser') return isBrowser()
    return isBrowser()
  }
  return (spec) => {
    if (spec.headers && TARGET_URL_HEADER in spec.headers) return Promise.resolve(spec)
    if (!shouldProxy()) return Promise.resolve(spec)
    return Promise.resolve({
      ...spec,
      url: proxy.url,
      headers: { ...(spec.headers ?? {}), [TARGET_URL_HEADER]: spec.url },
    })
  }
}

function withMiddleware(...middlewares: RequestMiddleware[]): RequestMiddleware {
  return async (spec) => {
    let current = spec
    for (const middleware of middlewares) {
      current = await middleware(current)
    }
    return current
  }
}

function resolveConfig(config: MediaClientConfig): ResolvedConfig {
  const baseMiddleware: RequestMiddleware = (spec) => Promise.resolve(spec)
  const requestMiddleware = config.proxyUrl
    ? withMiddleware(
        baseMiddleware,
        withProxy(typeof config.proxyUrl === 'string' ? { url: config.proxyUrl } : config.proxyUrl),
      )
    : baseMiddleware

  const resolved: ResolvedConfig = {
    credentials: config.credentials,
    suppressLocalCredentialsWarning: config.suppressLocalCredentialsWarning ?? false,
    requestMiddleware,
    responseHandler: defaultResponseHandler,
    retry: { ...DEFAULT_RETRY_OPTIONS, ...(config.retry ?? {}) },
    fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
  }

  const credentials = typeof resolved.credentials === 'function' ? resolved.credentials() : resolved.credentials
  if (isBrowser() && credentials && !resolved.suppressLocalCredentialsWarning) {
    console.warn(
      "The media credentials are exposed in the browser's environment. " +
        "That's not recommended for production use cases.",
    )
  }
  return resolved
}

interface DispatchOptions {
  signal?: AbortSignal
  retry?: Partial<RetryOptions>
  responseHandler?: ResponseHandler<unknown>
}

interface DispatchParams {
  method?: string
  targetUrl: string
  input?: unknown
  headers?: Record<string, string>
  config: ResolvedConfig
  options?: DispatchOptions
}

async function dispatchRequest<T>(params: DispatchParams): Promise<T> {
  const config = params.config
  const options = params.options ?? {}
  const retryOptions: RetryOptions = { ...config.retry, ...(options.retry ?? {}) }

  const execute = async (): Promise<T> => {
    const credentials = typeof config.credentials === 'function' ? config.credentials() : config.credentials
    const spec = await config.requestMiddleware({
      method: (params.method ?? 'post').toUpperCase(),
      url: params.targetUrl,
      headers: params.headers,
    })

    const authHeader: Record<string, string> = credentials ? { Authorization: `Key ${credentials}` } : {}
    // 浏览器禁止设置 User-Agent，故仅在非浏览器环境补充
    const userAgent: Record<string, string> = isBrowser() ? {} : { 'User-Agent': 'opentk-media-sdk/1.0.0' }
    const requestHeaders: Record<string, string> = {
      ...authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...userAgent,
      ...(spec.headers ?? {}),
    }

    const method = spec.method
    const response = await config.fetch(spec.url, {
      method,
      headers: requestHeaders,
      mode: 'cors',
      signal: options.signal,
      body: method.toLowerCase() !== 'get' && params.input !== undefined ? JSON.stringify(params.input) : undefined,
    })

    const handle = options.responseHandler ?? config.responseHandler
    return (await handle(response)) as T
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= retryOptions.maxRetries; attempt++) {
    try {
      return await execute()
    } catch (error) {
      lastError = error
      const shouldNotRetry =
        attempt === retryOptions.maxRetries ||
        !isRetryableError(error, retryOptions.retryableStatusCodes) ||
        options.signal?.aborted
      if (shouldNotRetry) throw error
      await sleep(calculateBackoffDelay(attempt, retryOptions))
    }
  }
  throw lastError
}

// 存储上传：提交前把输入中的 Blob/File 上传到 CDN，替换为可访问 URL
async function uploadBlob(file: Blob, config: ResolvedConfig): Promise<string> {
  const contentType = file.type || 'application/octet-stream'
  const fileName = (file as File).name || `${Date.now()}.${(contentType.split('/')[1] ?? 'bin').split(/[-;]/)[0]}`

  const init = await dispatchRequest<{ upload_url: string; file_url: string }>({
    method: 'POST',
    targetUrl: `${REST_API_URL}/storage/upload/initiate?storage_type=fal-cdn-v3`,
    input: { content_type: contentType, file_name: fileName },
    config,
  })

  const putResponse = await config.fetch(init.upload_url, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': contentType },
  })
  if (!putResponse.ok) {
    throw new ApiError({ message: `Upload failed: HTTP ${putResponse.status}`, status: putResponse.status })
  }
  return init.file_url
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && Object.getPrototypeOf(value) === Object.prototype

async function transformInput(input: unknown, config: ResolvedConfig): Promise<unknown> {
  if (Array.isArray(input)) return Promise.all(input.map((item) => transformInput(item, config)))
  if (input instanceof Blob) return uploadBlob(input, config)
  if (isPlainObject(input)) {
    const entries = await Promise.all(
      Object.entries(input).map(async ([key, value]) => [key, await transformInput(value, config)] as const),
    )
    return Object.fromEntries(entries)
  }
  return input
}

export type QueueStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'

export interface RequestStatus {
  status: QueueStatus
  request_id: string
  logs?: Array<Record<string, unknown>> | null
  queue_position?: number
  [key: string]: unknown
}

export interface SubmitResponse {
  request_id: string
  response_url: string
  status_url: string
  cancel_url: string
}

export interface SubmitOptions {
  input?: unknown
  method?: string
  path?: string
  webhookUrl?: string
  priority?: 'normal' | 'low'
  hint?: string
  headers?: Record<string, string>
  abortSignal?: AbortSignal
}

export interface StatusOptions {
  requestId: string
  headers?: Record<string, string>
  logs?: boolean
  abortSignal?: AbortSignal
}

export interface SubscribeToStatusOptions extends StatusOptions {
  pollInterval?: number
  onQueueUpdate?: (status: RequestStatus) => void
}

export interface SubscribeOptions extends SubmitOptions {
  logs?: boolean
  pollInterval?: number
  onEnqueue?: (requestId: string) => void
  onQueueUpdate?: (status: RequestStatus) => void
}

function createQueueClient(config: ResolvedConfig) {
  const client = {
    async submit(endpointId: string, options: SubmitOptions): Promise<SubmitResponse> {
      const input = options.input !== undefined ? await transformInput(options.input, config) : undefined
      const headers: Record<string, string> = {
        ...(options.headers ?? {}),
        [QUEUE_PRIORITY_HEADER]: options.priority ?? 'normal',
        ...(options.hint ? { 'x-fal-runner-hint': options.hint } : {}),
      }
      return dispatchRequest<SubmitResponse>({
        method: options.method,
        targetUrl: buildUrl(endpointId, {
          subdomain: 'queue',
          path: options.path,
          query: options.webhookUrl ? { fal_webhook: options.webhookUrl } : undefined,
        }),
        headers,
        input,
        config,
        options: { signal: options.abortSignal, retry: QUEUE_RETRY_CONFIG },
      })
    },

    async status(endpointId: string, options: StatusOptions): Promise<RequestStatus> {
      const appId = parseEndpointId(endpointId)
      const prefix = appId.namespace ? `${appId.namespace}/` : ''
      return dispatchRequest<RequestStatus>({
        method: 'get',
        targetUrl: buildUrl(`${prefix}${appId.owner}/${appId.alias}`, {
          subdomain: 'queue',
          query: { logs: options.logs ? '1' : '0' },
          path: `/requests/${options.requestId}/status`,
        }),
        headers: options.headers,
        config,
        options: { signal: options.abortSignal, retry: QUEUE_STATUS_RETRY_CONFIG },
      })
    },

    // 轮询状态直至 COMPLETED
    subscribeToStatus(endpointId: string, options: SubscribeToStatusOptions): Promise<RequestStatus> {
      const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL
      return new Promise((resolve, reject) => {
        const poll = async () => {
          try {
            const status = await client.status(endpointId, {
              requestId: options.requestId,
              headers: options.headers,
              logs: options.logs ?? false,
              abortSignal: options.abortSignal,
            })
            options.onQueueUpdate?.(status)
            if (status.status === 'COMPLETED') {
              resolve(status)
              return
            }
            setTimeout(poll, pollInterval)
          } catch (error) {
            reject(error)
          }
        }
        poll().catch(reject)
      })
    },

    async result<T = unknown>(endpointId: string, options: StatusOptions): Promise<Result<T>> {
      const appId = parseEndpointId(endpointId)
      const prefix = appId.namespace ? `${appId.namespace}/` : ''
      return dispatchRequest<Result<T>>({
        method: 'get',
        targetUrl: buildUrl(`${prefix}${appId.owner}/${appId.alias}`, {
          subdomain: 'queue',
          path: `/requests/${options.requestId}`,
        }),
        headers: options.headers,
        config: { ...config, responseHandler: resultResponseHandler as ResponseHandler<unknown> },
        options: { signal: options.abortSignal, retry: QUEUE_RETRY_CONFIG },
      })
    },
  }
  return client
}

export interface MediaClient {
  queue: ReturnType<typeof createQueueClient>
  subscribe<T = unknown>(endpointId: string, options: SubscribeOptions): Promise<Result<T>>
}

export function createMediaClient(userConfig: MediaClientConfig = {}): MediaClient {
  const config = resolveConfig(userConfig)
  const queue = createQueueClient(config)

  return {
    queue,
    async subscribe<T = unknown>(endpointId: string, options: SubscribeOptions): Promise<Result<T>> {
      const { request_id: requestId } = await queue.submit(endpointId, options)
      options.onEnqueue?.(requestId)
      await queue.subscribeToStatus(endpointId, {
        requestId,
        headers: options.headers,
        logs: options.logs,
        pollInterval: options.pollInterval,
        onQueueUpdate: options.onQueueUpdate,
        abortSignal: options.abortSignal,
      })
      return queue.result<T>(endpointId, { requestId, headers: options.headers, abortSignal: options.abortSignal })
    },
  }
}

// 兼容旧式单例用法：client.config(...) 会重建底层客户端实例
function createSingleton() {
  let instance = createMediaClient()
  return {
    config(config: MediaClientConfig) {
      instance = createMediaClient(config)
    },
    get queue() {
      return instance.queue
    },
    subscribe<T = unknown>(endpointId: string, options: SubscribeOptions): Promise<Result<T>> {
      return instance.subscribe<T>(endpointId, options)
    },
  }
}

export const client = createSingleton()
