import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { ensureImageCached, useStore } from '../store'
import { canvasToBlob, loadImage } from '../lib/canvasImage'
import { storeImage } from '../lib/db'
import { prepareMaskTargetDataUrl, replaceMaskTargetImage } from '../lib/maskPreprocess'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import {
  clampViewTransform,
  clientPointToCanvasPoint,
  getComfortableInitialTransform,
  getPinchTransform,
  type Point,
  type ViewTransform,
} from '../lib/viewportTransform'

type Tool = 'brush' | 'eraser'

interface CanvasSize {
  width: number
  height: number
}

interface PinchGesture {
  startTransform: ViewTransform
  startCentroid: Point
  startDistance: number
}

const DEFAULT_VIEW_TRANSFORM: ViewTransform = { scale: 1, x: 0, y: 0 }

function getCanvasPoint(canvas: HTMLCanvasElement, event: ReactPointerEvent<HTMLCanvasElement>): Point {
  return clientPointToCanvasPoint(
    canvas.getBoundingClientRect(),
    { x: event.clientX, y: event.clientY },
    { width: canvas.width, height: canvas.height },
  )
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function centroid(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  }
}

function firstTwoPointers(points: Map<number, Point>): [Point, Point] | null {
  const values = Array.from(points.values())
  return values.length >= 2 ? [values[0], values[1]] : null
}

function fillWhiteMask(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('图片导出失败'))
    reader.readAsDataURL(blob)
  })
}

