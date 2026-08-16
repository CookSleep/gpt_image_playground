import type { TaskParams } from '../types'
import { authFetch } from '../auth/api'
import { createImageStatusRequestId, type CallApiResult } from './imageApiShared'

interface BackendGenerationResponse {
  images?: unknown
  image_ids?: unknown
  actual_params?: unknown
  revised_prompts?: unknown
}

export async function callBackendImageApi(options: {
  projectId: string
  projectTitle: string
  taskId: string
  apiKey: string
  model: string
  apiMode: 'images' | 'responses'
  allowPromptRewrite: boolean
  codexCli: boolean
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
  onImageStatusRequestCreated?: (request: { requestId: string; requestIndex?: number }) => void
}): Promise<CallApiResult> {
  const requestCount = options.apiMode === 'responses' ? Math.max(1, options.params.n) : 1
  const requestIds = Array.from({ length: requestCount }, (_, requestIndex) => {
    const requestId = createImageStatusRequestId()
    options.onImageStatusRequestCreated?.({
      requestId,
      ...(requestCount > 1 ? { requestIndex } : {}),
    })
    return requestId
  })
  const resp = await authFetch(`/api/v1/projects/${encodeURIComponent(options.projectId)}/generations`, {
    method: 'POST',
    body: JSON.stringify({
      task_id: options.taskId,
      project_title: options.projectTitle,
      api_key: options.apiKey,
      model: options.model,
      api_mode: options.apiMode,
      allow_prompt_rewrite: options.allowPromptRewrite,
      codex_cli: options.codexCli,
      request_ids: requestIds,
      prompt: options.prompt,
      params: options.params,
      input_images: options.inputImageDataUrls,
      mask: options.maskDataUrl,
    }),
  })
  const data = await resp.json().catch(() => null) as BackendGenerationResponse & { message?: string } | null
  if (!resp.ok) throw new Error(data?.message || `后端生图失败：HTTP ${resp.status}`)

  const images = Array.isArray(data?.images) ? data.images.filter((item): item is string => typeof item === 'string' && item.startsWith('data:image/')) : []
  if (images.length === 0) throw new Error('后端生图接口没有返回图片')

  const actualParams = data?.actual_params && typeof data.actual_params === 'object'
    ? data.actual_params as Partial<TaskParams>
    : undefined
  const revisedPrompts = Array.isArray(data?.revised_prompts)
    ? data.revised_prompts.map((item) => typeof item === 'string' ? item : undefined)
    : undefined
  const imageIds = Array.isArray(data?.image_ids)
    ? data.image_ids.filter((item): item is string => typeof item === 'string')
    : undefined

  return {
    images,
    actualParams,
    actualParamsList: images.map(() => actualParams),
    revisedPrompts,
    imagesStoredOnline: true,
    imageIds,
  }
}
