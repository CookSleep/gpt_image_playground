export interface ParsedShot {
  index: number
  title: string
  shot: string
  action: string
  sound: string
}

const FIELD_NAMES = ['镜头', '声音', '音频', '动作', '原文', '字数', '建议时长', '时长', '标题'] as const

const KNOWN_FIELDS: Record<string, 'shot' | 'sound' | 'action' | 'source'> = {
  镜头: 'shot',
  声音: 'sound',
  音频: 'sound',
  动作: 'action',
  原文: 'source',
}

const IGNORED_LABELS = new Set(['字数', '建议时长', '时长', '标题'])

const FIELD_LINE = /^(镜头|声音|音频|动作|原文|字数|建议时长|时长|标题)\s*[:：]\s*(.*)$/
const SEGMENT_LINE = /^(?:#{1,6}\s*)?片段\s*(\d+|[零一二三四五六七八九十百]+)\s*$/
const LABEL_PATTERN = new RegExp(
  `[ \\t\\u3000]*(?:\\*\\*|__)?(${FIELD_NAMES.join('|')})\\s*[:：]\\s*(?:\\*\\*|__)?`,
  'g',
)

interface Draft {
  title: string
  shot: string[]
  action: string[]
  sound: string[]
  field: 'shot' | 'sound' | 'action' | 'source' | null
}

function blankDraft(): Draft {
  return { title: '', shot: [], action: [], sound: [], field: null }
}

function keepsField(field: Draft['field']): field is 'shot' | 'action' | 'sound' {
  return field === 'shot' || field === 'action' || field === 'sound'
}

function joinField(lines: string[]) {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function hasShotLabel(text: string) {
  return /(?:\*\*|__)?(?:镜头|声音|音频|动作|原文)(?:\*\*|__)?\s*[:：]/.test(text)
}

function normalizeTemplate(text: string) {
  return text.replace(LABEL_PATTERN, '\n$1：')
}

export function parseShotTemplate(input: string): ParsedShot[] {
  const text = input.replace(/\r\n/g, '\n').trim()
  if (!text) return []
  if (!hasShotLabel(text)) {
    return [{ index: 1, title: '镜头 01', shot: text, action: '', sound: '' }]
  }

  const drafts: Draft[] = []
  let current: Draft | null = null

  for (const raw of normalizeTemplate(text).split('\n')) {
    const line = raw.trim()
    if (!line) {
      if (current && keepsField(current.field)) {
        const bucket = current[current.field]
        if (bucket.length && bucket[bucket.length - 1] !== '') bucket.push('')
      }
      continue
    }

    const segment = line.match(SEGMENT_LINE)
    if (segment) {
      const title = `片段 ${segment[1]}`
      const hasContent = current !== null && [current.shot, current.action, current.sound].some((parts) => parts.some((part) => part.trim()))
      if (!current || hasContent) {
        current = blankDraft()
        current.title = title
        drafts.push(current)
      } else {
        current.title = title
        current.field = null
      }
      continue
    }

    const field = line.match(FIELD_LINE)
    if (field) {
      const label = field[1]
      if (IGNORED_LABELS.has(label)) {
        if (current) current.field = null
        continue
      }
      const key = KNOWN_FIELDS[label]
      if (key === 'shot' && current && current.shot.some((part) => part.trim())) {
        current = blankDraft()
        drafts.push(current)
      }
      if (!current) {
        current = blankDraft()
        drafts.push(current)
      }
      current.field = key
      const value = field[2].trim()
      if (value && keepsField(key)) current[key].push(value)
      continue
    }

    if (current && keepsField(current.field)) current[current.field].push(line)
  }

  return drafts
    .map((draft) => ({
      title: draft.title,
      shot: joinField(draft.shot),
      action: joinField(draft.action),
      sound: joinField(draft.sound),
    }))
    .filter((draft) => draft.shot)
    .map((draft, index) => ({
      index: index + 1,
      title: draft.title || `镜头 ${String(index + 1).padStart(2, '0')}`,
      shot: draft.shot,
      action: draft.action,
      sound: draft.sound,
    }))
}

export function buildShotImagePrompt(shot: string, hasStyleImages: boolean, sharedPrompt = '') {
  const parts = []
  if (hasStyleImages) {
    parts.push('参考所附图片的画风、材质、色彩和光影来生成新画面。这些图片只作为样式参考，不要照搬其中的具体主体、构图和文字。不要在画面里写出提示词。')
  }
  const shared = sharedPrompt.trim()
  if (shared) parts.push(shared)
  const body = shot.trim()
  if (body) parts.push(body)
  return parts.join('\n')
}

export function buildVideoPrompt(action: string, audio: string, sharedPrompt = '') {
  const shared = sharedPrompt.trim()
  const motion = action.trim()
  const sound = audio.trim()
  return [shared, motion && `动作：${motion}`, sound && `音频：${sound}`].filter(Boolean).join('\n')
}
