export interface ApiUser {
  id: string
  username: string
  nickname: string
  role: 'user' | 'admin'
  status: 'pending' | 'active' | 'disabled'
  quotaRemaining: number
  quotaUsed: number
  createdAt: string
  updatedAt: string
}

export interface ApiGenerationImage {
  id: string
  contentType: string
  revisedPrompt?: string | null
}

export interface ApiGeneration {
  id: string
  prompt: string
  params: {
    size: string
    quality: string
    output_format: string
    n: number
  }
  status: 'running' | 'done' | 'error'
  model: string
  error: string | null
  elapsedMs: number | null
  images: ApiGenerationImage[]
  createdAt: string
  finishedAt: string | null
}

async function readJson(response: Response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const payload = await readJson(response)
  if (!response.ok) {
    throw new Error(payload.message || `请求失败：HTTP ${response.status}`)
  }
  return payload as T
}

export function imageUrl(id: string) {
  return `/api/images/${encodeURIComponent(id)}`
}

