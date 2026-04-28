import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { createPortal } from 'react-dom'
import { ensureImageCached, useStore } from '../store'
import { canvasToBlob, loadImage } from '../lib/canvasImage'
import { storeImage } from '../lib/db'
import { prepareMaskTargetDataUrl, replaceMaskTargetImage } from '../lib/maskPreprocess'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
const ReferenceImageEditorModal = lazy(() => import('./ReferenceImageEditorModal'))
import {
  clampViewTransform,
  clientPointToCanvasPoint,
  getComfortableInitialTransform,
  getPinchTransform,
  zoomAtPoint,
  type Point,
  type ViewTransform,
} from '../lib/viewportTransform'

type Tool = 'brush' | 'eraser'

interface CanvasSize {
  width: number
  height: number
}

interface SliderAnchor {
  left: number
  bottom: number
}

interface PinchGesture {
  startTransform: ViewTransform
  startCentroid: Point
  startDistance: number
}

interface PanGesture {
  pointerId: number
  startPoint: Point
  startTransform: ViewTransform
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

function drawMaskImageToCanvas(maskImage: HTMLImageElement, maskCanvas: HTMLCanvasElement) {
  const maskAspect = maskImage.naturalWidth / maskImage.naturalHeight
  const canvasAspect = maskCanvas.width / maskCanvas.height
  if (Math.abs(maskAspect - canvasAspect) > 0.001) {
    throw new Error('遮罩尺寸与当前图片不一致')
  }

  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (!maskCtx) throw new Error('当前浏览器不支持 Canvas')
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
  maskCtx.imageSmoothingEnabled = true
  maskCtx.imageSmoothingQuality = 'high'
  maskCtx.drawImage(maskImage, 0, 0, maskCanvas.width, maskCanvas.height)
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
  const clearMaskDraft = useStore((s) => s.clearMaskDraft)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)

  const imageCanvasRef = useRef<HTMLCanvasElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement>(null)
  const cursorCanvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const baseFrameRef = useRef<HTMLDivElement>(null)
  const brushSizeControlRef = useRef<HTMLDivElement>(null)
  const brushSizeButtonRef = useRef<HTMLButtonElement>(null)
  const brushSizePanelRef = useRef<HTMLDivElement>(null)
  const maskInfoTimerRef = useRef<number | null>(null)
  const activePointerIdRef = useRef<number | null>(null)
  const lastPointRef = useRef<Point | null>(null)
  const pointerPositionsRef = useRef<Map<number, Point>>(new Map())
  const pinchGestureRef = useRef<PinchGesture | null>(null)
  const panGestureRef = useRef<PanGesture | null>(null)
  const undoStackRef = useRef<ImageData[]>([])
  const redoStackRef = useRef<ImageData[]>([])
  const previewFrameRef = useRef<number | null>(null)
  const saveTokenRef = useRef(0)
  const sessionIdRef = useRef(0)
  const activeSessionIdRef = useRef(0)
  const viewTransformRef = useRef<ViewTransform>(DEFAULT_VIEW_TRANSFORM)

