export function hasCompleteSettings(settings: { imageApiKeyId: string | null; promptApiKeyId: string | null } | null) {
  return Boolean(settings?.imageApiKeyId && settings.promptApiKeyId)
}

export function applyOptimizedPrompt(current: string, optimized: string, confirmed: boolean) {
  return confirmed ? optimized.trim() : current
}
