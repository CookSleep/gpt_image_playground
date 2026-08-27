import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { calculateImageSize, normalizeImageSize, parseRatio, type SizeTier } from '../lib/size'
import { useTooltip } from '../hooks/useTooltip'
import ViewportTooltip from './ViewportTooltip'

const TIERS: SizeTier[] = ['1K', '2K', '4K']
const SIZE_LIMIT_TEXT = '展示尺寸仅为参考，最终以实际生成结果为准，计费价格也以实际生成尺寸进行计费。\n\n尺寸限制：\n1. 宽高均为 16 的倍数\n2. 最大边长为 3840px\n3. 宽高比不超过 3:1\n4. 总像素范围为 655360-8294400'
const RATIOS = [
  { label: '1:1', value: '1:1' },
  { label: '3:2', value: '3:2' },
  { label: '2:3', value: '2:3' },
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '4:3', value: '4:3' },
  { label: '3:4', value: '3:4' },
  { label: '21:9', value: '21:9' },
]

interface Props {
  anchorRef: RefObject<HTMLButtonElement | null>
  currentSize: string
  onSelect: (size: string) => void
  onPreviewSizeChange?: (size: string) => void
  onClose: () => void
  allowAuto?: boolean
}

type Mode = 'auto' | 'ratio' | 'resolution'

function parseSize(size: string) {
  const match = size.match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/)
  if (!match) return null
  return { width: match[1], height: match[2] }
}

function findPresetForSize(size: string) {
  const normalized = normalizeImageSize(size)
  for (const tier of TIERS) {
    for (const ratio of RATIOS) {
      if (calculateImageSize(tier, ratio.value) === normalized) return { tier, ratio: ratio.value }
    }
  }
  return null
}

