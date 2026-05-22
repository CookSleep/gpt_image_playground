import { fetchImageUrlAsDataUrl, isDataUrl } from './imageApiShared'

const OPENVERSE_IMAGE_SEARCH_URL = 'https://api.openverse.org/v1/images/'
const WIKIMEDIA_IMAGE_SEARCH_URL = 'https://commons.wikimedia.org/w/api.php'
const DEFAULT_IMAGE_COUNT = 6
const MAX_IMAGE_COUNT = 12
const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']
const AGENT_PAGE_FETCH_PATH = '/agent-page-fetch'
const AGENT_IMAGE_FETCH_PATH = '/agent-image-fetch'
const AGENT_FETCH_HEADER = 'x-agent-fetch'
const AGENT_FETCH_UNAVAILABLE = 'agent-fetch-proxy-unavailable'
const HARUHIKAGE_SOURCE_PAGES = [
  'https://anime.bang-dream.com/mygo/character/tomori/',
  'https://anime.bang-dream.com/mygo/character/soyo/',
  'https://anime.bang-dream.com/mygo/character/sakiko/',
  'https://anime.bang-dream.com/mygo/character/taki/',
  'https://anime.bang-dream.com/mygo/character/anon/',
  'https://anime.bang-dream.com/mygo/character/rana/',
  'https://anime.bang-dream.com/mygo/character/mutsumi/',
]

export interface AgentImageSearchResult {
  id: string
  title: string
  imageUrl: string
  thumbnailUrl?: string
  pageUrl?: string
  creator?: string
  creatorUrl?: string
  license?: string
  licenseUrl?: string
  source: string
  provider?: string
  width?: number
  height?: number
  mimeType?: string
  attribution?: string
}

export interface AgentImageSearchResponse {
  query: string
  source: 'webpage' | 'openverse' | 'wikimedia' | 'mixed'
  pageUrls?: string[]
  results: AgentImageSearchResult[]
  warnings?: string[]
}

