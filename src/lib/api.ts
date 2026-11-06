import { getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { composeMarkupDataUrl, toApiInputImageDataUrl } from './canvasImage'
import { callFalAiImageApi } from './falAiImageApi'
import { callGoogleImageApi } from './googleImageApi'
import { supportsImageMarkup } from './imageModels'
import { getImageSearchSupport } from './imageSearch'
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
  const customProvider = getCustomProviderDefinition(opts.settings, profile.provider)
  const search = getImageSearchSupport(profile, customProvider)
  const prefix = opts.settings.imagePromptHints && profile.provider === 'google' ? '生成图像：' : ''
  const suffix = opts.settings.imagePromptHints ? [
    !search.googleSearch && opts.params.google_search ? '请使用 google:search 搜索相关信息。' : '',
    !search.imageSearch && opts.params.image_search ? '请使用 google:image_search 搜索图片，作为生成图像的参考。' : '',
  ].filter(Boolean).join('\n') : ''
  opts.onPromptHintsPrepared?.(prefix || suffix ? { prefix, suffix } : undefined)
  const prompt = `${prefix ? `${prefix}\n` : ''}${opts.prompt}${suffix ? `\n${suffix}` : ''}`
  const requestOpts = { ...opts, prompt, inputImageDataUrls, inputImageUrls, markupDataUrl }
  if (profile.provider === 'fal') return callFalAiImageApi(requestOpts, profile)
  if (profile.provider === 'google') return callGoogleImageApi(requestOpts, profile)

  return callOpenAICompatibleImageApi(requestOpts, profile, customProvider)
}
