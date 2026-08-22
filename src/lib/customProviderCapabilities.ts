import type { CustomProviderDefinition, CustomProviderSubmitMapping } from '../types'

function hasNativeTransparentBackgroundMapping(value: unknown): boolean {
  if (value === '$params.background') return true
  if (Array.isArray(value)) return value.some(hasNativeTransparentBackgroundMapping)
  if (!value || typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).some(hasNativeTransparentBackgroundMapping)
}

function customProviderSubmitSupportsNativeTransparentBackground(mapping: CustomProviderSubmitMapping): boolean {
  return hasNativeTransparentBackgroundMapping(mapping.body) || hasNativeTransparentBackgroundMapping(mapping.query)
}

export function customProviderSupportsNativeTransparentBackground(provider: CustomProviderDefinition): boolean {
  if (!customProviderSubmitSupportsNativeTransparentBackground(provider.submit)) return false
  return !provider.editSubmit || customProviderSubmitSupportsNativeTransparentBackground(provider.editSubmit)
}