export default function MaskEditorModal() {
  const imageId = useStore((s) => s.maskEditorImageId)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
  const maskDraft = useStore((s) => s.maskDraft)
  const setMaskDraft = useStore((s) => s.setMaskDraft)
  const showToast = useStore((s) => s.showToast)

  const imageCanvasRef = useRef<HTMLCanvasElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const baseFrameRef = useRef<HTMLDivElement>(null)
  const activePointerIdRef = useRef<number | null>(null)
  const lastPointRef = useRef<Point | null>(null)
  const pointerPositionsRef = useRef<Map<number, Point>>(new Map())
  const pinchGestureRef = useRef<PinchGesture | null>(null)
  const undoStackRef = useRef<ImageData[]>([])
  const redoStackRef = useRef<ImageData[]>([])
  const saveTokenRef = useRef(0)
  const sessionIdRef = useRef(0)
  const activeSessionIdRef = useRef(0)
  const viewTransformRef = useRef<ViewTransform>(DEFAULT_VIEW_TRANSFORM)

  const [sourceDataUrl, setSourceDataUrl] = useState('')
  const [size, setSize] = useState<CanvasSize | null>(null)
  const [tool, setTool] = useState<Tool>('brush')
  const [brushSize, setBrushSize] = useState(64)
  const [viewTransform, setViewTransform] = useState<ViewTransform>(DEFAULT_VIEW_TRANSFORM)
  const [showBrushControls, setShowBrushControls] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 })

  const close = () => {
    if (isSaving) return
    setMaskEditorImageId(null)
  }
  useCloseOnEscape(Boolean(imageId), close)

  function commitViewTransform(nextTransform: ViewTransform) {
    const frame = baseFrameRef.current
    const clamped = frame
      ? clampViewTransform(nextTransform, { width: frame.clientWidth, height: frame.clientHeight })
      : nextTransform
    viewTransformRef.current = clamped
    setViewTransform(clamped)
  }

  function resetViewTransform() {
    const frame = baseFrameRef.current
    const stage = stageRef.current
    const isCompactLayout = window.matchMedia('(max-width: 1023px)').matches
    if (!frame || !stage) {
      commitViewTransform(DEFAULT_VIEW_TRANSFORM)
      return
    }

    commitViewTransform(getComfortableInitialTransform(
      { width: frame.clientWidth, height: frame.clientHeight },
      { width: stage.clientWidth, height: stage.clientHeight },
      isCompactLayout,
    ))
  }

  function cancelActiveStroke() {
    if (activePointerIdRef.current == null) return

    const previous = undoStackRef.current.pop()
    if (previous) restoreMask(previous)
    activePointerIdRef.current = null
    lastPointRef.current = null
    syncHistoryState()
  }

  function beginPinchGesture() {
    const pointers = firstTwoPointers(pointerPositionsRef.current)
    const frame = baseFrameRef.current
    if (!pointers || !frame) return

    const rect = frame.getBoundingClientRect()
    const startCentroid = centroid(pointers[0], pointers[1])
    pinchGestureRef.current = {
      startTransform: viewTransformRef.current,
      startCentroid: {
        x: startCentroid.x - rect.left,
        y: startCentroid.y - rect.top,
      },
      startDistance: distance(pointers[0], pointers[1]),
    }
  }

  function updatePinchGesture() {
    const pointers = firstTwoPointers(pointerPositionsRef.current)
    const gesture = pinchGestureRef.current
    const frame = baseFrameRef.current
    if (!pointers || !gesture || !frame) return

    const rect = frame.getBoundingClientRect()
    const nextCentroid = centroid(pointers[0], pointers[1])
    commitViewTransform(getPinchTransform({
      startTransform: gesture.startTransform,
      startCentroid: gesture.startCentroid,
      nextCentroid: {
        x: nextCentroid.x - rect.left,
        y: nextCentroid.y - rect.top,
      },
      startDistance: gesture.startDistance,
      nextDistance: distance(pointers[0], pointers[1]),
      viewportSize: { width: frame.clientWidth, height: frame.clientHeight },
    }))
  }

  function syncHistoryState() {
    setHistoryState({
      undo: undoStackRef.current.length,
      redo: redoStackRef.current.length,
    })
  }

  function renderPreview() {
    const maskCanvas = maskCanvasRef.current
    const previewCanvas = previewCanvasRef.current
    if (!maskCanvas || !previewCanvas) return

    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })
    const previewCtx = previewCanvas.getContext('2d')
    if (!maskCtx || !previewCtx) return

    const maskPixels = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
    const overlay = previewCtx.createImageData(previewCanvas.width, previewCanvas.height)

    for (let i = 0; i < maskPixels.data.length; i += 4) {
      const editStrength = 255 - maskPixels.data[i + 3]
      overlay.data[i] = 255
      overlay.data[i + 1] = 112
      overlay.data[i + 2] = 32
      overlay.data[i + 3] = Math.round(editStrength * 0.58)
    }

    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height)
    previewCtx.putImageData(overlay, 0, 0)
  }

  function pushUndoSnapshot() {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !ctx) return

    undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height))
    if (undoStackRef.current.length > 40) undoStackRef.current.shift()
    redoStackRef.current = []
    syncHistoryState()
  }

  function restoreMask(imageData: ImageData) {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !ctx) return

    ctx.putImageData(imageData, 0, 0)
    renderPreview()
  }

  function drawAt(point: Point, nextTool = tool) {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    ctx.save()
    ctx.globalCompositeOperation = nextTool === 'brush' ? 'destination-out' : 'source-over'
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(point.x, point.y, brushSize / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    renderPreview()
  }

  function drawStroke(from: Point, to: Point, nextTool = tool) {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    ctx.save()
    ctx.globalCompositeOperation = nextTool === 'brush' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = brushSize
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    ctx.restore()
    renderPreview()
  }

  useEffect(() => {
    if (!imageId) {
      activeSessionIdRef.current = 0
      return
    }

    const nextSessionId = sessionIdRef.current + 1
    sessionIdRef.current = nextSessionId
    activeSessionIdRef.current = nextSessionId

    return () => {
      if (activeSessionIdRef.current === nextSessionId) {
        activeSessionIdRef.current = 0
      }
    }
  }, [imageId])

  useEffect(() => {
    if (!imageId) {
      setSourceDataUrl('')
      setSize(null)
      setShowBrushControls(false)
      setIsLoading(false)
      pointerPositionsRef.current.clear()
      pinchGestureRef.current = null
      viewTransformRef.current = DEFAULT_VIEW_TRANSFORM
      setViewTransform(DEFAULT_VIEW_TRANSFORM)
      undoStackRef.current = []
      redoStackRef.current = []
      syncHistoryState()
      return
    }

    const targetImageId = imageId
    let cancelled = false
    setIsLoading(true)
    setSourceDataUrl('')
    setSize(null)
    undoStackRef.current = []
    redoStackRef.current = []
    syncHistoryState()

    async function loadCanvases() {
      try {
        const dataUrl = await ensureImageCached(targetImageId)
        if (cancelled) return
        if (!dataUrl) {
          showToast('图片已不存在，无法编辑遮罩', 'error')
          setMaskEditorImageId(null)
          return
        }

        const preparedTarget = await prepareMaskTargetDataUrl(dataUrl)
        const image = await loadImage(preparedTarget.dataUrl)
        if (cancelled) return

        const nextSize = { width: preparedTarget.width, height: preparedTarget.height }
        const imageCanvas = imageCanvasRef.current
        const previewCanvas = previewCanvasRef.current
        const maskCanvas = maskCanvasRef.current
        if (!imageCanvas || !previewCanvas || !maskCanvas) return

        for (const canvas of [imageCanvas, previewCanvas, maskCanvas]) {
          canvas.width = nextSize.width
          canvas.height = nextSize.height
        }

        const imageCtx = imageCanvas.getContext('2d')
        if (!imageCtx) throw new Error('当前浏览器不支持 Canvas')
        imageCtx.clearRect(0, 0, imageCanvas.width, imageCanvas.height)
        imageCtx.drawImage(image, 0, 0)

        fillWhiteMask(maskCanvas)

        if (maskDraft?.targetImageId === targetImageId) {
          try {
            const draftImage = await loadImage(maskDraft.maskDataUrl)
            if (cancelled) return
            if (draftImage.naturalWidth !== nextSize.width || draftImage.naturalHeight !== nextSize.height) {
              throw new Error('遮罩尺寸与当前图片不一致')
            }
            const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })
            if (!maskCtx) throw new Error('当前浏览器不支持 Canvas')
            maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
            maskCtx.drawImage(draftImage, 0, 0)
          } catch (err) {
            fillWhiteMask(maskCanvas)
            showToast(
              `遮罩草稿加载失败，已重置为空白遮罩：${err instanceof Error ? err.message : String(err)}`,
              'error',
            )
          }
        }

        renderPreview()
        setSourceDataUrl(preparedTarget.dataUrl)
        setSize(nextSize)
        if (preparedTarget.wasResized) {
          showToast(
            `已为遮罩编辑优化图片尺寸：${preparedTarget.originalWidth}×${preparedTarget.originalHeight} → ${preparedTarget.width}×${preparedTarget.height}`,
            'info',
          )
        }
        requestAnimationFrame(() => resetViewTransform())
      } catch (err) {
        if (!cancelled) {
          showToast(err instanceof Error ? err.message : String(err), 'error')
          setMaskEditorImageId(null)
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadCanvases()

    return () => {
      cancelled = true
      activePointerIdRef.current = null
      lastPointRef.current = null
      pointerPositionsRef.current.clear()
      pinchGestureRef.current = null
    }
  }, [imageId, maskDraft, setMaskEditorImageId, showToast])

  useEffect(() => {
    const frame = baseFrameRef.current
    if (!frame || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      commitViewTransform(viewTransformRef.current)
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [size])

  if (!imageId) return null

  const isReady = Boolean(sourceDataUrl && size && !isLoading)
  const canUndo = historyState.undo > 0 && isReady && !isSaving
  const canRedo = historyState.redo > 0 && isReady && !isSaving
  const isZoomed = viewTransform.scale > 1.01 || Math.abs(viewTransform.x) > 1 || Math.abs(viewTransform.y) > 1

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isReady || isSaving || (event.pointerType !== 'touch' && event.button !== 0)) return
    event.preventDefault()
    const canvas = event.currentTarget
    pointerPositionsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (!canvas.hasPointerCapture(event.pointerId)) {
      canvas.setPointerCapture(event.pointerId)
    }

    if (pointerPositionsRef.current.size >= 2) {
      cancelActiveStroke()
      beginPinchGesture()
      return
    }

    activePointerIdRef.current = event.pointerId
    pushUndoSnapshot()
    const point = getCanvasPoint(canvas, event)
    lastPointRef.current = point
    drawAt(point)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerPositionsRef.current.has(event.pointerId)) {
      pointerPositionsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    }
    if (pinchGestureRef.current && pointerPositionsRef.current.size >= 2) {
      event.preventDefault()
      updatePinchGesture()
      return
    }
    if (activePointerIdRef.current !== event.pointerId || !lastPointRef.current || !isReady || isSaving) return
    event.preventDefault()
    const point = getCanvasPoint(event.currentTarget, event)
    drawStroke(lastPointRef.current, point)
    lastPointRef.current = point
  }

  const finishStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    pointerPositionsRef.current.delete(event.pointerId)

    if (pinchGestureRef.current) {
      if (pointerPositionsRef.current.size >= 2) beginPinchGesture()
      else pinchGestureRef.current = null
    }

    if (activePointerIdRef.current === event.pointerId) {
      activePointerIdRef.current = null
      lastPointRef.current = null
    }
  }

  const handleUndo = () => {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    const previous = undoStackRef.current.pop()
    if (!canvas || !ctx || !previous) return

    redoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height))
    restoreMask(previous)
    syncHistoryState()
  }

  const handleRedo = () => {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    const next = redoStackRef.current.pop()
    if (!canvas || !ctx || !next) return

    undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height))
    restoreMask(next)
    syncHistoryState()
  }

  const handleClear = () => {
    const canvas = maskCanvasRef.current
    if (!canvas || !isReady || isSaving) return

    pushUndoSnapshot()
    fillWhiteMask(canvas)
    renderPreview()
  }

  const handleSave = async () => {
    const canvas = maskCanvasRef.current
    const savingSessionId = activeSessionIdRef.current
    if (!canvas || !sourceDataUrl || !imageId || !isReady || isSaving || !savingSessionId) return

    const token = ++saveTokenRef.current
    const savingImageId = imageId
    try {
      setIsSaving(true)
      const blob = await canvasToBlob(canvas, 'image/png')
      const maskDataUrl = await blobToDataUrl(blob)
      const workingTargetId = await storeImage(sourceDataUrl, 'upload')
      if (
        saveTokenRef.current !== token ||
        activeSessionIdRef.current !== savingSessionId ||
        useStore.getState().maskEditorImageId !== savingImageId
      ) return

      const latestStore = useStore.getState()
      latestStore.setInputImages(
        replaceMaskTargetImage(latestStore.inputImages, savingImageId, {
          id: workingTargetId,
          dataUrl: sourceDataUrl,
        }),
      )
      setMaskDraft({
        targetImageId: workingTargetId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
      setMaskEditorImageId(null)
      showToast('遮罩已保存', 'success')
    } catch (err) {
      if (
        saveTokenRef.current !== token ||
        activeSessionIdRef.current !== savingSessionId ||
        useStore.getState().maskEditorImageId !== savingImageId
      ) return
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      if (saveTokenRef.current === token) setIsSaving(false)
    }
  }

  const toolButtonClass = (active: boolean) =>
    `flex-1 rounded-xl px-3 py-2 text-sm font-medium transition ${
      active
        ? 'bg-orange-500 text-white shadow-sm shadow-orange-500/20'
        : 'bg-white/60 text-gray-600 hover:bg-white dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]'
    }`

  const actionButtonClass =
    'rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-600 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]'

  const compactButtonClass = (active = false) =>
    `h-9 rounded-xl px-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${
      active
        ? 'bg-orange-500 text-white shadow-sm shadow-orange-500/20'
        : 'border border-gray-200/70 bg-white/70 text-gray-600 hover:bg-white dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]'
    }`

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-md animate-overlay-in" onClick={close} />
      <div
        className="relative z-10 flex h-[100dvh] w-full flex-col overflow-hidden bg-white/95 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:bg-gray-900/95 dark:ring-white/10 sm:h-[92vh] sm:max-w-6xl sm:rounded-3xl sm:border sm:border-white/50 dark:sm:border-white/[0.08]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mask-editor-title"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-white/[0.08] sm:px-5">
          <div className="min-w-0">
            <h3 id="mask-editor-title" className="text-base font-semibold text-gray-800 dark:text-gray-100">编辑遮罩</h3>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              <span className="sm:hidden">单指涂抹，双指缩放/平移。</span>
              <span className="hidden sm:inline">橙色区域将被编辑；未涂抹区域保持白色保护。</span>
            </p>
          </div>
          <button
            onClick={close}
            className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 sm:gap-4 sm:p-4 lg:flex-row lg:p-5">
          <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-gray-200/70 bg-[radial-gradient(circle_at_20%_20%,rgba(249,115,22,0.12),transparent_26%),linear-gradient(135deg,rgba(15,23,42,0.06),rgba(255,255,255,0.72))] p-2 dark:border-white/[0.08] dark:bg-[radial-gradient(circle_at_20%_20%,rgba(249,115,22,0.16),transparent_28%),linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.28))] sm:rounded-3xl sm:p-3">
            {isLoading && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/50 text-sm text-gray-500 backdrop-blur-sm dark:bg-gray-900/50 dark:text-gray-300">
                正在载入图片...
              </div>
            )}
            <div className="absolute left-3 top-3 z-10 rounded-full bg-black/45 px-2.5 py-1 text-[11px] text-white backdrop-blur-sm lg:hidden">
              {viewTransform.scale.toFixed(1)}x · 双指缩放
            </div>
            <div
              ref={baseFrameRef}
              className="relative max-h-full max-w-full rounded-2xl bg-gray-950/5 shadow-[0_20px_60px_rgba(15,23,42,0.18)] ring-1 ring-black/10 touch-none dark:bg-black/30 dark:ring-white/10"
              style={{
                aspectRatio: size ? `${size.width} / ${size.height}` : '1 / 1',
                width: size ? 'min(100%, calc((100dvh - 10rem) * var(--mask-aspect)))' : 'min(100%, 520px)',
                maxHeight: '100%',
                ['--mask-aspect' as string]: size ? String(size.width / size.height) : '1',
              }}
            >
              <div
                className="absolute inset-0 will-change-transform"
                style={{
                  transform: `matrix(${viewTransform.scale}, 0, 0, ${viewTransform.scale}, ${viewTransform.x}, ${viewTransform.y})`,
                  transformOrigin: '0 0',
                }}
              >
                <canvas ref={imageCanvasRef} className="absolute inset-0 h-full w-full" />
                <canvas ref={previewCanvasRef} className="absolute inset-0 h-full w-full pointer-events-none" />
                <canvas
                  ref={maskCanvasRef}
                  className="absolute inset-0 h-full w-full touch-none select-none opacity-0"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={finishStroke}
                  onPointerCancel={finishStroke}
                  onLostPointerCapture={finishStroke}
                />
              </div>
            </div>
          </div>

          <aside className="hidden w-full rounded-3xl border border-gray-200/70 bg-white/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.03] lg:block lg:w-72">
            <div className="space-y-5">
              <section>
                <div className="mb-2 text-xs font-medium text-gray-400 dark:text-gray-500">工具</div>
                <div className="flex rounded-2xl bg-gray-100/80 p-1 dark:bg-black/20">
                  <button className={toolButtonClass(tool === 'brush')} onClick={() => setTool('brush')} disabled={!isReady || isSaving}>
                    画笔
                  </button>
                  <button className={toolButtonClass(tool === 'eraser')} onClick={() => setTool('eraser')} disabled={!isReady || isSaving}>
                    橡皮
                  </button>
                </div>
                <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                  画笔创建透明编辑区，橡皮恢复白色保护区。
                </p>
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between text-xs font-medium text-gray-400 dark:text-gray-500">
                  <span>笔刷大小</span>
                  <span className="font-mono text-gray-500 dark:text-gray-300">{brushSize}px</span>
                </div>
                <input
                  type="range"
                  min={8}
                  max={220}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-full accent-orange-500"
                  disabled={!isReady || isSaving}
                />
              </section>

              <section>
                <div className="mb-2 text-xs font-medium text-gray-400 dark:text-gray-500">历史</div>
                <div className="grid grid-cols-3 gap-2">
                  <button onClick={handleUndo} disabled={!canUndo} className={actionButtonClass}>
                    撤销
                  </button>
                  <button onClick={handleRedo} disabled={!canRedo} className={actionButtonClass}>
                    重做
                  </button>
                  <button onClick={handleClear} disabled={!isReady || isSaving} className={actionButtonClass}>
                    清空
                  </button>
                </div>
              </section>

              <section>
                <div className="mb-2 text-xs font-medium text-gray-400 dark:text-gray-500">视图</div>
                <button onClick={resetViewTransform} disabled={!isReady || isSaving || !isZoomed} className={actionButtonClass}>
                  重置视图 · {viewTransform.scale.toFixed(1)}x
                </button>
                <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                  移动端可双指缩放/平移，单指继续绘制遮罩。
                </p>
              </section>

              <section className="rounded-2xl bg-orange-50/80 p-3 text-xs leading-relaxed text-orange-700 dark:bg-orange-500/10 dark:text-orange-200">
                保存后会把当前图片加入参考图，并在提交时作为遮罩主图使用。
              </section>
            </div>
          </aside>
        </div>

        <div className="shrink-0 border-t border-gray-100 px-3 py-2 dark:border-white/[0.08] sm:px-5 sm:py-3">
          <div className="lg:hidden">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              <button className={`${compactButtonClass(tool === 'brush')} shrink-0`} onClick={() => setTool('brush')} disabled={!isReady || isSaving} aria-pressed={tool === 'brush'}>
                画笔
              </button>
              <button className={`${compactButtonClass(tool === 'eraser')} shrink-0`} onClick={() => setTool('eraser')} disabled={!isReady || isSaving} aria-pressed={tool === 'eraser'}>
                橡皮
              </button>
              <button className={`${compactButtonClass(showBrushControls)} shrink-0`} onClick={() => setShowBrushControls((v) => !v)} disabled={!isReady || isSaving}>
                {brushSize}px
              </button>
              <button onClick={handleUndo} disabled={!canUndo} className={`${compactButtonClass()} shrink-0`}>
                撤销
              </button>
              <button onClick={handleRedo} disabled={!canRedo} className={`${compactButtonClass()} shrink-0`}>
                重做
              </button>
              <button onClick={handleClear} disabled={!isReady || isSaving} className={`${compactButtonClass()} shrink-0`}>
                清空
              </button>
              <button onClick={resetViewTransform} disabled={!isReady || isSaving || !isZoomed} className={`${compactButtonClass()} shrink-0`}>
                重置
              </button>
            </div>
            {showBrushControls && (
              <div className="mt-2 rounded-2xl border border-gray-200/70 bg-white/75 px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]">
                <div className="mb-1 flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
                  <span>笔刷大小</span>
                  <span className="font-mono text-gray-600 dark:text-gray-300">{brushSize}px</span>
                </div>
                <input
                  type="range"
                  min={8}
                  max={220}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-full accent-orange-500"
                  disabled={!isReady || isSaving}
                />
              </div>
            )}
          </div>

          <div className="mt-2 grid grid-cols-[1fr_1.5fr] gap-2 sm:flex sm:flex-row sm:justify-end lg:mt-0">
            <button
              onClick={close}
              disabled={isSaving}
              className="rounded-xl border border-gray-200/70 bg-white/70 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={!isReady || isSaving}
              className="rounded-xl bg-orange-500 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-orange-500/20 transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:shadow-none dark:disabled:bg-white/[0.08]"
            >
              {isSaving ? '保存中...' : '保存遮罩'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