function clampCount(value: unknown) {
  const count = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : DEFAULT_IMAGE_COUNT
  return Math.min(MAX_IMAGE_COUNT, Math.max(1, count))
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function uniqueStrings(values: Iterable<string>) {
  const output: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    output.push(normalized)
  }
  return output
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getNumberValue(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getOpenverseId(value: string) {
  return `openverse:${value}`
}

function getWikimediaId(value: string) {
  return `wikimedia:${value}`
}

function normalizeExtension(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.toLowerCase().replace(/^\./, '').split(/[?#]/)[0]?.trim() ?? ''
}

function isSupportedExtension(value: unknown) {
  const ext = normalizeExtension(value)
  return SUPPORTED_EXTENSIONS.includes(ext)
}

function getUrlExtension(url: string) {
  try {
    const pathname = new URL(url).pathname
    const filename = pathname.split('/').pop() ?? ''
    return normalizeExtension(filename.includes('.') ? filename.split('.').pop() : '')
  } catch {
    const withoutQuery = url.split(/[?#]/)[0] ?? ''
    const filename = withoutQuery.split('/').pop() ?? ''
    return normalizeExtension(filename.includes('.') ? filename.split('.').pop() : '')
  }
}

function isSupportedImageUrl(url: string) {
  return isSupportedExtension(getUrlExtension(url))
}

function isSupportedMimeType(value: unknown) {
  return typeof value === 'string' && /^image\/(?:jpeg|png|webp)$/i.test(value)
}

function getOpenverseResults(value: unknown): Record<string, unknown>[] {
  if (!isRecordValue(value) || !Array.isArray(value.results)) return []
  return value.results.filter(isRecordValue)
}

function getOpenverseSearchUrl(query: string, count: number) {
  const params = new URLSearchParams({
    q: query,
    page_size: String(count),
    page: '1',
    mature: 'false',
    extension: SUPPORTED_EXTENSIONS.join(','),
  })
  return `${OPENVERSE_IMAGE_SEARCH_URL}?${params.toString()}`
}

function parseOpenverseResult(item: Record<string, unknown>): AgentImageSearchResult | null {
  const id = getStringValue(item, 'id')
  const imageUrl = getStringValue(item, 'url')
  if (!id || !imageUrl) return null
  if (!isSupportedExtension(item.filetype) && !isSupportedExtension(item.extension) && !isSupportedMimeType(item.mime_type)) return null

  return {
    id: getOpenverseId(id),
    title: getStringValue(item, 'title') ?? 'Untitled image',
    imageUrl,
    thumbnailUrl: getStringValue(item, 'thumbnail'),
    pageUrl: getStringValue(item, 'foreign_landing_url'),
    creator: getStringValue(item, 'creator'),
    creatorUrl: getStringValue(item, 'creator_url'),
    license: getStringValue(item, 'license'),
    licenseUrl: getStringValue(item, 'license_url'),
    source: 'Openverse',
    provider: getStringValue(item, 'provider') ?? getStringValue(item, 'source'),
    width: getNumberValue(item, 'width'),
    height: getNumberValue(item, 'height'),
    mimeType: getStringValue(item, 'mime_type'),
    attribution: getStringValue(item, 'attribution'),
  }
}

async function searchOpenverseImages(query: string, count: number, signal?: AbortSignal): Promise<AgentImageSearchResponse> {
  const response = await fetch(getOpenverseSearchUrl(query, count), {
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error(`Openverse 图片搜索失败：HTTP ${response.status}`)

  const payload = await response.json()
  return {
    query,
    source: 'openverse',
    results: getOpenverseResults(payload)
      .map(parseOpenverseResult)
      .filter((item): item is AgentImageSearchResult => Boolean(item))
      .slice(0, count),
  }
}

function getWikimediaSearchUrl(query: string, count: number) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: query,
    gsrlimit: String(count),
    prop: 'imageinfo',
    iiprop: 'url|mime|size|extmetadata',
  })
  return `${WIKIMEDIA_IMAGE_SEARCH_URL}?${params.toString()}`
}

function getWikimediaPages(value: unknown): Record<string, unknown>[] {
  if (!isRecordValue(value) || !isRecordValue(value.query) || !isRecordValue(value.query.pages)) return []
  return Object.values(value.query.pages).filter(isRecordValue)
}

function getWikimediaExtMetadata(page: Record<string, unknown>): Record<string, unknown> {
  const imageinfo = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null
  if (!isRecordValue(imageinfo) || !isRecordValue(imageinfo.extmetadata)) return {}
  return imageinfo.extmetadata
}

function getWikimediaMetadataText(metadata: Record<string, unknown>, key: string): string | undefined {
  const field = metadata[key]
  if (!isRecordValue(field)) return undefined
  return getStringValue(field, 'value')
}

function stripHtml(value: string | undefined) {
  return value?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || undefined
}

function parseWikimediaResult(page: Record<string, unknown>): AgentImageSearchResult | null {
  const pageId = typeof page.pageid === 'number' ? String(page.pageid) : ''
  const title = getStringValue(page, 'title') ?? ''
  const imageinfo = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null
  if (!pageId || !title || !isRecordValue(imageinfo)) return null

  const imageUrl = getStringValue(imageinfo, 'url')
  const mimeType = getStringValue(imageinfo, 'mime')
  if (!imageUrl || !isSupportedMimeType(mimeType)) return null

  const metadata = getWikimediaExtMetadata(page)
  const artist = stripHtml(getWikimediaMetadataText(metadata, 'Artist'))
  const license = stripHtml(getWikimediaMetadataText(metadata, 'LicenseShortName'))
  const licenseUrl = getWikimediaMetadataText(metadata, 'LicenseUrl')

  return {
    id: getWikimediaId(pageId),
    title: title.replace(/^File:/, ''),
    imageUrl,
    thumbnailUrl: getStringValue(imageinfo, 'thumburl'),
    pageUrl: getStringValue(imageinfo, 'descriptionurl'),
    creator: artist,
    license,
    licenseUrl,
    source: 'Wikimedia Commons',
    provider: 'wikimedia',
    width: getNumberValue(imageinfo, 'width'),
    height: getNumberValue(imageinfo, 'height'),
    mimeType,
    attribution: [title.replace(/^File:/, ''), artist ? `by ${artist}` : '', license].filter(Boolean).join(' '),
  }
}

async function searchWikimediaImages(query: string, count: number, signal?: AbortSignal): Promise<AgentImageSearchResponse> {
  const response = await fetch(getWikimediaSearchUrl(query, count), {
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error(`Wikimedia 图片搜索失败：HTTP ${response.status}`)

  const payload = await response.json()
  return {
    query,
    source: 'wikimedia',
    results: getWikimediaPages(payload)
      .map(parseWikimediaResult)
      .filter((item): item is AgentImageSearchResult => Boolean(item))
      .slice(0, count),
  }
}

function getSameOriginToolUrl(path: string, targetUrl: string) {
  const origin = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://localhost'
  const url = new URL(path, origin)
  url.searchParams.set('url', targetUrl)
  return url.toString()
}

function isAgentFetchUnavailable(err: unknown) {
  return err instanceof Error && err.message === AGENT_FETCH_UNAVAILABLE
}

async function fetchThroughAgentProxy(path: string, targetUrl: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(getSameOriginToolUrl(path, targetUrl), {
    cache: 'no-store',
    signal,
  })
  if (response.headers.get(AGENT_FETCH_HEADER) !== 'ok') {
    throw new Error(AGENT_FETCH_UNAVAILABLE)
  }
  return response
}

async function fetchPageHtml(url: string, signal?: AbortSignal) {
  try {
    const response = await fetchThroughAgentProxy(AGENT_PAGE_FETCH_PATH, url, signal)
    if (!response.ok) throw new Error(`网页抓取代理失败：HTTP ${response.status}`)
    return response.text()
  } catch (err) {
    if (!isAgentFetchUnavailable(err)) throw err
  }

  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'text/html,application/xhtml+xml' },
    signal,
  })
  if (!response.ok) throw new Error(`网页抓取失败：HTTP ${response.status}`)
  return response.text()
}

function decodeHtmlEntities(value: string) {
  return value.replace(/&(?:#(\d+)|#x([\da-fA-F]+)|amp|lt|gt|quot|apos|nbsp);/g, (entity, decimal: string | undefined, hex: string | undefined) => {
    if (decimal) return String.fromCodePoint(Number(decimal))
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
    switch (entity) {
      case '&amp;': return '&'
      case '&lt;': return '<'
      case '&gt;': return '>'
      case '&quot;': return '"'
      case '&apos;': return "'"
      case '&nbsp;': return ' '
      default: return entity
    }
  })
}

function stripTags(value: string) {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function getHtmlTitle(html: string) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  return match ? stripTags(match[1]) : ''
}

function parseAttributes(tag: string) {
  const attrs: Record<string, string> = {}
  tag.replace(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g, (_match, key: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
    attrs[key.toLowerCase()] = decodeHtmlEntities(doubleQuoted ?? singleQuoted ?? bare ?? '').trim()
    return ''
  })
  return attrs
}

function getMetaContent(html: string, names: string[]) {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  const values: string[] = []
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0])
    const key = (attrs.property || attrs.name || '').toLowerCase()
    const content = attrs.content
    if (content && wanted.has(key)) values.push(content)
  }
  return values
}

function normalizeImageUrl(value: string, pageUrl: string): string | null {
  const trimmed = decodeHtmlEntities(value).trim()
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('#')) return null
  try {
    const url = new URL(trimmed, pageUrl)
    if (!/^https?:$/i.test(url.protocol)) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function getSrcsetUrls(value: string, pageUrl: string) {
  return value
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0] ?? '')
    .map((entry) => normalizeImageUrl(entry, pageUrl))
    .filter((item): item is string => Boolean(item))
}