  const [sourceDataUrl, setSourceDataUrl] = useState('')
  const [size, setSize] = useState<CanvasSize | null>(null)
  const [tool, setTool] = useState<Tool>('brush')
  const [brushSize, setBrushSize] = useState(64)
  const [showBrushControls, setShowBrushControls] = useState(false)
  const [viewTransform, setViewTransform] = useState<ViewTransform>(DEFAULT_VIEW_TRANSFORM)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 })
  const [hoverPoint, setHoverPoint] = useState<Point | null>(null)
  const [isPointerOverCanvas, setIsPointerOverCanvas] = useState(false)
  const [isAltKeyPressed, setIsAltKeyPressed] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [sliderAnchor, setSliderAnchor] = useState<SliderAnchor | null>(null)
  const [showMaskInfo, setShowMaskInfo] = useState(false)
  const [referenceEditorSession, setReferenceEditorSession] = useState<{
    imageId: string
    src: string
  } | null>(null)

  const close = () => {
    if (isSaving) return
    setMaskEditorImageId(null)
  }
  useCloseOnEscape(Boolean(imageId), close)

  const handleReferenceEditorSaved = (nextImageId: string) => {
    setReferenceEditorSession(null)
    setMaskEditorImageId(nextImageId)
  }

  useEffect(() => () => {
    if (maskInfoTimerRef.current != null) {
      window.clearTimeout(maskInfoTimerRef.current)
    }
  }, [])

  const showMaskInfoPopover = () => setShowMaskInfo(true)

  const hideMaskInfoPopover = () => {
    setShowMaskInfo(false)
    clearMaskInfoTimer()
  }

  const clearMaskInfoTimer = () => {
    if (maskInfoTimerRef.current != null) {
      window.clearTimeout(maskInfoTimerRef.current)
      maskInfoTimerRef.current = null
    }
  }

  const startMaskInfoTouch = () => {
    maskInfoTimerRef.current = window.setTimeout(() => {
      setShowMaskInfo(true)
      maskInfoTimerRef.current = null
    }, 450)
  }

  const handleRemoveMask = () => {
    setConfirmDialog({
      title: '移除遮罩',
      message: '确定要撤销对这张图片的所有涂抹并移除遮罩吗？',
      tone: 'danger',
      action: () => {
        clearMaskDraft()
        setMaskEditorImageId(null)
        showToast('已移除遮罩', 'success')
      },
    })
  }

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

  function renderPreviewNow() {
    const maskCanvas = maskCanvasRef.current
    const previewCanvas = previewCanvasRef.current
    if (!maskCanvas || !previewCanvas) return

    const previewCtx = previewCanvas.getContext('2d')
    if (!previewCtx) return

    previewFrameRef.current = null
    previewCtx.save()
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height)
    previewCtx.globalCompositeOperation = 'source-over'
    previewCtx.fillStyle = 'rgba(59, 130, 246, 0.58)'
    previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height)
    previewCtx.globalCompositeOperation = 'destination-out'
    previewCtx.drawImage(maskCanvas, 0, 0)
    previewCtx.restore()
  }

  function renderPreview() {
    if (previewFrameRef.current != null) return
    previewFrameRef.current = window.requestAnimationFrame(renderPreviewNow)
  }

  function updateCursor(point: Point | null) {
    const cursorCanvas = cursorCanvasRef.current
    const stage = stageRef.current
    const frame = baseFrameRef.current
    const maskCanvas = maskCanvasRef.current
    const ctx = cursorCanvas?.getContext('2d')
    if (!cursorCanvas || !ctx || !stage || !frame || !maskCanvas) return

    const dpr = window.devicePixelRatio || 1
    const width = stage.clientWidth
    const height = stage.clientHeight
    if (cursorCanvas.width !== Math.round(width * dpr) || cursorCanvas.height !== Math.round(height * dpr)) {
      cursorCanvas.width = Math.round(width * dpr)
      cursorCanvas.height = Math.round(height * dpr)
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    if (!point) return

    const scale = viewTransformRef.current.scale
    const stageRect = stage.getBoundingClientRect()
    const frameRect = frame.getBoundingClientRect()
    const frameLeft = frameRect.left - stageRect.left
    const frameTop = frameRect.top - stageRect.top
    const x = frameLeft + (point.x / maskCanvas.width) * frame.clientWidth * scale + viewTransformRef.current.x
    const y = frameTop + (point.y / maskCanvas.height) * frame.clientHeight * scale + viewTransformRef.current.y
    const radius = (brushSize / 2 / maskCanvas.width) * frame.clientWidth * scale

    ctx.save()
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.stroke()
    
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)'
    ctx.beginPath()
    ctx.arc(x, y, radius + 1, 0, Math.PI * 2)
    ctx.stroke()
    
    ctx.beginPath()
    ctx.arc(x, y, Math.max(0, radius - 1), 0, Math.PI * 2)
    ctx.stroke()

    const crosshairSize = 5
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
    ctx.beginPath()
    ctx.moveTo(x - crosshairSize, y)
    ctx.lineTo(x + crosshairSize, y)
    ctx.moveTo(x, y - crosshairSize)
    ctx.lineTo(x, y + crosshairSize)
    ctx.stroke()

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.beginPath()
    ctx.moveTo(x - crosshairSize, y)
    ctx.lineTo(x + crosshairSize, y)
    ctx.moveTo(x, y - crosshairSize)
    ctx.lineTo(x, y + crosshairSize)
    ctx.stroke()
    ctx.restore()
  }

  function getViewportCenterCanvasPoint(): Point | null {
    const frame = baseFrameRef.current
    const maskCanvas = maskCanvasRef.current
    if (!frame || !maskCanvas) return null

    const transform = viewTransformRef.current
    return {
      x: ((frame.clientWidth / 2 - transform.x) / transform.scale / frame.clientWidth) * maskCanvas.width,
      y: ((frame.clientHeight / 2 - transform.y) / transform.scale / frame.clientHeight) * maskCanvas.height,
    }
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
    if (imageId) {
      setReferenceEditorSession(null)
    }
  }, [imageId])

  useEffect(() => {
    if (!imageId) {
      if (previewFrameRef.current != null) {
        window.cancelAnimationFrame(previewFrameRef.current)
        previewFrameRef.current = null
      }
      setSourceDataUrl('')
      setSize(null)
      setIsLoading(false)
      pointerPositionsRef.current.clear()
      pinchGestureRef.current = null
      panGestureRef.current = null
      setIsPanning(false)
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
            drawMaskImageToCanvas(draftImage, maskCanvas)
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
            `已为遮罩编辑按官方要求调整图片尺寸：\n${preparedTarget.originalWidth}×${preparedTarget.originalHeight} → ${preparedTarget.width}×${preparedTarget.height}`,
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
      if (previewFrameRef.current != null) {
        window.cancelAnimationFrame(previewFrameRef.current)
        previewFrameRef.current = null
      }
      activePointerIdRef.current = null
      lastPointRef.current = null
      pointerPositionsRef.current.clear()
      pinchGestureRef.current = null
      panGestureRef.current = null
      setIsPanning(false)
    }
  }, [imageId, maskDraft, setMaskEditorImageId, showToast])

  useEffect(() => {
    if (isAltKeyPressed) {
      updateCursor(null)
    } else if (showBrushControls && !isPointerOverCanvas && size) {
      updateCursor(getViewportCenterCanvasPoint())
    } else {
      updateCursor(hoverPoint)
    }
  }, [brushSize, viewTransform, hoverPoint, isPointerOverCanvas, showBrushControls, size, isAltKeyPressed])

  useEffect(() => {
    if (!imageId) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey) setIsAltKeyPressed(true)
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Alt') setIsAltKeyPressed(false)
    }
    const handleBlur = () => setIsAltKeyPressed(false)

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [imageId])

  useEffect(() => {
    if (!showBrushControls) return

    const closeBrushControls = (event: PointerEvent) => {
      const control = brushSizeControlRef.current
      const panel = brushSizePanelRef.current
      if (control?.contains(event.target as Node)) return
      if (panel?.contains(event.target as Node)) return
      setShowBrushControls(false)
      setSliderAnchor(null)
    }

    document.addEventListener('pointerdown', closeBrushControls, true)
    return () => document.removeEventListener('pointerdown', closeBrushControls, true)
  }, [showBrushControls])

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
    setShowBrushControls(false)
    setSliderAnchor(null)
    const canvas = event.currentTarget

    if (event.altKey) {
      if (!canvas.hasPointerCapture(event.pointerId)) {
        canvas.setPointerCapture(event.pointerId)
      }
      panGestureRef.current = {
        pointerId: event.pointerId,
        startPoint: { x: event.clientX, y: event.clientY },
        startTransform: viewTransformRef.current,
      }
      setIsPanning(true)
      updateCursor(null)
      return
    }

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
    const point = getCanvasPoint(event.currentTarget, event)
    if (event.pointerType !== 'touch') {
      setIsPointerOverCanvas(true)
      setHoverPoint(point)
      updateCursor(event.altKey || isAltKeyPressed ? null : point)
    }

    const panGesture = panGestureRef.current
    if (panGesture?.pointerId === event.pointerId) {
      const frame = baseFrameRef.current
      if (!frame) return

      event.preventDefault()
      commitViewTransform({
        scale: panGesture.startTransform.scale,
        x: panGesture.startTransform.x + event.clientX - panGesture.startPoint.x,
        y: panGesture.startTransform.y + event.clientY - panGesture.startPoint.y,
      })
      return
    }

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
    drawStroke(lastPointRef.current, point)
    lastPointRef.current = point
  }

  const handlePointerLeave = () => {
    setIsPointerOverCanvas(false)
    setHoverPoint(null)
    updateCursor(null)
  }

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.altKey || !isReady || isSaving) return

    const frame = baseFrameRef.current
    if (!frame) return

    event.preventDefault()
    const rect = frame.getBoundingClientRect()
    const point = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    }
    const scaleFactor = Math.exp(-event.deltaY * 0.002)
    commitViewTransform(zoomAtPoint(
      viewTransformRef.current,
      point,
      viewTransformRef.current.scale * scaleFactor,
      { width: frame.clientWidth, height: frame.clientHeight },
    ))
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

    if (panGestureRef.current?.pointerId === event.pointerId) {
      panGestureRef.current = null
      setIsPanning(false)
    }

    if (activePointerIdRef.current === event.pointerId) {
      activePointerIdRef.current = null
      lastPointRef.current = null
      if (hoverPoint) updateCursor(hoverPoint)
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

  const toggleBrushControls = () => {
    const rect = brushSizeButtonRef.current?.getBoundingClientRect()
    if (!rect) return

    setIsPointerOverCanvas(false)
    setHoverPoint(null)
    if (size) updateCursor(getViewportCenterCanvasPoint())

    setSliderAnchor({
      left: rect.left + rect.width / 2,
      bottom: window.innerHeight - rect.top + 8,
    })
    setShowBrushControls((value) => !value)
  }

  const handleOpenReferenceEditor = () => {
    if (!imageId || !sourceDataUrl || isLoading || isSaving) return
    setReferenceEditorSession({
      imageId,
      src: sourceDataUrl,
    })
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[80] flex flex-col bg-gray-50 dark:bg-gray-900 animate-modal-in"
        aria-hidden={referenceEditorSession ? 'true' : undefined}
      >
      {/* Header */}
      <div className="flex-none flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950 z-20">
        <div className="flex items-center gap-3">
          <button onClick={close} disabled={isSaving} className="p-2 -ml-2 text-gray-500 hover:bg-gray-100 rounded-lg dark:text-gray-400 dark:hover:bg-gray-800 transition" title="取消">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
          <div className="relative flex items-center gap-1.5">
            <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200" id="mask-editor-title">编辑遮罩</h2>
            <button
              type="button"
              onClick={showMaskInfoPopover}
              onMouseEnter={showMaskInfoPopover}
              onMouseLeave={hideMaskInfoPopover}
              onTouchStart={startMaskInfoTouch}
              onTouchEnd={clearMaskInfoTimer}
              onTouchCancel={hideMaskInfoPopover}
              className="flex h-6 w-6 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              aria-label="遮罩编辑说明"
              title="遮罩编辑说明"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
            {showMaskInfo && (
              <div className="absolute left-0 top-full mt-2 w-64 rounded-xl border border-gray-200/80 bg-white px-3 py-2 text-xs leading-5 text-gray-600 shadow-lg dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300">
                <div className="absolute -top-1.5 left-16 h-3 w-3 rotate-45 border-l border-t border-gray-200/80 bg-white dark:border-white/[0.08] dark:bg-gray-900" />
                根据官方文档说明，此功能仅基于提示词，无法完全控制模型编辑区域
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {maskDraft?.targetImageId === imageId && (
            <button onClick={handleRemoveMask} className="flex h-8 items-center gap-1.5 px-4 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-lg transition">
              移除遮罩
            </button>
          )}
          <button onClick={handleSave} disabled={!isReady || isSaving} className="flex h-8 items-center gap-1.5 px-4 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 rounded-lg disabled:opacity-50 transition">
            {isSaving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>

      {/* Workspace */}
      <div ref={stageRef} className="flex-1 relative flex items-center justify-center overflow-hidden bg-gray-100/50 dark:bg-black/50 p-0 pb-[76px] sm:p-6 sm:pb-[100px]" style={{ containerType: 'size' }}>
        {isLoading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/50 text-sm text-gray-500 backdrop-blur-sm dark:bg-gray-900/50 dark:text-gray-300">
            正在载入图片...
          </div>
        )}
        <div
          ref={baseFrameRef}
          className="relative max-h-full max-w-full sm:rounded-xl shadow-inner sm:ring-1 ring-black/5 touch-none dark:bg-black/50 dark:ring-white/5"
          onWheel={handleWheel}
          style={{
            aspectRatio: size ? `${size.width} / ${size.height}` : '1 / 1',
            width: size ? `min(100%, 100cqh * ${size.width / size.height})` : '520px',
            maxHeight: '100%',
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
                style={{ cursor: isPanning ? 'grabbing' : isAltKeyPressed ? 'grab' : hoverPoint ? 'none' : 'crosshair' }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishStroke}
                onPointerCancel={finishStroke}
                onLostPointerCapture={finishStroke}
                onPointerLeave={handlePointerLeave}
              />
            </div>
          </div>
          <canvas ref={cursorCanvasRef} className="absolute inset-0 h-full w-full pointer-events-none" />
        </div>

        {/* Footer Toolbar */}
        <div className="absolute bottom-4 sm:bottom-8 left-1/2 -translate-x-1/2 flex items-center justify-center z-20 pointer-events-none w-full px-2 sm:px-4">
          <div className="flex items-center gap-2 sm:gap-4 px-2 sm:px-3 py-1.5 sm:py-2 bg-white/95 dark:bg-[#0f0f0f]/95 backdrop-blur-md border border-gray-200/80 dark:border-white/5 rounded-2xl sm:rounded-[1.25rem] shadow-2xl pointer-events-auto">
            <div className="flex items-center gap-1.5 sm:gap-3">
              <div className="flex items-center bg-gray-100/80 dark:bg-[#232325]/80 p-1 rounded-xl sm:rounded-[14px]">
                <button
                  className={`p-2 sm:p-2.5 rounded-lg sm:rounded-xl transition-all ${tool === 'brush' ? 'bg-white shadow-sm text-blue-500 dark:bg-[#323338] dark:text-blue-400 dark:shadow-none' : 'text-gray-500 hover:text-gray-700 dark:text-[#8a8a8e] dark:hover:text-gray-200'}`}
                  onClick={() => setTool('brush')}
                  disabled={!isReady || isSaving}
                  title="画笔"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
                <button
                  className={`p-2 sm:p-2.5 rounded-lg sm:rounded-xl transition-all ${tool === 'eraser' ? 'bg-white shadow-sm text-blue-500 dark:bg-[#323338] dark:text-blue-400 dark:shadow-none' : 'text-gray-500 hover:text-gray-700 dark:text-[#8a8a8e] dark:hover:text-gray-200'}`}
                  onClick={() => setTool('eraser')}
                  disabled={!isReady || isSaving}
                  title="橡皮"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <g transform="translate(0, 1) rotate(-45 12 12)">
                      <path fill="currentColor" d="M4 10a2 2 0 0 1 2-2h7v8H6a2 2 0 0 1-2-2z" />
                      <rect x="4" y="8" width="16" height="8" rx="2" />
                    </g>
                    <path d="M8 21h12" />
                  </svg>
                </button>
              </div>
              
              <div ref={brushSizeControlRef} className="relative flex items-center justify-center">
                <button
                  ref={brushSizeButtonRef}
                  onClick={toggleBrushControls}
                  className={`flex items-center justify-center w-10 h-10 sm:w-[46px] sm:h-[46px] rounded-xl sm:rounded-[14px] transition-all border ${showBrushControls ? 'bg-blue-50 border-blue-200 text-blue-600 dark:bg-[#323338] dark:border-gray-600 dark:text-blue-400' : 'bg-white border-gray-200/80 text-gray-700 hover:bg-gray-50 dark:bg-transparent dark:border-[#323338] dark:text-[#e0e0e0] dark:hover:border-gray-500'}`}
                  disabled={!isReady || isSaving}
                  title="调节笔刷大小"
                >
                  <span className="text-[14px] sm:text-[15px] font-semibold tracking-tight">{brushSize}</span>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-0.5 sm:gap-2 sm:ml-1">
              <button onClick={handleUndo} disabled={!canUndo} className="p-2 sm:p-2.5 text-gray-500 hover:bg-gray-100 rounded-lg sm:rounded-xl disabled:opacity-30 dark:text-[#8a8a8e] dark:hover:bg-white/10 dark:hover:text-gray-200 transition-all" title="撤销">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7v6h6" />
                  <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
                </svg>
              </button>
              <button onClick={handleRedo} disabled={!canRedo} className="p-2 sm:p-2.5 text-gray-500 hover:bg-gray-100 rounded-lg sm:rounded-xl disabled:opacity-30 dark:text-[#8a8a8e] dark:hover:bg-white/10 dark:hover:text-gray-200 transition-all" title="重做">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 7v6h-6" />
                  <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />
                </svg>
              </button>
              <div className="w-px h-4 sm:h-5 bg-gray-300 dark:bg-[#323338] mx-1"></div>
              <button onClick={resetViewTransform} disabled={!isReady || isSaving || !isZoomed} className="p-2 sm:p-2.5 text-gray-500 hover:bg-gray-100 rounded-lg sm:rounded-xl disabled:opacity-30 dark:text-[#8a8a8e] dark:hover:bg-white/10 dark:hover:text-gray-200 transition-all" title="重置视图">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 14h6v6"/>
                  <path d="M20 10h-6V4"/>
                  <path d="M14 10l7-7"/>
                  <path d="M3 21l7-7"/>
                </svg>
              </button>
              <button onClick={handleClear} disabled={!isReady || isSaving} className="p-2 sm:p-2.5 text-gray-500 hover:bg-gray-100 rounded-lg sm:rounded-xl disabled:opacity-30 dark:text-[#8a8a8e] dark:hover:bg-white/10 dark:hover:text-gray-200 transition-all" title="清空遮罩">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18"/>
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                </svg>
              </button>
              <div className="w-px h-4 sm:h-5 bg-gray-300 dark:bg-[#323338] mx-1"></div>
              <button
                onClick={handleOpenReferenceEditor}
                disabled={!isReady || isSaving}
                className="flex items-center gap-1.5 rounded-lg sm:rounded-xl bg-blue-50 px-3 py-2 text-xs font-medium text-blue-600 transition hover:bg-blue-100 disabled:opacity-30 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/20"
                title="切换到高级编辑"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
                高级编辑
              </button>
            </div>
          </div>
        </div>
      </div>
      {showBrushControls && sliderAnchor && createPortal(
        <div
          ref={brushSizePanelRef}
          className="fixed z-[100] h-44 w-14 -translate-x-1/2 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700"
          style={{ left: sliderAnchor.left, bottom: sliderAnchor.bottom }}
        >
          <input
            type="range"
            min={8}
            max={220}
            value={brushSize}
            onChange={(e) => {
              const nextSize = Number(e.target.value)
              setBrushSize(nextSize)
              if (!isPointerOverCanvas && size) updateCursor(getViewportCenterCanvasPoint())
            }}
            className="absolute left-1/2 top-1/2 h-5 w-32 -translate-x-1/2 -translate-y-1/2 -rotate-90 accent-blue-500 cursor-ns-resize"
            disabled={!isReady || isSaving}
          />
        </div>,
        document.body,
      )}
      {referenceEditorSession
        ? createPortal(
            <div className="fixed inset-0 z-[120]">
              <Suspense
                fallback={
                  <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-md text-sm text-white/70">
                    正在加载高级编辑器...
                  </div>
                }
              >
                <ReferenceImageEditorModal
                  imageId={referenceEditorSession.imageId}
                  src={referenceEditorSession.src}
                  saveMode="replace-input"
                  onSaved={handleReferenceEditorSaved}
                  onClose={() => setReferenceEditorSession(null)}
                />
              </Suspense>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
