export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
export type StudioView = 'gallery' | 'workspace' | 'assets'
export type GenerationFilter = 'all' | 'running' | 'done' | 'error'
export type StudioLocation = { view: StudioView; filter: GenerationFilter; generationId: string }
export type StudioDraft = {
  prompt: string
  size: string
  quality: string
  format: string
  imageCount: number
}

export function sanitizeThemePreference(value: string | null): ThemePreference {
  if (value === 'light' || value === 'dark') return value
  return 'system'
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

export function cycleIndex(current: number, direction: number, count: number) {
  if (count <= 0) return 0
  return (current + direction + count) % count
}

export function serializeStudioDraft(draft: StudioDraft) {
  return JSON.stringify(draft)
}

export function parseStudioDraft(value: string | null): StudioDraft | null {
  if (!value) return null
  try {
    const draft = JSON.parse(value) as Partial<StudioDraft>
    if (typeof draft.prompt !== 'string' || typeof draft.size !== 'string' || typeof draft.quality !== 'string' || typeof draft.format !== 'string' || typeof draft.imageCount !== 'number') return null
    return { prompt: draft.prompt, size: draft.size, quality: draft.quality, format: draft.format, imageCount: draft.imageCount }
  } catch {
    return null
  }
}

export function buildGenerationNotice(status: 'running' | 'done' | 'error', prompt: string) {
  const label = prompt.length > 24 ? `${prompt.slice(0, 24)}…` : prompt
  if (status === 'running') return `任务已创建，正在生成「${label}」`
  if (status === 'done') return `生成完成：「${label}」已加入图片资产`
  return `生成失败：「${label}」，请查看任务详情后重试`
}


export function parseStudioLocation(search: string): StudioLocation {
  const params = new URLSearchParams(search)
  const view = params.get('view')
  const filter = params.get('filter')
  return {
    view: view === 'workspace' || view === 'assets' ? view : 'gallery',
    filter: filter === 'running' || filter === 'done' || filter === 'error' ? filter : 'all',
    generationId: params.get('generation') ?? '',
  }
}

export function serializeStudioLocation(location: StudioLocation) {
  const params = new URLSearchParams()
  params.set('view', location.view)
  params.set('filter', location.filter)
  if (location.generationId) params.set('generation', location.generationId)
  return `?${params.toString()}`
}


export function wheelCarouselDirection(deltaX: number, deltaY: number) {
  if (Math.abs(deltaX) < 24 || Math.abs(deltaX) <= Math.abs(deltaY)) return 0
  return deltaX > 0 ? 1 : -1
}


export async function withSingleRetry<T>(request: () => Promise<T>) {
  try {
    return await request()
  } catch {
    return request()
  }
}


export function carouselPosition(index: number, current: number, count: number) {
  if (index === current) return 'current'
  if (index === cycleIndex(current, -1, count)) return 'previous'
  if (index === cycleIndex(current, 1, count)) return 'next'
  return 'hidden'
}
