import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { flushSync } from 'react-dom'
import { MAX_INPUT_IMAGES, type SketchBoardRequest } from '../types'
import { useStore } from '../store'
import { canvasToBlob, loadImage } from '../lib/canvasImage'
import { blobToDataUrl } from '../lib/dataUrl'
import { storeImage } from '../lib/db'
import { cacheImage, ensureImageCached } from '../lib/imageCache'
import {
  SKETCH_FONT_FAMILY,
  SKETCH_HANDLES,
  SKETCH_LINE_HEIGHT,
  SKETCH_LONG_EDGE,
  SKETCH_MAX_STROKE,
  SKETCH_MIN_STROKE,
  SKETCH_SHAPES,
  createSketchId,
  drawEraseStroke,
  drawSketchElementWithErase,
  findTopElementAt,
  getElementBounds,
  getHandlePoint,
  getSketchCanvasSize,
  getSketchFontSize,
  getSketchStrokeWidthFromFontSize,
  getTransformBounds,
  hitTestElement,
  isLineShape,
  isSketchElementVisible,
  measureTextElement,
  moveElement,
  resizeBounds,
  snapToAngle,
  transformElement,
  type SketchBounds,
  type SketchComment,
  type SketchElement,
  type SketchEraseStroke,
  type SketchHandle,
  type SketchPathElement,
  type SketchPoint,
  type SketchShapeElement,
  type SketchShapeKind,
  type SketchTextElement,
  type SketchTool,
} from '../lib/sketch'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { useEditorViewport } from '../hooks/useEditorViewport'
import { useSketchComments } from '../hooks/useSketchComments'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { useTooltip } from '../hooks/useTooltip'
import { TooltipButton } from './TooltipButton'
import ViewportTooltip from './ViewportTooltip'
import SketchCommentLayer from './SketchCommentLayer'
import {
  BrushCursor,
  CheckIcon,
  ClearIcon,
  EDITOR_ICON_BUTTON_CLASS,
  EditorResetViewButton,
  EditorShell,
  EditorSizeSlider,
  EditorTopBar,
  EraserIcon,
  PenIcon,
  RedoIcon,
  UndoIcon,
  getEditorToolButtonClass,
} from './editor/EditorControls'
import { CloseIcon } from './icons'

type EndpointHandle = 'start' | 'end'

interface HistoryEntry {
  elements: SketchElement[]
  comments: SketchComment[]
  markupCleared: boolean
}

type Gesture =
  | { kind: 'draw'; pointerId: number; el: SketchPathElement }
  | { kind: 'shape'; pointerId: number; el: SketchShapeElement }
  | { kind: 'erase'; pointerId: number; stroke: SketchEraseStroke }
  | { kind: 'comment'; pointerId: number; point: SketchPoint }
  | { kind: 'move'; pointerId: number; before: SketchElement[]; changed?: boolean; start: SketchPoint; targetId: string }
  | { kind: 'endpoint'; pointerId: number; before: SketchElement[]; changed?: boolean; target: SketchShapeElement; handle: EndpointHandle }
  | {
      kind: 'resize'
      pointerId: number
      before: SketchElement[]
      changed?: boolean
      target: SketchElement
      handle: SketchHandle
      from: SketchBounds
      offset: SketchPoint
    }

const PALETTE = [
  { value: '#6b7280', label: '灰色' },
  { value: '#92400e', label: '棕色' },
  { value: '#dc2626', label: '红色' },
  { value: '#f97316', label: '橙色' },
  { value: '#f59e0b', label: '琥珀色' },
  { value: '#16a34a', label: '绿色' },
  { value: '#0d9488', label: '青绿色' },
  { value: '#06b6d4', label: '青色' },
  { value: '#2563eb', label: '蓝色' },
  { value: '#4f46e5', label: '靛蓝色' },
  { value: '#9333ea', label: '紫色' },
  { value: '#db2777', label: '粉色' },
]
const MAX_HISTORY = 100
const HANDLE_CURSORS: Record<SketchHandle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
}
const SHAPE_LABELS: Record<SketchShapeKind, string> = {
  line: '直线',
  arrow: '箭头',
  rect: '矩形',
  ellipse: '椭圆',
  triangle: '三角形',
  diamond: '菱形',
  star: '星形',
  heart: '心形',
}

