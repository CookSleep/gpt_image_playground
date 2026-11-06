import type { CustomProviderDefinition, CustomProviderSubmitMapping } from '../types'
import { resolveCustomProviderModel } from './imageProviderMappings'

function hasNativeTransparentBackgroundMapping(value: unknown): boolean {
  if (value === '$params.background') return true
  if (Array.isArray(value)) return value.some(hasNativeTransparentBackgroundMapping)
  if (!value || typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).some(hasNativeTransparentBackgroundMapping)
}

function customProviderSubmitSupportsNativeTransparentBackground(mapping: CustomProviderSubmitMapping): boolean {
  return hasNativeTransparentBackgroundMapping(mapping.body) || hasNativeTransparentBackgroundMapping(mapping.query)
}

export function customProviderSupportsNativeTransparentBackground(provider: CustomProviderDefinition, model?: string): boolean {
  // 保存配置时保留任一模型可用的偏好，请求时按实际模型判断。
  const mappings = model === undefined ? [provider, ...provider.modelOverrides ?? []] : [resolveCustomProviderModel(provider, model)]
  return mappings.some((mapping) => customProviderSubmitSupportsNativeTransparentBackground(mapping.submit)
    && (!mapping.editSubmit || customProviderSubmitSupportsNativeTransparentBackground(mapping.editSubmit)))
}
