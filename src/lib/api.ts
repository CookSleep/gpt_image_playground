import { getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { composeMarkupDataUrl, toApiInputImageDataUrl } from './canvasImage'
import { callFalAiImageApi } from './falAiImageApi'
import { supportsImageMarkup } from './imageModels'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  const inputImageDataUrls = await Promise.all(opts.inputImageDataUrls.map(toApiInputImageDataUrl))
  const inputImageUrls = opts.inputImageUrls ? [...opts.inputImageUrls] : undefined
  let markupDataUrl = opts.markupDataUrl
  // 接口不支持 markup，或已有遮罩（两者不能同时使用）时，把标注直接画进第一张图
  if (markupDataUrl && inputImageDataUrls.length && (opts.maskDataUrl || !supportsImageMarkup(profile))) {
    inputImageDataUrls[0] = await composeMarkupDataUrl(inputImageDataUrls[0], markupDataUrl)
    if (inputImageUrls) inputImageUrls[0] = null
    markupDataUrl = undefined
  }
  const requestOpts = { ...opts, inputImageDataUrls, inputImageUrls, markupDataUrl }
  if (profile.provider === 'fal') return callFalAiImageApi(requestOpts, profile)

  return callOpenAICompatibleImageApi(requestOpts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
}
