import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, Ellipse, FabricImage, IText, PencilBrush, Rect, Triangle, type FabricObject } from 'fabric'
import { addInputImageWithDataUrl, replaceInputImageWithDataUrl, useStore } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

interface ReferenceImageEditorModalProps {
  imageId: string
  src: string
  saveMode: 'replace-input' | 'append-input'
  onClose: () => void
  onSaved?: (nextImageId: string, nextDataUrl: string) => void
}

type ToolMode = 'select' | 'mask-brush'
type MaskShapeType = 'rect' | 'ellipse' | 'triangle'

interface TextStyleState {
  text: string
  fill: string
  fontSize: number
  fontWeight: 'normal' | 'bold'
  fontStyle: 'normal' | 'italic'
}

type BaseImageData = {
  editorKind: 'base-image'
  flipX: boolean
  flipY: boolean
}

const DEFAULT_TEXT_STYLE: TextStyleState = {
  text: '输入文字',
  fill: '#ffffff',
  fontSize: 48,
  fontWeight: 'bold',
  fontStyle: 'normal',
}

const DEFAULT_MASK_HUE = 0

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function buildMaskColor(hue: number, alpha: number) {
  return `hsla(${Math.round(hue)}, 85%, 48%, ${clamp(alpha, 0.05, 1)})`
}

function getEditorKind(object: FabricObject | null): string | undefined {
  if (!object || typeof object !== 'object') return undefined
  return (object as FabricObject & { data?: { editorKind?: string } }).data?.editorKind
}

function getBaseImageData(object: FabricObject | null): BaseImageData | undefined {
  if (getEditorKind(object) !== 'base-image') return undefined
  return (object as FabricObject & { data?: BaseImageData }).data
}

function getMaskShapeTypeFromObject(object: FabricObject | null): MaskShapeType | undefined {
  if (!object || typeof object !== 'object') return undefined
  return (object as FabricObject & { data?: { shapeType?: MaskShapeType } }).data?.shapeType
}

function useIsMobileDevice() {
  const getIsMobileDevice = () => {
    const ua = navigator.userAgent || ''
    const platform = navigator.platform || ''
    const isIpadOS = platform === 'MacIntel' && navigator.maxTouchPoints > 1
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(ua) || isIpadOS
  }
  const [isMobileDevice, setIsMobileDevice] = useState(getIsMobileDevice)
  useEffect(() => {
    const update = () => setIsMobileDevice(getIsMobileDevice())
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])
  return isMobileDevice
}