function getImageUrlText(url: string) {
  try {
    const parsed = new URL(url)
    return decodeURIComponent(`${parsed.hostname} ${parsed.pathname}`).replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

function getQueryTerms(query: string) {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
  return uniqueStrings(terms).slice(0, 12)
}

function getBuiltInSourcePageHints(query: string) {
  const normalized = query.toLowerCase()
  if (normalized.includes('春日影') || normalized.includes('haruhikage') || normalized.includes('mygo') || normalized.includes('bang dream') || normalized.includes('bang-dream')) {
    return HARUHIKAGE_SOURCE_PAGES
  }
  return []
}

function simpleHash(value: string) {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

interface WebImageCandidate {
  imageUrl: string
  title?: string
  alt?: string
  sourceType: 'meta' | 'img' | 'srcset' | 'url'
  width?: number
  height?: number
  order: number
}

function numberFromAttribute(value: string | undefined) {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function getCandidateScore(candidate: WebImageCandidate, queryTerms: string[], pageTitle: string) {
  const haystack = [
    candidate.title,
    candidate.alt,
    pageTitle,
    getImageUrlText(candidate.imageUrl),
  ].filter(Boolean).join(' ').toLowerCase()
  let score = candidate.sourceType === 'img' ? 40 : candidate.sourceType === 'srcset' ? 35 : candidate.sourceType === 'meta' ? 25 : 8

  for (const term of queryTerms) {
    if (haystack.includes(term)) score += 14
  }

  const urlText = getImageUrlText(candidate.imageUrl)
  if (/\b(character|chara|char|body|main|visual|profile|stand|tachie)\b/i.test(urlText)) score += 35
  if (/\b(thumb|thumbnail)\b/i.test(urlText)) score += 8
  if (/\b(ogp|logo|icon|favicon|share|banner|button|bg|background)\b/i.test(urlText)) score -= 45

  if (candidate.width && candidate.height) {
    const pixels = candidate.width * candidate.height
    if (candidate.width < 120 || candidate.height < 120) score -= 80
    else if (pixels >= 700_000) score += 35
    else if (pixels >= 250_000) score += 20
  }

  if (!isSupportedImageUrl(candidate.imageUrl)) score -= 80
  return score
}

function isLikelyDecorativeImageUrl(url: string) {
  const urlText = getImageUrlText(url)
  return /\b(?:ogp|logo|icon|favicon|share|banner|button|bg|background|txt|loading|arrow|sns)\b/i.test(urlText)
}

function getWebPageResultPriority(result: AgentImageSearchResult) {
  const urlText = getImageUrlText(result.imageUrl)
  let score = 0
  if (/\b(?:body|main|visual|profile|stand|tachie)\b/i.test(urlText)) score += 100
  if (/\bcharacter_sub\b/i.test(urlText)) score += 90
  if (/\bcharacter\b/i.test(urlText)) score += 40
  if (/\bthumb|thumbnail\b/i.test(urlText)) score -= 10
  if (result.width && result.height) {
    const pixels = result.width * result.height
    if (pixels >= 700_000) score += 40
    else if (pixels >= 250_000) score += 20
  }
  return score
}

function getFileTitle(url: string) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    return name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim()
  } catch {
    return '网页图片'
  }
}

export function extractAgentImagesFromHtml(opts: {
  html: string
  pageUrl: string
  query: string
  count?: number
}): AgentImageSearchResult[] {
  const count = clampCount(opts.count)
  const pageTitle = getHtmlTitle(opts.html)
  const queryTerms = getQueryTerms(opts.query)
  const candidates: WebImageCandidate[] = []
  let order = 0

  for (const metaImage of getMetaContent(opts.html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'])) {
    const imageUrl = normalizeImageUrl(metaImage, opts.pageUrl)
    if (!imageUrl) continue
    candidates.push({ imageUrl, sourceType: 'meta', title: pageTitle || undefined, order: order++ })
  }

  for (const match of opts.html.matchAll(/<img\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0])
    const title = attrs.title || attrs.alt || pageTitle || undefined
    const alt = attrs.alt || undefined
    const width = numberFromAttribute(attrs.width)
    const height = numberFromAttribute(attrs.height)
    for (const key of ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-image', 'data-img']) {
      const imageUrl = attrs[key] ? normalizeImageUrl(attrs[key], opts.pageUrl) : null
      if (imageUrl) candidates.push({ imageUrl, title, alt, sourceType: 'img', width, height, order: order++ })
    }
    for (const key of ['srcset', 'data-srcset']) {
      for (const imageUrl of attrs[key] ? getSrcsetUrls(attrs[key], opts.pageUrl) : []) {
        candidates.push({ imageUrl, title, alt, sourceType: 'srcset', width, height, order: order++ })
      }
    }
  }

  const absoluteImageUrlRe = /https?:\/\/[^\s"'<>\\]+\.(?:png|jpe?g|webp)(?:\?[^\s"'<>\\]*)?/gi
  for (const match of opts.html.matchAll(absoluteImageUrlRe)) {
    const imageUrl = normalizeImageUrl(match[0], opts.pageUrl)
    if (!imageUrl) continue
    candidates.push({ imageUrl, title: pageTitle || undefined, sourceType: 'url', order: order++ })
  }

  const byUrl = new Map<string, WebImageCandidate>()
  for (const candidate of candidates) {
    if (!isSupportedImageUrl(candidate.imageUrl)) continue
    if (isLikelyDecorativeImageUrl(candidate.imageUrl)) continue
    const key = candidate.imageUrl.replace(/[?#].*$/, '')
    const existing = byUrl.get(key)
    if (!existing || getCandidateScore(candidate, queryTerms, pageTitle) > getCandidateScore(existing, queryTerms, pageTitle)) {
      byUrl.set(key, candidate)
    }
  }

  return [...byUrl.values()]
    .map((candidate) => ({
      candidate,
      score: getCandidateScore(candidate, queryTerms, pageTitle),
    }))
    .filter((item) => item.score > -20)
    .sort((a, b) => b.score - a.score || a.candidate.order - b.candidate.order)
    .slice(0, count)
    .map(({ candidate }, index): AgentImageSearchResult => {
      const title = candidate.title || candidate.alt || pageTitle || getFileTitle(candidate.imageUrl) || `网页图片 ${index + 1}`
      const hostname = (() => {
        try {
          return new URL(opts.pageUrl).hostname
        } catch {
          return 'webpage'
        }
      })()
      return {
        id: `webpage:${simpleHash(`${opts.pageUrl}\n${candidate.imageUrl}`)}`,
        title,
        imageUrl: candidate.imageUrl,
        thumbnailUrl: candidate.imageUrl,
        pageUrl: opts.pageUrl,
        source: hostname,
        provider: 'webpage',
        width: candidate.width,
        height: candidate.height,
        mimeType: `image/${getUrlExtension(candidate.imageUrl) === 'jpg' ? 'jpeg' : getUrlExtension(candidate.imageUrl)}`,
        attribution: pageTitle ? `${title} - ${pageTitle}` : title,
      }
    })
}

async function searchWebPageImages(query: string, count: number, pageUrls: string[], signal?: AbortSignal): Promise<AgentImageSearchResponse> {
  const warnings: string[] = []
  const results: AgentImageSearchResult[] = []
  const normalizedPageUrls = uniqueStrings(pageUrls)

  for (const pageUrl of normalizedPageUrls.slice(0, 10)) {
    try {
      const html = await fetchPageHtml(pageUrl, signal)
      const pageResults = extractAgentImagesFromHtml({ html, pageUrl, query, count })
      results.push(...pageResults)
    } catch (err) {
      warnings.push(`${pageUrl}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const deduped = new Map<string, AgentImageSearchResult>()
  for (const result of results) {
    const key = result.imageUrl.replace(/[?#].*$/, '')
    if (!deduped.has(key)) deduped.set(key, result)
  }

  return {
    query,
    source: 'webpage',
    pageUrls: normalizedPageUrls,
    results: [...deduped.values()]
      .sort((a, b) => getWebPageResultPriority(b) - getWebPageResultPriority(a))
      .slice(0, count),
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

export async function searchAgentImages(opts: {
  query: string
  count?: number
  pageUrls?: string[]
  signal?: AbortSignal
}): Promise<AgentImageSearchResponse> {
  const query = opts.query.trim()
  if (!query) throw new Error('图片搜索关键词不能为空')

  const count = clampCount(opts.count)
  const warnings: string[] = []
  const inferredPageUrls = getBuiltInSourcePageHints(query)
  const pageUrls = uniqueStrings([...(opts.pageUrls ?? []), ...inferredPageUrls])
  let pageResults: AgentImageSearchResult[] = []

  if (pageUrls.length > 0) {
    const result = await searchWebPageImages(query, count, pageUrls, opts.signal)
    pageResults = result.results
    if (result.warnings?.length) warnings.push(...result.warnings)
    if (opts.pageUrls?.length === 0 && inferredPageUrls.length > 0 && pageResults.length > 0) {
      warnings.push('已根据关键词推断并抽取 BanG Dream! MyGO 官方角色页图片。')
    }
    if (pageResults.length >= count) {
      return {
        query,
        source: 'webpage',
        pageUrls,
        results: pageResults.slice(0, count),
        warnings: warnings.length > 0 ? warnings : undefined,
      }
    }
  }

  try {
    const result = await searchOpenverseImages(query, count - pageResults.length, opts.signal)
    if (result.results.length > 0) {
      const results = [...pageResults, ...result.results].slice(0, count)
      return {
        query,
        source: pageResults.length > 0 ? 'mixed' : result.source,
        ...(pageUrls.length > 0 ? { pageUrls } : {}),
        results,
        warnings: warnings.length > 0 ? warnings : undefined,
      }
    }
    warnings.push('Openverse 未返回可用的光栅图片结果。')
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err))
  }

  try {
    const fallback = await searchWikimediaImages(query, count - pageResults.length, opts.signal)
    return {
      query,
      source: pageResults.length > 0 ? 'mixed' : fallback.source,
      ...(pageUrls.length > 0 ? { pageUrls } : {}),
      results: [...pageResults, ...fallback.results].slice(0, count),
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err))
    if (pageResults.length > 0) {
      return {
        query,
        source: 'webpage',
        ...(pageUrls.length > 0 ? { pageUrls } : {}),
        results: pageResults.slice(0, count),
        warnings,
      }
    }
    throw new Error(warnings.join('\n') || '图片搜索失败')
  }
}

async function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000)
    binary += String.fromCharCode(...chunk)
  }

  return `data:${blob.type || fallbackMime};base64,${btoa(binary)}`
}

async function fetchImageThroughAgentProxy(url: string, signal?: AbortSignal) {
  const response = await fetchThroughAgentProxy(AGENT_IMAGE_FETCH_PATH, url, signal)
  if (!response.ok) throw new Error(`图片抓取代理失败：HTTP ${response.status}`)

  const contentType = response.headers.get('content-type') ?? ''
  if (!isSupportedMimeType(contentType)) {
    throw new Error(`图片抓取代理返回了非支持图片类型：${contentType || 'unknown'}`)
  }
  return blobToDataUrl(await response.blob(), contentType || 'image/png')
}

export async function fetchAgentImageAsDataUrl(url: string, signal?: AbortSignal) {
  if (isDataUrl(url)) return url

  let proxyError: unknown
  try {
    return await fetchImageThroughAgentProxy(url, signal)
  } catch (err) {
    proxyError = err
    if (!isAgentFetchUnavailable(err)) {
      // Some hosts reject server-side fetches. Fall back to direct browser fetch before failing.
    }
  }

  try {
    const dataUrl = await fetchImageUrlAsDataUrl(url, 'image/png', signal)
    if (!/^data:image\/(?:png|jpe?g|webp);/i.test(dataUrl)) {
      throw new Error('下载结果不是可用的 PNG/JPEG/WebP 图片')
    }
    return dataUrl
  } catch (directError) {
    if (proxyError && !isAgentFetchUnavailable(proxyError)) {
      throw new Error(`图片下载失败：代理抓取失败（${proxyError instanceof Error ? proxyError.message : String(proxyError)}）；直接下载也失败（${directError instanceof Error ? directError.message : String(directError)}）。`)
    }
    throw directError
  }
}
