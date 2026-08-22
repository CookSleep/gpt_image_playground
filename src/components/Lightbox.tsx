import { useEffect, useState, useRef, useCallback } from 'react'
import { createInputImageFromFile, deleteImageIfUnreferenced, useStore } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { useHintTooltip } from '../hooks/useHintTooltip'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { suppressGlobalClicks } from '../lib/clickSuppression'
import { ensureImageCached, getCachedImage } from '../lib/imageCache'
import ButtonTooltip from './input/buttonTooltip'
import { EditIcon, RefreshIcon } from './icons'

const MIN_SCALE = 1
const MAX_SCALE = 10
const SWIPE_INTENT_THRESHOLD = 10
const SWIPE_ACTION_THRESHOLD = 40
const DOUBLE_TAP_DELAY = 350
const DOUBLE_TAP_DISTANCE = 40

type TouchIntent = 'none' | 'horizontal-swipe' | 'vertical-move' | 'zoom-pan' | 'pinch'

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

export default function Lightbox() {
  const lightboxImageId = useStore((s) => s.lightboxImageId)
  const lightboxImageList = useStore((s) => s.lightboxImageList)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const maskDraft = useStore((s) => s.maskDraft)
  const tasks = useStore((s) => s.tasks)
  const inputImages = useStore((s) => s.inputImages)
  const replaceInputImage = useStore((s) => s.replaceInputImage)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
  const showToast = useStore((s) => s.showToast)
  const replaceFileInputRef = useRef<HTMLInputElement>(null)
  const replaceImageTargetRef = useRef<string | null>(null)

  const [src, setSrc] = useState('')
  const [maskImageSrc, setMaskImageSrc] = useState('')
  const [maskPreviewSrc, setMaskPreviewSrc] = useState('')

  const close = useCallback(() => setLightboxImageId(null), [setLightboxImageId])
  useCloseOnEscape(Boolean(lightboxImageId), close)
  usePreventBackgroundScroll(Boolean(lightboxImageId))

  // 图片加载
  useEffect(() => {
    let cancelled = false

    if (!lightboxImageId) {
      setSrc('')
      return
    }

    setSrc('')

    const imageId = lightboxImageId
    const cached = getCachedImage(imageId)
    if (cached) {
      setSrc(cached)
    } else {
      ensureImageCached(imageId).then((url) => {
        if (!cancelled && url) setSrc(url)
      })
    }

    return () => {
      cancelled = true
    }
  }, [lightboxImageId])

  // 遮罩图加载
  useEffect(() => {
    let cancelled = false

    if (!lightboxImageId) {
      setMaskImageSrc('')
      return
    }

    if (maskDraft?.targetImageId === lightboxImageId) {
      setMaskImageSrc(maskDraft.maskDataUrl)
      return
    }

    setMaskImageSrc('')

    const taskWithMask = tasks.find((t) => t.maskTargetImageId === lightboxImageId && t.maskImageId)
    if (taskWithMask?.maskImageId) {
      const maskImageId = taskWithMask.maskImageId
      const cached = getCachedImage(maskImageId)
      if (cached) {
        setMaskImageSrc(cached)
      } else {
        ensureImageCached(maskImageId).then((url) => {
          if (!cancelled && url) setMaskImageSrc(url)
        })
      }
    } else {
      setMaskImageSrc('')
    }

    return () => {
      cancelled = true
    }
  }, [lightboxImageId, maskDraft?.targetImageId, maskDraft?.maskDataUrl, tasks])

  // 生成遮罩预览
  useEffect(() => {
    let cancelled = false
    if (!src || !maskImageSrc) {
      setMaskPreviewSrc('')
      return
    }

    createMaskPreviewDataUrl(src, maskImageSrc)
      .then((url) => {
        if (!cancelled) setMaskPreviewSrc(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewSrc('')
      })

    return () => {
      cancelled = true
    }
  }, [src, maskImageSrc])

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

  const isInputImage = Boolean(lightboxImageId && inputImages.some((image) => image.id === lightboxImageId))

  const openReplaceFilePicker = useCallback(() => {
    if (!lightboxImageId || !isInputImage) return
    replaceImageTargetRef.current = lightboxImageId
    replaceFileInputRef.current?.click()
  }, [isInputImage, lightboxImageId])

  const handleReplaceFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    const targetId = replaceImageTargetRef.current
    replaceImageTargetRef.current = null
    if (!file || !targetId) return

    try {
      const image = await createInputImageFromFile(file)
      if (!image) {
        showToast('请选择有效图片', 'error')
        return
      }

      const currentImages = useStore.getState().inputImages
      const targetIdx = currentImages.findIndex((item) => item.id === targetId)
      if (targetIdx < 0) {
        void deleteImageIfUnreferenced(image.id)
        showToast('原参考图已不存在', 'error')
        return
      }
      if (targetId === image.id) {
        showToast('参考图未变化', 'info')
        return
      }
      if (currentImages.some((item, idx) => idx !== targetIdx && item.id === image.id)) {
        showToast('这张图片已在参考图中', 'info')
        return
      }

      replaceInputImage(targetIdx, image)
      const nextList = lightboxImageList.map((id) => id === targetId ? image.id : id)
      setLightboxImageId(image.id, nextList)
      showToast('参考图已替换', 'success')
    } catch (err) {
      showToast(`参考图替换失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }, [lightboxImageList, replaceInputImage, setLightboxImageId, showToast])

  const editInputImage = useCallback(() => {
    if (!lightboxImageId || !isInputImage) return
    const imageId = lightboxImageId
    close()
    setMaskEditorImageId(imageId)
  }, [close, isInputImage, lightboxImageId, setMaskEditorImageId])

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
        imageId={lightboxImageId}
        maskPreviewSrc={maskPreviewSrc}
        onClose={close}
        showNav={showNav}
        currentIndex={currentIndex}
        total={total}
        onPrev={goPrev}
        onNext={goNext}
        showInputActions={isInputImage}
        editDisabled={Boolean(maskDraft && maskDraft.targetImageId !== lightboxImageId)}
        onReplace={openReplaceFilePicker}
        onEdit={editInputImage}
      />
      <input
        ref={replaceFileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleReplaceFileUpload}
      />
    </>
  )
}

interface LightboxInnerProps {
  src: string
  imageId: string
  maskPreviewSrc?: string
  onClose: () => void
  showNav: boolean
  currentIndex: number
  total: number
  onPrev: () => void
  onNext: () => void
  showInputActions: boolean
  editDisabled: boolean
  onReplace: () => void
  onEdit: () => void
}

/** 内部组件：保证挂载时 DOM 已经存在，所有 ref / effect 都可靠 */
function LightboxInner({ src, imageId, maskPreviewSrc, onClose, showNav, currentIndex, total, onPrev, onNext, showInputActions, editDisabled, onReplace, onEdit }: LightboxInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const openedAtRef = useRef(Date.now())
  const editHint = useHintTooltip({ enabled: () => editDisabled })

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
  const touchStartedOnControlRef = useRef(false)
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const touchIntentRef = useRef<TouchIntent>('none')
  const touchMovedRef = useRef(false)
  const swipeHandledRef = useRef(false)
  const doubleTapHandledRef = useRef(false)
  const closeTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 判断本次 mousedown → mouseup 是否发生了拖拽，用于区分点击和拖拽
  const didDragRef = useRef(false)
  const suppressNextClickRef = useRef(false)
  const suppressClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 切换图片时重置缩放
  useEffect(() => {
    openedAtRef.current = Date.now()
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

  const cancelCloseTap = useCallback(() => {
    if (closeTapTimerRef.current) {
      clearTimeout(closeTapTimerRef.current)
      closeTapTimerRef.current = null
    }
  }, [])

  const suppressNextClickBriefly = useCallback(() => {
    suppressNextClickRef.current = true
    if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current)
    suppressClickTimerRef.current = setTimeout(() => {
      suppressNextClickRef.current = false
      suppressClickTimerRef.current = null
    }, 350)
  }, [])

  const resetTouchGesture = useCallback(() => {
    touchStartRef.current = null
    touchIntentRef.current = 'none'
    touchMovedRef.current = false
    swipeHandledRef.current = false
    touchStartedOnControlRef.current = false
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
    if (Date.now() - openedAtRef.current < DOUBLE_TAP_DELAY) return
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
      if (e.touches.length === 2) {
        e.preventDefault()
        cancelCloseTap()
        resetTouchGesture()
        hadMultiTouchRef.current = true
        touchIntentRef.current = 'pinch'
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
        touchStartedOnControlRef.current = e.target instanceof Element && Boolean(e.target.closest('button'))
        touchStartRef.current = { x: t.clientX, y: t.clientY, time: now }
        touchIntentRef.current = 'none'
        touchMovedRef.current = false
        swipeHandledRef.current = false

        // 双击检测
        if (
          touchStartedOnImageRef.current &&
          now - prev.time < DOUBLE_TAP_DELAY &&
          Math.abs(t.clientX - prev.x) < DOUBLE_TAP_DISTANCE &&
          Math.abs(t.clientY - prev.y) < DOUBLE_TAP_DISTANCE
        ) {
          e.preventDefault()
          cancelCloseTap()
          suppressNextClickBriefly()
          doubleTapHandledRef.current = true
          if (scaleRef.current > 1) {
            apply(1, 0, 0)
          } else {
            const { cx, cy } = getCenter()
            const mx = t.clientX - cx
            const my = t.clientY - cy
            apply(3, -mx * 2, -my * 2)
          }
          tapRef.current = { time: 0, x: 0, y: 0 }
          resetTouchGesture()
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
        const dx = t.clientX - d.startX
        const dy = t.clientY - d.startY
        if (Math.abs(dx) > SWIPE_INTENT_THRESHOLD || Math.abs(dy) > SWIPE_INTENT_THRESHOLD) {
          touchMovedRef.current = true
          touchIntentRef.current = 'zoom-pan'
        }
        apply(scaleRef.current, d.baseTx + dx, d.baseTy + dy)
      } else if (scaleRef.current <= 1 && e.touches.length === 1 && touchStartRef.current) {
        const t = e.touches[0]
        const dx = t.clientX - touchStartRef.current.x
        const dy = t.clientY - touchStartRef.current.y
        const absX = Math.abs(dx)
        const absY = Math.abs(dy)

        if (absX > SWIPE_INTENT_THRESHOLD || absY > SWIPE_INTENT_THRESHOLD) {
          touchMovedRef.current = true
        }
        if (touchIntentRef.current === 'none' && (absX > SWIPE_INTENT_THRESHOLD || absY > SWIPE_INTENT_THRESHOLD)) {
          touchIntentRef.current = absX > absY ? 'horizontal-swipe' : 'vertical-move'
          if (touchIntentRef.current === 'horizontal-swipe') cancelCloseTap()
        }
        if (touchIntentRef.current === 'horizontal-swipe') {
          e.preventDefault()
        }
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchRef.current.active = false
      if (e.touches.length === 0) {
        dragRef.current.active = false
        if (hadMultiTouchRef.current) {
          hadMultiTouchRef.current = false
          tapRef.current = { time: 0, x: 0, y: 0 }
          resetTouchGesture()
          return
        }

        if (doubleTapHandledRef.current) {
          doubleTapHandledRef.current = false
          resetTouchGesture()
          return
        }

        const start = touchStartRef.current
        const changed = e.changedTouches[0]
        const dx = start && changed ? changed.clientX - start.x : 0
        const intent = touchIntentRef.current
        const moved = touchMovedRef.current

        if (intent === 'horizontal-swipe' && scaleRef.current <= 1) {
          cancelCloseTap()
          suppressNextClickBriefly()
          swipeHandledRef.current = Math.abs(dx) >= SWIPE_ACTION_THRESHOLD
          tapRef.current = { time: 0, x: 0, y: 0 }
          e.preventDefault()
          if (swipeHandledRef.current) {
            if (dx < 0 && showNav) onNext()
            if (dx > 0 && showNav) onPrev()
          }
          resetTouchGesture()
          return
        }

        if (moved || intent === 'vertical-move' || intent === 'zoom-pan') {
          suppressNextClickBriefly()
          tapRef.current = { time: 0, x: 0, y: 0 }
          resetTouchGesture()
          return
        }

        // 触摸设备会在 touchend 后补发 click，这里接管点按，避免首个点按关闭导致双击缩放失效。
        suppressNextClickBriefly()

        // 单击关闭：未缩放时图片也可点按关闭；图片上的关闭延迟到双击窗口后，避免破坏双击缩放。
        if (touchStartedOnControlRef.current) {
          resetTouchGesture()
          return
        }
        if (scaleRef.current <= 1 && touchStartedOnImageRef.current) {
          cancelCloseTap()
          closeTapTimerRef.current = setTimeout(() => {
            closeTapTimerRef.current = null
            suppressGlobalClicks()
            onClose()
          }, DOUBLE_TAP_DELAY)
        } else if (!touchStartedOnImageRef.current) {
          cancelCloseTap()
          suppressGlobalClicks()
          if (e.cancelable) e.preventDefault()
          onClose()
        }
        resetTouchGesture()
      }
    }

    const onTouchCancel = () => {
      cancelCloseTap()
      tapRef.current = { time: 0, x: 0, y: 0 }
      hadMultiTouchRef.current = false
      doubleTapHandledRef.current = false
      pinchRef.current.active = false
      dragRef.current.active = false
      resetTouchGesture()
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchCancel)
    return () => {
      cancelCloseTap()
      if (suppressClickTimerRef.current) {
        clearTimeout(suppressClickTimerRef.current)
        suppressClickTimerRef.current = null
      }
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [apply, cancelCloseTap, getCenter, onClose, onNext, onPrev, resetTouchGesture, showNav, suppressNextClickBriefly])

  const s = scaleRef.current
  const tx = txRef.current
  const ty = tyRef.current
  const isZoomed = s > 1
  const isDragging = dragRef.current.active || pinchRef.current.active
  const zoomPercent = Math.round(s * 100)

  const navBtnClass =
    'absolute top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/80 text-gray-800 hover:bg-white dark:bg-black/40 dark:text-white dark:hover:bg-black/60 transition-all z-10 backdrop-blur-sm shadow-md border border-gray-200/50 dark:border-transparent'

  return (
    <div
      ref={containerRef}
      data-lightbox-root
      className="fixed inset-0 z-[60] flex items-center justify-center select-none"
      style={{ cursor: isZoomed ? (isDragging ? 'grabbing' : 'grab') : 'pointer' }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="absolute inset-0 bg-black/35 dark:bg-black/70 backdrop-blur-md animate-fade-in" />
      <div className="relative animate-zoom-in">
        <div
          className="relative flex items-center justify-center"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${s})`,
            transition: isDragging ? 'none' : 'transform 0.2s ease-out',
            willChange: 'transform',
          }}
        >
          <img
            src={src}
            data-image-id={imageId}
            className="saveable-image max-w-[90vw] max-h-[70vh] sm:max-w-[85vw] sm:max-h-[75vh] object-contain rounded-lg shadow-2xl"
            onDragStart={(e) => e.preventDefault()}
            alt=""
          />
          {maskPreviewSrc && (
            <img
              src={maskPreviewSrc}
              className="absolute inset-0 w-full h-full object-contain rounded-lg pointer-events-none"
              alt=""
            />
          )}
        </div>
      </div>

      {/* 左右切换按钮 */}
      {showNav && !isZoomed && (
        <>
          <button
            className={`${navBtnClass} left-3 sm:left-5`}
            onClick={(e) => { e.stopPropagation(); goPrev() }}
          >
            <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            className={`${navBtnClass} right-3 sm:right-5`}
            onClick={(e) => { e.stopPropagation(); goNext() }}
          >
            <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </>
      )}

      {/* 参考图操作 */}
      {showInputActions && !isZoomed && (
        <div className="absolute bottom-8 left-1/2 z-10 flex w-max -translate-x-1/2 items-center gap-2 rounded-2xl bg-white/90 dark:bg-black/60 p-2 backdrop-blur-xl border border-gray-200/80 dark:border-white/15 shadow-2xl transition-colors" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="flex items-center justify-center gap-2 whitespace-nowrap rounded-xl px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-white/90 dark:hover:bg-white/15 transition active:scale-95"
            onClick={onReplace}
          >
            <RefreshIcon className="w-4 h-4" />
            <span>替换图片</span>
          </button>
          <div
            className="relative flex items-center"
            onMouseEnter={editHint.show}
            onMouseLeave={editHint.hide}
            onTouchStart={editHint.startTouch}
            onTouchEnd={editHint.clearTimer}
            onTouchCancel={editHint.hide}
          >
            <ButtonTooltip visible={editDisabled && editHint.visible} text="只能有一张遮罩图" />
            <button
              type="button"
              disabled={editDisabled}
              className={`flex items-center justify-center gap-2 whitespace-nowrap rounded-xl px-5 py-2.5 text-sm font-medium shadow-md transition active:scale-95 ${editDisabled ? 'cursor-not-allowed bg-gray-100 text-gray-400 dark:bg-white/10 dark:text-white/40 shadow-none' : 'bg-blue-500 text-white hover:bg-blue-600 hover:shadow-blue-500/25'}`}
              onClick={onEdit}
            >
              <EditIcon className="w-4 h-4" />
              <span>编辑图片</span>
            </button>
          </div>
        </div>
      )}

      {/* 指示器 */}
      {showZoomBadge && isZoomed && zoomPercent !== 100 && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-none">
          <span className="px-3 py-1.5 bg-white/90 dark:bg-black/50 text-gray-800 dark:text-white/80 text-xs rounded-full backdrop-blur-sm transition-opacity duration-500 border border-gray-200/80 dark:border-transparent">
            {zoomPercent}%
          </span>
        </div>
      )}
      {showNav && !isZoomed && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 pointer-events-none z-10">
          <span className="px-3 py-1 bg-white/90 dark:bg-black/60 text-gray-800 dark:text-white/90 text-sm font-medium rounded-full backdrop-blur-md shadow-lg border border-gray-200/80 dark:border-white/15">
            {currentIndex + 1} / {total}
          </span>
        </div>
      )}
    </div>
  )

  function goPrev() { onPrev() }
  function goNext() { onNext() }
}
