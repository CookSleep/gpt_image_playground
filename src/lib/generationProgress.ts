type GenerationProgressInput = {
  status: 'running' | 'done' | 'error'
  createdAt: string
  elapsedMs: number | null
}

export function formatRunDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')

  if (hours > 0) return `${hours}:${mm}:${ss}`
  return `${mm}:${ss}`
}

function formatElapsedSeconds(ms: number) {
  return `${Math.max(0, Math.round(ms / 1000))} 秒`
}

function getRunningMs(createdAt: string, now: number) {
  const startedAt = Date.parse(createdAt)
  if (!Number.isFinite(startedAt)) return 0
  return Math.max(0, now - startedAt)
}

export function getGenerationProgress(generation: GenerationProgressInput, now = Date.now()) {
  if (generation.status === 'running') {
    const runningMs = getRunningMs(generation.createdAt, now)
    const duration = formatRunDuration(runningMs)
    const hint = runningMs >= 180_000
      ? '生成时间较长，可稍后刷新查看'
      : runningMs >= 60_000
        ? '仍在生成，图片任务可能需要更久'
        : null

    return {
      timingText: `生成中 · ${duration}`,
      detailText: `已运行 ${duration}`,
      hint,
    }
  }

  if (generation.status === 'done' && generation.elapsedMs != null) {
    const elapsed = formatElapsedSeconds(generation.elapsedMs)
    return {
      timingText: `耗时 ${elapsed}`,
      detailText: `总耗时 ${elapsed}`,
      hint: null,
    }
  }

  return {
    timingText: generation.status === 'error' ? '失败 · 未扣费' : '-',
    detailText: generation.status === 'error' ? '失败未扣费' : '-',
    hint: null,
  }
}
