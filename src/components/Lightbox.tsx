import { Suspense, lazy, useEffect, useState, useRef, useCallback } from 'react'
import { useStore, getCachedImage, ensureImageCached } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

const ReferenceImageEditorModal = lazy(() => import('./ReferenceImageEditorModal'))

const MIN_SCALE = 1
const MAX_SCALE = 10

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function isLightboxControl(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('[data-lightbox-control]'))
}

export default function Lightbox() {
  const lightboxImageId = useStore((s) => s.lightboxImageId)
  const lightboxImageList = useStore((s) => s.lightboxImageList)
  const lightboxStartEditor = useStore((s) => s.lightboxStartEditor)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setLightboxStartEditor = useStore((s) => s.setLightboxStartEditor)
  const inputImages = useStore((s) => s.inputImages)
  const [src, setSrc] = useState('')
  const [showEditor, setShowEditor] = useState(false)

  const close = useCallback(() => setLightboxImageId(null), [setLightboxImageId])
  useCloseOnEscape(Boolean(lightboxImageId), close)

  // 图片加载
  useEffect(() => {
    if (!lightboxImageId) {
      setSrc('')
      setShowEditor(false)
      setLightboxStartEditor(false)
      return
    }
    const cached = getCachedImage(lightboxImageId)
    if (cached) {
      setSrc(cached)
    } else {
      ensureImageCached(lightboxImageId).then((url) => {
        if (url) setSrc(url)
      })
    }
  }, [lightboxImageId, setLightboxStartEditor])

  const isReferenceImage = Boolean(lightboxImageId && inputImages.some((image) => image.id === lightboxImageId))

  useEffect(() => {
    if (!lightboxImageId || !src || !lightboxStartEditor) return
    setShowEditor(true)
    setLightboxStartEditor(false)
  }, [lightboxImageId, lightboxStartEditor, setLightboxStartEditor, src])

  // 导航
  const currentIndex = lightboxImageId ? lightboxImageList.indexOf(lightboxImageId) : -1
  const total = lightboxImageList.length
  const showNav = total > 1

  const goTo = useCallback((idx: number) => {
    if (lightboxImageList.length === 0) return
    const wrapped = ((idx % lightboxImageList.length) + lightboxImageList.length) % lightboxImageList.length
    setLightboxImageId(lightboxImageList[wrapped], lightboxImageList)
  }, [lightboxImageList, setLightboxImageId])

  const goPrev = useCallback(() => { if (showNav) goTo(currentIndex - 1) }, [showNav, currentIndex, goTo])
  const goNext = useCallback(() => { if (showNav) goTo(currentIndex + 1) }, [showNav, currentIndex, goTo])

  // 键盘左右切换
  useEffect(() => {
    if (!lightboxImageId || !showNav) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightboxImageId, showNav, goPrev, goNext])

  if (!lightboxImageId || !src) return null

  return (
    <>
      <LightboxInner
        src={src}
        onClose={close}
        showNav={showNav}
        currentIndex={currentIndex}
        total={total}
        onPrev={goPrev}
        onNext={goNext}
        isReferenceImage={isReferenceImage}
        onEdit={() => setShowEditor(true)}
      />
      {showEditor && lightboxImageId && src ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/55 backdrop-blur-md text-sm text-white/70">
              正在加载编辑器...
            </div>
          }
        >
          <ReferenceImageEditorModal
            imageId={lightboxImageId}
            src={src}
            saveMode={isReferenceImage ? 'replace-input' : 'append-input'}
            onClose={() => setShowEditor(false)}
          />
        </Suspense>
      ) : null}
    </>
  )
}

interface LightboxInnerProps {
  src: string
  onClose: () => void
  showNav: boolean
  currentIndex: number
  total: number
  onPrev: () => void
  onNext: () => void
  isReferenceImage: boolean
  onEdit: () => void
}

