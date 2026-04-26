// ===== 设置 =====

export type ApiMode = 'images' | 'responses'

export interface AppSettings {
  baseUrl: string
  apiKey: string
  model: string
  timeout: number
  apiMode: ApiMode
}

const DEFAULT_BASE_URL = import.meta.env.VITE_DEFAULT_API_URL?.trim() || 'https://api.openai.com'

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: DEFAULT_BASE_URL,
  apiKey: '',
  model: 'gpt-image-2',
  timeout: 300,
  apiMode: 'images',
}

// ===== 任务参数 =====

export interface TaskParams {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
}

export const DEFAULT_PARAMS: TaskParams = {
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: 'auto',
  n: 1,
}

// ===== 输入图片（UI 层面） =====

export interface InputImage {
  /** IndexedDB image store 的 id（SHA-256 hash） */
  id: string
  /** data URL，用于预览 */
  dataUrl: string
}

// ===== 任务记录 =====

export type TaskStatus = 'running' | 'done' | 'error'

export interface TaskRecord {
  id: string
  prompt: string
  params: TaskParams
  /** 输入图片的 image store id 列表 */
  inputImageIds: string[]
  /** 输出图片的 image store id 列表 */
  outputImages: string[]
  status: TaskStatus
  error: string | null
  createdAt: number
  finishedAt: number | null
  /** 总耗时毫秒 */
  elapsed: number | null
}

// ===== IndexedDB 存储的图片 =====

export interface StoredImage {
  id: string
  dataUrl: string
  /** 图片首次存储时间（ms） */
  createdAt?: number
  /** 图片来源：用户上传 / API 生成 */
  source?: 'upload' | 'generated'
}

// ===== API 请求体 =====

export interface ImageGenerationRequest {
  model: string
  prompt: string
  size: string
  quality: string
  output_format: string
  moderation: string
  output_compression?: number
  n?: number
}

// ===== API 响应 =====

export interface ImageResponseItem {
  b64_json?: string
  url?: string
}

export interface ImageApiResponse {
  data: ImageResponseItem[]
}

export interface ResponsesOutputItem {
  type?: string
  result?: string | {
    b64_json?: string
    image?: string
    data?: string
  }
}

export interface ResponsesApiResponse {
  output?: ResponsesOutputItem[]
}

// ===== 导出数据 =====

/** ZIP manifest.json 格式 */
export interface ExportData {
  version: number
  exportedAt: string
  settings: AppSettings
  tasks: TaskRecord[]
  /** imageId → 图片信息 */
  imageFiles: Record<string, {
    path: string
    createdAt?: number
    source?: 'upload' | 'generated'
  }>
}