export default function ReferenceImageEditorModal({ imageId, src, saveMode, onClose, onSaved }: ReferenceImageEditorModalProps) {
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const inputImages = useStore((s) => s.inputImages)
  const lightboxImageList = useStore((s) => s.lightboxImageList)
  const showToast = useStore((s) => s.showToast)
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null)
  const canvasElementRef = useRef<HTMLCanvasElement>(null)
  const canvasViewportRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<Canvas | null>(null)
  const sourceImageRef = useRef<HTMLImageElement | null>(null)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const suppressHistoryRef = useRef(false)
  const displaySizeRef = useRef({ width: 0, height: 0 })
  const sourceSizeRef = useRef({ width: 0, height: 0 })
  const imageBoundsRef = useRef({ left: 0, top: 0, width: 0, height: 0 })
  const exportMultiplierRef = useRef(1)
  const baseFlipRef = useRef({ x: false, y: false })
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const panningRef = useRef(false)
  const touchGestureRef = useRef({
    active: false,
    distance: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    centerX: 0,
    centerY: 0,
  })
  const lastPointerRef = useRef({ x: 0, y: 0 })
  const spacePressedRef = useRef(false)
  const toolModeRef = useRef<ToolMode>('select')
  const [ready, setReady] = useState(false)
  const [toolMode, setToolMode] = useState<ToolMode>('select')
  const [maskOpacity, setMaskOpacity] = useState(0.55)
  const [maskWidth, setMaskWidth] = useState(34)
  const [maskHue, setMaskHue] = useState(DEFAULT_MASK_HUE)
  const [maskShapeType, setMaskShapeType] = useState<MaskShapeType>('rect')
  const [activeObject, setActiveObject] = useState<FabricObject | null>(null)
  const [textStyle, setTextStyle] = useState<TextStyleState>(DEFAULT_TEXT_STYLE)
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false })
  const currentImageList = useMemo(() => lightboxImageList.length ? lightboxImageList : inputImages.map((item) => item.id), [inputImages, lightboxImageList])
  const isOpen = true
  const isMobileDevice = useIsMobileDevice()

  useCloseOnEscape(isOpen, onClose)

  function redrawBackgroundNow() {
    const canvas = backgroundCanvasRef.current
    const image = sourceImageRef.current
    if (!canvas || !image) return

    const context = canvas.getContext('2d')
    if (!context) return

    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#11161d'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.setTransform(zoomRef.current, 0, 0, zoomRef.current, panRef.current.x, panRef.current.y)
    const bounds = imageBoundsRef.current
    if (baseFlipRef.current.x || baseFlipRef.current.y) {
      context.translate(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      context.scale(baseFlipRef.current.x ? -1 : 1, baseFlipRef.current.y ? -1 : 1)
      context.drawImage(image, -bounds.width / 2, -bounds.height / 2, bounds.width, bounds.height)
      return
    }
    context.drawImage(image, bounds.left, bounds.top, bounds.width, bounds.height)
  }

  useEffect(() => {
    toolModeRef.current = toolMode
  }, [toolMode])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.body.dataset.referenceEditorActive = '1'
    return () => {
      document.body.style.overflow = previousOverflow
      delete document.body.dataset.referenceEditorActive
    }
  }, [])

  const updateHistoryFlags = useCallback(() => {
    setHistoryState({
      canUndo: historyIndexRef.current > 0,
      canRedo: historyIndexRef.current < historyRef.current.length - 1,
    })
  }, [])

  const syncTextStyleFromObject = useCallback((object: FabricObject | null) => {
    if (!(object instanceof IText)) {
      setTextStyle((prev) => ({ ...prev }))
      return
    }

    setTextStyle({
      text: object.text ?? DEFAULT_TEXT_STYLE.text,
      fill: typeof object.fill === 'string' ? object.fill : DEFAULT_TEXT_STYLE.fill,
      fontSize: typeof object.fontSize === 'number' ? object.fontSize : DEFAULT_TEXT_STYLE.fontSize,
      fontWeight: object.fontWeight === 'bold' ? 'bold' : 'normal',
      fontStyle: object.fontStyle === 'italic' ? 'italic' : 'normal',
    })
  }, [])

  const pushHistory = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || suppressHistoryRef.current) return

    const serialized = JSON.stringify(
      (canvas as Canvas & { toJSON: (propertiesToInclude?: string[]) => unknown }).toJSON(['data']),
    )
    if (historyRef.current[historyIndexRef.current] === serialized) {
      updateHistoryFlags()
      return
    }

    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1)
    historyRef.current.push(serialized)
    historyIndexRef.current = historyRef.current.length - 1
    updateHistoryFlags()
  }, [updateHistoryFlags])

  const restoreHistory = useCallback(async (nextIndex: number) => {
    const canvas = canvasRef.current
    const snapshot = historyRef.current[nextIndex]
    if (!canvas || !snapshot) return

    suppressHistoryRef.current = true
    await canvas.loadFromJSON(JSON.parse(snapshot))
    canvas.renderAll()
    suppressHistoryRef.current = false
    historyIndexRef.current = nextIndex
    const currentActive = canvas.getActiveObject() ?? null
    const baseProxy = canvas.getObjects().find((object) => getEditorKind(object) === 'base-image') ?? null
    const baseData = getBaseImageData(baseProxy)
    baseFlipRef.current = { x: Boolean(baseData?.flipX), y: Boolean(baseData?.flipY) }
    redrawBackgroundNow()
    setActiveObject(currentActive)
    syncTextStyleFromObject(currentActive)
    updateHistoryFlags()
  }, [syncTextStyleFromObject, updateHistoryFlags])

  const refreshBrush = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const alpha = clamp(maskOpacity, 0.05, 1)
    const width = clamp(maskWidth, 4, 160)
    const brush = new PencilBrush(canvas)
    brush.color = buildMaskColor(maskHue, alpha)
    brush.width = width
    canvas.freeDrawingBrush = brush
    canvas.isDrawingMode = toolMode === 'mask-brush'
    canvas.defaultCursor = toolMode === 'mask-brush' ? 'crosshair' : 'default'
  }, [maskHue, maskOpacity, maskWidth, toolMode])

  const handleToolModeChange = useCallback((nextToolMode: ToolMode) => {
    const canvas = canvasRef.current
    if (canvas) {
      canvas.discardActiveObject()
      canvas.requestRenderAll()
    }
    setActiveObject(null)
    setToolMode(nextToolMode)
  }, [])

  const redrawBackground = useCallback(() => {
    redrawBackgroundNow()
   }, [])

  const resizeStageToViewport = useCallback((options?: { preserveViewport?: boolean; transformObjects?: boolean }) => {
    const viewport = canvasViewportRef.current
    const backgroundElement = backgroundCanvasRef.current
    const canvas = canvasRef.current
    const image = sourceImageRef.current
    if (!viewport || !backgroundElement || !canvas || !image) return

    const stageRect = viewport.getBoundingClientRect()
    const stageWidth = Math.max(320, Math.floor(stageRect.width))
    const stageHeight = Math.max(320, Math.floor(stageRect.height))
    const prevDisplaySize = displaySizeRef.current
    const prevBounds = imageBoundsRef.current

    if (
      prevDisplaySize.width === stageWidth &&
      prevDisplaySize.height === stageHeight &&
      backgroundElement.width === stageWidth &&
      backgroundElement.height === stageHeight
    ) {
      return
    }

    const imageScale = Math.min(
      stageWidth / Math.max(1, image.naturalWidth),
      stageHeight / Math.max(1, image.naturalHeight),
      1,
    )
    const imageDisplayWidth = Math.max(1, Math.round(image.naturalWidth * imageScale))
    const imageDisplayHeight = Math.max(1, Math.round(image.naturalHeight * imageScale))
    const imageLeft = Math.max(0, Math.round((stageWidth - imageDisplayWidth) / 2))
    const imageTop = Math.max(0, Math.round((stageHeight - imageDisplayHeight) / 2))
    const nextBounds = {
      left: imageLeft,
      top: imageTop,
      width: imageDisplayWidth,
      height: imageDisplayHeight,
    }

    if (options?.transformObjects && prevBounds.width > 0 && prevBounds.height > 0) {
      const scaleX = nextBounds.width / prevBounds.width
      const scaleY = nextBounds.height / prevBounds.height
      canvas.getObjects().forEach((object) => {
        const left = typeof object.left === 'number' ? object.left : 0
        const top = typeof object.top === 'number' ? object.top : 0
        object.set({
          left: nextBounds.left + (left - prevBounds.left) * scaleX,
          top: nextBounds.top + (top - prevBounds.top) * scaleY,
          scaleX: (object.scaleX ?? 1) * scaleX,
          scaleY: (object.scaleY ?? 1) * scaleY,
        })
        object.setCoords()
      })
      const current = canvas.getActiveObject() ?? null
      setActiveObject(current)
      syncTextStyleFromObject(current)
    }

    displaySizeRef.current = { width: stageWidth, height: stageHeight }
    imageBoundsRef.current = nextBounds
    exportMultiplierRef.current = Math.max(1, image.naturalWidth / Math.max(1, imageDisplayWidth))

    backgroundElement.width = stageWidth
    backgroundElement.height = stageHeight
    canvas.setDimensions({ width: stageWidth, height: stageHeight })
    canvas.calcOffset()

    if (!options?.preserveViewport) {
      zoomRef.current = 1
      panRef.current = { x: 0, y: 0 }
    }
    canvas.setViewportTransform([zoomRef.current, 0, 0, zoomRef.current, panRef.current.x, panRef.current.y])
    canvas.requestRenderAll()
    redrawBackground()
  }, [redrawBackground, syncTextStyleFromObject])

  const syncViewportTransform = useCallback(() => {
    const canvas = canvasRef.current
    if (canvas) {
      canvas.setViewportTransform([zoomRef.current, 0, 0, zoomRef.current, panRef.current.x, panRef.current.y])
      canvas.requestRenderAll()
    }
    redrawBackground()
  }, [redrawBackground])

  const createBaseImageProxy = useCallback(() => {
    const bounds = imageBoundsRef.current
    const proxy = new Rect({
      left: bounds.left + bounds.width / 2,
      top: bounds.top + bounds.height / 2,
      width: bounds.width,
      height: bounds.height,
      originX: 'center',
      originY: 'center',
      fill: 'rgba(59, 130, 246, 0.001)',
      stroke: 'rgba(59, 130, 246, 0)',
      strokeWidth: 0,
      selectable: false,
      evented: false,
      hasControls: false,
      lockMovementX: true,
      lockMovementY: true,
      lockRotation: true,
      lockScalingX: true,
      lockScalingY: true,
      hoverCursor: 'pointer',
    })
    ;(proxy as FabricObject & { data?: BaseImageData }).data = {
      editorKind: 'base-image',
      flipX: baseFlipRef.current.x,
      flipY: baseFlipRef.current.y,
    }
    return proxy
  }, [])

  const syncBaseProxyData = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const proxy = canvas.getObjects().find((object) => getEditorKind(object) === 'base-image') as FabricObject | undefined
    if (!proxy) return
    ;(proxy as FabricObject & { data?: BaseImageData }).data = {
      editorKind: 'base-image',
      flipX: baseFlipRef.current.x,
      flipY: baseFlipRef.current.y,
    }
  }, [])

  const addImageLayer = useCallback(async (dataUrl: string) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const htmlImage = await loadHtmlImage(dataUrl)
    const image = new FabricImage(htmlImage, {
      width: htmlImage.naturalWidth,
      height: htmlImage.naturalHeight,
      left: canvas.getWidth() / 2,
      top: canvas.getHeight() / 2,
      originX: 'center',
      originY: 'center',
      cornerStyle: 'circle',
      transparentCorners: false,
      borderColor: '#3b82f6',
      cornerColor: '#ffffff',
      cornerStrokeColor: '#3b82f6',
    })

    const width = displaySizeRef.current.width || canvas.getWidth()
    const height = displaySizeRef.current.height || canvas.getHeight()
    const fitScale = Math.min(
      1,
      (width * 0.55) / Math.max(1, htmlImage.naturalWidth),
      (height * 0.55) / Math.max(1, htmlImage.naturalHeight),
    )
    image.scale(Math.max(0.08, fitScale))
    image.setControlsVisibility({ mtr: true })
    canvas.add(image)
    canvas.setActiveObject(image)
    canvas.renderAll()
    pushHistory()
  }, [pushHistory])

  useEffect(() => {
    let disposed = false

    const mountCanvas = async () => {
      const element = canvasElementRef.current
      const backgroundElement = backgroundCanvasRef.current
      const viewport = canvasViewportRef.current
      if (!element || !backgroundElement || !viewport) return

      const htmlImage = await loadHtmlImage(src)
      if (disposed) return
      sourceImageRef.current = htmlImage

      const stageRect = viewport.getBoundingClientRect()
      const stageWidth = Math.max(320, Math.floor(stageRect.width))
      const stageHeight = Math.max(320, Math.floor(stageRect.height))
      const imageScale = Math.min(
        stageWidth / Math.max(1, htmlImage.naturalWidth),
        stageHeight / Math.max(1, htmlImage.naturalHeight),
        1,
      )
      const imageDisplayWidth = Math.max(1, Math.round(htmlImage.naturalWidth * imageScale))
      const imageDisplayHeight = Math.max(1, Math.round(htmlImage.naturalHeight * imageScale))
      const imageLeft = Math.max(0, Math.round((stageWidth - imageDisplayWidth) / 2))
      const imageTop = Math.max(0, Math.round((stageHeight - imageDisplayHeight) / 2))

      displaySizeRef.current = { width: stageWidth, height: stageHeight }
      sourceSizeRef.current = {
        width: htmlImage.naturalWidth,
        height: htmlImage.naturalHeight,
      }
      imageBoundsRef.current = {
        left: imageLeft,
        top: imageTop,
        width: imageDisplayWidth,
        height: imageDisplayHeight,
      }
      exportMultiplierRef.current = Math.max(1, htmlImage.naturalWidth / Math.max(1, imageDisplayWidth))
      zoomRef.current = 1
      panRef.current = { x: 0, y: 0 }

      backgroundElement.width = stageWidth
      backgroundElement.height = stageHeight

      const canvas = new Canvas(element, {
        selection: true,
        preserveObjectStacking: true,
        enableRetinaScaling: false,
      })
      canvasRef.current = canvas

      canvas.setDimensions({
        width: stageWidth,
        height: stageHeight,
      })
      canvas.calcOffset()
      canvas.add(createBaseImageProxy())
      redrawBackground()

      canvas.on('mouse:wheel', (event) => {
        const wheelEvent = event.e as WheelEvent
        wheelEvent.preventDefault()
        wheelEvent.stopPropagation()
        const nextZoom = clamp(zoomRef.current * Math.pow(0.999, wheelEvent.deltaY), 0.35, 6)
        const factor = nextZoom / zoomRef.current
        panRef.current = {
          x: wheelEvent.offsetX - factor * (wheelEvent.offsetX - panRef.current.x),
          y: wheelEvent.offsetY - factor * (wheelEvent.offsetY - panRef.current.y),
        }
        zoomRef.current = nextZoom
        syncViewportTransform()
      })

      canvas.on('mouse:down', (event) => {
        const rawEvent = event.e as MouseEvent
        if (rawEvent.button === 1 || (spacePressedRef.current && toolModeRef.current === 'select')) {
          panningRef.current = true
          lastPointerRef.current = { x: rawEvent.clientX, y: rawEvent.clientY }
          canvas.selection = false
          canvas.defaultCursor = 'grab'
          return
        }

        if (toolModeRef.current === 'select' && !event.target) {
          const pointer = canvas.getScenePoint(event.e)
          const bounds = imageBoundsRef.current
          const isInsideBaseImage =
            pointer.x >= bounds.left &&
            pointer.x <= bounds.left + bounds.width &&
            pointer.y >= bounds.top &&
            pointer.y <= bounds.top + bounds.height
          if (isInsideBaseImage) {
            const baseProxy = canvas.getObjects().find((object) => getEditorKind(object) === 'base-image') ?? null
            canvas.discardActiveObject()
            canvas.requestRenderAll()
            setActiveObject(baseProxy)
          }
        }
      })

      canvas.on('mouse:move', (event) => {
        if (!panningRef.current) return
        const rawEvent = event.e as MouseEvent
        const deltaX = rawEvent.clientX - lastPointerRef.current.x
        const deltaY = rawEvent.clientY - lastPointerRef.current.y
        panRef.current = {
          x: panRef.current.x + deltaX,
          y: panRef.current.y + deltaY,
        }
        syncViewportTransform()
        lastPointerRef.current = { x: rawEvent.clientX, y: rawEvent.clientY }
      })

      canvas.on('mouse:up', () => {
        panningRef.current = false
        canvas.selection = toolModeRef.current === 'select'
        canvas.defaultCursor = toolModeRef.current === 'mask-brush' ? 'crosshair' : 'default'
      })

      const handleSelection = () => {
        const current = canvas.getActiveObject() ?? null
        setActiveObject(current)
        syncTextStyleFromObject(current)
        const selectedShapeType = getMaskShapeTypeFromObject(current)
      if (selectedShapeType) {
          setMaskShapeType(selectedShapeType)
        if (typeof current?.fill === 'string') {
          const match = current.fill.match(/hsla?\((\d+)/i)
          if (match) {
            setMaskHue(clamp(Number(match[1]) || DEFAULT_MASK_HUE, 0, 360))
          }
        }
      }
    }

      canvas.on('selection:created', handleSelection)
      canvas.on('selection:updated', handleSelection)
      canvas.on('selection:cleared', () => {
        setActiveObject(null)
      })

      const recordChange = () => pushHistory()
      canvas.on('object:added', recordChange)
      canvas.on('object:modified', recordChange)
      canvas.on('object:removed', recordChange)
      canvas.on('path:created', (event) => {
        const path = event.path
        if (path) {
          ;(path as FabricObject & { data?: { editorKind: string } }).data = { editorKind: 'mask-brush' }
        }
        pushHistory()
      })

      refreshBrush()
      suppressHistoryRef.current = true
      historyRef.current = []
      historyIndexRef.current = -1
      suppressHistoryRef.current = false
      pushHistory()
      setReady(true)
    }

    void mountCanvas()

    return () => {
      disposed = true
      setReady(false)
      canvasRef.current?.dispose()
      canvasRef.current = null
    }
  }, [createBaseImageProxy, pushHistory, redrawBackground, src, syncTextStyleFromObject, syncViewportTransform])

  useEffect(() => {
    const viewport = canvasViewportRef.current
    if (!viewport) return

    let frame = 0
    const resize = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        resizeStageToViewport({ transformObjects: true })
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(viewport)
    window.addEventListener('orientationchange', resize)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('orientationchange', resize)
    }
  }, [resizeStageToViewport])

  useEffect(() => {
    refreshBrush()
  }, [refreshBrush])

  useEffect(() => {
    const viewport = canvasViewportRef.current
    if (!viewport) return

    const getTouchMetrics = (event: TouchEvent) => {
      const [first, second] = [event.touches[0], event.touches[1]]
      const rect = viewport.getBoundingClientRect()
      return {
        distance: Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY),
        centerX: (first.clientX + second.clientX) / 2 - rect.left,
        centerY: (first.clientY + second.clientY) / 2 - rect.top,
      }
    }

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return
      event.preventDefault()
      const metrics = getTouchMetrics(event)
      touchGestureRef.current = {
        active: true,
        distance: metrics.distance,
        zoom: zoomRef.current,
        panX: panRef.current.x,
        panY: panRef.current.y,
        centerX: metrics.centerX,
        centerY: metrics.centerY,
      }
    }

    const onTouchMove = (event: TouchEvent) => {
      if (!touchGestureRef.current.active || event.touches.length !== 2) return
      event.preventDefault()
      const metrics = getTouchMetrics(event)
      const start = touchGestureRef.current
      const nextZoom = clamp(start.zoom * (metrics.distance / Math.max(1, start.distance)), 0.35, 6)
      const factor = nextZoom / Math.max(0.01, start.zoom)
      zoomRef.current = nextZoom
      panRef.current = {
        x: metrics.centerX - factor * (start.centerX - start.panX),
        y: metrics.centerY - factor * (start.centerY - start.panY),
      }
      syncViewportTransform()
    }

    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) {
        touchGestureRef.current.active = false
      }
    }

    viewport.addEventListener('touchstart', onTouchStart, { passive: false })
    viewport.addEventListener('touchmove', onTouchMove, { passive: false })
    viewport.addEventListener('touchend', onTouchEnd)
    viewport.addEventListener('touchcancel', onTouchEnd)
    return () => {
      viewport.removeEventListener('touchstart', onTouchStart)
      viewport.removeEventListener('touchmove', onTouchMove)
      viewport.removeEventListener('touchend', onTouchEnd)
      viewport.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [syncViewportTransform])

  useEffect(() => {
    const canvas = canvasRef.current
    const current = activeObject
    if (!canvas || !current || getEditorKind(current) !== 'mask-region') return
    current.set({
      fill: buildMaskColor(maskHue, maskOpacity),
    })
    current.setCoords()
    canvas.renderAll()
  }, [activeObject, maskHue, maskOpacity])

  const handleDeleteActiveObject = useCallback(() => {
    const canvas = canvasRef.current
    const current = canvas?.getActiveObject()
    if (!canvas || !current) return

    const selection = current as FabricObject & { getObjects?: () => FabricObject[] }
    if (typeof selection.getObjects === 'function') {
      selection.getObjects().forEach((object) => {
        if (getEditorKind(object) !== 'base-image') {
          canvas.remove(object)
        }
      })
    } else if (getEditorKind(current) === 'base-image') {
      return
    } else {
      canvas.remove(current)
    }
    canvas.discardActiveObject()
    canvas.renderAll()
    setActiveObject(null)
    pushHistory()
  }, [pushHistory])

  useEffect(() => {
    const onPaste = async (event: ClipboardEvent) => {
      const items = Array.from(event.clipboardData?.items ?? [])
      const imageItem = items.find((item) => item.type.startsWith('image/'))
      if (!imageItem) return
      const file = imageItem.getAsFile()
      if (!file) return
      event.preventDefault()
      await addImageLayer(await readFileAsDataUrl(file))
    }

    const onKeyDown = async (event: KeyboardEvent) => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && activeObject) {
        const target = event.target
        const isTextInput =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable)
        const current = canvasRef.current?.getActiveObject()
        if (isTextInput || (current instanceof IText && current.isEditing)) {
          return
        }
        handleDeleteActiveObject()
        return
      }

      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault()
        if (historyIndexRef.current > 0) {
          await restoreHistory(historyIndexRef.current - 1)
        }
      }

      if (mod && (event.key.toLowerCase() === 'y' || (event.shiftKey && event.key.toLowerCase() === 'z'))) {
        event.preventDefault()
        if (historyIndexRef.current < historyRef.current.length - 1) {
          await restoreHistory(historyIndexRef.current + 1)
        }
      }
    }

    const onKeyPressState = (event: KeyboardEvent, pressed: boolean) => {
      if (event.code === 'Space') {
        spacePressedRef.current = pressed
        if (pressed) {
          event.preventDefault()
        }
      }
    }

    const onKeyDownState = (event: KeyboardEvent) => onKeyPressState(event, true)
    const onKeyUpState = (event: KeyboardEvent) => onKeyPressState(event, false)

    window.addEventListener('paste', onPaste)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keydown', onKeyDownState)
    window.addEventListener('keyup', onKeyUpState)
    return () => {
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keydown', onKeyDownState)
      window.removeEventListener('keyup', onKeyUpState)
    }
  }, [activeObject, addImageLayer, handleDeleteActiveObject, restoreHistory])

  const handleAddText = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const text = new IText(textStyle.text || DEFAULT_TEXT_STYLE.text, {
      left: canvas.getWidth() / 2,
      top: canvas.getHeight() / 2,
      originX: 'center',
      originY: 'center',
      fill: textStyle.fill,
      fontSize: textStyle.fontSize,
      fontWeight: textStyle.fontWeight,
      fontStyle: textStyle.fontStyle,
      cornerStyle: 'circle',
      transparentCorners: false,
      borderColor: '#3b82f6',
      cornerColor: '#ffffff',
      cornerStrokeColor: '#3b82f6',
    })

    canvas.add(text)
    canvas.setActiveObject(text)
    canvas.renderAll()
    text.enterEditing()
    text.selectAll()
    pushHistory()
  }

  const handleObjectStyleChange = (patch: Partial<TextStyleState>) => {
    const canvas = canvasRef.current
    const current = canvas?.getActiveObject()
    const next = { ...textStyle, ...patch }
    setTextStyle(next)

    if (!(current instanceof IText) || !canvas) return

    current.set({
      text: next.text,
      fill: next.fill,
      fontSize: next.fontSize,
      fontWeight: next.fontWeight,
      fontStyle: next.fontStyle,
    })
    current.setCoords()
    canvas.renderAll()
    pushHistory()
  }

  const buildMaskShape = useCallback((shapeType: MaskShapeType, left: number, top: number, width: number, height: number) => {
    const fill = buildMaskColor(maskHue, maskOpacity)
    const centerLeft = left + width / 2
    const centerTop = top + height / 2
    const shared = {
      left: centerLeft,
      top: centerTop,
      originX: 'center' as const,
      originY: 'center' as const,
      fill,
      cornerStyle: 'circle' as const,
      transparentCorners: false,
      borderColor: '#3b82f6',
      cornerColor: '#ffffff',
      cornerStrokeColor: '#3b82f6',
    }

    if (shapeType === 'ellipse') {
      return new Ellipse({
        ...shared,
        rx: width / 2,
        ry: height / 2,
      })
    }

    if (shapeType === 'triangle') {
      return new Triangle({
        ...shared,
        width,
        height,
      })
    }

    return new Rect({
      ...shared,
      width,
      height,
    })
  }, [maskHue, maskOpacity])

  const handleAddMaskRegion = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const mask = buildMaskShape(
      maskShapeType,
      canvas.getWidth() / 2 - 140,
      canvas.getHeight() / 2 - 70,
      280,
      140,
    )
    ;(mask as FabricObject & { data?: { editorKind: string; shapeType: MaskShapeType } }).data = {
      editorKind: 'mask-region',
      shapeType: maskShapeType,
    }
    canvas.add(mask)
    canvas.setActiveObject(mask)
    canvas.renderAll()
    pushHistory()
  }

  const handleChangeMaskShapeType = (nextShapeType: MaskShapeType) => {
    setMaskShapeType(nextShapeType)
    const canvas = canvasRef.current
    if (!canvas || getEditorKind(activeObject) !== 'mask-region' || !activeObject) return

    const center = activeObject.getCenterPoint()
    const scaledWidth = activeObject.getScaledWidth()
    const scaledHeight = activeObject.getScaledHeight()
    const angle = activeObject.angle ?? 0
    const fill = typeof activeObject.fill === 'string'
      ? activeObject.fill
      : buildMaskColor(maskHue, maskOpacity)

    suppressHistoryRef.current = true
    canvas.remove(activeObject)
    const replacement = buildMaskShape(
      nextShapeType,
      center.x - scaledWidth / 2,
      center.y - scaledHeight / 2,
      scaledWidth,
      scaledHeight,
    )
    replacement.set({
      angle,
      fill,
    })
    replacement.setPositionByOrigin(center, 'center', 'center')
    ;(replacement as FabricObject & { data?: { editorKind: string; shapeType: MaskShapeType } }).data = {
      editorKind: 'mask-region',
      shapeType: nextShapeType,
    }
    canvas.add(replacement)
    canvas.setActiveObject(replacement)
    canvas.renderAll()
    suppressHistoryRef.current = false
    setActiveObject(replacement)
    pushHistory()
  }

  const handleFlipActiveObject = (axis: 'x' | 'y') => {
    const canvas = canvasRef.current
    const current = canvas?.getActiveObject() ?? activeObject
    if (!canvas || !current) return

    if (getEditorKind(current) === 'base-image') {
      if (axis === 'x') {
        baseFlipRef.current = { ...baseFlipRef.current, x: !baseFlipRef.current.x }
      } else {
        baseFlipRef.current = { ...baseFlipRef.current, y: !baseFlipRef.current.y }
      }
      syncBaseProxyData()
      redrawBackground()
      canvas.requestRenderAll()
      pushHistory()
      return
    }

    current.set(axis === 'x' ? { flipX: !current.flipX } : { flipY: !current.flipY })
    current.setCoords()
    canvas.requestRenderAll()
    pushHistory()
  }

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    event.target.value = ''
    await addImageLayer(await readFileAsDataUrl(file))
  }

  const handleUndo = async () => {
    if (historyIndexRef.current <= 0) return
    await restoreHistory(historyIndexRef.current - 1)
  }

  const handleRedo = async () => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return
    await restoreHistory(historyIndexRef.current + 1)
  }

  const handleSave = async () => {
    const canvas = canvasRef.current
    const sourceImage = sourceImageRef.current
    if (!canvas || !sourceImage) return

    const previousViewport = canvas.viewportTransform ? [...canvas.viewportTransform] : null
    const baseProxy = canvas.getObjects().find((object) => getEditorKind(object) === 'base-image')
    const previousBaseVisible = baseProxy?.visible
    if (baseProxy) {
      baseProxy.set({ visible: false })
    }
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0])
    canvas.renderAll()
    const overlayDataUrl = canvas.toDataURL({
      format: 'png',
      left: imageBoundsRef.current.left,
      top: imageBoundsRef.current.top,
      width: imageBoundsRef.current.width,
      height: imageBoundsRef.current.height,
      multiplier: exportMultiplierRef.current,
    })
    if (baseProxy) {
      baseProxy.set({ visible: previousBaseVisible ?? true })
    }
    if (previousViewport) {
      canvas.setViewportTransform(previousViewport as [number, number, number, number, number, number])
      canvas.renderAll()
    }

    const overlayImage = await loadHtmlImage(overlayDataUrl)
    const exportCanvas = document.createElement('canvas')
    exportCanvas.width = sourceSizeRef.current.width
    exportCanvas.height = sourceSizeRef.current.height
    const exportContext = exportCanvas.getContext('2d')
    if (!exportContext) return
    exportContext.imageSmoothingEnabled = true
    exportContext.imageSmoothingQuality = 'high'
    if (baseFlipRef.current.x || baseFlipRef.current.y) {
      exportContext.translate(exportCanvas.width / 2, exportCanvas.height / 2)
      exportContext.scale(baseFlipRef.current.x ? -1 : 1, baseFlipRef.current.y ? -1 : 1)
      exportContext.drawImage(sourceImage, -exportCanvas.width / 2, -exportCanvas.height / 2, exportCanvas.width, exportCanvas.height)
      exportContext.setTransform(1, 0, 0, 1, 0, 0)
    } else {
      exportContext.drawImage(sourceImage, 0, 0, exportCanvas.width, exportCanvas.height)
    }
    exportContext.drawImage(overlayImage, 0, 0, exportCanvas.width, exportCanvas.height)
    const editedDataUrl = exportCanvas.toDataURL('image/png')

    if (saveMode === 'replace-input') {
      const nextId = await replaceInputImageWithDataUrl(imageId, editedDataUrl)
      setLightboxImageId(nextId, currentImageList.map((id) => (id === imageId ? nextId : id)))
      onSaved?.(nextId, editedDataUrl)
      showToast('参考图已更新', 'success')
    } else {
      const nextId = await addInputImageWithDataUrl(editedDataUrl)
      const nextList = currentImageList.includes(nextId) ? currentImageList : [...currentImageList, nextId]
      setLightboxImageId(nextId, nextList)
      onSaved?.(nextId, editedDataUrl)
      showToast('编辑结果已加入参考图', 'success')
    }
    onClose()
  }

  const isTextSelected = activeObject instanceof IText
  const activeEditorKind = getEditorKind(activeObject)
  const canDeleteActiveObject = Boolean(activeObject && activeEditorKind !== 'base-image')
  const isMaskRegionSelected = activeEditorKind === 'mask-region'
  const showMaskSettings = toolMode === 'mask-brush' || isMaskRegionSelected
  const settingsPanel = isTextSelected ? 'text' : showMaskSettings ? 'mask' : null
  const showTextSettings = settingsPanel === 'text'
  const showLocalMaskSettings = settingsPanel === 'mask'

  return (
    <div className="fixed inset-0 z-[75] h-[100dvh] overflow-hidden bg-black/70 backdrop-blur-md">
      <div className="absolute inset-0 bg-[#0b0e12]">
        <div
          ref={canvasViewportRef}
          className="absolute inset-x-2 top-2 bottom-[292px] overflow-hidden rounded-2xl border border-white/10 bg-[#11161d] shadow-2xl touch-none sm:inset-x-3 sm:top-3 sm:bottom-[320px] md:inset-4 md:right-[392px] md:bottom-4 md:rounded-3xl"
        >
          {!ready && (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-white/65">
              正在加载编辑器...
            </div>
          )}
          <canvas
            ref={backgroundCanvasRef}
            className="absolute inset-0 block h-full w-full touch-none"
          />
          <canvas
            ref={canvasElementRef}
            className="absolute inset-0 block touch-none"
          />
        </div>
        <aside className="absolute inset-x-2 bottom-2 z-20 max-h-[282px] overflow-y-auto rounded-2xl border border-white/10 bg-[#12161d]/96 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-white shadow-2xl backdrop-blur-xl sm:inset-x-3 sm:bottom-3 sm:max-h-[306px] sm:p-4 md:bottom-4 md:left-auto md:right-4 md:top-4 md:max-h-none md:w-[360px] md:p-5">
          <div className="mb-3 flex items-center justify-between md:mb-5">
              <div>
                <h3 className="text-base font-semibold md:text-lg">高级编辑</h3>
                <p className="mt-1 hidden text-xs text-white/45 sm:block">
                文字、涂抹、区域填色、贴图。
                {saveMode === 'replace-input' ? ' 保存后替换当前参考图。' : ' 保存后加入参考图。'}
              </p>
            </div>
            <button
              onClick={onClose}
              className="rounded-full p-2 text-white/45 transition hover:bg-white/10 hover:text-white"
              aria-label="关闭编辑器"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="space-y-3 md:space-y-5">
            <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3 md:rounded-2xl md:p-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-white/45 md:mb-3">历史</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => void handleUndo()}
                  disabled={!historyState.canUndo}
                  className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40 md:rounded-xl"
                >
                  撤销
                </button>
                <button
                  onClick={() => void handleRedo()}
                  disabled={!historyState.canRedo}
                  className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40 md:rounded-xl"
                >
                  重做
                </button>
              </div>
            </section>

            <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3 md:rounded-2xl md:p-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-white/45 md:mb-3">工具</div>
              <div className="grid grid-cols-2 gap-2">
                <div className={canDeleteActiveObject && isMobileDevice ? 'grid grid-cols-2 gap-2' : ''}>
                  <button
                  onClick={() => handleToolModeChange('select')}
                    className={`w-full rounded-lg px-3 py-2 text-sm transition md:rounded-xl ${toolMode === 'select' ? 'bg-blue-500 text-white' : 'bg-white/8 text-white hover:bg-white/12'}`}
                  >
                    选择
                  </button>
                  {canDeleteActiveObject && isMobileDevice && (
                    <button
                      onClick={handleDeleteActiveObject}
                      className="w-full rounded-lg bg-red-500/90 px-3 py-2 text-sm text-white transition hover:bg-red-500"
                    >
                      删除
                    </button>
                  )}
                </div>
                <button
                  onClick={() => handleToolModeChange('mask-brush')}
                  className={`rounded-lg px-3 py-2 text-sm transition md:rounded-xl ${toolMode === 'mask-brush' ? 'bg-blue-500 text-white' : 'bg-white/8 text-white hover:bg-white/12'}`}
                >
                  涂抹
                </button>
                <button
                  onClick={() => handleFlipActiveObject('x')}
                  disabled={!activeObject}
                  className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40 md:rounded-xl"
                >
                  水平翻转
                </button>
                <button
                  onClick={() => handleFlipActiveObject('y')}
                  disabled={!activeObject}
                  className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40 md:rounded-xl"
                >
                  垂直翻转
                </button>
                <button
                  onClick={handleAddMaskRegion}
                  className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 md:rounded-xl"
                >
                  区域填色
                </button>
                <button
                  onClick={handleAddText}
                  className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 md:rounded-xl"
                >
                  添加文字
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 md:rounded-xl"
                >
                  从文件贴图
                </button>
                <button
                  onClick={() => showToast('直接粘贴图片即可加入画布', 'info')}
                  className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 md:rounded-xl"
                >
                  从剪贴板贴图
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => void handleFileSelect(event)}
              />
            </section>

            {showTextSettings && (
              <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3 md:rounded-2xl md:p-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-white/45 md:mb-3">文字样式</div>
              <div className="space-y-3">
                <label className="block">
                  <span className="mb-1 block text-xs text-white/55">文字内容</span>
                  <textarea
                    value={textStyle.text}
                    onChange={(e) => handleObjectStyleChange({ text: e.target.value })}
                    rows={2}
                    className="w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 md:rounded-xl"
                    placeholder="输入要添加到画布的文字"
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs text-white/55">颜色</span>
                    <input
                      type="color"
                      value={normalizeColorValue(textStyle.fill)}
                      onChange={(e) => handleObjectStyleChange({ fill: e.target.value })}
                      className="h-10 w-full rounded-lg border border-white/10 bg-black/25 p-1 md:rounded-xl"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-white/55">字号</span>
                    <input
                      type="number"
                      min={12}
                      max={240}
                      value={textStyle.fontSize}
                      onChange={(e) => handleObjectStyleChange({ fontSize: clamp(Number(e.target.value) || 12, 12, 240) })}
                      className="h-10 w-full rounded-lg border border-white/10 bg-black/25 px-3 text-sm text-white outline-none focus:border-blue-400 md:rounded-xl"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handleObjectStyleChange({ fontWeight: textStyle.fontWeight === 'bold' ? 'normal' : 'bold' })}
                    className={`rounded-lg px-3 py-2 text-sm transition md:rounded-xl ${textStyle.fontWeight === 'bold' ? 'bg-blue-500 text-white' : 'bg-white/8 text-white hover:bg-white/12'}`}
                  >
                    粗体
                  </button>
                  <button
                    onClick={() => handleObjectStyleChange({ fontStyle: textStyle.fontStyle === 'italic' ? 'normal' : 'italic' })}
                    className={`rounded-lg px-3 py-2 text-sm transition md:rounded-xl ${textStyle.fontStyle === 'italic' ? 'bg-blue-500 text-white' : 'bg-white/8 text-white hover:bg-white/12'}`}
                  >
                    斜体
                  </button>
                </div>
                {!isTextSelected && (
                  <div className="text-xs text-white/45">当前没有选中文字对象，样式会用于下一个新建文字。</div>
                )}
              </div>
              </section>
            )}

            {showLocalMaskSettings && (
              <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3 md:rounded-2xl md:p-4">
                <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-white/45 md:mb-3">填色样式</div>
                <div className="space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-xs text-white/55">透明度</span>
                    <input
                      type="range"
                      min={0.05}
                      max={1}
                      step={0.05}
                      value={maskOpacity}
                      onChange={(e) => setMaskOpacity(Number(e.target.value))}
                      className="w-full accent-blue-500"
                    />
                    <span className="mt-1 block text-xs text-white/45">{Math.round(maskOpacity * 100)}%</span>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-white/55">笔刷大小</span>
                    <input
                      type="range"
                      min={4}
                      max={160}
                      step={1}
                      value={maskWidth}
                      onChange={(e) => setMaskWidth(Number(e.target.value))}
                      className="w-full accent-blue-500"
                    />
                    <span className="mt-1 block text-xs text-white/45">{maskWidth}px</span>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-white/55">颜色</span>
                    <input
                      type="range"
                      min={0}
                      max={360}
                      step={1}
                      value={maskHue}
                      onChange={(e) => setMaskHue(Number(e.target.value))}
                      className="w-full"
                      style={{ accentColor: buildMaskColor(maskHue, 1) }}
                    />
                    <span
                      className="mt-1 block h-6 rounded-lg border border-white/10"
                      style={{ background: buildMaskColor(maskHue, maskOpacity) }}
                    />
                  </label>
                  <div>
                    <div className="mb-1 text-xs text-white/55">区域形状</div>
                    <div className="grid grid-cols-3 gap-2">
                      {(['rect', 'ellipse', 'triangle'] as const).map((shapeType) => (
                        <button
                          key={shapeType}
                          onClick={() => handleChangeMaskShapeType(shapeType)}
                          className={`rounded-lg px-3 py-2 text-sm transition md:rounded-xl ${maskShapeType === shapeType ? 'bg-blue-500 text-white' : 'bg-white/8 text-white hover:bg-white/12'}`}
                        >
                          {shapeType === 'rect' ? '矩形' : shapeType === 'ellipse' ? '圆形' : '三角'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            )}

            <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3 md:rounded-2xl md:p-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-white/45 md:mb-3">完成</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={onClose}
                  className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 md:rounded-xl"
                >
                  放弃修改
                </button>
                <button
                  onClick={() => void handleSave()}
                  className="rounded-lg bg-blue-500 px-3 py-2 text-sm text-white transition hover:bg-blue-600 md:rounded-xl"
                >
                  {saveMode === 'replace-input' ? '保存替换' : '保存并加入'}
                </button>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </div>
  )
}

async function loadHtmlImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = src
  })
}

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

function normalizeColorValue(value: string) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  if (/^#[0-9a-f]{3}$/i.test(value)) return value
  return '#ffffff'
}