export default function SizePickerModal({ anchorRef, currentSize, onSelect, onPreviewSizeChange, onClose, allowAuto = true }: Props) {
  const pickerRef = useRef<HTMLDivElement>(null)
  const lockControlRef = useRef<HTMLButtonElement>(null)
  const sizeLimitTooltip = useTooltip()
  const [position, setPosition] = useState<{ left: number; bottom: number; width: number; maxHeight: number } | null>(null)

  useLayoutEffect(() => {
    const updatePosition = () => {
      const trigger = anchorRef.current
      if (!trigger) return
      const narrow = window.innerWidth < 768
      const inputBar = trigger.closest('[data-input-bar]')
      const submitButton = narrow
        ? Array.from(inputBar?.querySelectorAll<HTMLElement>('[data-submit-button]') ?? []).find((el) => {
            const rect = el.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          })
        : null
      const anchorRect = (submitButton ?? trigger).getBoundingClientRect()
      const margin = 12
      const gap = 8
      const width = Math.min(384, window.innerWidth - margin * 2)
      const preferredLeft = narrow ? anchorRect.right - width : anchorRect.left
      const left = Math.min(Math.max(preferredLeft, margin), window.innerWidth - width - margin)
      const bottom = Math.max(margin, window.innerHeight - anchorRect.top + gap)
      setPosition({ left, bottom, width, maxHeight: Math.max(0, window.innerHeight - bottom - margin) })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    window.visualViewport?.addEventListener('resize', updatePosition)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      window.visualViewport?.removeEventListener('resize', updatePosition)
    }
  }, [anchorRef])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-size-picker]')) return
      if (!pickerRef.current?.contains(event.target as Node)) onClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const currentPreset = findPresetForSize(currentSize)
  const currentParsedSize = parseSize(currentSize)
  const [mode, setMode] = useState<Mode>(() => {
    if (!currentSize || currentSize === 'auto') return allowAuto ? 'auto' : 'ratio'
    if (currentPreset) return 'ratio'
    return 'resolution'
  })
  const [tier, setTier] = useState<SizeTier>(currentPreset?.tier ?? '1K')
  const [ratio, setRatio] = useState(currentPreset?.ratio ?? (allowAuto ? '1:1' : '4:3'))
  const [customRatio, setCustomRatio] = useState('16:9')
  const [customW, setCustomW] = useState(currentParsedSize?.width ?? '1024')
  const [customH, setCustomH] = useState(currentParsedSize?.height ?? '1024')
  const [ratioLocked, setRatioLocked] = useState(false)
  const resizeDragRef = useRef<{ pointerId: number; startY: number; width: number; height: number; moved: boolean } | null>(null)
  const suppressLockClickRef = useRef(false)

  const activeRatio = ratio === 'custom' ? customRatio : ratio
  const parsedCustomRatio = parseRatio(customRatio)
  const customRatioValid = ratio !== 'custom' || Boolean(parsedCustomRatio)

  const previewSize = useMemo(() => {
    if (mode === 'auto') return 'auto'
    if (mode === 'ratio') {
      const size = calculateImageSize(tier, activeRatio)
      return size ? normalizeImageSize(size) : ''
    }
    const w = parseInt(customW, 10)
    const h = parseInt(customH, 10)
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return normalizeImageSize(`${w}x${h}`)
    return ''
  }, [mode, tier, activeRatio, customW, customH])

  useEffect(() => {
    if (mode !== 'ratio' || !previewSize || previewSize === 'auto') return
    const linkedSize = parseSize(previewSize)
    if (!linkedSize) return
    if (customW !== linkedSize.width) setCustomW(linkedSize.width)
    if (customH !== linkedSize.height) setCustomH(linkedSize.height)
  }, [mode, previewSize, customW, customH])

  const linkedSize = mode === 'ratio' && previewSize ? parseSize(previewSize) : null
  const dimensionWidth = mode === 'auto' ? '' : linkedSize?.width ?? customW
  const dimensionHeight = mode === 'auto' ? '' : linkedSize?.height ?? customH
  const updateDimensions = (axis: 'width' | 'height', value: string) => {
    setMode('resolution')
    const nextValue = parseInt(value, 10)
    const width = parseInt(dimensionWidth, 10)
    const height = parseInt(dimensionHeight, 10)
    if (!ratioLocked || !Number.isFinite(nextValue) || nextValue <= 0 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      if (axis === 'width') setCustomW(value)
      else setCustomH(value)
      return
    }
    if (axis === 'width') {
      setCustomW(value)
      setCustomH(String(Math.max(1, Math.round(nextValue * height / width))))
      return
    }
    setCustomH(value)
    setCustomW(String(Math.max(1, Math.round(nextValue * width / height))))
  }

  const handleLockPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (mode === 'auto') return
    const width = parseInt(dimensionWidth, 10)
    const height = parseInt(dimensionHeight, 10)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeDragRef.current = { pointerId: event.pointerId, startY: event.clientY, width, height, moved: false }
    suppressLockClickRef.current = false
  }

  const handleLockPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = resizeDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const deltaY = drag.startY - event.clientY
    if (Math.abs(deltaY) < 2) return
    drag.moved = true
    suppressLockClickRef.current = true
    const scale = Math.max(0.1, 1 + deltaY / 200)
    setMode('resolution')
    setCustomW(String(Math.max(16, Math.round((drag.width * scale) / 16) * 16)))
    setCustomH(String(Math.max(16, Math.round((drag.height * scale) / 16) * 16)))
  }

  const handleLockPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (resizeDragRef.current?.pointerId === event.pointerId) resizeDragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const handleLockClick = () => {
    if (suppressLockClickRef.current) {
      suppressLockClickRef.current = false
      return
    }
    setRatioLocked((value) => !value)
  }

  useEffect(() => {
    const el = lockControlRef.current
    if (!el) return
    const handleWheel = (event: WheelEvent) => {
      if (mode === 'auto') return
      const width = parseInt(dimensionWidth, 10)
      const height = parseInt(dimensionHeight, 10)
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
      event.preventDefault()
      event.stopPropagation()
      const scale = event.deltaY < 0 ? 1.05 : 0.95
      setMode('resolution')
      setCustomW(String(Math.max(16, Math.round((width * scale) / 16) * 16)))
      setCustomH(String(Math.max(16, Math.round((height * scale) / 16) * 16)))
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [mode, dimensionWidth, dimensionHeight])

  useEffect(() => {
    if (previewSize) onPreviewSizeChange?.(previewSize)
  }, [onPreviewSizeChange, previewSize])

  const applySize = () => {
    if (!previewSize) return
    onSelect(previewSize)
    onClose()
  }

  const buttonClass = (active: boolean) => `rounded-xl border px-3 py-2 text-sm transition ${active
    ? 'border-blue-400 bg-blue-50 text-blue-600 dark:border-blue-500/50 dark:bg-blue-500/10 dark:text-blue-300'
    : 'border-gray-200/70 bg-white/60 text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06]'
  }`

  return createPortal(
    <div
      ref={pickerRef}
      data-size-picker
      data-no-drag-select
      role="dialog"
      aria-label="设置图像尺寸"
      className="fixed z-[70] flex flex-col overflow-hidden rounded-2xl border border-white/60 bg-white p-4 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 dark:ring-white/10 sm:p-5"
      style={{
        left: position?.left ?? 0,
        bottom: position?.bottom ?? 0,
        width: position?.width ?? 384,
        maxHeight: position?.maxHeight ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">设置图像尺寸</h3>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">当前：{currentSize || 'auto'}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200" aria-label="关闭">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-gray-200 dark:scrollbar-thumb-white/10">
        {allowAuto && (
          <button type="button" onClick={() => setMode('auto')} className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${buttonClass(mode === 'auto')}`}>
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-500 dark:bg-blue-500/10">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            </span>
            <span>
              <span className="block text-sm font-medium text-gray-800 dark:text-gray-200">自动尺寸</span>
              <span className="mt-1 block text-xs leading-relaxed text-gray-400 dark:text-gray-500">由模型自己决定生成尺寸</span>
            </span>
          </button>
        )}

        <section className={`rounded-xl border p-3 transition ${mode === 'resolution' ? 'border-blue-300/70 bg-blue-50/30 dark:border-blue-500/40 dark:bg-blue-500/[0.05]' : 'border-gray-200/70 dark:border-white/[0.08]'}`}>
          <div className="mb-3 flex items-center gap-1.5">
            <button type="button" className="text-sm font-medium text-gray-800 dark:text-gray-200" onClick={() => setMode('resolution')}>尺寸</button>
            <span className="relative inline-flex" {...sizeLimitTooltip.handlers}>
              <button type="button" className="flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold leading-none text-gray-400 transition hover:border-blue-400 hover:text-blue-500 focus:outline-none dark:border-gray-600 dark:text-gray-500 dark:hover:border-blue-400 dark:hover:text-blue-300" aria-label="查看尺寸限制">?</button>
              <ViewportTooltip visible={sizeLimitTooltip.visible} className="w-72 whitespace-pre-line text-left leading-5">
                {SIZE_LIMIT_TEXT}
              </ViewportTooltip>
            </span>
          </div>
          <div className="flex items-center gap-4">
            <label className="min-w-0 w-0 flex-1">
              <span className="flex w-full items-center gap-2 rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 transition focus-within:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:focus-within:border-blue-500/50">
                <span className="shrink-0 font-mono text-sm font-medium text-gray-400 dark:text-gray-500">W</span>
                <input type="number" value={dimensionWidth} onChange={(e) => updateDimensions('width', e.target.value)} className="min-w-0 flex-1 bg-transparent text-sm text-gray-700 outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-200" aria-label="宽度" disabled={mode === 'auto'} />
              </span>
            </label>
            <button
              ref={lockControlRef}
              type="button"
              aria-label={ratioLocked ? '解锁比例' : '锁定比例'}
              aria-pressed={ratioLocked}
              disabled={mode === 'auto'}
              onPointerDown={handleLockPointerDown}
              onPointerMove={handleLockPointerMove}
              onPointerUp={handleLockPointerUp}
              onPointerCancel={handleLockPointerUp}
              onClick={handleLockClick}
              className={`flex h-10 w-8 shrink-0 touch-none cursor-ns-resize flex-col items-center justify-center gap-0.5 rounded-lg transition disabled:cursor-not-allowed disabled:opacity-40 ${ratioLocked ? 'bg-blue-50 text-blue-500 dark:bg-blue-500/10 dark:text-blue-300' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-white/[0.06] dark:hover:text-gray-300'}`}
              title="点击锁定比例，按住上下拖动缩放尺寸"
            >
              <svg className="h-2.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 14 10" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2 8l5-5 5 5" />
              </svg>
              <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                {ratioLocked ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 10V7a5 5 0 0110 0v3m-11 0h12a1 1 0 011 1v9a1 1 0 01-1 1H6a1 1 0 01-1-1v-9a1 1 0 011-1z" /> : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 10V7a5 5 0 019.5-2.06M17 10h1a1 1 0 011 1v9a1 1 0 01-1 1H6a1 1 0 01-1-1v-9a1 1 0 011-1h8" />}
              </svg>
              <svg className="h-2.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 14 10" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2 2l5 5 5-5" />
              </svg>
            </button>
            <label className="min-w-0 w-0 flex-1">
              <span className="flex w-full items-center gap-2 rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 transition focus-within:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:focus-within:border-blue-500/50">
                <span className="shrink-0 font-mono text-sm font-medium text-gray-400 dark:text-gray-500">H</span>
                <input type="number" value={dimensionHeight} onChange={(e) => updateDimensions('height', e.target.value)} className="min-w-0 flex-1 bg-transparent text-sm text-gray-700 outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-200" aria-label="高度" disabled={mode === 'auto'} />
              </span>
            </label>
          </div>
        </section>

        <section className={`rounded-xl border p-3 transition ${mode === 'ratio' ? 'border-blue-300/70 bg-blue-50/30 dark:border-blue-500/40 dark:bg-blue-500/[0.05]' : 'border-gray-200/70 dark:border-white/[0.08]'}`}>
          <button type="button" className="mb-3 flex w-full items-center text-left" onClick={() => setMode('ratio')}>
            <span className="text-sm font-medium text-gray-800 dark:text-gray-200">按比例</span>
          </button>
          <div className="mb-4 text-xs font-medium text-gray-400 dark:text-gray-500">基准分辨率</div>
          <div className="grid grid-cols-3 gap-2">
            {TIERS.map((item) => (
              <button key={item} type="button" className={buttonClass(mode === 'ratio' && tier === item)} onClick={() => { setMode('ratio'); setTier(item) }}>{item}</button>
            ))}
          </div>
          <div className="mb-2 mt-4 text-xs font-medium text-gray-400 dark:text-gray-500">图像比例</div>
          <div className="grid grid-cols-4 gap-2">
            {RATIOS.map((item) => {
              const [w, h] = item.value.split(':').map(Number)
              const isHorizontal = w > h
              const isSquare = w === h
              return (
                <button key={item.value} type="button" className={`${buttonClass(mode === 'ratio' && ratio === item.value)} flex flex-col items-center justify-center gap-1.5 !py-2.5`} onClick={() => { setMode('ratio'); setRatio(item.value) }}>
                  <div className="flex h-5 w-5 items-center justify-center"><div className="rounded-[3px] border-[1.5px] border-current opacity-60" style={{ width: isHorizontal || isSquare ? '100%' : `${(w / h) * 100}%`, height: !isHorizontal || isSquare ? '100%' : `${(h / w) * 100}%` }} /></div>
                  <span className="text-xs">{item.label}</span>
                </button>
              )
            })}
            <button type="button" className={`${buttonClass(mode === 'ratio' && ratio === 'custom')} col-span-4`} onClick={() => { setMode('ratio'); setRatio('custom') }}>自定义比例</button>
          </div>
          {ratio === 'custom' && (
            <label className="mt-4 block">
              <span className="mb-2 block text-xs font-medium text-gray-400 dark:text-gray-500">输入自定义比例</span>
              <input value={customRatio} onChange={(e) => { setMode('ratio'); setCustomRatio(e.target.value) }} placeholder="例如 5:4 / 2.39:1" className={`w-full rounded-xl border px-3 py-2 text-sm outline-none transition ${customRatioValid ? 'border-gray-200/70 bg-white/60 text-gray-700 focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50' : 'border-red-300 bg-white/60 text-gray-700 focus:border-red-400 dark:border-red-500/40 dark:bg-white/[0.03] dark:text-gray-200'}`} />
            </label>
          )}
        </section>

      </div>

      <div className="mt-5 flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 rounded-xl bg-gray-100 px-4 py-2.5 text-sm text-gray-600 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]">取消</button>
        <button type="button" onClick={applySize} disabled={!previewSize} className="flex-1 rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50">确定</button>
      </div>
    </div>,
    document.body,
  )
}