/** 内部组件：保证挂载时 DOM 已经存在，所有 ref / effect 都可靠 */
function LightboxInner({ src, onClose, showNav, currentIndex, total, onPrev, onNext, isReferenceImage, onEdit }: LightboxInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // 用 ref 追踪最新变换，避免闭包过期
  const scaleRef = useRef(1)
  const txRef = useRef(0)
  const tyRef = useRef(0)

  // 仅用于触发渲染
  const [, forceRender] = useState(0)
  const rerender = useCallback(() => forceRender((n) => n + 1), [])

  // 缩放倍率显示：2s 无操作后自动隐藏
  const [showZoomBadge, setShowZoomBadge] = useState(false)
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 拖拽状态
  const dragRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    baseTx: 0,
    baseTy: 0,
  })

  // 双指缩放状态
  const pinchRef = useRef({
    active: false,
    startDist: 0,
    startScale: 1,
    startTx: 0,
    startTy: 0,
    midX: 0,
    midY: 0,
  })

  // 双击检测（触控）
  const tapRef = useRef({ time: 0, x: 0, y: 0 })
  const hadMultiTouchRef = useRef(false)
  const touchStartedOnImageRef = useRef(false)

  // 判断本次 mousedown → mouseup 是否发生了拖拽，用于区分点击和拖拽
  const didDragRef = useRef(false)
  const suppressNextClickRef = useRef(false)

  // 切换图片时重置缩放
  useEffect(() => {
    scaleRef.current = 1
    txRef.current = 0
    tyRef.current = 0
    rerender()
  }, [src, rerender])

  useEffect(() => {
    const suppressClick = () => {
      suppressNextClickRef.current = true
    }

    window.addEventListener('image-context-menu-dismiss-lightbox-click', suppressClick)
    return () => window.removeEventListener('image-context-menu-dismiss-lightbox-click', suppressClick)
  }, [])

  const getCenter = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { cx: 0, cy: 0 }
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 }
  }, [])

  const apply = useCallback((s: number, tx: number, ty: number) => {
    const ns = clamp(s, MIN_SCALE, MAX_SCALE)
    scaleRef.current = ns
    txRef.current = ns <= 1 ? 0 : tx
    tyRef.current = ns <= 1 ? 0 : ty

    // 显示缩放倍率并重置自动隐藏计时器
    if (ns > 1) {
      setShowZoomBadge(true)
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
      zoomTimerRef.current = setTimeout(() => setShowZoomBadge(false), 1500)
    } else {
      setShowZoomBadge(false)
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
    }

    rerender()
  }, [rerender])

  // ====== 滚轮缩放 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = scaleRef.current
      const tx = txRef.current
      const ty = tyRef.current
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left - rect.width / 2
      const my = e.clientY - rect.top - rect.height / 2

      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const ns = clamp(s * factor, MIN_SCALE, MAX_SCALE)
      const r = ns / s
      apply(ns, mx - r * (mx - tx), my - r * (my - ty))
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [apply])

  // ====== 鼠标拖拽 + 点击关闭 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      didDragRef.current = false
      if (scaleRef.current <= 1) return
      e.preventDefault()
      dragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        baseTx: txRef.current,
        baseTy: tyRef.current,
      }
    }

    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d.active) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDragRef.current = true
      apply(scaleRef.current, d.baseTx + dx, d.baseTy + dy)
    }

    const onUp = () => {
      dragRef.current.active = false
    }

    el.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      el.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [apply])

  // ====== 单击关闭（仅未缩放且非拖拽） ======
  const onClick = useCallback((e: React.MouseEvent) => {
    if (isLightboxControl(e.target)) return
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      e.stopPropagation()
      return
    }
    if (didDragRef.current) return
    if (scaleRef.current > 1 && e.target instanceof HTMLImageElement) return
    onClose()
  }, [onClose])

  // ====== 鼠标双击缩放 ======
  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (scaleRef.current > 1) {
      apply(1, 0, 0)
    } else {
      const { cx, cy } = getCenter()
      const mx = e.clientX - cx
      const my = e.clientY - cy
      apply(3, -mx * 2, -my * 2)
    }
  }, [apply, getCenter])

  // ====== 触控事件 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onTouchStart = (e: TouchEvent) => {
      if (isLightboxControl(e.target)) {
        tapRef.current = { time: 0, x: 0, y: 0 }
        touchStartedOnImageRef.current = false
        return
      }

      if (e.touches.length === 2) {
        e.preventDefault()
        hadMultiTouchRef.current = true
        tapRef.current = { time: 0, x: 0, y: 0 }
        const [a, b] = [e.touches[0], e.touches[1]]
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        const { cx, cy } = getCenter()
        pinchRef.current = {
          active: true,
          startDist: dist,
          startScale: scaleRef.current,
          startTx: txRef.current,
          startTy: tyRef.current,
          midX: (a.clientX + b.clientX) / 2 - cx,
          midY: (a.clientY + b.clientY) / 2 - cy,
        }
        dragRef.current.active = false
      } else if (e.touches.length === 1) {
        const t = e.touches[0]
        const now = Date.now()
        const prev = tapRef.current
        touchStartedOnImageRef.current = e.target instanceof HTMLImageElement

        // 双击检测
        if (
          now - prev.time < 300 &&
          Math.abs(t.clientX - prev.x) < 30 &&
          Math.abs(t.clientY - prev.y) < 30
        ) {
          e.preventDefault()
          if (scaleRef.current > 1) {
            apply(1, 0, 0)
          } else {
            const { cx, cy } = getCenter()
            const mx = t.clientX - cx
            const my = t.clientY - cy
            apply(3, -mx * 2, -my * 2)
          }
          tapRef.current = { time: 0, x: 0, y: 0 }
          return
        }
        tapRef.current = { time: now, x: t.clientX, y: t.clientY }

        if (scaleRef.current > 1 && touchStartedOnImageRef.current) {
          e.preventDefault()
          dragRef.current = {
            active: true,
            startX: t.clientX,
            startY: t.clientY,
            baseTx: txRef.current,
            baseTy: tyRef.current,
          }
        }
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (pinchRef.current.active && e.touches.length === 2) {
        e.preventDefault()
        const [a, b] = [e.touches[0], e.touches[1]]
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        const p = pinchRef.current
        const ns = clamp(p.startScale * (dist / p.startDist), MIN_SCALE, MAX_SCALE)
        const r = ns / p.startScale
        apply(ns, p.midX - r * (p.midX - p.startTx), p.midY - r * (p.midY - p.startTy))
      } else if (dragRef.current.active && e.touches.length === 1) {
        e.preventDefault()
        const t = e.touches[0]
        const d = dragRef.current
        apply(scaleRef.current, d.baseTx + t.clientX - d.startX, d.baseTy + t.clientY - d.startY)
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (isLightboxControl(e.target)) {
        tapRef.current = { time: 0, x: 0, y: 0 }
        return
      }

      if (e.touches.length < 2) pinchRef.current.active = false
      if (e.touches.length === 0) {
        dragRef.current.active = false
        if (hadMultiTouchRef.current) {
          hadMultiTouchRef.current = false
          tapRef.current = { time: 0, x: 0, y: 0 }
          return
        }
        // 单击关闭：未缩放时任意位置关闭；缩放时仅点击图片外关闭。
        if (scaleRef.current <= 1 || !touchStartedOnImageRef.current) {
          const prev = tapRef.current
          if (prev.time > 0 && Date.now() - prev.time < 300) {
            setTimeout(() => {
              if (tapRef.current.time === prev.time) {
                onClose()
              }
            }, 310)
          }
        }
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [apply, getCenter, onClose])

  const s = scaleRef.current
  const tx = txRef.current
  const ty = tyRef.current
  const isZoomed = s > 1
  const isDragging = dragRef.current.active || pinchRef.current.active
  const zoomPercent = Math.round(s * 100)

  const navBtnClass =
    'absolute top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white hover:bg-black/60 transition-all z-10 backdrop-blur-sm'

  return (
    <div
      ref={containerRef}
      data-lightbox-root
      className="fixed inset-0 z-[60] flex items-center justify-center select-none"
      style={{ cursor: isZoomed ? (isDragging ? 'grabbing' : 'grab') : 'pointer' }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md animate-fade-in" />
      <button
        data-lightbox-control
        className="absolute right-5 top-5 z-20 rounded-full bg-black/45 px-4 py-2 text-sm text-white backdrop-blur-sm transition hover:bg-black/65"
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onEdit()
        }}
      >
        {isReferenceImage ? '编辑参考图' : '编辑并加入参考图'}
      </button>
      <div className="relative animate-zoom-in">
        <img
          src={src}
          className="max-w-[85vw] max-h-[85vh] object-contain rounded-lg shadow-2xl"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${s})`,
            transition: isDragging ? 'none' : 'transform 0.2s ease-out',
            willChange: 'transform',
          }}
          onDragStart={(e) => e.preventDefault()}
          alt=""
        />
      </div>

      {/* 左右切换按钮 */}
      {showNav && !isZoomed && (
        <>
          <button
            data-lightbox-control
            className={`${navBtnClass} left-3 sm:left-5`}
            onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); goPrev() }}
          >
            <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            data-lightbox-control
            className={`${navBtnClass} right-3 sm:right-5`}
            onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); goNext() }}
          >
            <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </>
      )}

      {/* 底部指示器 */}
      {showZoomBadge && isZoomed && zoomPercent !== 100 && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-none">
          <span className="px-3 py-1.5 bg-black/50 text-white/80 text-xs rounded-full backdrop-blur-sm transition-opacity duration-500">
            {zoomPercent}%
          </span>
        </div>
      )}
      {showNav && !isZoomed && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-none">
          <span className="px-3 py-1.5 bg-black/50 text-white/80 text-xs rounded-full backdrop-blur-sm">
            {currentIndex + 1} / {total}
          </span>
        </div>
      )}
    </div>
  )

  function goPrev() { onPrev() }
  function goNext() { onNext() }
}
