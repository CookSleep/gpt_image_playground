import type { ApiProfile } from '../types'
import { buildApiUrl, readClientDevProxyConfig } from './devProxy'
import { getImageModelParams } from './imageModelParams'
import { getImageSearchSupport, getImageThinkingSupport, parseImageSearchGrounding } from './imageSearch'
import { assertImageInputPayloadSize, createRequestTimeoutError, getApiErrorMessage, mergeConcurrentApiResults, type CallApiOptions, type CallApiResult } from './imageApiShared'
import { apiFetch } from './platform'

export async function callGoogleImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  // generateContent 没有 n 参数，多张使用独立请求，不传多轮历史。
  if (n > 1) {
    const results = await Promise.allSettled(Array.from({ length: n }, () => callGoogleImageApi({
      ...opts,
      params: { ...opts.params, n: 1 },
    }, profile)))
    return mergeConcurrentApiResults(results)
  }
  if (opts.maskDataUrl) throw new Error('此模型不支持遮罩编辑，请使用参考图和提示词描述修改内容')
  const params = getImageModelParams(profile, opts.params)
  const search = getImageSearchSupport(profile)
  const googleSearch = !search.googleSearch && opts.params.google_search
  const imageSearch = !search.imageSearch && opts.params.image_search
  const thinking = getImageThinkingSupport(profile)
  const thinkingConfig = thinking.levels.includes(opts.params.thinking_level ?? '') ? { thinkingLevel: opts.params.thinking_level!.toUpperCase() } : undefined
  const tools = googleSearch || imageSearch ? [{ googleSearch: search.imageSearch ? {} : {
    searchTypes: { ...(googleSearch ? { webSearch: {} } : {}), ...(imageSearch ? { imageSearch: {} } : {}) },
  } }] : undefined
  const parts: Array<Record<string, unknown>> = [{ text: opts.prompt }]
  for (const url of opts.inputImageDataUrls) {
    const match = url.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/)
    if (!match) throw new Error('参考图不是有效的 Base64 图片')
    parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
  }
  assertImageInputPayloadSize(opts.inputImageDataUrls.reduce((sum, url) => sum + url.length, 0))
  const imageConfig = {
    ...(params.aspect_ratio === 'auto' ? {} : { aspectRatio: params.aspect_ratio }),
    ...(params.resolution ? { imageSize: params.resolution } : {}),
  }
  const model = profile.model.replace(/^models\//, '')
  const url = buildApiUrl(profile.baseUrl, `models/${encodeURIComponent(model)}:generateContent`, readClientDevProxyConfig(), false, 'v1beta')
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)
  try {
    const response = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': profile.apiKey },
      cache: 'no-store',
      body: JSON.stringify({ contents: [{ role: 'user', parts }], tools, generationConfig: { responseModalities: ['IMAGE'], imageConfig, thinkingConfig } }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    const payload = await response.json()
    const images: string[] = []
    const actualParamsList: NonNullable<CallApiResult['actualParamsList']> = []
    const searchGrounding: NonNullable<CallApiResult['searchGrounding']> = []
    for (const candidate of Array.isArray(payload?.candidates) ? payload.candidates : []) {
      // 启用 Image Search 后仍可能只返回 web 来源或缺少 groundingMetadata，按实际响应展示，不能据此判定未执行图片搜索
      const grounding = parseImageSearchGrounding(candidate?.groundingMetadata)
      if (grounding) searchGrounding.push(grounding)
      for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
        if (!part || part.thought) continue
        const data = part.inlineData ?? part.inline_data
        const mime = data?.mimeType ?? data?.mime_type
        if (typeof data?.data !== 'string' || !data.data || typeof mime !== 'string' || !mime.startsWith('image/')) continue
        images.push(`data:${mime};base64,${data.data}`)
        actualParamsList.push({ aspect_ratio: params.aspect_ratio, ...(params.resolution ? { resolution: params.resolution } : {}), ...(mime === 'image/jpeg' ? { output_format: 'jpeg' } : mime === 'image/png' ? { output_format: 'png' } : {}) })
      }
    }
    if (!images.length) {
      const reason = payload?.promptFeedback?.blockReason ?? payload?.candidates?.[0]?.finishReason
      throw Object.assign(new Error(`接口未返回图片${reason ? `：${reason}` : ''}`), { rawResponsePayload: JSON.stringify(payload, null, 2) })
    }
    return { images, actualParamsList, ...(searchGrounding.length ? { searchGrounding } : {}) }
  } catch (err) {
    console.warn('Google 图像请求失败', err)
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}
