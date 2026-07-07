import { DEFAULT_PARAMS, type AppSettings, type TaskParams } from '../types'
import { ATLAS_CLOUD_DEFAULT_IMAGE_SIZE, ATLAS_CLOUD_DEFAULT_QUALITY, ATLAS_CLOUD_PROVIDER_ID, getActiveApiProfile } from './apiProfiles'
import { normalizeImageSize } from './size'

export const MAX_ATLAS_CLOUD_OUTPUT_IMAGES = 1
export const DEFAULT_FAL_IMAGE_SIZE = '1360x1024'
export const MAX_FAL_OUTPUT_IMAGES = 4
export const MAX_OPENAI_OUTPUT_IMAGES = 10

export function getOutputImageLimitForSettings(settings: AppSettings) {
  const provider = getActiveApiProfile(settings).provider
  if (provider === ATLAS_CLOUD_PROVIDER_ID) return MAX_ATLAS_CLOUD_OUTPUT_IMAGES
  return provider === 'fal' ? MAX_FAL_OUTPUT_IMAGES : MAX_OPENAI_OUTPUT_IMAGES
}

export function normalizeParamsForSettings(
  params: TaskParams,
  settings: AppSettings,
  options: { hasInputImages?: boolean } = {},
): TaskParams {
  const activeProfile = getActiveApiProfile(settings)
  const outputImageLimit = getOutputImageLimitForSettings(settings)
  const nextParams: TaskParams = {
    ...params,
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    n: Math.min(outputImageLimit, Math.max(1, params.n || DEFAULT_PARAMS.n)),
  }

  if (activeProfile.provider === 'openai' && activeProfile.codexCli) {
    nextParams.quality = DEFAULT_PARAMS.quality
  }

  if (activeProfile.provider === 'fal') {
    if (!options.hasInputImages && nextParams.size === 'auto') nextParams.size = DEFAULT_FAL_IMAGE_SIZE
    if (nextParams.quality === 'auto') nextParams.quality = 'high'
    nextParams.moderation = DEFAULT_PARAMS.moderation
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  if (activeProfile.provider === ATLAS_CLOUD_PROVIDER_ID) {
    if (nextParams.size === 'auto') nextParams.size = ATLAS_CLOUD_DEFAULT_IMAGE_SIZE
    if (nextParams.quality === 'auto') nextParams.quality = ATLAS_CLOUD_DEFAULT_QUALITY
    if (nextParams.output_format === 'webp') nextParams.output_format = DEFAULT_PARAMS.output_format
    if (nextParams.moderation === 'auto') nextParams.moderation = 'low'
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  if (nextParams.output_format === 'png') {
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  return nextParams
}

export function getChangedParams(current: TaskParams, next: TaskParams): Partial<TaskParams> {
  const patch: Partial<TaskParams> = {}
  for (const key of Object.keys(next) as Array<keyof TaskParams>) {
    if (current[key] !== next[key]) {
      ;(patch as Record<keyof TaskParams, TaskParams[keyof TaskParams]>)[key] = next[key]
    }
  }
  return patch
}