function ShapeIcon({ shape }: { shape: SketchShapeKind }) {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {shape === 'line' && <path d="M5 19 19 5" />}
      {shape === 'arrow' && <path d="M5 19 19 5M10 5h9v9" />}
      {shape === 'rect' && <rect x="4" y="4" width="16" height="16" rx="1.5" />}
      {shape === 'ellipse' && <circle cx="12" cy="12" r="8" />}
      {shape === 'triangle' && <path d="M12 4.5 20 19H4z" />}
      {shape === 'diamond' && <path d="m12 3 9 9-9 9-9-9z" />}
      {shape === 'star' && <path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6l-5.4 2.9 1.2-6-4.5-4.2 6.1-.7z" />}
      {shape === 'heart' && <path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z" />}
    </svg>
  )
}

export default function SketchBoardModal() {
  const board = useStore((s) => s.sketchBoard)
  if (!board) return null
  return <SketchBoardEditor baseImageSrc={board.baseImageSrc} replaceImageId={board.replaceImageId} />
}

function SketchBoardEditor({ baseImageSrc, replaceImageId }: SketchBoardRequest) {
  const setSketchBoard = useStore((s) => s.setSketchBoard)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const swatchesRef = useRef<HTMLDivElement>(null)
  const shapeMenuRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  // 撤销历史同时记录笔画与评论，只在本次打开期间保留
  const undoRef = useRef<HistoryEntry[]>([])
  const redoRef = useRef<HistoryEntry[]>([])
  const editingRef = useRef<SketchTextElement | null>(null)
  const widthBeforeRef = useRef<SketchElement[] | null>(null)
  const colorBeforeRef = useRef<SketchElement[] | null>(null)
  const colorInputRef = useRef<HTMLInputElement>(null)
  // 离屏画布：笔画层、单个元素擦除用的临时层（底图不参与擦除），以及判断擦除后是否还有像素的探测层
  const [inkCanvas] = useState(() => document.createElement('canvas'))
  const [scratchCanvas] = useState(() => document.createElement('canvas'))
  const [probeCanvas] = useState(() => document.createElement('canvas'))
  // 文字测量不依赖具体画布，复用临时层的上下文
  const measureCtx = scratchCanvas.getContext('2d')!

  // 画板背景跟随打开时的颜色模式，导出的草图保持所见即所得
  const [isDark] = useState(() => document.documentElement.classList.contains('dark'))
  const inkColor = isDark ? '#ffffff' : '#18181b'
  const paperColor = isDark ? '#232326' : '#ffffff'

  const [docSize, setDocSize] = useState(() => baseImageSrc ? null : getSketchCanvasSize(useStore.getState().params.size))
  const [baseImage, setBaseImage] = useState<HTMLImageElement | null>(null)
  // 参考图上已有的标注层：作为底图的一部分显示，完成时与新笔画合并成新的标注层
  const [existingMarkupId] = useState(() => replaceImageId ? useStore.getState().inputImages.find((img) => img.id === replaceImageId)?.markupImageId : undefined)
  const [markupImage, setMarkupImage] = useState<HTMLImageElement | null>(null)
  const [markupCleared, setMarkupCleared] = useState(false)
  const hasVisibleMarkup = Boolean(markupImage) && !markupCleared
  const [elements, setElements] = useState<SketchElement[]>([])
  const [draft, setDraft] = useState<SketchElement | null>(null)
  const [liveErase, setLiveErase] = useState<SketchEraseStroke | null>(null)
  const [, setHistoryVersion] = useState(0)
  const [tool, setTool] = useState<SketchTool>('pen')
  const [shape, setShape] = useState<SketchShapeKind>('rect')
  const [color, setColor] = useState(inkColor)
  // 最近一次自定义颜色，切换到预设色后仍保留在自定义色块上，便于切回
  const [customColor, setCustomColor] = useState<string | null>(null)
  const [strokeWidth, setStrokeWidth] = useState(12)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState<SketchTextElement | null>(null)
  const [showShapeMenu, setShowShapeMenu] = useState(false)
  const [hoverPoint, setHoverPoint] = useState<SketchPoint | null>(null)
  const [hoverCursor, setHoverCursor] = useState('default')
  const [isAdjustingWidth, setIsAdjustingWidth] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const {
    comments,
    activeCommentId,
    commentData,
    commentsChanged,
    updateComment,
    createComment,
    finishComment,
    openComment,
    removeComment,
    moveComment,
    finishMove,
    restoreComments,
    saveComments,
  } = useSketchComments(replaceImageId, (before) => pushHistory(elements, before))

  const viewport = useEditorViewport(frameRef, viewRef, Boolean(docSize))
  const customColorTooltip = useTooltip()
  editingRef.current = editingText
  // 布局像素与文档像素之比（未含缩放）
  const cssScale = docSize ? viewport.frameWidth / docSize.width : 0
  // 屏幕像素与文档像素的换算比例，包含缩放
  const viewScale = cssScale * viewport.transform.scale
  const isReady = Boolean(docSize)
  const selected = elements.find((el) => el.id === selectedId) ?? null
  const canUndo = undoRef.current.length > 0 && !isSaving
  const canRedo = redoRef.current.length > 0 && !isSaving
  const canConfirm = elements.length > 0 || commentsChanged || markupCleared || (Boolean(baseImage) && !replaceImageId)

  const closeNow = () => setSketchBoard(null)

  const close = () => {
    if (isSaving) return
    if (editingRef.current) {
      textareaRef.current?.blur()
      return
    }
    if (activeCommentId) {
      finishComment()
      return
    }
    if (showShapeMenu) {
      setShowShapeMenu(false)
      return
    }
    if (elements.length === 0 && !commentsChanged && !markupCleared) {
      closeNow()
      return
    }
    setConfirmDialog({
      title: '关闭画板',
      message: '当前草图尚未保存，确定要放弃吗？',
      confirmText: '放弃',
      tone: 'danger',
      action: closeNow,
    })
  }
  useCloseOnEscape(true, close)
  usePreventBackgroundScroll(true, swatchesRef)

  useEffect(() => {
    if (!baseImageSrc) return
    let cancelled = false
    loadImage(baseImageSrc)
      .then((image) => {
        if (cancelled) return
        const scale = SKETCH_LONG_EDGE / Math.max(image.naturalWidth, image.naturalHeight)
        setBaseImage(image)
        setDocSize({ width: Math.round(image.naturalWidth * scale), height: Math.round(image.naturalHeight * scale) })
      })
      .catch((err) => {
        if (cancelled) return
        showToast(`底图加载失败：${err instanceof Error ? err.message : String(err)}`, 'error')
        setSketchBoard(null)
      })
    return () => {
      cancelled = true
    }
  }, [baseImageSrc, setSketchBoard, showToast])

  useEffect(() => {
    if (!existingMarkupId) return
    let cancelled = false
    ensureImageCached(existingMarkupId)
      .then((dataUrl) => dataUrl ? loadImage(dataUrl) : null)
      .then((image) => {
        if (!cancelled) setMarkupImage(image)
      })
      .catch((err) => console.warn('标注层加载失败', err))
    return () => {
      cancelled = true
    }
  }, [existingMarkupId])

  useEffect(() => {
    if (!showShapeMenu) return
    const closeMenu = (event: PointerEvent) => {
      if (shapeMenuRef.current?.contains(event.target as Node)) return
      setShowShapeMenu(false)
    }
    document.addEventListener('pointerdown', closeMenu, true)
    return () => document.removeEventListener('pointerdown', closeMenu, true)
  }, [showShapeMenu])

  /** 把笔画画到透明的笔画层上 */
  function renderInk(items: SketchElement[], erase?: SketchEraseStroke | null) {
    const size = docSize!
    if (inkCanvas.width !== size.width || inkCanvas.height !== size.height) {
      inkCanvas.width = size.width
      inkCanvas.height = size.height
    }
    const inkCtx = inkCanvas.getContext('2d')!
    inkCtx.clearRect(0, 0, size.width, size.height)
    for (const el of items) drawSketchElementWithErase(inkCtx, el, scratchCanvas)
    if (erase) drawEraseStroke(inkCtx, erase)
  }

  function drawScene(ctx: CanvasRenderingContext2D, items: SketchElement[], erase?: SketchEraseStroke | null) {
    const size = docSize!
    renderInk(items, erase)
    ctx.clearRect(0, 0, size.width, size.height)
    ctx.fillStyle = paperColor
    ctx.fillRect(0, 0, size.width, size.height)
    if (baseImage) ctx.drawImage(baseImage, 0, 0, size.width, size.height)
    if (markupImage && !markupCleared) ctx.drawImage(markupImage, 0, 0, size.width, size.height)
    ctx.drawImage(inkCanvas, 0, 0)
  }

  function getSelectionBox(el: SketchElement) {
    const b = getElementBounds(el, measureCtx)
    const pad = 6 / viewScale
    return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
  }

  /** 直线和箭头只显示两端控制点，其余元素显示包围盒的 8 个控制点 */
  function getHandleAt(el: SketchElement, point: SketchPoint): SketchHandle | EndpointHandle | null {
    const reach = 10 / viewScale
    const near = (p: SketchPoint) => Math.abs(p.x - point.x) <= reach && Math.abs(p.y - point.y) <= reach
    if (isLineShape(el)) return near(el.end) ? 'end' : near(el.start) ? 'start' : null
    const box = getSelectionBox(el)
    return SKETCH_HANDLES.find((handle) => near(getHandlePoint(box, handle))) ?? null
  }

  useEffect(() => {
    if (!docSize) return
    const ctx = canvasRef.current!.getContext('2d')!
    const visible = elements.filter((el) => el.id !== editingText?.id)
    drawScene(ctx, draft ? [...visible, draft] : visible, liveErase)
  }, [elements, draft, liveErase, editingText, baseImage, markupImage, markupCleared, docSize])

  // 选中框单独画在叠加层上，缩放时只需重绘这一层
  useEffect(() => {
    if (!docSize) return
    const ctx = overlayRef.current!.getContext('2d')!
    ctx.clearRect(0, 0, docSize.width, docSize.height)
    if (!selected || editingText) return

    const unit = 1 / viewScale
    const size = 9 * unit
    ctx.save()
    ctx.strokeStyle = '#3b82f6'
    ctx.fillStyle = '#ffffff'
    ctx.lineWidth = 1.5 * unit
    if (isLineShape(selected)) {
      for (const p of [selected.start, selected.end]) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, size / 1.6, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
      ctx.restore()
      return
    }
    const box = getSelectionBox(selected)
    ctx.setLineDash([6 * unit, 4 * unit])
    ctx.strokeRect(box.x, box.y, box.width, box.height)
    ctx.setLineDash([])
    for (const handle of SKETCH_HANDLES) {
      const p = getHandlePoint(box, handle)
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size)
      ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size)
    }
    ctx.restore()
  }, [selected, editingText, viewScale, docSize])

  function syncHistory() {
    setHistoryVersion((v) => v + 1)
  }

  function pushHistory(before: SketchElement[], beforeComments = comments) {
    undoRef.current.push({ elements: before, comments: beforeComments, markupCleared })
    if (undoRef.current.length > MAX_HISTORY) undoRef.current.shift()
    redoRef.current = []
    syncHistory()
  }

  function commit(next: SketchElement[]) {
    pushHistory(elements)
    setElements(next)
  }

  function undo() {
    commitCustomColor()
    const previous = undoRef.current.pop()
    if (!previous) return
    redoRef.current.push({ elements, comments, markupCleared })
    setElements(previous.elements)
    restoreComments(previous.comments)
    setMarkupCleared(previous.markupCleared)
    setSelectedId(null)
    syncHistory()
  }

  function redo() {
    commitCustomColor()
    const next = redoRef.current.pop()
    if (!next) return
    undoRef.current.push({ elements, comments, markupCleared })
    setElements(next.elements)
    restoreComments(next.comments)
    setMarkupCleared(next.markupCleared)
    setSelectedId(null)
    syncHistory()
  }

  function clearAll() {
    if (elements.length === 0 && !hasVisibleMarkup) return
    commit([])
    if (markupImage) setMarkupCleared(true)
    setSelectedId(null)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 只在文字输入时让出快捷键；取色器关闭后焦点仍停在颜色输入框上，不能拦截撤销
      if (event.target instanceof Element && event.target.closest('input:not([type="color"]), textarea, [contenteditable="true"]')) return
      // 调节粗细期间不响应快捷键，否则松手时记下的调节前快照会打乱撤销顺序
      if (isSaving || widthBeforeRef.current || useStore.getState().confirmDialog) return
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (mod && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (mod && key === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault()
        commit(elements.filter((el) => el.id !== selectedId))
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [elements, comments, selectedId, isSaving])

  function toDocPoint(event: { clientX: number; clientY: number }): SketchPoint {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * docSize!.width,
      y: ((event.clientY - rect.top) / rect.height) * docSize!.height,
    }
  }

  function selectElement(el: SketchElement | null) {
    setSelectedId(el?.id ?? null)
    if (!el) return
    setColor(el.color)
    if (el.color !== inkColor && !PALETTE.some((item) => item.value === el.color)) setCustomColor(el.color)
    setStrokeWidth(el.type === 'text' ? getSketchStrokeWidthFromFontSize(el.fontSize) : el.width)
  }

  function startEditing(el: SketchTextElement) {
    setSelectedId(null)
    flushSync(() => setEditingText(el))
    const textarea = textareaRef.current
    if (!textarea) return
    // 必须在用户手势内同步聚焦，移动端才会弹出软键盘
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }

  function commitText() {
    const editing = editingRef.current
    if (!editing) return
    editingRef.current = null
    setEditingText(null)

    const text = editing.text.replace(/\s+$/, '')
    const existing = elements.find((el) => el.id === editing.id)
    if (!text.trim()) {
      if (existing) commit(elements.filter((el) => el.id !== editing.id))
      return
    }
    const next = { ...editing, text }
    if (!existing) {
      commit([...elements, next])
      return
    }
    // 编辑中可能只调了字号或颜色，内容相同也要比较，否则调整会被丢弃
    if (existing.type === 'text' && existing.text === text && existing.fontSize === next.fontSize && existing.color === next.color) return
    commit(elements.map((el) => el.id === next.id ? next : el))
  }

  /** 双指手势开始时撤销正在进行的单指操作 */
  function cancelGesture() {
    const gesture = gestureRef.current
    gestureRef.current = null
    setDraft(null)
    setLiveErase(null)
    if (gesture && 'before' in gesture) setElements(gesture.before)
  }

  /** 把擦除笔迹挂到所有被擦到的元素上，完全擦掉的元素直接移除 */
  function applyErase(stroke: SketchEraseStroke) {
    let changed = false
    const next: SketchElement[] = []
    for (const el of elements) {
      const touched = stroke.points.some((p) => hitTestElement(el, p, stroke.width / 2, measureCtx, 'erase'))
      if (!touched) {
        next.push(el)
        continue
      }
      changed = true
      const erased = { ...el, erase: [...(el.erase ?? []), stroke] }
      if (isSketchElementVisible(erased, probeCanvas)) next.push(erased)
    }
    if (changed) commit(next)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!docSize || isSaving || (event.pointerType !== 'touch' && event.button !== 0)) return
    if (event.target === textareaRef.current) return
    if (editingRef.current) {
      textareaRef.current?.blur()
      return
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    const viewportGesture = viewport.pointerDown(event)
    if (viewportGesture === 'pan') return
    if (viewportGesture === 'pinch') {
      cancelGesture()
      return
    }
    if (viewport.isPinching() || gestureRef.current) return
    // 评论输入框打开时，点击画布只负责收起它（输入框不会失焦，需手动结束）
    if (activeCommentId) {
      finishComment()
      return
    }

    setShowShapeMenu(false)
    const point = toDocPoint(event)
    const pointerId = event.pointerId
    const tolerance = 6 / viewScale

    if (tool === 'text') {
      if (point.x < 0 || point.y < 0 || point.x > docSize.width || point.y > docSize.height) return
      const hit = findTopElementAt(elements.filter((el) => el.type === 'text'), point, tolerance, measureCtx)
      // 编辑已有文字时滑块和色块会直接作用于它，需先同步为这段文字的字号和颜色
      if (hit?.type === 'text') {
        selectElement(hit)
        startEditing(hit)
        return
      }
      const fontSize = getSketchFontSize(strokeWidth)
      startEditing({
        id: createSketchId(),
        type: 'text',
        color,
        width: strokeWidth,
        x: point.x,
        y: point.y - (fontSize * SKETCH_LINE_HEIGHT) / 2,
        text: '',
        fontSize,
      })
      return
    }
    if (tool === 'comment') {
      if (point.x < 0 || point.y < 0 || point.x > docSize.width || point.y > docSize.height) return
      // 抬起时才新建评论，开始双指捏合时手势被取消，不会误建评论
      gestureRef.current = { kind: 'comment', pointerId, point }
      return
    }
    if (tool === 'pen') {
      const el: SketchPathElement = { id: createSketchId(), type: 'path', color, width: strokeWidth, points: [point] }
      gestureRef.current = { kind: 'draw', pointerId, el }
      setDraft(el)
      return
    }
    if (tool === 'shape') {
      const el: SketchShapeElement = { id: createSketchId(), type: 'shape', shape, color, width: strokeWidth, start: point, end: point }
      gestureRef.current = { kind: 'shape', pointerId, el }
      setDraft(el)
      return
    }
    if (tool === 'eraser') {
      const stroke = { width: strokeWidth, points: [point] }
      gestureRef.current = { kind: 'erase', pointerId, stroke }
      setLiveErase(stroke)
      return
    }

    const handle = selected ? getHandleAt(selected, point) : null
    if (selected && handle) {
      if (handle === 'start' || handle === 'end') {
        if (isLineShape(selected)) gestureRef.current = { kind: 'endpoint', pointerId, before: elements, target: selected, handle }
        return
      }
      const box = getSelectionBox(selected)
      const from = getTransformBounds(selected, measureCtx)
      const boxHandle = getHandlePoint(box, handle)
      const fromHandle = getHandlePoint(from, handle)
      gestureRef.current = {
        kind: 'resize',
        pointerId,
        before: elements,
        target: selected,
        handle,
        from,
        offset: { x: boxHandle.x - fromHandle.x, y: boxHandle.y - fromHandle.y },
      }
      return
    }

    const hit = findTopElementAt(elements, point, tolerance, measureCtx)
    selectElement(hit)
    if (hit) gestureRef.current = { kind: 'move', pointerId, before: elements, start: point, targetId: hit.id }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!docSize || viewport.pointerMove(event)) return
    const point = toDocPoint(event)
    if (event.pointerType !== 'touch') setHoverPoint(point)

    const gesture = gestureRef.current
    if (!gesture) {
      if (tool !== 'select') return
      const handle = selected ? getHandleAt(selected, point) : null
      const handleCursor = handle === 'start' || handle === 'end' ? 'crosshair' : handle ? HANDLE_CURSORS[handle] : null
      setHoverCursor(handleCursor ?? (findTopElementAt(elements, point, 6 / viewScale, measureCtx) ? 'move' : 'default'))
      return
    }
    if (gesture.pointerId !== event.pointerId) return

    // 进行中的笔迹保存在手势对象里，避免快速抬起时读到过期的渲染状态
    if (gesture.kind === 'draw') {
      const last = gesture.el.points[gesture.el.points.length - 1]
      if (Math.hypot(point.x - last.x, point.y - last.y) < 1) return
      gesture.el = { ...gesture.el, points: [...gesture.el.points, point] }
      setDraft(gesture.el)
      return
    }
    if (gesture.kind === 'erase') {
      // 按笔宽插值，保证快速划过时也能擦到中间经过的笔画
      const points = gesture.stroke.points
      const last = points[points.length - 1]
      const steps = Math.ceil(Math.hypot(point.x - last.x, point.y - last.y) / Math.max(1, gesture.stroke.width / 3))
      const added = Array.from({ length: steps }, (_, i) => ({
        x: last.x + ((point.x - last.x) * (i + 1)) / steps,
        y: last.y + ((point.y - last.y) * (i + 1)) / steps,
      }))
      gesture.stroke = { ...gesture.stroke, points: [...points, ...added] }
      setLiveErase(gesture.stroke)
      return
    }
    if (gesture.kind === 'shape') {
      const d = gesture.el
      const dx = point.x - d.start.x
      const dy = point.y - d.start.y
      const side = Math.max(Math.abs(dx), Math.abs(dy))
      const end = !event.shiftKey
        ? point
        : d.shape === 'line' || d.shape === 'arrow'
        ? snapToAngle(d.start, point)
        : { x: d.start.x + Math.sign(dx || 1) * side, y: d.start.y + Math.sign(dy || 1) * side }
      gesture.el = { ...d, end }
      setDraft(gesture.el)
      return
    }
    if (gesture.kind === 'comment') return
    gesture.changed = true
    if (gesture.kind === 'move') {
      const dx = point.x - gesture.start.x
      const dy = point.y - gesture.start.y
      setElements(gesture.before.map((el) => el.id === gesture.targetId ? moveElement(el, dx, dy) : el))
      return
    }
    if (gesture.kind === 'endpoint') {
      const target = gesture.target
      const anchor = gesture.handle === 'start' ? target.end : target.start
      const next = event.shiftKey ? snapToAngle(anchor, point) : point
      const updated = gesture.handle === 'start' ? { ...target, start: next } : { ...target, end: next }
      setElements(gesture.before.map((el) => el.id === target.id ? updated : el))
      return
    }

    // Shift：封闭图形缩放为等宽高，手绘笔迹保持原比例
    const target = gesture.target
    const aspect = !event.shiftKey || target.type === 'text'
      ? undefined
      : target.type === 'shape' ? 1 : gesture.from.width / gesture.from.height
    const to = resizeBounds(gesture.from, gesture.handle, { x: point.x - gesture.offset.x, y: point.y - gesture.offset.y }, 8, aspect)
    setElements(gesture.before.map((el) => el.id === target.id ? transformElement(target, gesture.from, to, gesture.handle) : el))
  }

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    viewport.pointerUp(event)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null

    if (gesture.kind === 'comment') {
      if (event.type !== 'pointerup') return
      // 同步渲染输入框，使其在用户手势内获得焦点，移动端才会弹出软键盘
      flushSync(() => createComment(gesture.point.x / docSize!.width, gesture.point.y / docSize!.height))
      return
    }
    if (gesture.kind === 'draw') {
      commit([...elements, gesture.el])
      setDraft(null)
      return
    }
    if (gesture.kind === 'erase') {
      applyErase(gesture.stroke)
      setLiveErase(null)
      return
    }
    if (gesture.kind === 'shape') {
      setDraft(null)
      const el = gesture.el
      // 过小的图形视为误触
      if (Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y) < 4 / viewScale) return
      commit([...elements, el])
      setTool('select')
      setSelectedId(el.id)
      return
    }
    if (gesture.changed) pushHistory(gesture.before)
  }

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!docSize || tool !== 'select') return
    const hit = findTopElementAt(elements, toDocPoint(event), 6 / viewScale, measureCtx)
    if (hit?.type === 'text') startEditing(hit)
  }

  // 取色器拖动时只实时预览，关闭取色器（原生 change 事件）后才合并记一条撤销记录
  const previewCustomColor = (next: string) => {
    setCustomColor(next)
    setColor(next)
    const editing = editingRef.current
    if (editing) {
      setEditingText({ ...editing, color: next })
      return
    }
    if (!selected) return
    if (!colorBeforeRef.current) colorBeforeRef.current = elements
    setElements((items) => items.map((el) => el.id === selected.id ? { ...el, color: next } : el))
  }

  const commitCustomColor = () => {
    const before = colorBeforeRef.current
    colorBeforeRef.current = null
    if (before) pushHistory(before)
  }

  // 原生 change 监听只注册一次，通过 ref 调用最新的 commitCustomColor，撤销记录里的评论才是当前值
  const commitCustomColorRef = useRef(commitCustomColor)
  commitCustomColorRef.current = commitCustomColor
  useEffect(() => {
    const input = colorInputRef.current!
    const handleChange = () => commitCustomColorRef.current()
    input.addEventListener('change', handleChange)
    return () => input.removeEventListener('change', handleChange)
  }, [])

  const applyColor = (next: string) => {
    setColor(next)
    // 正在输入的文字直接换色，提交文字时一并记入历史
    const editing = editingRef.current
    if (editing) {
      setEditingText({ ...editing, color: next })
      return
    }
    if (selected && selected.color !== next) {
      commit(elements.map((el) => el.id === selected.id ? { ...el, color: next } : el))
    }
  }

  // 只在滑块调节期间调用，松手或松开按键后由 onAdjustEnd 统一记一条历史
  const applyStrokeWidth = (next: number) => {
    if (next === strokeWidth) return
    setStrokeWidth(next)
    // 正在输入的文字直接改字号，提交文字时一并记入历史
    const editing = editingRef.current
    if (editing) {
      setEditingText({ ...editing, width: next, fontSize: getSketchFontSize(next) })
      return
    }
    if (!selected) return
    setElements((items) => items.map((el) => {
      if (el.id !== selected.id) return el
      return el.type === 'text' ? { ...el, width: next, fontSize: getSketchFontSize(next) } : { ...el, width: next }
    }))
  }

  const selectTool = (next: SketchTool) => {
    if (editingRef.current) textareaRef.current?.blur()
    setTool(next)
    setShowShapeMenu(false)
    if (next !== 'select') setSelectedId(null)
  }

  const handleConfirm = async () => {
    if (!docSize || !canConfirm || isSaving) return
    const state = useStore.getState()
    const replaceIdx = replaceImageId ? state.inputImages.findIndex((img) => img.id === replaceImageId) : -1
    if (replaceIdx < 0 && state.inputImages.length >= MAX_INPUT_IMAGES) {
      showToast(`参考图数量已达上限（${MAX_INPUT_IMAGES} 张），无法继续添加`, 'error')
      return
    }

    // 在参考图上画的内容保存为与原图同尺寸的透明标注层，原图保持不变；只改了评论时不必重新导出
    if (replaceIdx >= 0 && baseImage && replaceImageId) {
      if (elements.length === 0 && !markupCleared) {
        saveComments(replaceIdx)
        showToast('评论已更新', 'success')
        closeNow()
        return
      }
      try {
        setIsSaving(true)
        // 旧标注可能还没加载完，保存时直接从图片库读取，避免丢掉它
        const existingMarkup = existingMarkupId && !markupCleared
          ? markupImage ?? await ensureImageCached(existingMarkupId).then((dataUrl) => dataUrl ? loadImage(dataUrl) : null)
          : null
        let markupImageId: string | undefined
        if (elements.length > 0 || existingMarkup) {
          const canvas = document.createElement('canvas')
          canvas.width = baseImage.naturalWidth
          canvas.height = baseImage.naturalHeight
          const ctx = canvas.getContext('2d')!
          if (existingMarkup) ctx.drawImage(existingMarkup, 0, 0, canvas.width, canvas.height)
          renderInk(elements)
          ctx.drawImage(inkCanvas, 0, 0, canvas.width, canvas.height)
          const dataUrl = await blobToDataUrl(await canvasToBlob(canvas, 'image/png'))
          markupImageId = await storeImage(dataUrl, 'mask')
          cacheImage(markupImageId, dataUrl)
        }
        useStore.getState().setInputImageMarkup(replaceImageId, markupImageId)
        if (commentsChanged) saveComments(replaceIdx)
        showToast(markupImageId ? '标注已保存，原图保持不变' : '标注已清除', 'success')
        closeNow()
      } catch (err) {
        console.error(err)
        showToast(`标注保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
        setIsSaving(false)
      }
      return
    }

    try {
      setIsSaving(true)
      const canvas = document.createElement('canvas')
      canvas.width = docSize.width
      canvas.height = docSize.height
      drawScene(canvas.getContext('2d')!, elements)
      const dataUrl = await blobToDataUrl(await canvasToBlob(canvas, 'image/png'))
      const id = await storeImage(dataUrl, 'upload')
      cacheImage(id, dataUrl)
      // 参考图按内容哈希去重：导出结果与另一张参考图完全相同时不重复添加，评论合并到那张图上
      const existingIdx = useStore.getState().inputImages.findIndex((img) => img.id === id)
      if (existingIdx >= 0 && existingIdx !== replaceIdx) {
        if (commentData.length) saveComments(existingIdx, true)
        showToast(commentData.length ? `参考图中已有相同的图片，评论已合并到图${existingIdx + 1}` : '参考图中已有相同的图片', 'info')
        closeNow()
        return
      }
      if (replaceIdx >= 0) {
        useStore.getState().replaceInputImage(replaceIdx, { id, dataUrl })
        showToast('参考图已更新', 'success')
      } else {
        useStore.getState().addInputImage({ id, dataUrl })
        showToast('草图已添加到参考图', 'success')
      }
      if (commentsChanged) saveComments(useStore.getState().inputImages.findIndex((img) => img.id === id))
      closeNow()
    } catch (err) {
      console.error(err)
      showToast(`草图保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      setIsSaving(false)
    }
  }

  // 画笔 / 橡皮的覆盖范围预览；调节粗细且指针不在画布上时显示在可见区域中心，放大后也能看到
  const showsBrush = tool === 'pen' || tool === 'eraser' || tool === 'shape'
  const brushRingPoint = !showsBrush || !docSize || viewport.isAltPressed
    ? null
    : isAdjustingWidth
    ? hoverPoint ?? viewport.getVisibleCenter(cssScale)
    : tool === 'shape' ? null : hoverPoint
  const canvasCursor = viewport.isPanning
    ? 'grabbing'
    : viewport.isAltPressed
    ? 'grab'
    : tool === 'select'
    ? hoverCursor
    : tool === 'text'
    ? 'text'
    : brushRingPoint ? 'none' : 'crosshair'

  const editingSize = editingText ? measureTextElement(measureCtx, editingText) : null
  // 评论输入框可放置的区域：视口去掉内边距（避开左侧粗细滑块），换算到画布布局框坐标
  const getCommentEditorBounds = () => {
    const view = viewRef.current!
    const viewRect = view.getBoundingClientRect()
    const frameRect = frameRef.current!.getBoundingClientRect()
    const style = getComputedStyle(view)
    return {
      left: viewRect.left + parseFloat(style.paddingLeft) - frameRect.left,
      right: viewRect.right - parseFloat(style.paddingRight) - frameRect.left,
      top: viewRect.top - frameRect.top,
      bottom: viewRect.bottom - frameRect.top,
    }
  }
  const swatchClass = (active: boolean) => `h-7 w-7 flex-none rounded-full transition-transform hover:scale-110 ${
    active ? 'ring-2 ring-blue-500 ring-offset-2 ring-offset-white dark:ring-offset-gray-900' : 'ring-1 ring-inset ring-black/10 dark:ring-white/15'
  }`

  return (
    <EditorShell onBackdropClick={close}>
      <EditorTopBar
        left={
          <TooltipButton tooltip="关闭" className={EDITOR_ICON_BUTTON_CLASS} disabled={isSaving} onClick={close}>
            <CloseIcon className="h-5 w-5" />
          </TooltipButton>
        }
        center={
          <>
            <TooltipButton tooltip="选择" className={getEditorToolButtonClass(tool === 'select')} disabled={!isReady} onClick={() => selectTool('select')}>
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 4.5 19 11l-6.2 1.8L10 19z" />
              </svg>
            </TooltipButton>
            <TooltipButton tooltip="画笔" className={getEditorToolButtonClass(tool === 'pen')} disabled={!isReady} onClick={() => selectTool('pen')}>
              <PenIcon />
            </TooltipButton>
            <TooltipButton tooltip="文字" className={getEditorToolButtonClass(tool === 'text')} disabled={!isReady} onClick={() => selectTool('text')}>
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 7V4.5h14V7M12 4.5v15M9 19.5h6" />
              </svg>
            </TooltipButton>
            <div ref={shapeMenuRef} className="relative inline-flex">
              <TooltipButton
                tooltip={`图形：${SHAPE_LABELS[shape]}`}
                className={getEditorToolButtonClass(tool === 'shape')}
                disabled={!isReady}
                onClick={() => {
                  if (editingRef.current) textareaRef.current?.blur()
                  setShowShapeMenu((v) => !v)
                }}
              >
                {tool === 'shape' ? <ShapeIcon shape={shape} /> : (
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8.3 10a.7.7 0 0 1-.63-1.08L11.4 3a.7.7 0 0 1 1.2-.04L16.3 8.9a.7.7 0 0 1-.57 1.1z" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <circle cx="17.5" cy="17.5" r="3.5" />
                  </svg>
                )}
              </TooltipButton>
              {showShapeMenu && (
                <div className="absolute left-1/2 top-full z-30 mt-2 grid w-max -translate-x-1/2 grid-cols-4 gap-1 rounded-2xl border border-gray-200/80 bg-white/95 p-1.5 shadow-xl backdrop-blur-md animate-fade-in dark:border-white/[0.08] dark:bg-gray-800/95">
                  {SKETCH_SHAPES.map((item) => (
                    <TooltipButton
                      key={item}
                      tooltip={SHAPE_LABELS[item]}
                      className={`flex h-9 w-9 items-center justify-center rounded-xl transition ${
                        tool === 'shape' && shape === item
                          ? 'bg-blue-50 text-blue-500 dark:bg-blue-500/15 dark:text-blue-400'
                          : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.08]'
                      }`}
                      onClick={() => {
                        setShape(item)
                        selectTool('shape')
                      }}
                    >
                      <ShapeIcon shape={item} />
                    </TooltipButton>
                  ))}
                </div>
              )}
            </div>
            <TooltipButton tooltip="橡皮擦" className={getEditorToolButtonClass(tool === 'eraser')} disabled={!isReady} onClick={() => selectTool('eraser')}>
              <EraserIcon />
            </TooltipButton>
            <TooltipButton tooltip="评论" className={getEditorToolButtonClass(tool === 'comment')} disabled={!isReady} onClick={() => selectTool('comment')}>
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8.5a1.5 1.5 0 0 1-1.5 1.5H12l-4.5 3.5v-3.5h-2A1.5 1.5 0 0 1 4 15V6.5A1.5 1.5 0 0 1 5.5 5zM8.5 9.5h7M8.5 12.5h4" />
              </svg>
            </TooltipButton>
          </>
        }
        right={
          <>
            <TooltipButton tooltip="撤销" className={EDITOR_ICON_BUTTON_CLASS} disabled={!canUndo} onClick={undo}>
              <UndoIcon />
            </TooltipButton>
            <TooltipButton tooltip="重做" className={EDITOR_ICON_BUTTON_CLASS} disabled={!canRedo} onClick={redo}>
              <RedoIcon />
            </TooltipButton>
            <TooltipButton tooltip="清空画布" wrapperClassName="relative hidden sm:inline-flex" className={EDITOR_ICON_BUTTON_CLASS} disabled={(elements.length === 0 && !hasVisibleMarkup) || isSaving} onClick={clearAll}>
              <ClearIcon />
            </TooltipButton>
          </>
        }
      />

      {/* 画布区域：整个区域都是缩放视口，放大后画布可铺满 */}
      <div className="relative min-h-0 flex-1 bg-gray-100/70 dark:bg-black/25">
        <div
          ref={viewRef}
          className="absolute inset-0 flex touch-none select-none items-center justify-center overflow-hidden py-4 pl-16 pr-4 sm:px-20 sm:py-6"
          style={{ containerType: 'size', cursor: canvasCursor }}
          onMouseDown={(e) => {
            // 不让点击画布抢走文字或评论输入框的焦点
            if (!(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) e.preventDefault()
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={finishGesture}
          onLostPointerCapture={finishGesture}
          onPointerLeave={() => setHoverPoint(null)}
          onDoubleClick={handleDoubleClick}
        >
          {docSize && (
            <div
              ref={frameRef}
              className="relative max-h-full max-w-full"
              style={{
                aspectRatio: `${docSize.width} / ${docSize.height}`,
                width: `min(100%, 100cqh * ${docSize.width / docSize.height})`,
              }}
            >
              <div
                className="absolute inset-0 will-change-transform"
                style={{
                  transform: `matrix(${viewport.transform.scale}, 0, 0, ${viewport.transform.scale}, ${viewport.transform.x}, ${viewport.transform.y})`,
                  transformOrigin: '0 0',
                }}
              >
                <div className="absolute inset-0 overflow-hidden rounded-lg shadow-sm ring-1 ring-black/5 dark:ring-white/10" style={{ background: paperColor }}>
                  <canvas
                    ref={canvasRef}
                    width={docSize.width}
                    height={docSize.height}
                    className="absolute inset-0 h-full w-full"
                  />
                  <canvas
                    ref={overlayRef}
                    width={docSize.width}
                    height={docSize.height}
                    className="pointer-events-none absolute inset-0 h-full w-full"
                  />
                </div>
                {editingText && (
                  <textarea
                    ref={textareaRef}
                    value={editingText.text}
                    onChange={(e) => setEditingText({ ...editingText, text: e.target.value })}
                    onBlur={commitText}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.blur()
                    }}
                    spellCheck={false}
                    wrap="off"
                    className="absolute resize-none overflow-hidden whitespace-pre border-0 bg-transparent p-0 outline-dashed outline-[1.5px] outline-offset-[6px] outline-blue-500"
                    style={{
                      left: editingText.x * cssScale,
                      top: editingText.y * cssScale,
                      width: ((editingSize?.width ?? 0) + editingText.fontSize) * cssScale,
                      height: (editingSize?.height ?? editingText.fontSize * SKETCH_LINE_HEIGHT) * cssScale,
                      fontSize: editingText.fontSize * cssScale,
                      lineHeight: SKETCH_LINE_HEIGHT,
                      fontFamily: SKETCH_FONT_FAMILY,
                      color: editingText.color,
                      caretColor: editingText.color,
                    }}
                  />
                )}
              </div>
              {brushRingPoint && (
                <BrushCursor
                  x={brushRingPoint.x * viewScale + viewport.transform.x}
                  y={brushRingPoint.y * viewScale + viewport.transform.y}
                  size={strokeWidth * viewScale}
                />
              )}
              <SketchCommentLayer
                comments={comments}
                activeId={activeCommentId}
                docSize={docSize}
                viewScale={viewScale}
                offset={viewport.transform}
                bounds={activeCommentId ? getCommentEditorBounds() : null}
                interactive={tool === 'comment' || tool === 'select'}
                canOpen={tool === 'comment'}
                toDocPoint={toDocPoint}
                onMove={moveComment}
                onMoveEnd={finishMove}
                onOpen={openComment}
                onChangeText={(id, text) => updateComment(id, { text })}
                onFinish={finishComment}
                onDelete={removeComment}
              />
            </div>
          )}
        </div>
        {!isReady && (
          <div className="absolute inset-0 z-20 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            正在载入底图...
          </div>
        )}

        <EditorSizeSlider
          value={strokeWidth}
          min={SKETCH_MIN_STROKE}
          max={SKETCH_MAX_STROKE}
          label={tool === 'text' ? '字号' : '粗细'}
          displayValue={tool === 'text' ? getSketchFontSize(strokeWidth) : strokeWidth}
          disabled={!isReady}
          onChange={applyStrokeWidth}
          onAdjustStart={() => {
            widthBeforeRef.current = elements
            setIsAdjustingWidth(true)
          }}
          onAdjustEnd={() => {
            setIsAdjustingWidth(false)
            const before = widthBeforeRef.current
            widthBeforeRef.current = null
            if (before && before !== elements) pushHistory(before)
          }}
        />

        {viewport.isZoomed && <EditorResetViewButton onClick={() => viewport.commit()} />}
      </div>

      {/* 底部颜色与确认 */}
      <div className="flex flex-none items-center gap-3 px-3 py-3 sm:px-4">
        {/* 点按色块不抢焦点，输入文字时可以直接换色 */}
        <div ref={swatchesRef} onMouseDown={(e) => e.preventDefault()} className="flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto px-2 py-1.5 sm:justify-center [scrollbar-width:none]">
          <span
            className="relative inline-flex flex-none"
            {...customColorTooltip.handlers}
            onClick={() => {
              customColorTooltip.dismiss()
              // 点击时先切回上次的自定义颜色，同时打开取色器便于继续调整
              if (customColor) applyColor(customColor)
            }}
          >
            <label
              className={`${swatchClass(customColor !== null && color === customColor)} relative cursor-pointer overflow-hidden`}
              style={{ background: 'conic-gradient(from 90deg, #ef4444, #f59e0b, #eab308, #22c55e, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)' }}
            >
              {customColor && <span className="absolute inset-[5px] rounded-full ring-2 ring-white" style={{ background: customColor }} />}
              <input
                ref={colorInputRef}
                type="color"
                value={customColor ?? (/^#[0-9a-f]{6}$/i.test(color) ? color : '#000000')}
                onChange={(e) => previewCustomColor(e.target.value)}
                onBlur={commitCustomColor}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="自定义颜色"
              />
            </label>
            <ViewportTooltip visible={customColorTooltip.visible} className="whitespace-nowrap">自定义颜色</ViewportTooltip>
          </span>
          {[{ value: inkColor, label: isDark ? '白色' : '黑色' }, ...PALETTE].map((item) => (
            <TooltipButton
              key={item.value}
              tooltip={item.label}
              wrapperClassName="relative inline-flex flex-none"
              className={swatchClass(color === item.value)}
              onClick={() => applyColor(item.value)}
            >
              <span className="block h-full w-full rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15" style={{ background: item.value }} />
            </TooltipButton>
          ))}
        </div>
        <button
          onClick={handleConfirm}
          disabled={!canConfirm || isSaving}
          className="flex h-10 flex-none items-center gap-1.5 rounded-xl bg-blue-500 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-blue-600 active:bg-blue-700 disabled:opacity-50"
        >
          <CheckIcon />
          {isSaving ? '保存中...' : '完成'}
        </button>
      </div>
    </EditorShell>
  )
}
