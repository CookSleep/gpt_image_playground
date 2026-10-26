import type { ApiProfile } from '../types'
import { parseRatio } from './size'

export const DEFAULT_AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1'
export const DEFAULT_AGNES_MODEL = 'agnes-image-2.5-flash'
export const AGNES_SIZE_TIERS = ['1K', '2K', '3K', '4K'] as const
export const AGNES_IMAGE_SIZES = {
  '1:1': [1024, 1024],
  '3:4': [864, 1152],
  '4:3': [1152, 864],
  '16:9': [1312, 736],
  '9:16': [736, 1312],
  '2:3': [832, 1248],
  '3:2': [1248, 832],
  '21:9': [1568, 672],
} as const

export function isAgnesImageProfile(profile: ApiProfile) {
  return profile.provider === 'agnes' || (profile.provider === 'openai' && profile.apiMode === 'images' && /^agnes-image-/i.test(profile.model.trim()))
}

export function getAgnesImageSize(size: string) {
  const parsed = parseRatio(size)
  const tier = AGNES_SIZE_TIERS.find((item) => item === size.trim().toUpperCase())
  if (!parsed) return { size: tier ?? '1K', ratio: '1:1' as keyof typeof AGNES_IMAGE_SIZES }
  const target = parsed.width / parsed.height
  const ratio = Object.keys(AGNES_IMAGE_SIZES).map((ratio) => ({
    ratio: ratio as keyof typeof AGNES_IMAGE_SIZES,
    delta: Math.abs(Math.log(Number(ratio.split(':')[0]) / Number(ratio.split(':')[1]) / target)),
  })).sort((a, b) => a.delta - b.delta)[0].ratio
  const base = AGNES_IMAGE_SIZES[ratio]
  const scale = Math.sqrt(parsed.width * parsed.height / (base[0] * base[1]))
  return { size: AGNES_SIZE_TIERS[Math.min(3, Math.max(0, Math.ceil(scale) - 1))], ratio }
}

export function normalizeAgnesImageSize(size: string) {
  const opts = getAgnesImageSize(size)
  const base = AGNES_IMAGE_SIZES[opts.ratio]
  const scale = AGNES_SIZE_TIERS.indexOf(opts.size) + 1
  return `${base[0] * scale}x${base[1] * scale}`
}
