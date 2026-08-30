import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectCanvasCrop, ProjectCanvasItem, ProjectCanvasState, ProjectCanvasViewport, TaskRecord } from '../types'
import {
  ALL_FAVORITES_COLLECTION_ID,
  ALL_PROJECTS_ID,
  LOCAL_PROJECT_ID,
  editOutputImage,
  ensureImageCached,
  ensureImageThumbnailCached,
  getImageFavoriteCollectionIds,
  removeOutputImage,
  removeTask,
  reuseImageConfig,
  retryImage,
  subscribeImageThumbnail,
  taskMatchesFilterStatus,
  taskMatchesSearchQuery,
  useStore,
} from '../store'
import {
  DEFAULT_CANVAS_ITEM_WIDTH,
  clampCanvasScale,
  ensureProjectCanvas,
  findAvailableCanvasItemPosition,
  getDefaultCanvasItem,
  isCanvasRectVisible,
  zoomCanvasViewport,
} from '../lib/projectCanvas'
import { copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { getTaskIds } from '../lib/taskIds'
import { downloadImageIds, exportImage, type ImageExportFormat } from '../lib/downloadImages'
import { uploadMaterialImage } from '../lib/materialApi'
import { TooltipButton } from './TooltipButton'
import SearchBar from './SearchBar'
import {
  AngleIcon,
  CloudUploadIcon,
  ChevronDownIcon,
  CropIcon,
  CopyIcon,
  DownloadIcon,
  EditIcon,
  ExportIcon,
  FavoriteIcon,
  FlipHorizontalIcon,
  FlipVerticalIcon,
  HomeIcon,
  ImageIcon,
  InfoIcon,
  LayersIcon,
  MapIcon,
  RefreshIcon,
  ScaleIcon,
  RotateIcon,
  RotateLeftIcon,
  RotateRightIcon,
  ReuseConfigIcon,
  TrashIcon,
  WarningIcon,
} from './icons'

type CanvasNode = {
  key: string
  imageId?: string
  task: TaskRecord
  status: 'done' | 'running' | 'error'
  previewSrc?: string
  error?: string
  placeholderDimensions?: { width: number; height: number }
  placeholderName?: string
}

function cloneCanvasState(state: ProjectCanvasState): ProjectCanvasState {
  return {
    ...state,
    viewport: { ...state.viewport },
    items: Object.fromEntries(Object.entries(state.items).map(([key, item]) => [key, {
      ...item,
      ...(item.operator ? {
        operator: {
          ...item.operator,
          ...(item.operator.crop ? { crop: { ...item.operator.crop } } : {}),
        },
      } : {}),
    }])),
  }
}

function canvasItemsEqual(left: ProjectCanvasState, right: ProjectCanvasState) {
  const leftKeys = Object.keys(left.items)
  const rightKeys = Object.keys(right.items)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => key in right.items && JSON.stringify(left.items[key]) === JSON.stringify(right.items[key]))
}

function HighlightedSearchText({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return text
  const lowerText = text.toLowerCase()
  const lowerQuery = normalizedQuery.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let matchIndex = lowerText.indexOf(lowerQuery)
  while (matchIndex >= 0) {
    if (matchIndex > cursor) parts.push(text.slice(cursor, matchIndex))
    parts.push(<mark key={matchIndex} className="rounded bg-yellow-300/90 px-0.5 text-gray-950 dark:bg-yellow-300 dark:text-gray-950">{text.slice(matchIndex, matchIndex + normalizedQuery.length)}</mark>)
    cursor = matchIndex + normalizedQuery.length
    matchIndex = lowerText.indexOf(lowerQuery, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

function getSearchSnippet(text: string, query: string, maxLength: number) {
  const normalizedQuery = query.trim()
  if (!normalizedQuery || text.length <= maxLength) return text
  const matchIndex = text.toLowerCase().indexOf(normalizedQuery.toLowerCase())
  if (matchIndex < 0) return text.slice(0, maxLength)
  const matchEnd = matchIndex + normalizedQuery.length
  if (maxLength <= normalizedQuery.length + 2) return text.slice(matchIndex, matchEnd)
  const sideLength = Math.max(1, Math.floor((maxLength - normalizedQuery.length - 2) / 2))
  const start = Math.max(0, matchIndex - sideLength)
  const end = Math.min(text.length, matchEnd + sideLength)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  return prefix + text.slice(start, end) + suffix
}

const EMPTY_PROJECT_CANVAS_CACHE: Record<string, ProjectCanvasState> = {}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function centroid(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function normalizeCanvasRotation(value: number) {
  const normalized = ((value % 360) + 360) % 360
  return normalized < 0.5 || normalized > 359.5 ? 0 : normalized
}

function getCanvasConnectionPoint(center: { x: number; y: number }, other: { x: number; y: number }, width: number, height: number) {
  const dx = other.x - center.x
  const dy = other.y - center.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    const side = dx >= 0 ? 1 : -1
    return { x: center.x + side * width / 2, y: center.y }
  }
  const side = dy >= 0 ? 1 : -1
  return { x: center.x, y: center.y + side * height / 2 }
}

function getCanvasConnectionPath(start: { x: number; y: number }, end: { x: number; y: number }) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const horizontal = Math.abs(dx) >= Math.abs(dy)
  const offset = Math.max(28, Math.min(120, (horizontal ? Math.abs(dx) : Math.abs(dy)) * 0.45))
  const control = horizontal
    ? { x: Math.sign(dx || 1) * offset, y: (Math.sign(dy) || 1) * Math.max(18, offset * Math.tan(Math.PI / 6)) }
    : { x: (Math.sign(dx) || 1) * Math.max(18, offset * Math.tan(Math.PI / 6)), y: Math.sign(dy || 1) * offset }
  return `M ${start.x} ${start.y} C ${start.x + control.x} ${start.y + control.y}, ${end.x - control.x} ${end.y - control.y}, ${end.x} ${end.y}`
}

function getPlaceholderDimensions(task: TaskRecord) {
  const match = /^([1-9]\d*)x([1-9]\d*)$/i.exec(task.params.size.trim())
  if (!match) return { width: 1024, height: 1024 }
  return { width: Number(match[1]), height: Number(match[2]) }
}

function CanvasEdgeIndicator({ node, item, ratio, viewport, containerSize, onClick }: {
  node: CanvasNode
  item: ProjectCanvasItem
  ratio: number
  viewport: ProjectCanvasViewport
  containerSize: { width: number; height: number }
  onClick: () => void
}) {
  const [src, setSrc] = useState(node.previewSrc ?? '')
  const imageHeight = item.width / Math.max(0.01, ratio)

  useEffect(() => {
    if (node.previewSrc) {
      setSrc(node.previewSrc)
      return
    }
    if (!node.imageId) {
      setSrc('')
      return
    }
    let cancelled = false
    const unsubscribe = subscribeImageThumbnail(node.imageId, (thumbnail) => {
      if (!cancelled) setSrc(thumbnail.dataUrl)
    })
    void ensureImageThumbnailCached(node.imageId).then((thumbnail) => {
      if (!cancelled && thumbnail) setSrc(thumbnail.dataUrl)
    }).catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [node.imageId, node.previewSrc])

  if (containerSize.width <= 0 || containerSize.height <= 0 || isCanvasRectVisible(item, imageHeight, viewport, containerSize, 0)) return null

  const center = {
    x: viewport.x + (item.x + item.width / 2) * viewport.scale,
    y: viewport.y + (item.y + imageHeight / 2) * viewport.scale,
  }
  const canvasCenter = { x: containerSize.width / 2, y: containerSize.height / 2 }
  const vector = { x: center.x - canvasCenter.x, y: center.y - canvasCenter.y }
  const halfWidth = Math.max(1, canvasCenter.x - 8)
  const halfHeight = Math.max(1, canvasCenter.y - 8)
  const edgeScale = Math.min(
    vector.x === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(vector.x),
    vector.y === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(vector.y),
  )
  const point = {
    x: canvasCenter.x + vector.x * edgeScale,
    y: canvasCenter.y + vector.y * edgeScale,
  }
  const indicatorWidth = 148
  const indicatorHeight = 42
  const left = Math.min(Math.max(4, point.x - indicatorWidth / 2), Math.max(4, containerSize.width - indicatorWidth - 4))
  const top = Math.min(Math.max(4, point.y - indicatorHeight / 2), Math.max(4, containerSize.height - indicatorHeight - 4))
  const label = item.name ?? node.placeholderName ?? node.imageId ?? '图片'
  const isError = node.status === 'error'

  return (
    <button
      type="button"
      data-canvas-edge-indicator
      aria-label={`跳转到${label}`}
      title={`跳转到${label}`}
      className="absolute z-[35] flex h-[42px] w-[148px] items-center gap-2 rounded-md border border-gray-200 bg-white/95 px-1.5 text-left shadow-md backdrop-blur transition hover:border-[#3f78c5] hover:shadow-lg dark:border-white/[0.12] dark:bg-gray-900/95"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded border ${isError ? 'border-red-200 bg-red-100 text-red-600 dark:border-red-900/70 dark:bg-red-950/60 dark:text-red-400' : 'border-gray-200 bg-gray-100 dark:border-white/[0.1] dark:bg-gray-800'}`}>
        {src ? <img src={src} alt="" draggable={false} className="h-full w-full object-cover" /> : isError ? <WarningIcon className="h-4 w-4" /> : <ImageIcon className="h-4 w-4 text-gray-400 dark:text-gray-500" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-700 dark:text-gray-200">{label}</span>
    </button>
  )
}

function CanvasImageNode({
  node,
  item,
  selected,
  multiSelected,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onRotateStart,
  onRotateMove,
  onRotateEnd,
  onDoubleClick,
  onRatio,
  onDimensions,
  onRename,
  onCopyImageId,
  onCopyFailureId,
  onCopyFailureError,
  cropEditing,
  onCropCommit,
  onCropCancel,
  viewportScale,
  interactionActive,
  searchQuery,
}: {
  node: CanvasNode
  item: ProjectCanvasItem
  selected: boolean
  multiSelected: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerEnd: (event: ReactPointerEvent<HTMLDivElement>) => void
  onResizeStart: (corner: ResizeCorner, event: ReactPointerEvent<HTMLButtonElement>) => void
  onResizeMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onResizeEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onRotateStart: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onRotateMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onRotateEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onDoubleClick: () => void
  onRatio: (ratio: number) => void
  onDimensions: (width: number, height: number) => void
  onRename: (name: string) => boolean
  onCopyImageId: (imageId: string) => void
  onCopyFailureId: (label: 'request_id' | 'task_id', value: string) => void
  onCopyFailureError: (value: string) => void
  cropEditing: boolean
  onCropCommit: (crop: ProjectCanvasCrop) => void
  onCropCancel: () => void
  viewportScale: number
  interactionActive: boolean
  searchQuery: string
}) {
  const [src, setSrc] = useState(node.previewSrc ?? '')
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(node.placeholderDimensions ?? null)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(item.name ?? node.imageId ?? '')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const nodeRef = useRef<HTMLDivElement>(null)
  const cropStageRef = useRef<HTMLImageElement>(null)
  const cropDragRef = useRef<{ pointerId: number; corner: CropHandle; startX: number; startY: number; crop: ProjectCanvasCrop; stageWidth: number; stageHeight: number } | null>(null)
  const [cropDraft, setCropDraft] = useState<ProjectCanvasCrop>(item.operator?.crop ?? { x: 0, y: 0, width: 1, height: 1 })
  const [cropSizeDraft, setCropSizeDraft] = useState({ width: '', height: '' })
  const [cropPanelPosition, setCropPanelPosition] = useState<{ left: number; top: number } | null>(null)
  const onRatioRef = useRef(onRatio)
  const onDimensionsRef = useRef(onDimensions)
  const metadataScale = 1 / Math.max(viewportScale, 0.01)
  const selectionStrokeWidth = 2 / Math.max(viewportScale, 0.01)
  const handleScale = metadataScale
  const flipX = item.operator?.flipX === true
  const flipY = item.operator?.flipY === true
  const handleOffset = -5
  const rotationOffset = -26 - 6 * handleScale
  const connectorOffset = -20 * handleScale

  const updateDimensions = (width?: number, height?: number) => {
    if (!width || !height) return
    setDimensions((current) => current?.width === width && current.height === height ? current : { width, height })
    onRatioRef.current(width / height)
    onDimensionsRef.current(width, height)
  }

  useEffect(() => {
    onRatioRef.current = onRatio
    onDimensionsRef.current = onDimensions
  }, [onDimensions, onRatio])

  useEffect(() => {
    if (!editingName) return
    nameInputRef.current?.focus()
    nameInputRef.current?.select()
  }, [editingName])

  useEffect(() => {
    if (!cropEditing) return
    const next = item.operator?.crop ?? { x: 0, y: 0, width: 1, height: 1 }
    setCropDraft(next)
    if (dimensions) setCropSizeDraft({ width: String(Math.round(dimensions.width * next.width)), height: String(Math.round(dimensions.height * next.height)) })
  }, [cropEditing, dimensions, item.operator?.crop])

  useEffect(() => {
    if (node.previewSrc) {
      setSrc(node.previewSrc)
      return
    }
    if (!node.imageId) {
      setSrc('')
      return
    }

    let cancelled = false
    const unsubscribe = subscribeImageThumbnail(node.imageId, (thumbnail) => {
      if (cancelled) return
      setSrc(thumbnail.dataUrl)
      updateDimensions(thumbnail.width, thumbnail.height)
    })
    void ensureImageThumbnailCached(node.imageId).then((thumbnail) => {
      if (cancelled || !thumbnail) return
      setSrc(thumbnail.dataUrl)
      updateDimensions(thumbnail.width, thumbnail.height)
    }).catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [node.imageId, node.previewSrc])

  const statusText = node.status === 'running' ? '生成中' : node.status === 'error' ? '生成失败' : ''
  const taskIds = getTaskIds(node.task)
  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  const imageLabel = item.name ?? node.placeholderName ?? node.imageId ?? '图片'
  const nameSearchMatch = Boolean(normalizedSearchQuery && imageLabel.toLowerCase().includes(normalizedSearchQuery))
  const promptSearchMatch = Boolean(normalizedSearchQuery && (node.task.prompt || '').toLowerCase().includes(normalizedSearchQuery))
  const promptOverlayWidth = Math.max(1, Math.min(240, item.width * viewportScale - 16))
  const promptTextWidth = Math.max(1, promptOverlayWidth - 16)
  const promptSnippet = getSearchSnippet(node.task.prompt, searchQuery, Math.max(normalizedSearchQuery.length + 2, Math.floor(promptTextWidth / 7)))
  const commitName = () => {
    const name = nameDraft.trim()
    if (!name || name === item.name) {
      setEditingName(false)
      return
    }
    if (onRename(name)) setEditingName(false)
  }

  const sourceRatio = dimensions ? dimensions.width / Math.max(1, dimensions.height) : 1
  const crop = item.operator?.crop
  const frameHeight = cropEditing
      ? item.width / sourceRatio
      : crop
        ? item.width * crop.height / (sourceRatio * crop.width)
      : dimensions
        ? item.width / sourceRatio
      : undefined
  const showResolution = item.width * viewportScale >= 160

  const setCropSelection = (next: ProjectCanvasCrop) => {
    setCropDraft(next)
    if (dimensions) setCropSizeDraft({ width: String(Math.round(dimensions.width * next.width)), height: String(Math.round(dimensions.height * next.height)) })
  }

  const updateCropSize = (axis: 'width' | 'height', value: string) => {
    setCropSizeDraft((current) => ({ ...current, [axis]: value }))
    if (!dimensions) return
    const pixels = Number(value)
    if (!Number.isFinite(pixels) || pixels <= 0) return
    const sourceSize = axis === 'width' ? dimensions.width : dimensions.height
    const normalizedSize = Math.min(1, Math.max(0.05, pixels / sourceSize))
    const center = axis === 'width' ? cropDraft.x + cropDraft.width / 2 : cropDraft.y + cropDraft.height / 2
    const start = Math.min(1 - normalizedSize, Math.max(0, center - normalizedSize / 2))
    setCropDraft(axis === 'width'
      ? { ...cropDraft, x: start, width: normalizedSize }
      : { ...cropDraft, y: start, height: normalizedSize })
  }

  const restoreCropSizeDraft = () => {
    if (!dimensions) return
    setCropSizeDraft({ width: String(Math.round(dimensions.width * cropDraft.width)), height: String(Math.round(dimensions.height * cropDraft.height)) })
  }

  useLayoutEffect(() => {
    if (!cropEditing || !dimensions || !nodeRef.current || typeof window === 'undefined') {
      setCropPanelPosition(null)
      return
    }
    const nodeRect = nodeRef.current.getBoundingClientRect()
    const canvasRect = nodeRef.current.closest<HTMLElement>('[data-project-canvas]')?.getBoundingClientRect()
    const panelWidth = 192
    const panelHeight = 210
    const gap = 12
    const minLeft = (canvasRect?.left ?? 0) + 8
    const maxRight = (canvasRect?.right ?? window.innerWidth) - 8
    const preferredRight = nodeRect.right + gap
    const left = preferredRight + panelWidth <= maxRight
      ? preferredRight
      : Math.max(minLeft, nodeRect.left - panelWidth - gap)
    const minTop = (canvasRect?.top ?? 0) + 8
    const maxTop = (canvasRect?.bottom ?? window.innerHeight) - panelHeight - 8
    const top = Math.min(Math.max(nodeRect.top, minTop), Math.max(minTop, maxTop))
    setCropPanelPosition((current) => current?.left === left && current.top === top ? current : { left, top })
  })

  const handleCropResizeStart = (corner: ResizeCorner, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const rect = cropStageRef.current?.getBoundingClientRect()
    if (!rect) return
    event.currentTarget.setPointerCapture(event.pointerId)
    cropDragRef.current = {
      pointerId: event.pointerId,
      corner,
      startX: event.clientX,
      startY: event.clientY,
      crop: cropDraft,
      stageWidth: rect.width,
      stageHeight: rect.height,
    }
  }

  const handleCropMoveStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    const rect = cropStageRef.current?.getBoundingClientRect()
    if (!rect) return
    event.currentTarget.setPointerCapture(event.pointerId)
    cropDragRef.current = {
      pointerId: event.pointerId,
      corner: 'move',
      startX: event.clientX,
      startY: event.clientY,
      crop: cropDraft,
      stageWidth: rect.width,
      stageHeight: rect.height,
    }
  }

  const handleCropResizeMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = cropDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = (event.clientX - drag.startX) / Math.max(1, drag.stageWidth)
    const dy = (event.clientY - drag.startY) / Math.max(1, drag.stageHeight)
    if (drag.corner === 'move') {
      setCropSelection({
        ...drag.crop,
        x: Math.min(1 - drag.crop.width, Math.max(0, drag.crop.x + dx)),
        y: Math.min(1 - drag.crop.height, Math.max(0, drag.crop.y + dy)),
      })
      return
    }
    const right = drag.crop.x + drag.crop.width
    const bottom = drag.crop.y + drag.crop.height
    const minSize = 0.05
    const left = drag.corner.includes('w') ? Math.min(Math.max(0, drag.crop.x + dx), right - minSize) : drag.crop.x
    const top = drag.corner.includes('n') ? Math.min(Math.max(0, drag.crop.y + dy), bottom - minSize) : drag.crop.y
    const nextRight = drag.corner.includes('e') ? Math.max(Math.min(1, right + dx), left + minSize) : right
    const nextBottom = drag.corner.includes('s') ? Math.max(Math.min(1, bottom + dy), top + minSize) : bottom
    setCropSelection({ x: left, y: top, width: nextRight - left, height: nextBottom - top })
  }

  const handleCropResizeEnd = (event: ReactPointerEvent<HTMLElement>) => {
    if (cropDragRef.current?.pointerId !== event.pointerId) return
    cropDragRef.current = null
  }

  const handleCropPreset = (ratio: number) => {
    const normalizedRatio = ratio / sourceRatio
    const width = normalizedRatio >= 1 ? 1 : normalizedRatio
    const height = normalizedRatio >= 1 ? 1 / normalizedRatio : 1
    setCropSelection({ x: (1 - width) / 2, y: (1 - height) / 2, width, height })
  }

  return (
    <div
      ref={nodeRef}
      data-canvas-node
      data-node-key={node.key}
      className="absolute select-none"
      style={{
        left: item.x,
        top: item.y,
        width: item.width,
        transform: `rotate(${normalizeCanvasRotation(item.rotation ?? item.operator?.rotation ?? 0)}deg)`,
        transformOrigin: 'center center',
        zIndex: selected || multiSelected ? Math.max(item.z, 1000) : item.z,
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={(event) => {
        if ((event.target as Element).closest('[data-canvas-image-name], [data-canvas-image-name-container]')) return
        onDoubleClick()
      }}
      title={node.error}
    >
      <div
        className={`relative ${cropEditing || promptSearchMatch ? 'overflow-visible' : 'overflow-hidden'} bg-white shadow-sm dark:bg-gray-900 ${selected || multiSelected ? 'ring-0' : 'ring-1 ring-black/10 dark:ring-white/10'}`}
        style={{
          ...(!cropEditing && (selected || multiSelected) ? { boxShadow: `0 0 0 ${selectionStrokeWidth}px #3f78c5` } : {}),
          ...(frameHeight ? { height: frameHeight } : {}),
        }}
      >
        {src ? <img
          ref={cropEditing ? cropStageRef : undefined}
          src={src}
          data-image-id={node.imageId}
          data-output-image-ids={node.imageId}
          draggable={false}
          alt=""
          className={cropEditing || crop ? 'absolute max-w-none' : 'block h-auto w-full object-contain'}
          style={cropEditing && dimensions
            ? { width: '100%', height: '100%', left: 0, top: 0, objectFit: 'fill', ...(flipX || flipY ? { transform: `scaleX(${flipX ? -1 : 1}) scaleY(${flipY ? -1 : 1})` } : {}) }
            : crop && dimensions
              ? { width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, left: `${-crop.x / crop.width * 100}%`, top: `${-crop.y / crop.height * 100}%`, ...(flipX || flipY ? { transform: `scaleX(${flipX ? -1 : 1}) scaleY(${flipY ? -1 : 1})` } : {}) }
              : flipX || flipY ? { transform: `scaleX(${flipX ? -1 : 1}) scaleY(${flipY ? -1 : 1})` } : undefined}
        /> : (
          <div className={`relative flex w-full items-center justify-center overflow-hidden text-xs ${node.status === 'error' ? 'border border-red-200 bg-red-100 text-red-700 dark:border-red-900/70 dark:bg-red-950/60 dark:text-red-300' : 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`} style={{ height: frameHeight ?? item.width }}>
            {node.status === 'running' && <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <span className="canvas-generation-glow-base" />
              <span className="canvas-generation-glow" />
            </div>}
            <div className="relative z-10 flex h-full w-full flex-col items-center justify-center gap-2">
              {node.status === 'error'
                ? <WarningIcon className="h-32 w-32 text-red-600 dark:text-red-400" />
                : <ImageIcon className={`h-[7.5rem] w-[7.5rem] text-[#3f78c5]/70 ${node.status === 'running' ? 'animate-pulse' : ''}`} />}
              {node.status === 'running'
                ? <span>{statusText}</span>
                : <span className={node.status === 'error' ? 'text-4xl font-medium' : undefined}>{statusText}</span>}
              {node.status === 'error' && node.error && (
                <>
                  <span className="flex max-w-[92%] items-center gap-1">
                    <span
                      className="max-h-24 min-w-0 flex-1 overflow-hidden break-words text-center text-base leading-6 text-red-700 dark:text-red-300"
                      title={node.error}
                      style={{
                        display: '-webkit-box',
                        WebkitBoxOrient: 'vertical',
                        WebkitLineClamp: 4,
                      }}
                    >
                      {node.error}
                    </span>
                    <button type="button" data-canvas-handle className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-red-600 hover:bg-red-200/70 dark:text-red-300 dark:hover:bg-red-900/50" aria-label="复制错误原因" title="复制错误原因" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onCopyFailureError(node.error!) }}><CopyIcon className="h-4 w-4" /></button>
                  </span>
                  {(node.task.requestId || taskIds.length > 0) && (
                    <span className="flex max-w-[92%] flex-col items-center gap-1 text-center font-mono text-base leading-6 text-red-600/90 dark:text-red-300/90">
                      {node.task.requestId && <span className="flex max-w-full items-center gap-1 break-all"><span>request_id: {node.task.requestId}</span><button type="button" data-canvas-handle className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-red-600 hover:bg-red-200/70 dark:text-red-300 dark:hover:bg-red-900/50" aria-label="复制 request_id" title="复制 request_id" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onCopyFailureId('request_id', node.task.requestId!) }}><CopyIcon className="h-3.5 w-3.5" /></button></span>}
                      {taskIds.map((id) => <span key={id} className="flex max-w-full items-center gap-1 break-all"><span>task_id: {id}</span><button type="button" data-canvas-handle className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-red-600 hover:bg-red-200/70 dark:text-red-300 dark:hover:bg-red-900/50" aria-label="复制 task_id" title="复制 task_id" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onCopyFailureId('task_id', id) }}><CopyIcon className="h-3.5 w-3.5" /></button></span>)}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        {cropEditing && dimensions && (
          <div className="absolute inset-0 z-[60]" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
            <div className="absolute inset-x-0 top-0 bg-black/25" style={{ height: `${cropDraft.y * 100}%` }} />
            <div className="absolute inset-x-0 bottom-0 bg-black/25" style={{ height: `${(1 - cropDraft.y - cropDraft.height) * 100}%` }} />
            <div className="absolute bg-black/25" style={{ left: 0, top: `${cropDraft.y * 100}%`, width: `${cropDraft.x * 100}%`, height: `${cropDraft.height * 100}%` }} />
            <div className="absolute right-0 bg-black/25" style={{ top: `${cropDraft.y * 100}%`, width: `${(1 - cropDraft.x - cropDraft.width) * 100}%`, height: `${cropDraft.height * 100}%` }} />
            <div
              className="absolute cursor-move border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.65)]"
              style={{ left: `${cropDraft.x * 100}%`, top: `${cropDraft.y * 100}%`, width: `${cropDraft.width * 100}%`, height: `${cropDraft.height * 100}%` }}
              onPointerDown={handleCropMoveStart}
              onPointerMove={handleCropResizeMove}
              onPointerUp={handleCropResizeEnd}
              onPointerCancel={handleCropResizeEnd}
            >
              <span className="pointer-events-none absolute left-1/3 top-0 h-full border-l border-white/70" />
              <span className="pointer-events-none absolute left-2/3 top-0 h-full border-l border-white/70" />
              <span className="pointer-events-none absolute left-0 top-1/3 w-full border-t border-white/70" />
              <span className="pointer-events-none absolute left-0 top-2/3 w-full border-t border-white/70" />
              {(['nw', 'ne', 'sw', 'se'] as ResizeCorner[]).map((corner) => <button
                key={corner}
                type="button"
                data-canvas-handle
                aria-label={`调整裁剪区域${corner}`}
                className={`absolute h-2.5 w-2.5 rounded-full border border-gray-600 bg-gray-400 shadow ${corner === 'nw' ? 'cursor-nwse-resize' : corner === 'ne' ? 'cursor-nesw-resize' : corner === 'sw' ? 'cursor-nesw-resize' : 'cursor-nwse-resize'}`}
                style={{
                  left: corner === 'nw' || corner === 'sw' ? -5 : undefined,
                  right: corner === 'ne' || corner === 'se' ? -5 : undefined,
                  top: corner === 'nw' || corner === 'ne' ? -5 : undefined,
                  bottom: corner === 'sw' || corner === 'se' ? -5 : undefined,
                  transform: `scale(${handleScale})`,
                  transformOrigin: 'center center',
                }}
                onPointerDown={(event) => handleCropResizeStart(corner, event)}
                onPointerMove={handleCropResizeMove}
                onPointerUp={handleCropResizeEnd}
                onPointerCancel={handleCropResizeEnd}
              />)}
            </div>
          </div>
        )}
        {import.meta.env.DEV && node.imageId && (
          <span
            data-canvas-debug-position
            className="pointer-events-none absolute left-0 top-0 z-10 whitespace-nowrap px-0.5 font-mono text-[10px] font-semibold leading-3 text-[#3f78c5]"
            style={{
              transform: `translate(3px, 3px) scale(${metadataScale})`,
              transformOrigin: 'left top',
              textShadow: '0 0 2px rgba(255, 255, 255, 0.9)',
            }}
          >
            x: {Math.round(item.x)}, y: {Math.round(item.y)}
          </span>
        )}
        {statusText && src && (
          <span className={`absolute bottom-2 left-2 rounded px-2 py-1 text-xs text-white backdrop-blur ${node.status === 'running' ? 'bg-[#3f78c5]/85' : 'bg-red-500/85'}`}>
            {statusText}
          </span>
        )}
        {promptSearchMatch && (
          <div
            className="pointer-events-none absolute z-20 box-border max-h-20 overflow-hidden rounded bg-black/65 px-2 py-1.5 text-[11px] leading-4 text-white shadow-sm backdrop-blur-sm"
            style={{
              left: `${8 / Math.max(viewportScale, 0.01)}px`,
              bottom: `${8 / Math.max(viewportScale, 0.01)}px`,
              width: `${promptOverlayWidth}px`,
              transform: `scale(${metadataScale})`,
              transformOrigin: 'left bottom',
            }}
          >
            <HighlightedSearchText text={promptSnippet} query={searchQuery} />
          </div>
        )}
      </div>
      {cropEditing && dimensions && cropPanelPosition && typeof document !== 'undefined' && createPortal(
        <div className="fixed z-[200] w-48 rounded-md border border-gray-200 bg-white p-2 text-xs text-gray-700 shadow-lg antialiased dark:border-white/[0.1] dark:bg-gray-900 dark:text-gray-200" style={{ left: cropPanelPosition.left, top: cropPanelPosition.top }} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
          <div className="mb-1.5 font-medium text-gray-900 dark:text-white">裁剪</div>
          <div className="mb-2 flex items-center gap-1.5">
            <input aria-label="裁剪宽度" type="number" min="1" value={cropSizeDraft.width} onChange={(event) => updateCropSize('width', event.target.value)} onBlur={restoreCropSizeDraft} className="h-7 min-w-0 flex-1 rounded border border-gray-200 bg-transparent px-2 text-center tabular-nums text-gray-700 outline-none focus:border-[#3f78c5] dark:border-white/[0.12] dark:text-gray-200" />
            <span className="shrink-0 text-gray-400">×</span>
            <input aria-label="裁剪高度" type="number" min="1" value={cropSizeDraft.height} onChange={(event) => updateCropSize('height', event.target.value)} onBlur={restoreCropSizeDraft} className="h-7 min-w-0 flex-1 rounded border border-gray-200 bg-transparent px-2 text-center tabular-nums text-gray-700 outline-none focus:border-[#3f78c5] dark:border-white/[0.12] dark:text-gray-200" />
          </div>
          <div className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">裁剪比例</div>
          <div className="mb-2 grid grid-cols-2 gap-1">
            {([[16 / 9, '16:9'], [9 / 16, '9:16'], [4 / 3, '4:3'], [3 / 4, '3:4']] as const).map(([ratio, label]) => <button key={label} type="button" className="rounded border border-gray-200 px-1.5 py-1 text-gray-600 hover:border-[#3f78c5] hover:text-[#3f78c5] dark:border-white/[0.12] dark:text-gray-300" onClick={() => handleCropPreset(ratio)}>{label}</button>)}
          </div>
          <div className="flex items-center gap-1.5 border-t border-gray-100 pt-2 dark:border-white/[0.08]">
            <button type="button" className="flex-1 rounded px-2 py-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/[0.08]" onClick={onCropCancel}>取消</button>
            <button type="button" className="flex-1 rounded bg-[#3f78c5] px-2 py-1 text-white hover:bg-[#3569ad]" onClick={() => onCropCommit(cropDraft)}>确定</button>
          </div>
        </div>,
        document.body,
      )}
      {(selected || nameSearchMatch) && (node.imageId || node.status === 'running' || node.status === 'error') && (
        <div
          className={`absolute bottom-full left-0 mb-4 flex max-w-44 items-end gap-1 text-[#3f78c5] ${nameSearchMatch && !selected ? 'pointer-events-none' : ''}`}
          title={node.imageId ?? node.placeholderName}
          data-canvas-image-name-container
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => {
            event.stopPropagation()
            if (!selected) return
            if ((event.target as Element).closest('button')) return
            setNameDraft(item.name ?? node.placeholderName ?? node.imageId ?? '')
            setEditingName(true)
          }}
          style={{ transform: `scale(${metadataScale})`, transformOrigin: 'left bottom' }}
        >
          <ImageIcon className="h-3.5 w-3.5 shrink-0" />
          {editingName ? (
            <input
              data-canvas-handle
              data-canvas-image-name
              ref={nameInputRef}
              autoFocus
              value={nameDraft}
              maxLength={80}
              className="h-4 min-w-0 w-32 border-0 border-b border-[#3f78c5] bg-transparent p-0 font-sans text-xs font-medium leading-4 text-[#3f78c5] outline-none"
              onChange={(event) => setNameDraft(event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitName()
                if (event.key === 'Escape') {
                  setNameDraft(item.name ?? node.imageId ?? '')
                  setEditingName(false)
                }
              }}
            />
          ) : (
            <span
              data-canvas-image-name
              className="min-w-0 cursor-text truncate font-sans text-xs font-medium leading-4"
            ><HighlightedSearchText text={imageLabel} query={nameSearchMatch ? searchQuery : ''} /></span>
          )}
          {node.imageId && <button
            type="button"
            data-canvas-handle
            aria-label="复制图片 ID"
            title="复制图片 ID"
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[#3f78c5] hover:bg-[#3f78c5]/15 hover:text-[#3f78c5]"
            onClick={() => onCopyImageId(node.imageId!)}
          >
            <CopyIcon className="h-3 w-3" />
          </button>}
        </div>
      )}
      {selected && showResolution && dimensions && (node.imageId || node.status === 'running' || node.status === 'error') && <span className="absolute bottom-full right-0 mb-4 whitespace-nowrap font-sans text-xs font-medium leading-4 text-[#3f78c5]" style={{ transform: `scale(${metadataScale})`, transformOrigin: 'right bottom' }}>{node.status === 'running' || node.status === 'error' ? `${dimensions.width} × ${dimensions.height}` : `${Math.round(item.width)} × ${Math.round(frameHeight ?? item.width / (dimensions.width / dimensions.height))}`}</span>}
      {selected && node.imageId && !cropEditing && <>
        {(['nw', 'ne', 'sw', 'se'] as ResizeCorner[]).map((corner) => <button
          key={corner}
          type="button"
          data-canvas-handle
          aria-label={`调整图片${corner}`}
          className={`absolute h-2.5 w-2.5 rounded-sm border border-[#3f78c5] bg-white shadow-sm ${corner === 'nw' ? 'left-0 top-0 cursor-nwse-resize' : corner === 'ne' ? 'right-0 top-0 cursor-nesw-resize' : corner === 'sw' ? 'bottom-0 left-0 cursor-nesw-resize' : 'bottom-0 right-0 cursor-nwse-resize'}`}
          style={{
            left: corner === 'nw' || corner === 'sw' ? handleOffset : undefined,
            right: corner === 'ne' || corner === 'se' ? handleOffset : undefined,
            top: corner === 'nw' || corner === 'ne' ? handleOffset : undefined,
            bottom: corner === 'sw' || corner === 'se' ? handleOffset : undefined,
            transform: `scale(${handleScale})`,
            transformOrigin: 'center center',
          }}
          onPointerDown={(event) => onResizeStart(corner, event)}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
        />)}
        <button
          type="button"
          data-canvas-handle
          aria-label="旋转图片"
          title="旋转图片"
          className="absolute left-1/2 flex h-[26px] w-[26px] -translate-x-1/2 cursor-grab items-center justify-center rounded-full bg-[#3f78c5] p-1 text-white shadow-sm active:cursor-grabbing"
          style={{
            top: rotationOffset,
            transform: `translateX(-50%) scale(${handleScale})`,
            transformOrigin: 'center bottom',
          }}
          onPointerDown={onRotateStart}
          onPointerMove={onRotateMove}
          onPointerUp={onRotateEnd}
          onPointerCancel={onRotateEnd}
        ><RotateIcon className="h-3.5 w-3.5" /></button>
        <span className="pointer-events-none absolute left-1/2 border-l border-[#3f78c5]" style={{ top: connectorOffset, height: `${20 * handleScale}px`, transform: 'translateX(-50%)', borderLeftWidth: `${handleScale}px` }} />
      </>}
    </div>
  )
}

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'
type CropHandle = ResizeCorner | 'move'

export default function ProjectCanvas({ agentPanelCollapsed = false, canvasHeaderControls }: { agentPanelCollapsed?: boolean; canvasHeaderControls?: ReactNode }) {
  const tasks = useStore((s) => s.tasks)
  const projects = useStore((s) => s.projects)
  const projectsLoaded = useStore((s) => s.projectsLoaded)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const projectCanvasCache = useStore((s) => s.projectCanvasCache) ?? EMPTY_PROJECT_CANVAS_CACHE
  const streamPreviewSlots = useStore((s) => s.streamPreviewSlots)
  const updateProjectCanvas = useStore((s) => s.updateProjectCanvas)
  const updateProjectCanvasViewport = useStore((s) => s.updateProjectCanvasViewport)
  const touchProjectUpdatedAt = useStore((s) => s.touchProjectUpdatedAt)
  const flushProjectCanvasOnExit = useStore((s) => s.flushProjectCanvasOnExit)
  const setDetailImage = useStore((s) => s.setDetailImage)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const openImageFavoritePicker = useStore((s) => s.openImageFavoritePicker)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const activeProject = projects.find((project) => project.id === activeProjectId)
  const canvasProjectId = activeProject?.id ?? (activeProjectId === LOCAL_PROJECT_ID ? LOCAL_PROJECT_ID : null)
  const containerRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<ProjectCanvasState>(ensureProjectCanvas((canvasProjectId ? projectCanvasCache[canvasProjectId] : undefined) ?? activeProject?.canvas, []))
  const persistTimerRef = useRef<number | null>(null)
  const viewportPersistTimerRef = useRef<number | null>(null)
  const viewportDirtyRef = useRef(false)
  const canvasProjectRef = useRef<string | null>(canvasProjectId)
  const historyProjectRef = useRef<string | null>(canvasProjectId)
  const historyBaselineRef = useRef<ProjectCanvasState | null>(null)
  const historyInternalCanvasRef = useRef<ProjectCanvasState | null>(null)
  const undoStackRef = useRef<ProjectCanvasState[]>([])
  const redoStackRef = useRef<ProjectCanvasState[]>([])
  const historyApplyingRef = useRef(false)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const panRef = useRef<{ pointerId: number; start: { x: number; y: number }; viewport: ProjectCanvasViewport; moved: boolean } | null>(null)
  const pinchRef = useRef<{ distance: number; screenCentroid: { x: number; y: number }; canvasCentroid: { x: number; y: number }; viewport: ProjectCanvasViewport; moved: boolean } | null>(null)
  const minimapDragRef = useRef<{ pointerId: number; start: { x: number; y: number }; viewport: ProjectCanvasViewport; width: number; height: number } | null>(null)
  const dragRef = useRef<{ keys: string[]; pointerId: number; start: { x: number; y: number }; items: Record<string, ProjectCanvasItem>; moved: boolean } | null>(null)
  const resizeRef = useRef<{ key: string; pointerId: number; corner: ResizeCorner; start: { x: number; y: number }; item: ProjectCanvasItem; moved: boolean } | null>(null)
  const rotateRef = useRef<{ key: string; pointerId: number; center: { x: number; y: number }; startAngle: number; startRotation: number; moved: boolean } | null>(null)
  const marqueeRef = useRef<{ pointerId: number; start: { x: number; y: number }; initial: string[] } | null>(null)
  const autoLayoutProjectRef = useRef<string | null>(null)
  const knownImageIdsRef = useRef(new Set<string>())
  const knownPlaceholderKeysRef = useRef(new Set<string>())
  const placeholderProjectRef = useRef<string | null>(null)
  const wasProjectsLoadingRef = useRef(false)
  const centeredFirstImageRef = useRef<{ projectId: string; imageId: string } | null>(null)
  const [canvas, setCanvas] = useState(canvasRef.current)
  const [transientNodeItems, setTransientNodeItems] = useState<Record<string, ProjectCanvasItem>>({})
  const [imageDimensions, setImageDimensions] = useState<Record<string, { width: number; height: number }>>({})
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [transformPanelKey, setTransformPanelKey] = useState<string | null>(null)
  const [rotationInput, setRotationInput] = useState('0')
  const [scaleInput, setScaleInput] = useState('100')
  const [editingTransformField, setEditingTransformField] = useState<'rotation' | 'scale' | null>(null)
  const [interactionKeys, setInteractionKeys] = useState<string[]>([])
  const [multiSelectedKeys, setMultiSelectedKeys] = useState<string[]>([])
  const canvasSelectedTaskIdsRef = useRef<string[]>([])
  const [marquee, setMarquee] = useState<{ start: { x: number; y: number }; current: { x: number; y: number } } | null>(null)
  const [ratios, setRatios] = useState<Record<string, number>>({})
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [toolbarSize, setToolbarSize] = useState({ width: 0, height: 0 })
  const [cropImageId, setCropImageId] = useState<string | null>(null)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exportMenuPosition, setExportMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const [zoomPresetOpen, setZoomPresetOpen] = useState(false)
  const [zoomHelpOpen, setZoomHelpOpen] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const [minimapOpen, setMinimapOpen] = useState(false)
  const [editingLayerKey, setEditingLayerKey] = useState<string | null>(null)
  const [layerNameDraft, setLayerNameDraft] = useState('')
  const [zoomEditing, setZoomEditing] = useState(false)
  const [zoomInput, setZoomInput] = useState('')
  const [viewportAnimating, setViewportAnimating] = useState(false)
  const viewportAnimationTimerRef = useRef<number | null>(null)
  const zoomInputRef = useRef<HTMLInputElement>(null)
  const zoomControlsRef = useRef<HTMLDivElement>(null)
  const transientNodeItemsRef = useRef(transientNodeItems)

  const projectTasks = useMemo(() => [...tasks]
    .filter((task) => {
      if (activeProjectId === LOCAL_PROJECT_ID) return !task.projectId
      if (activeProjectId && activeProjectId !== ALL_PROJECTS_ID) return task.projectId === activeProjectId
      return true
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), [activeProjectId, tasks])
  const projectImageIds = useMemo(() => projectTasks.flatMap((task) => task.outputImages), [projectTasks])
  const imageZById = useMemo(() => {
    const result: Record<string, number> = {}
    let z = 0
    for (const task of projectTasks) {
      for (const imageId of task.outputImages) {
        if (!(imageId in result)) result[imageId] = z++
      }
    }
    return result
  }, [projectTasks])
  const errorNodeKeys = useMemo(() => projectTasks.flatMap((task) => [
    ...(task.status === 'error' && task.outputImages.length === 0 && !task.outputErrors?.length ? [`${task.id}:error`] : []),
    ...(task.outputErrors ?? []).map((error) => `${task.id}:error:${error.requestIndex}`),
  ]), [projectTasks])
  const legacyFavoriteIdsByImage = useMemo(() => Object.fromEntries(projectTasks.flatMap((task) =>
    task.outputImages.map((imageId) => [imageId, task.isFavorite ? getImageFavoriteCollectionIds(imageId, task) : []]),
  )), [projectTasks])

  useEffect(() => {
    const cachedCanvas = canvasProjectId ? projectCanvasCache[canvasProjectId] : undefined
    const sourceCanvas = cachedCanvas ?? activeProject?.canvas ?? canvasRef.current
    console.info('[项目画布] 初始化数据', {
      projectId: canvasProjectId,
      source: cachedCanvas ? 'localStorage.projectCanvasCache' : activeProject?.canvas ? 'IndexedDB.project' : 'memory/default',
      canvas: sourceCanvas,
    })
    const next = ensureProjectCanvas(sourceCanvas, projectImageIds, legacyFavoriteIdsByImage, imageZById, errorNodeKeys)
    const preserveLocalViewport = canvasProjectRef.current === canvasProjectId && viewportDirtyRef.current
    if (preserveLocalViewport) next.viewport = canvasRef.current.viewport
    const historySourceChanged = historyInternalCanvasRef.current === null || !canvasItemsEqual(historyInternalCanvasRef.current, next)
    if (historyProjectRef.current !== canvasProjectId || historyBaselineRef.current === null || historySourceChanged) {
      historyProjectRef.current = canvasProjectId
      historyBaselineRef.current = Object.keys(sourceCanvas?.items ?? {}).length > 0 ? cloneCanvasState(next) : null
      undoStackRef.current = []
      redoStackRef.current = []
    }
    historyInternalCanvasRef.current = cloneCanvasState(next)
    canvasProjectRef.current = canvasProjectId
    canvasRef.current = next
    setCanvas(next)
  }, [activeProject, activeProject?.canvas, activeProject?.id, canvasProjectId, errorNodeKeys, imageZById, legacyFavoriteIdsByImage, projectCanvasCache, projectImageIds])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = () => setContainerSize({ width: container.clientWidth, height: container.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => {
    if (persistTimerRef.current != null) {
      window.clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
      if (canvasProjectId) {
        updateProjectCanvas(canvasProjectId, canvasRef.current)
        viewportDirtyRef.current = false
      }
    }
    if (viewportPersistTimerRef.current != null) {
      window.clearTimeout(viewportPersistTimerRef.current)
      viewportPersistTimerRef.current = null
    }
    if (canvasProjectId && viewportDirtyRef.current && typeof updateProjectCanvasViewport === 'function') {
      viewportDirtyRef.current = false
      updateProjectCanvasViewport(canvasProjectId, canvasRef.current.viewport)
    }
  }, [canvasProjectId, updateProjectCanvas, updateProjectCanvasViewport])

  useEffect(() => {
    const handlePageHide = () => {
      if (!canvasProjectId || typeof flushProjectCanvasOnExit !== 'function') return
      const hasPendingCanvas = persistTimerRef.current != null || viewportDirtyRef.current
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      if (viewportPersistTimerRef.current != null) {
        window.clearTimeout(viewportPersistTimerRef.current)
        viewportPersistTimerRef.current = null
      }
      viewportDirtyRef.current = false
      flushProjectCanvasOnExit(canvasProjectId, canvasRef.current, hasPendingCanvas)
    }
    window.addEventListener('pagehide', handlePageHide)
    return () => window.removeEventListener('pagehide', handlePageHide)
  }, [canvasProjectId, flushProjectCanvasOnExit])

  useEffect(() => () => {
    if (viewportAnimationTimerRef.current == null) return
    window.clearTimeout(viewportAnimationTimerRef.current)
    viewportAnimationTimerRef.current = null
  }, [])

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) {
      setToolbarSize({ width: 0, height: 0 })
      return
    }
    const update = () => setToolbarSize({ width: toolbar.offsetWidth, height: toolbar.offsetHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [selectedKey, containerSize.width])

  useEffect(() => {
    setExportMenuOpen(false)
    setExportMenuPosition(null)
  }, [selectedKey])

  useEffect(() => {
    if (!zoomHelpOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && zoomControlsRef.current?.contains(target)) return
      setZoomHelpOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [zoomHelpOpen])

  useEffect(() => {
    if (!layersOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && zoomControlsRef.current?.contains(target)) return
      setLayersOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [layersOpen])

  useEffect(() => {
    if (!zoomPresetOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && zoomControlsRef.current?.contains(target)) return
      setZoomPresetOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [zoomPresetOpen])

  const recordCanvasHistory = (next: ProjectCanvasState) => {
    if (historyApplyingRef.current) return
    const previous = historyBaselineRef.current
    if (!previous) {
      historyBaselineRef.current = cloneCanvasState(next)
      return
    }
    if (canvasItemsEqual(previous, next)) {
      historyBaselineRef.current = cloneCanvasState(next)
      return
    }
    undoStackRef.current = [...undoStackRef.current, cloneCanvasState(previous)].slice(-30)
    redoStackRef.current = []
    historyBaselineRef.current = cloneCanvasState(next)
  }

  const applyCanvasHistory = (direction: 'undo' | 'redo') => {
    const source = direction === 'undo' ? undoStackRef.current : redoStackRef.current
    const target = source.pop()
    if (!target) return
    const current = cloneCanvasState(canvasRef.current)
    const destination = direction === 'undo' ? redoStackRef.current : undoStackRef.current
    destination.push(current)
    if (destination.length > 30) destination.splice(0, destination.length - 30)
    const next = {
      ...target,
      viewport: { ...canvasRef.current.viewport },
    }
    historyApplyingRef.current = true
    historyBaselineRef.current = cloneCanvasState(next)
    canvasRef.current = next
    setCanvas(next)
    historyApplyingRef.current = false
    if (persistTimerRef.current != null) {
      window.clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    if (viewportPersistTimerRef.current != null) {
      window.clearTimeout(viewportPersistTimerRef.current)
      viewportPersistTimerRef.current = null
    }
    viewportDirtyRef.current = false
    if (canvasProjectId) {
      historyInternalCanvasRef.current = next
      updateProjectCanvas(canvasProjectId, next)
    }
  }

  const persistCanvas = (next: ProjectCanvasState, delay = 0, recordHistory = true) => {
    if (recordHistory) recordCanvasHistory(next)
    else historyBaselineRef.current = cloneCanvasState(next)
    canvasRef.current = next
    setCanvas(next)
    if (viewportPersistTimerRef.current != null) {
      window.clearTimeout(viewportPersistTimerRef.current)
      viewportPersistTimerRef.current = null
    }
    viewportDirtyRef.current = false
    if (!canvasProjectId) return
    if (persistTimerRef.current != null) window.clearTimeout(persistTimerRef.current)
    if (delay <= 0) {
      persistTimerRef.current = null
      historyInternalCanvasRef.current = next
      updateProjectCanvas(canvasProjectId, next)
      return
    }
    persistTimerRef.current = window.setTimeout(() => {
      historyInternalCanvasRef.current = canvasRef.current
      updateProjectCanvas(canvasProjectId, canvasRef.current)
      persistTimerRef.current = null
    }, delay)
  }

  useEffect(() => {
    if (!canvasProjectId || !projectsLoaded) {
      wasProjectsLoadingRef.current = true
      autoLayoutProjectRef.current = null
      knownImageIdsRef.current = new Set()
      return
    }
    if (containerSize.width <= 0 || containerSize.height <= 0) return

    const persistedCanvas = projectCanvasCache[canvasProjectId] ?? activeProject?.canvas
    const persistedItems = persistedCanvas?.items ?? {}
    if (wasProjectsLoadingRef.current) {
      wasProjectsLoadingRef.current = false
      autoLayoutProjectRef.current = canvasProjectId
      knownImageIdsRef.current = new Set(projectImageIds)
      return
    }
    if (autoLayoutProjectRef.current !== canvasProjectId) {
      autoLayoutProjectRef.current = canvasProjectId
      knownImageIdsRef.current = new Set(Object.keys(persistedItems))
    }
    const addedImageIds = projectImageIds.filter((imageId) => !knownImageIdsRef.current.has(imageId) && !persistedItems[imageId])
    if (addedImageIds.some((imageId) => !canvasRef.current.items[imageId])) return
    knownImageIdsRef.current = new Set(projectImageIds)

    if (addedImageIds.length === 0) {
      const centeredFirstImage = centeredFirstImageRef.current
      if (centeredFirstImage?.projectId === canvasProjectId) {
        const item = canvasRef.current.items[centeredFirstImage.imageId]
        const ratio = ratios[centeredFirstImage.imageId] ?? 1
        if (item && ratio !== 1 && item.x === -item.width / 2 && item.y === -item.width / 2) {
          const nextItems = {
            ...canvasRef.current.items,
            [centeredFirstImage.imageId]: { ...item, y: -item.width / ratio / 2 },
          }
          centeredFirstImageRef.current = null
          persistCanvas({ ...canvasRef.current, items: nextItems }, 0, false)
          return
        }
      }
      if (Object.keys(persistedItems).length > 0 || Object.keys(canvasRef.current.items).length > 0) return
      const centered = {
        ...canvasRef.current.viewport,
        x: containerSize.width / 2,
        y: containerSize.height / 2,
      }
      if (centered.x !== canvasRef.current.viewport.x || centered.y !== canvasRef.current.viewport.y) setViewport(centered)
      return
    }

    const existingItemIds = Object.keys(canvasRef.current.items).filter((imageId) => !addedImageIds.includes(imageId))
    const firstLayout = existingItemIds.length === 0 && Object.keys(persistedItems).length === 0
    const nextItems = { ...canvasRef.current.items }
    const consumedTransientKeys: string[] = []
    const placedItems: Array<{ x: number; y: number; width: number; height: number }> = []
    for (const [index, imageId] of addedImageIds.entries()) {
      const current = nextItems[imageId] ?? getDefaultCanvasItem(index, addedImageIds.length)
      const ratio = ratios[imageId] ?? 1
      const height = current.width / ratio
      const task = projectTasks.find((candidate) => candidate.outputImages.includes(imageId))
      const outputIndex = task?.outputImages.indexOf(imageId) ?? -1
      const transientKey = task && outputIndex >= 0 ? `${task.id}:running:${outputIndex}` : null
      const transient = transientKey ? transientNodeItemsRef.current[transientKey] : undefined
      const transientNode = transientKey ? nodes.find((node) => node.key === transientKey) : undefined
      const position = transient
        ? { x: transient.x, y: transient.y }
        : firstLayout && index === 0
          ? { x: -current.width / 2, y: -height / 2 }
          : findAvailableCanvasItemPosition(
              Object.fromEntries(Object.entries(nextItems)
                .filter(([id]) => id !== imageId)
                .map(([id, existing]) => [id, { ...existing, height: existing.width / (ratios[id] ?? 1) }])),
              canvasRef.current.viewport,
              containerSize,
              { width: current.width, height },
            )
      if (transientKey && transient) consumedTransientKeys.push(transientKey)
      const next = {
        ...current,
        ...position,
        ...(transient?.name && transient.name !== transientNode?.placeholderName ? { name: transient.name } : {}),
      }
      nextItems[imageId] = next
      placedItems.push({ x: next.x, y: next.y, width: next.width, height })
    }
    if (consumedTransientKeys.length > 0) {
      const nextTransientItems = { ...transientNodeItemsRef.current }
      for (const key of consumedTransientKeys) delete nextTransientItems[key]
      transientNodeItemsRef.current = nextTransientItems
      setTransientNodeItems(nextTransientItems)
    }
    if (firstLayout) centeredFirstImageRef.current = { projectId: canvasProjectId, imageId: addedImageIds[0] }

    const focus = placedItems.reduce((center, item) => ({
      x: center.x + item.x + item.width / 2,
      y: center.y + item.y + item.height / 2,
    }), { x: 0, y: 0 })
    const focusX = focus.x / placedItems.length
    const focusY = focus.y / placedItems.length
    const focusedViewport = {
      ...canvasRef.current.viewport,
      x: containerSize.width / 2 - focusX * canvasRef.current.viewport.scale,
      y: containerSize.height / 2 - focusY * canvasRef.current.viewport.scale,
    }
    persistCanvas({
      ...canvasRef.current,
      items: nextItems,
      viewport: firstLayout ? focusedViewport : canvasRef.current.viewport,
    }, 0, false)
  }, [activeProject?.canvas, canvas.items, canvasProjectId, containerSize, projectCanvasCache, projectImageIds, projectTasks, projectsLoaded, ratios])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleWheel = (event: WheelEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-canvas-toolbar]')) return
      event.preventDefault()
      const rect = container.getBoundingClientRect()
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const factor = Math.exp(-event.deltaY * 0.0015)
      setViewport(zoomCanvasViewport(canvasRef.current.viewport, point, canvasRef.current.viewport.scale * factor))
    }
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [activeProject?.id])

  const nodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const result: CanvasNode[] = []
    for (const task of projectTasks) {
      if (!taskMatchesFilterStatus(task, filterStatus)) continue
      const taskSearchMatch = taskMatchesSearchQuery(task, q)
      for (const imageId of task.outputImages) {
        const imageIndex = projectImageIds.indexOf(imageId)
        const imageName = canvas.items[imageId]?.name || (imageIndex >= 0 ? `图片 ${imageIndex + 1}` : imageId)
        if (q && !taskSearchMatch && !imageName.toLowerCase().includes(q)) continue
        const favoriteIds = getImageFavoriteCollectionIds(imageId, task)
        if (filterFavorite && favoriteIds.length === 0) continue
        if (filterFavorite && activeFavoriteCollectionId && activeFavoriteCollectionId !== ALL_FAVORITES_COLLECTION_ID && !favoriteIds.includes(activeFavoriteCollectionId)) continue
        result.push({ key: imageId, imageId, task, status: 'done' })
      }
      if (filterFavorite) continue

      const previews = streamPreviewSlots[task.id] ?? {}
      if (task.status === 'running') {
        const count = Math.max(0, task.params.n - task.outputImages.length - (task.outputErrors?.length ?? 0))
        const placeholderDimensions = getPlaceholderDimensions(task)
        for (let index = 0; index < count; index++) {
          const slot = String(task.outputImages.length + index)
          const placeholderName = `占位图${Number(slot) + 1}`
          if (q && !taskSearchMatch && !placeholderName.toLowerCase().includes(q)) continue
          result.push({
            key: `${task.id}:running:${slot}`,
            task,
            status: 'running',
            previewSrc: previews[slot],
            placeholderDimensions,
            placeholderName,
          })
        }
      }
      if (task.status === 'error' && task.outputImages.length === 0 && !task.outputErrors?.length) {
        if (q && !taskSearchMatch && !'占位图1'.includes(q)) continue
        result.push({
          key: `${task.id}:error`,
          task,
          status: 'error',
          error: task.error ?? undefined,
          placeholderDimensions: getPlaceholderDimensions(task),
          placeholderName: '占位图1',
        })
      }
      for (const error of task.outputErrors ?? []) {
        const placeholderName = `占位图${error.requestIndex + 1}`
        if (q && !taskSearchMatch && !placeholderName.toLowerCase().includes(q)) continue
        result.push({
          key: `${task.id}:error:${error.requestIndex}`,
          task,
          status: 'error',
          error: error.error,
          placeholderDimensions: getPlaceholderDimensions(task),
          placeholderName,
        })
      }
    }
    return result
  }, [activeFavoriteCollectionId, canvas.items, filterFavorite, filterStatus, projectImageIds, projectTasks, searchQuery, streamPreviewSlots])

  const nodeItems = useMemo(() => {
    const items: Record<string, ProjectCanvasItem> = {}
    const occupied: Record<string, ProjectCanvasItem & { height?: number }> = { ...canvas.items }
    let fallbackIndex = projectImageIds.length
    for (const node of nodes) {
      const imageIndex = node.imageId ? projectImageIds.indexOf(node.imageId) : -1
      const fallbackNodeIndex = fallbackIndex
      const fallback = getDefaultCanvasItem(fallbackIndex++)
      const existing = canvas.items[node.key]
      const transient = transientNodeItems[node.key]
      if (transient) {
        items[node.key] = transient
        occupied[node.key] = { ...transient, height: transient.width / (node.placeholderDimensions ? node.placeholderDimensions.width / node.placeholderDimensions.height : 1) }
        continue
      }
      if (existing) {
        const next = existing.name || imageIndex < 0 ? existing : { ...existing, name: `图片 ${imageIndex + 1}` }
        items[node.key] = next
        occupied[node.key] = { ...next, height: next.width / (ratios[node.key] ?? 1) }
        continue
      }
      if (node.status === 'running' || node.status === 'error') {
        const dimensions = node.placeholderDimensions ?? { width: 1024, height: 1024 }
        const width = dimensions.width
        const height = dimensions.height
        const position = projectImageIds.length === 0 && Object.keys(items).length === 0
          ? { x: -width / 2, y: -height / 2 }
          : findAvailableCanvasItemPosition(occupied, canvas.viewport, containerSize, { width, height })
        const next = { ...fallback, ...position, width, name: node.placeholderName }
        items[node.key] = next
        occupied[node.key] = { ...next, height }
        continue
      }
      const next = node.imageId && imageIndex >= 0
        ? { ...fallback, name: `图片 ${imageIndex + 1}` }
        : fallbackNodeIndex === 0
          ? { ...fallback, x: -fallback.width / 2, y: -fallback.width / 2 }
          : fallback
      items[node.key] = next
      occupied[node.key] = { ...next, height: next.width / (ratios[node.key] ?? 1) }
    }
    return items
  }, [canvas.items, canvas.viewport, containerSize, nodes, projectImageIds, ratios, transientNodeItems])

  const canvasConnections = useMemo(() => {
    const nodesByImageId = new Map(nodes.flatMap((node) => node.imageId ? [[node.imageId, node] as const] : []))
    return nodes.flatMap((targetNode) => {
      const targetItem = nodeItems[targetNode.key]
      if (!targetItem) return []
      const targetRatio = Math.max(0.01, ratios[targetNode.key] ?? (targetNode.placeholderDimensions ? targetNode.placeholderDimensions.width / targetNode.placeholderDimensions.height : 1))
      const targetCenter = { x: targetItem.x + targetItem.width / 2, y: targetItem.y + targetItem.width / targetRatio / 2 }
      return targetNode.task.inputImageIds.flatMap((sourceImageId) => {
        const sourceNode = nodesByImageId.get(sourceImageId)
        if (!sourceNode || sourceNode.key === targetNode.key) return []
        const sourceItem = nodeItems[sourceNode.key]
        if (!sourceItem) return []
        const sourceRatio = Math.max(0.01, ratios[sourceNode.key] ?? (sourceNode.placeholderDimensions ? sourceNode.placeholderDimensions.width / sourceNode.placeholderDimensions.height : 1))
        const sourceCenter = { x: sourceItem.x + sourceItem.width / 2, y: sourceItem.y + sourceItem.width / sourceRatio / 2 }
        const start = getCanvasConnectionPoint(sourceCenter, targetCenter, sourceItem.width, sourceItem.width / sourceRatio)
        const end = getCanvasConnectionPoint(targetCenter, sourceCenter, targetItem.width, targetItem.width / targetRatio)
        return [{
          id: `${sourceNode.key}:${targetNode.key}`,
          start: { x: canvas.viewport.x + start.x * canvas.viewport.scale, y: canvas.viewport.y + start.y * canvas.viewport.scale },
          end: { x: canvas.viewport.x + end.x * canvas.viewport.scale, y: canvas.viewport.y + end.y * canvas.viewport.scale },
        }]
      })
    })
  }, [canvas.viewport, nodeItems, nodes, ratios])

  const minimapData = useMemo(() => {
    const entries = nodes.flatMap((node) => {
      const item = nodeItems[node.key]
      if (!item) return []
      const ratio = Math.max(0.01, ratios[node.key] ?? 1)
      return [{ node, item, height: item.width / ratio }]
    })
    if (entries.length === 0) return null
    const minX = Math.min(...entries.map(({ item }) => item.x))
    const minY = Math.min(...entries.map(({ item }) => item.y))
    const maxX = Math.max(...entries.map(({ item }) => item.x + item.width))
    const maxY = Math.max(...entries.map(({ item, height }) => item.y + height))
    const padding = Math.max(DEFAULT_CANVAS_ITEM_WIDTH * 0.25, Math.max(maxX - minX, maxY - minY) * 0.08)
    const bounds = { minX: minX - padding, minY: minY - padding, width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 }
    const viewportScale = Math.max(0.01, canvas.viewport.scale)
    const viewportX = -canvas.viewport.x / viewportScale
    const viewportY = -canvas.viewport.y / viewportScale
    return {
      entries,
      bounds,
      viewport: {
        left: (viewportX - bounds.minX) / bounds.width * 100,
        top: (viewportY - bounds.minY) / bounds.height * 100,
        width: containerSize.width / viewportScale / bounds.width * 100,
        height: containerSize.height / viewportScale / bounds.height * 100,
      },
    }
  }, [canvas.viewport, containerSize, nodeItems, nodes, ratios])

  useEffect(() => {
    const transientNodes = nodes.filter((node) => !node.imageId && node.status === 'running')
    const runningNodes = transientNodes.filter((node) => node.status === 'running')
    if (placeholderProjectRef.current !== canvasProjectId) {
      placeholderProjectRef.current = canvasProjectId
      knownPlaceholderKeysRef.current = new Set()
    }
    const transientKeys = new Set(transientNodes.map((node) => node.key))
    const addedRunningNodes = runningNodes.filter((node) => !knownPlaceholderKeysRef.current.has(node.key))
    const nextTransientItems = { ...transientNodeItemsRef.current }
    let changed = false
    for (const node of transientNodes) {
      if (nextTransientItems[node.key] || !nodeItems[node.key]) continue
      nextTransientItems[node.key] = nodeItems[node.key]
      changed = true
    }
    for (const key of Object.keys(nextTransientItems)) {
      if (transientKeys.has(key)) continue
      delete nextTransientItems[key]
      changed = true
    }
    if (changed) {
      transientNodeItemsRef.current = nextTransientItems
      setTransientNodeItems(nextTransientItems)
    }
    const focusedNode = addedRunningNodes[addedRunningNodes.length - 1]
    const focusedItem = focusedNode ? nextTransientItems[focusedNode.key] ?? nodeItems[focusedNode.key] : undefined
    if (containerSize.width <= 0 || containerSize.height <= 0) return
    knownPlaceholderKeysRef.current = new Set(runningNodes.map((node) => node.key))
    if (!focusedNode || !focusedItem) return
    focusCanvasImage(focusedNode.key)
  }, [canvasProjectId, containerSize, nodeItems, nodes])

  useEffect(() => {
    if (!canvasProjectId || !projectsLoaded || containerSize.width <= 0 || containerSize.height <= 0) return
    const errorNodes = nodes.filter((node) => node.status === 'error')
    const additions = errorNodes.reduce<Record<string, ProjectCanvasItem>>((result, node) => {
      if (!canvasRef.current.items[node.key] && nodeItems[node.key]) result[node.key] = nodeItems[node.key]
      return result
    }, {})
    if (Object.keys(additions).length === 0) return
    persistCanvas({ ...canvasRef.current, items: { ...canvasRef.current.items, ...additions } }, 0, false)
  }, [canvasProjectId, containerSize, nodeItems, nodes, projectsLoaded])

  const visibleNodes = useMemo(() => nodes.filter((node) => {
    if (node.key === selectedKey) return true
    const item = nodeItems[node.key]
    const ratio = ratios[node.key] ?? 1
    return isCanvasRectVisible(item, item.width / ratio, canvas.viewport, containerSize)
  }), [canvas.viewport, containerSize, nodeItems, nodes, ratios, selectedKey])
  const selectedNode = nodes.find((node) => node.key === selectedKey)
  const selectedItem = selectedKey ? nodeItems[selectedKey] : undefined
  const selectedDimensions = selectedKey ? imageDimensions[selectedKey] : undefined
  const selectedRatio = selectedKey ? ratios[selectedKey] ?? 1 : 1
  const selectedRotation = selectedItem ? normalizeCanvasRotation(selectedItem.rotation ?? selectedItem.operator?.rotation ?? 0) : 0
  const selectedScale = selectedItem?.operator?.scale ?? 1
  const selectedTransformActive = selectedItem
    ? selectedRotation !== 0 || Math.abs(selectedScale - 1) > 0.001
    : false

  useEffect(() => {
    const taskIds = Array.from(new Set(
      multiSelectedKeys
        .map((key) => nodes.find((node) => node.key === key)?.task.id)
        .filter((id): id is string => Boolean(id)),
    ))
    if (multiSelectedKeys.length > 1 && taskIds.length > 0) {
      canvasSelectedTaskIdsRef.current = taskIds
      setSelectedTaskIds(taskIds)
      return
    }
    if (canvasSelectedTaskIdsRef.current.length > 0) {
      const previous = new Set(canvasSelectedTaskIdsRef.current)
      canvasSelectedTaskIdsRef.current = []
      setSelectedTaskIds((current) => current.filter((id) => !previous.has(id)))
    }
  }, [multiSelectedKeys, nodes, setSelectedTaskIds])

  useEffect(() => {
    const syncedTaskIds = canvasSelectedTaskIdsRef.current
    if (syncedTaskIds.length > 0 && syncedTaskIds.length === selectedTaskIds.length && syncedTaskIds.every((id) => selectedTaskIds.includes(id))) return

    const selectedSet = new Set(selectedTaskIds)
    const keys = nodes.filter((node) => selectedSet.has(node.task.id)).map((node) => node.key)
    setMultiSelectedKeys((current) => {
      if (current.length === keys.length && current.every((key, index) => key === keys[index])) return current
      return keys.length > 1 ? keys : []
    })
    if (keys.length > 1) setSelectedKey(null)
  }, [nodes, selectedTaskIds])

  useEffect(() => {
    if (!selectedItem) return
    setRotationInput(String(Math.round(selectedRotation)))
    setScaleInput(String(Math.round(selectedScale * 100)))
  }, [selectedKey, selectedRotation, selectedScale])

  useEffect(() => {
    if (!selectedKey || !selectedTransformActive) return
    setTransformPanelKey((current) => current === selectedKey ? current : selectedKey)
  }, [selectedKey, selectedTransformActive])

  const toolbarPosition = selectedItem ? (() => {
    const itemWidth = selectedItem.width
    const selectedCrop = selectedItem.operator?.crop
    const itemHeight = cropImageId === selectedKey || !selectedCrop
      ? selectedItem.width / selectedRatio
      : selectedItem.width * selectedCrop.height / (selectedRatio * selectedCrop.width)
    const rotation = normalizeCanvasRotation(selectedItem.rotation ?? selectedItem.operator?.rotation ?? 0) * Math.PI / 180
    const rotatedHeight = (Math.abs(Math.sin(rotation)) * itemWidth + Math.abs(Math.cos(rotation)) * itemHeight) * canvas.viewport.scale
    const center = selectedItem.x * canvas.viewport.scale + canvas.viewport.x + itemWidth * canvas.viewport.scale / 2
    const centerY = selectedItem.y * canvas.viewport.scale + canvas.viewport.y + itemHeight * canvas.viewport.scale / 2
    const imageTop = centerY - rotatedHeight / 2
    const imageBottom = centerY + rotatedHeight / 2
    const toolbarHeight = toolbarSize.height || 42
    const toolbarWidth = toolbarSize.width > 0 ? toolbarSize.width : Math.min(400, Math.max(0, containerSize.width - 16))
    const halfWidth = toolbarWidth / 2
    const gap = 34
    const above = imageTop - toolbarHeight - gap
    const below = imageBottom + gap
    const canPlaceAbove = above >= 8
    const canPlaceBelow = below + toolbarHeight <= containerSize.height - 8
    const preferredTop = canPlaceAbove ? above : canPlaceBelow ? below : Math.max(8, above)
    const maxLeft = Math.max(8, containerSize.width - toolbarWidth - 8)
    return {
      left: Math.round(Math.min(Math.max(center - halfWidth, 8), maxLeft)),
      top: Math.round(Math.min(Math.max(preferredTop, 8), Math.max(8, containerSize.height - toolbarHeight - 8))),
    }
  })() : null

  const imageInfoPanelPosition = selectedItem && selectedNode?.imageId ? (() => {
    const itemWidth = selectedItem.width
    const selectedCrop = selectedItem.operator?.crop
    const itemHeight = cropImageId === selectedKey || !selectedCrop
      ? selectedItem.width / selectedRatio
      : selectedItem.width * selectedCrop.height / (selectedRatio * selectedCrop.width)
    const rotation = normalizeCanvasRotation(selectedItem.rotation ?? selectedItem.operator?.rotation ?? 0) * Math.PI / 180
    const rotatedWidth = (Math.abs(Math.cos(rotation)) * itemWidth + Math.abs(Math.sin(rotation)) * itemHeight) * canvas.viewport.scale
    const rotatedHeight = (Math.abs(Math.sin(rotation)) * itemWidth + Math.abs(Math.cos(rotation)) * itemHeight) * canvas.viewport.scale
    const center = selectedItem.x * canvas.viewport.scale + canvas.viewport.x + itemWidth * canvas.viewport.scale / 2
    const centerY = selectedItem.y * canvas.viewport.scale + canvas.viewport.y + itemHeight * canvas.viewport.scale / 2
    const panelWidth = 140
    const panelHeight = 80
    const gap = 12
    const preferredLeft = center - rotatedWidth / 2 - panelWidth - gap
    const rightLeft = center + rotatedWidth / 2 + gap
    const rawLeft = preferredLeft >= 8 ? preferredLeft : rightLeft
    return {
      left: Math.round(Math.min(Math.max(rawLeft, 8), Math.max(8, containerSize.width - panelWidth - 8))),
      top: Math.round(Math.min(Math.max(centerY - rotatedHeight / 2, 8), Math.max(8, containerSize.height - panelHeight - 8))),
    }
  })() : null

  const setViewport = (viewport: ProjectCanvasViewport) => {
    const current = canvasRef.current.viewport
    if (current.x === viewport.x && current.y === viewport.y && current.scale === viewport.scale) return
    const next = { ...canvasRef.current, viewport }
    canvasRef.current = next
    setCanvas(next)
    if (!canvasProjectId) return
    if (!viewportDirtyRef.current && typeof touchProjectUpdatedAt === 'function') touchProjectUpdatedAt(canvasProjectId)
    viewportDirtyRef.current = true
    if (viewportPersistTimerRef.current != null) window.clearTimeout(viewportPersistTimerRef.current)
    viewportPersistTimerRef.current = window.setTimeout(() => {
      viewportPersistTimerRef.current = null
      if (!viewportDirtyRef.current || !canvasProjectId || typeof updateProjectCanvasViewport !== 'function') return
      viewportDirtyRef.current = false
      updateProjectCanvasViewport(canvasProjectId, canvasRef.current.viewport)
    }, 350)
  }

  const handleMinimapDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!minimapData) return
    const mapRect = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!mapRect) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    minimapDragRef.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      viewport: canvasRef.current.viewport,
      width: mapRect.width,
      height: mapRect.height,
    }
  }

  const handleMinimapDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = minimapDragRef.current
    if (!drag || drag.pointerId !== event.pointerId || !minimapData) return
    event.stopPropagation()
    const dx = (event.clientX - drag.start.x) / Math.max(1, drag.width) * minimapData.bounds.width
    const dy = (event.clientY - drag.start.y) / Math.max(1, drag.height) * minimapData.bounds.height
    setViewport({
      ...drag.viewport,
      x: drag.viewport.x - dx * drag.viewport.scale,
      y: drag.viewport.y - dy * drag.viewport.scale,
    })
  }

  const handleMinimapDragEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (minimapDragRef.current?.pointerId !== event.pointerId) return
    event.stopPropagation()
    minimapDragRef.current = null
  }

  const focusCanvasImage = (key: string) => {
    const item = nodeItems[key]
    if (!item || containerSize.width <= 0 || containerSize.height <= 0) return
    const node = nodes.find((candidate) => candidate.key === key)
    setTransformPanelKey(null)
    setSelectedKey(key)
    setMultiSelectedKeys([])
    setInteractionKeys([])
    const ratio = Math.max(0.01, ratios[key] ?? (node?.placeholderDimensions
      ? node.placeholderDimensions.width / node.placeholderDimensions.height
      : 1))
    const crop = item.operator?.crop
    const itemHeight = crop
      ? item.width * crop.height / (ratio * crop.width)
      : item.width / ratio
    const longEdge = Math.max(item.width, itemHeight)
    const viewportShortEdge = Math.min(containerSize.width, containerSize.height)
    const targetScale = Math.min(3, viewportShortEdge * 0.7 / Math.max(1, longEdge))
    const scale = clampCanvasScale(targetScale)
    const center = {
      x: item.x + item.width / 2,
      y: item.y + itemHeight / 2,
    }
    if (viewportAnimationTimerRef.current != null) window.clearTimeout(viewportAnimationTimerRef.current)
    setViewportAnimating(true)
    viewportAnimationTimerRef.current = window.setTimeout(() => {
      viewportAnimationTimerRef.current = null
      setViewportAnimating(false)
    }, 560)
    setViewport({
      ...zoomCanvasViewport(canvasRef.current.viewport, { x: containerSize.width / 2, y: containerSize.height / 2 }, scale),
      x: containerSize.width / 2 - center.x * scale,
      y: containerSize.height / 2 - center.y * scale,
    })
  }

  useEffect(() => {
    if (!zoomEditing) return
    zoomInputRef.current?.focus()
    zoomInputRef.current?.select()
  }, [zoomEditing])

  const setCanvasZoomPercent = (percent: number) => {
    if (!Number.isFinite(percent)) return
    const scale = clampCanvasScale(percent / 100)
    setViewport(zoomCanvasViewport(canvasRef.current.viewport, { x: containerSize.width / 2, y: containerSize.height / 2 }, scale))
    setZoomPresetOpen(false)
    setZoomEditing(false)
  }

  const commitCanvasZoomInput = () => {
    const percent = Number(zoomInput)
    if (Number.isFinite(percent) && percent > 0) setCanvasZoomPercent(percent)
    else setZoomEditing(false)
  }

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-canvas-node], [data-canvas-toolbar], button')) return
    setTransformPanelKey(null)
    const modifier = event.ctrlKey || event.metaKey
    if (modifier) {
      const rect = event.currentTarget.getBoundingClientRect()
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      event.currentTarget.setPointerCapture(event.pointerId)
      marqueeRef.current = { pointerId: event.pointerId, start: point, initial: multiSelectedKeys }
      setMarquee({ start: point, current: point })
      setSelectedKey(null)
      setInteractionKeys([])
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    setSelectedKey(null)
    setMultiSelectedKeys([])
    setInteractionKeys([])

    if (pointersRef.current.size === 1) {
      panRef.current = {
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        viewport: canvasRef.current.viewport,
        moved: false,
      }
      return
    }

    const points = [...pointersRef.current.values()]
    const screenCentroid = centroid(points[0], points[1])
    const rect = event.currentTarget.getBoundingClientRect()
    pinchRef.current = {
      distance: distance(points[0], points[1]),
      screenCentroid,
      canvasCentroid: { x: screenCentroid.x - rect.left, y: screenCentroid.y - rect.top },
      viewport: canvasRef.current.viewport,
      moved: false,
    }
    panRef.current = null
  }

  const handleCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const marqueeState = marqueeRef.current
    if (marqueeState?.pointerId === event.pointerId) {
      const rect = event.currentTarget.getBoundingClientRect()
      const current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      setMarquee({ start: marqueeState.start, current })
      const left = Math.min(marqueeState.start.x, current.x)
      const right = Math.max(marqueeState.start.x, current.x)
      const top = Math.min(marqueeState.start.y, current.y)
      const bottom = Math.max(marqueeState.start.y, current.y)
      const hits = visibleNodes.filter((node) => {
        const element = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-canvas-node]')).find((candidate) => candidate.dataset.nodeKey === node.key)
        if (!element) return false
        const nodeRect = element.getBoundingClientRect()
        const nodeLeft = nodeRect.left - rect.left
        const nodeRight = nodeRect.right - rect.left
        const nodeTop = nodeRect.top - rect.top
        const nodeBottom = nodeRect.bottom - rect.top
        return left < nodeRight && right > nodeLeft && top < nodeBottom && bottom > nodeTop
      }).map((node) => node.key)
      setMultiSelectedKeys(Array.from(new Set([...marqueeState.initial, ...hits])))
      return
    }
    if (!pointersRef.current.has(event.pointerId)) return
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const points = [...pointersRef.current.values()]
    if (points.length >= 2 && pinchRef.current) {
      pinchRef.current.moved = true
      const nextCentroid = centroid(points[0], points[1])
      const nextScale = pinchRef.current.viewport.scale * (distance(points[0], points[1]) / Math.max(1, pinchRef.current.distance))
      const centered = zoomCanvasViewport(pinchRef.current.viewport, pinchRef.current.canvasCentroid, nextScale)
      setViewport({
        ...centered,
        x: centered.x + nextCentroid.x - pinchRef.current.screenCentroid.x,
        y: centered.y + nextCentroid.y - pinchRef.current.screenCentroid.y,
      })
      return
    }

    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    const deltaX = event.clientX - pan.start.x
    const deltaY = event.clientY - pan.start.y
    pan.moved = pan.moved || Math.hypot(deltaX, deltaY) > 3
    setViewport({ ...pan.viewport, x: pan.viewport.x + deltaX, y: pan.viewport.y + deltaY })
  }

  const handleCanvasPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (marqueeRef.current?.pointerId === event.pointerId) {
      marqueeRef.current = null
      setMarquee(null)
      if (multiSelectedKeys.length === 1) {
        setSelectedKey(multiSelectedKeys[0])
        setMultiSelectedKeys([])
      }
      return
    }
    pointersRef.current.delete(event.pointerId)
    panRef.current = null
    pinchRef.current = null
  }

  const handleNodePointerDown = (node: CanvasNode, event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    event.stopPropagation()
    setTransformPanelKey(null)
    if (event.ctrlKey || event.metaKey) {
      setSelectedKey(null)
      setInteractionKeys([])
      setMultiSelectedKeys((current) => {
        const base = current.length > 0 ? current : selectedKey ? [selectedKey] : []
        return base.includes(node.key) ? base.filter((key) => key !== node.key) : [...base, node.key]
      })
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const keys = multiSelectedKeys.includes(node.key) && multiSelectedKeys.length > 1 ? multiSelectedKeys : [node.key]
    setSelectedKey(keys.length === 1 ? node.key : null)
    setMultiSelectedKeys(keys.length > 1 ? keys : [])
    setInteractionKeys(keys)
    const items = Object.fromEntries(keys.flatMap((key) => nodeItems[key] ? [[key, nodeItems[key]]] : []))
    dragRef.current = {
      keys,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      items,
      moved: false,
    }
  }

  const handleNodePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const deltaX = (event.clientX - drag.start.x) / canvasRef.current.viewport.scale
    const deltaY = (event.clientY - drag.start.y) / canvasRef.current.viewport.scale
    if (Math.hypot(deltaX, deltaY) <= 2 && !drag.moved) return
    drag.moved = true
    const items = { ...canvasRef.current.items }
    const nextTransientItems = { ...transientNodeItemsRef.current }
    let hasPersistentChanges = false
    let hasTransientChanges = false
    for (const key of drag.keys) {
      const item = drag.items[key]
      if (!item) continue
      const node = nodes.find((candidate) => candidate.key === key)
      const nextItem = { ...item, x: item.x + deltaX, y: item.y + deltaY }
      if (node?.imageId || node?.status === 'error') {
        items[key] = nextItem
        hasPersistentChanges = true
      } else {
        nextTransientItems[key] = nextItem
        hasTransientChanges = true
      }
    }
    if (hasPersistentChanges) {
      canvasRef.current = { ...canvasRef.current, items }
      setCanvas(canvasRef.current)
    }
    if (hasTransientChanges) {
      transientNodeItemsRef.current = nextTransientItems
      setTransientNodeItems(nextTransientItems)
    }
  }

  const handleNodePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setInteractionKeys([])
    if (drag.moved && drag.keys.some((key) => nodes.some((node) => node.key === key && (Boolean(node.imageId) || node.status === 'error')))) persistCanvas(canvasRef.current, 0)
  }

  const handleImageDimensions = (key: string, width: number, height: number) => {
    setImageDimensions((current) => current[key]?.width === width && current[key]?.height === height ? current : { ...current, [key]: { width, height } })
    const item = canvasRef.current.items[key]
    if (!item) return
    const originalWidth = item.operator?.originalWidth ?? width
    const adoptOriginalWidth = !item.operator?.originalWidth && item.width === DEFAULT_CANVAS_ITEM_WIDTH
    const nextWidth = adoptOriginalWidth ? width : item.width
    const isCentered = Math.abs(item.x + item.width / 2) < 0.5 && Math.abs(item.y + item.width / 2) < 0.5
    const nextItem = {
      ...item,
      ...(adoptOriginalWidth ? {
        width: nextWidth,
        ...(isCentered ? { x: -nextWidth / 2, y: -height / 2 } : {}),
      } : {}),
      operator: { ...item.operator, originalWidth, scale: nextWidth / originalWidth },
    }
    if (JSON.stringify(nextItem) === JSON.stringify(item)) return
    persistCanvas({ ...canvasRef.current, items: { ...canvasRef.current.items, [key]: nextItem } }, 0, false)
  }

  const handleRenameImage = (key: string, name: string) => {
    const item = canvasRef.current.items[key] ?? transientNodeItemsRef.current[key] ?? nodeItems[key]
    if (!item || item.name === name) return true
    const duplicate = [
      ...Object.entries(canvasRef.current.items),
      ...Object.entries(transientNodeItemsRef.current),
      ...Object.entries(nodeItems),
    ].some(([itemKey, current]) => itemKey !== key && current.name === name)
    if (duplicate) {
      showToast('图片名称已存在，请换一个名称', 'error')
      return false
    }
    if (canvasRef.current.items[key]) {
      persistCanvas({ ...canvasRef.current, items: { ...canvasRef.current.items, [key]: { ...item, name } } }, 0)
      return true
    }
    const nextTransientItems = { ...transientNodeItemsRef.current, [key]: { ...item, name } }
    transientNodeItemsRef.current = nextTransientItems
    setTransientNodeItems(nextTransientItems)
    return true
  }

  const handleResizeStart = (key: string, corner: ResizeCorner, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setInteractionKeys([key])
    event.currentTarget.setPointerCapture(event.pointerId)
    const item = nodeItems[key]
    if (!item) return
    resizeRef.current = { key, pointerId: event.pointerId, corner, start: { x: event.clientX, y: event.clientY }, item, moved: false }
  }

  const handleResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const ratio = ratios[resize.key] ?? 1
    const scale = canvasRef.current.viewport.scale
    const deltaX = (event.clientX - resize.start.x) / scale
    const deltaY = (event.clientY - resize.start.y) / scale
    const horizontal = resize.corner.endsWith('e') ? deltaX : -deltaX
    const vertical = resize.corner.startsWith('s') ? deltaY : -deltaY
    const widthDelta = Math.abs(horizontal) >= Math.abs(vertical * ratio) ? horizontal : vertical * ratio
    const width = Math.max(80, resize.item.width + widthDelta)
    resize.moved = resize.moved || width !== resize.item.width
    const actualDelta = width - resize.item.width
    const originalWidth = resize.item.operator?.originalWidth ?? imageDimensions[resize.key]?.width ?? resize.item.width
    const items = { ...canvasRef.current.items, [resize.key]: {
      ...resize.item,
      width,
      x: resize.corner.endsWith('e') ? resize.item.x : resize.item.x - actualDelta,
      y: resize.corner.startsWith('s') ? resize.item.y : resize.item.y - actualDelta / ratio,
      operator: { ...resize.item.operator, originalWidth, scale: width / originalWidth },
    } }
    canvasRef.current = { ...canvasRef.current, items }
    setCanvas(canvasRef.current)
  }

  const handleResizeEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    resizeRef.current = null
    setInteractionKeys([])
    if (resize.moved) persistCanvas(canvasRef.current, 0)
  }

  const handleRotateStart = (key: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setInteractionKeys([key])
    event.currentTarget.setPointerCapture(event.pointerId)
    const item = nodeItems[key]
    if (!item) return
    const ratio = ratios[key] ?? 1
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const center = {
      x: rect.left + item.x * canvasRef.current.viewport.scale + canvasRef.current.viewport.x + item.width * canvasRef.current.viewport.scale / 2,
      y: rect.top + item.y * canvasRef.current.viewport.scale + canvasRef.current.viewport.y + item.width / ratio * canvasRef.current.viewport.scale / 2,
    }
    rotateRef.current = {
      key,
      pointerId: event.pointerId,
      center,
      startAngle: Math.atan2(event.clientY - center.y, event.clientX - center.x),
      startRotation: normalizeCanvasRotation(item.rotation ?? item.operator?.rotation ?? 0),
      moved: false,
    }
  }

  const handleRotateMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const rotate = rotateRef.current
    if (!rotate || rotate.pointerId !== event.pointerId) return
    const angle = Math.atan2(event.clientY - rotate.center.y, event.clientX - rotate.center.x)
    const rotation = rotate.startRotation + (angle - rotate.startAngle) * 180 / Math.PI
    rotate.moved = rotate.moved || Math.abs(rotation - rotate.startRotation) > 0.01
    const normalizedRotation = normalizeCanvasRotation(rotation)
    const items = { ...canvasRef.current.items, [rotate.key]: { ...canvasRef.current.items[rotate.key], rotation: normalizedRotation, operator: { ...canvasRef.current.items[rotate.key]?.operator, rotation: normalizedRotation } } }
    canvasRef.current = { ...canvasRef.current, items }
    setCanvas(canvasRef.current)
  }

  const handleRotateEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const rotate = rotateRef.current
    if (!rotate || rotate.pointerId !== event.pointerId) return
    rotateRef.current = null
    setInteractionKeys([])
    if (rotate.moved) persistCanvas(canvasRef.current, 0)
  }

  const updateSelectedImageOperator = (patch: Partial<NonNullable<ProjectCanvasItem['operator']>>) => {
    if (!selectedKey) return
    const item = canvasRef.current.items[selectedKey]
    if (!item) return
    const nextOperator = { ...item.operator, ...patch }
    const nextItem = {
      ...item,
      ...(patch.rotation !== undefined ? { rotation: patch.rotation } : {}),
      operator: nextOperator,
    }
    if (JSON.stringify(nextItem) === JSON.stringify(item)) return
    persistCanvas({ ...canvasRef.current, items: { ...canvasRef.current.items, [selectedKey]: nextItem } }, 0)
  }

  const handleRotateBy = (delta: number) => {
    if (!selectedItem) return
    const rotation = normalizeCanvasRotation((selectedItem.rotation ?? selectedItem.operator?.rotation ?? 0) + delta)
    updateSelectedImageOperator({ rotation })
  }

  const handleFlip = (axis: 'x' | 'y') => {
    if (!selectedItem) return
    updateSelectedImageOperator(axis === 'x'
      ? { flipX: !selectedItem.operator?.flipX }
      : { flipY: !selectedItem.operator?.flipY })
  }

  const commitRotationInput = () => {
    if (!selectedItem) return
    const value = Number(rotationInput)
    if (!Number.isFinite(value)) {
      setRotationInput(String(Math.round(selectedRotation)))
      return
    }
    const rotation = Math.min(360, Math.max(0, value))
    updateSelectedImageOperator({ rotation: normalizeCanvasRotation(rotation) })
    setRotationInput(String(Math.round(rotation)))
  }

  const commitScaleInput = () => {
    if (!selectedKey || !selectedItem) return
    const value = Number(scaleInput)
    if (!Number.isFinite(value)) {
      setScaleInput(String(Math.round(selectedScale * 100)))
      return
    }
    const percent = Math.min(500, Math.max(1, value))
    const ratio = Math.max(0.01, ratios[selectedKey] ?? 1)
    const originalWidth = selectedItem.operator?.originalWidth ?? imageDimensions[selectedKey]?.width ?? selectedItem.width
    const width = originalWidth * percent / 100
    const height = width / ratio
    const centerX = selectedItem.x + selectedItem.width / 2
    const centerY = selectedItem.y + selectedItem.width / ratio / 2
    const nextItem = {
      ...selectedItem,
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      operator: { ...selectedItem.operator, originalWidth, scale: percent / 100 },
    }
    if (JSON.stringify(nextItem) === JSON.stringify(selectedItem)) return
    persistCanvas({ ...canvasRef.current, items: { ...canvasRef.current.items, [selectedKey]: nextItem } }, 0)
    setScaleInput(String(Math.round(percent)))
  }

  const handleRestoreOriginalResolution = () => {
    if (!selectedKey) return
    const dimensions = imageDimensions[selectedKey]
    const item = canvasRef.current.items[selectedKey]
    if (!dimensions || !item || item.width === dimensions.width) return
    const nextItem = {
      ...item,
      width: dimensions.width,
      operator: { ...item.operator, originalWidth: dimensions.width, scale: 1 },
    }
    persistCanvas({ ...canvasRef.current, items: { ...canvasRef.current.items, [selectedKey]: nextItem } }, 0)
  }

  const handleRestoreRotation = () => {
    if (!selectedItem) return
    updateSelectedImageOperator({ rotation: 0 })
  }

  const handleCropCommit = (key: string, crop: ProjectCanvasCrop) => {
    const item = canvasRef.current.items[key]
    if (!item) return
    const currentCrop = item.operator?.crop ?? { x: 0, y: 0, width: 1, height: 1 }
    if (currentCrop.x === crop.x && currentCrop.y === crop.y && currentCrop.width === crop.width && currentCrop.height === crop.height) {
      setCropImageId(null)
      return
    }
    persistCanvas({
      ...canvasRef.current,
      items: {
        ...canvasRef.current.items,
        [key]: { ...item, operator: { ...item.operator, crop } },
      },
    }, 0)
    setCropImageId(null)
  }

  const getSelectedSource = async () => {
    if (!selectedNode?.imageId) return null
    return await ensureImageCached(selectedNode.imageId)
  }

  const handleDownload = async () => {
    if (!selectedNode?.imageId) return
    setExportMenuOpen(false)
    const result = await downloadImageIds([selectedNode.imageId], selectedItem?.name || `image-${selectedNode.imageId}`)
    showToast(result.successCount ? '下载成功' : '下载失败', result.successCount ? 'success' : 'error')
  }

  const handleExport = async (format: ImageExportFormat) => {
    if (!selectedNode?.imageId) return
    setExportMenuOpen(false)
    try {
      const originalWidth = selectedItem?.operator?.originalWidth
      const scale = selectedItem?.operator?.scale ?? (originalWidth ? selectedItem.width / originalWidth : 1)
      await exportImage(selectedNode.imageId, selectedItem?.name || `image-${selectedNode.imageId}`, format, {
        crop: selectedItem?.operator?.crop,
        scale,
        rotation: selectedItem ? normalizeCanvasRotation(selectedItem.rotation ?? selectedItem.operator?.rotation ?? 0) : undefined,
        flipX: selectedItem?.operator?.flipX,
        flipY: selectedItem?.operator?.flipY,
      })
      showToast(`已导出 ${format.toUpperCase()}`, 'success')
    } catch (err) {
      showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const handleCopyImageId = async (imageId: string) => {
    try {
      await copyTextToClipboard(imageId)
      showToast('image_id 已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制 image_id 失败', err), 'error')
    }
  }

  const handleCopyFailureId = async (label: 'request_id' | 'task_id', value: string) => {
    try {
      await copyTextToClipboard(value)
      showToast(`${label} 已复制`, 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage(`复制 ${label} 失败`, err), 'error')
    }
  }

  const handleCopyFailureError = async (value: string) => {
    try {
      await copyTextToClipboard(value)
      showToast('错误原因已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制错误原因失败', err), 'error')
    }
  }

  const handleSaveMaterial = async () => {
    if (!selectedNode?.imageId) return
    try {
      const src = await getSelectedSource()
      if (!src) throw new Error('图片已不存在')
      await uploadMaterialImage(src, `image-${selectedNode.imageId}`)
      showToast('已保存到素材库', 'success')
    } catch (err) {
      showToast(`保存到素材库失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const handleDelete = () => {
    if (!selectedNode) return
    const task = selectedNode.task
    if (!selectedNode.imageId) {
      setConfirmDialog({
        title: '删除任务',
        message: '确定要删除这个生成失败的任务吗？',
        tone: 'danger',
        action: () => {
          setSelectedKey(null)
          void removeTask(task)
        },
      })
      return
    }
    const imageId = selectedNode.imageId
    setConfirmDialog({
      title: '删除图片',
      message: '确定要删除当前图片吗？同一任务中的其他图片会保留。',
      tone: 'danger',
      action: () => {
        setSelectedKey(null)
        void removeOutputImage(task, imageId)
      },
    })
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, [contenteditable="true"]'))) return
      const key = event.key.toLowerCase()
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && !event.altKey && !event.repeat && (key === 'z' || key === 'y')) {
        event.preventDefault()
        applyCanvasHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo')
        return
      }
      if (!selectedKey || event.repeat || (event.key !== 'Backspace' && event.key !== 'Delete')) return
      event.preventDefault()
      handleDelete()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [applyCanvasHistory, handleDelete, selectedKey])

  const toolbarButtonClass = 'flex h-8 w-8 items-center justify-center rounded text-gray-600 transition hover:bg-gray-100 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white'

  return (
    <div
      ref={containerRef}
      data-project-canvas
      data-no-drag-select
      className="relative h-full min-h-[320px] w-full overflow-hidden border border-gray-200 bg-gray-100 sm:min-h-[420px] dark:border-white/[0.08] dark:bg-gray-950"
      style={{ touchAction: 'none' }}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerEnd}
      onPointerCancel={handleCanvasPointerEnd}
    >
      {canvasConnections.length > 0 && (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible"
          data-canvas-reference-connections
        >
          <defs>
            <marker
              id="canvas-reference-arrow"
              markerHeight="8"
              markerUnits="userSpaceOnUse"
              markerWidth="8"
              orient="auto"
              refX="7"
              refY="4"
              viewBox="0 0 8 8"
            >
              <path d="M0 0 L8 4 L0 8 Z" fill="#3f78c5" />
            </marker>
          </defs>
          {canvasConnections.map((connection) => (
            <g key={connection.id} data-canvas-reference-connection>
              <path
                d={getCanvasConnectionPath(connection.start, connection.end)}
                fill="none"
                stroke="#3f78c5"
                strokeLinecap="round"
                strokeOpacity="0.14"
                strokeWidth="6"
              />
              <path
                d={getCanvasConnectionPath(connection.start, connection.end)}
                fill="none"
                stroke="#3f78c5"
                strokeLinecap="round"
                strokeOpacity="0.72"
                strokeWidth="1.75"
                markerEnd="url(#canvas-reference-arrow)"
              />
            </g>
          ))}
        </svg>
      )}
      <div
        className="absolute left-0 top-0 z-10 origin-top-left"
        style={{
          transform: `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.scale})`,
          transition: viewportAnimating ? 'transform 560ms cubic-bezier(0.22, 1, 0.36, 1)' : undefined,
        }}
      >
        {import.meta.env.DEV && (
          <div
            data-canvas-origin
            className="pointer-events-none absolute z-10"
            style={{
              left: 0,
              top: 0,
              width: 1,
              height: 1,
              transform: `scale(${1 / Math.max(canvas.viewport.scale, 0.01)})`,
              transformOrigin: 'center center',
            }}
          >
            <span className="absolute left-2 top-2 whitespace-nowrap font-mono text-[10px] font-semibold leading-3 text-[#3f78c5]" style={{ textShadow: '0 0 2px rgba(255, 255, 255, 0.9)' }}>0, 0</span>
            <span className="absolute -left-3 top-0 h-px w-6 bg-[#3f78c5]" />
            <span className="absolute left-0 -top-3 h-6 w-px bg-[#3f78c5]" />
          </div>
        )}
        {visibleNodes.map((node) => (
          <CanvasImageNode
            key={node.key}
            node={node}
            item={nodeItems[node.key]}
            selected={node.key === selectedKey}
            multiSelected={multiSelectedKeys.includes(node.key)}
            onPointerDown={(event) => handleNodePointerDown(node, event)}
            onPointerMove={handleNodePointerMove}
            onPointerEnd={handleNodePointerEnd}
            onResizeStart={(corner, event) => handleResizeStart(node.key, corner, event)}
            onResizeMove={handleResizeMove}
            onResizeEnd={handleResizeEnd}
            onRotateStart={(event) => handleRotateStart(node.key, event)}
            onRotateMove={handleRotateMove}
            onRotateEnd={handleRotateEnd}
            onDoubleClick={() => {
              if (node.imageId) focusCanvasImage(node.key)
            }}
            onRatio={(ratio) => setRatios((current) => current[node.key] === ratio ? current : { ...current, [node.key]: ratio })}
            onDimensions={(width, height) => handleImageDimensions(node.key, width, height)}
            onRename={(name) => handleRenameImage(node.key, name)}
            onCopyImageId={handleCopyImageId}
            onCopyFailureId={handleCopyFailureId}
            onCopyFailureError={handleCopyFailureError}
            cropEditing={cropImageId === node.key}
            onCropCommit={(crop) => handleCropCommit(node.key, crop)}
            onCropCancel={() => setCropImageId(null)}
            viewportScale={canvas.viewport.scale}
            interactionActive={interactionKeys.includes(node.key)}
            searchQuery={searchQuery}
          />
        ))}
      </div>

      <div data-canvas-toolbar className="pointer-events-none absolute inset-x-0 top-4 z-50 flex justify-center px-3 sm:top-5 sm:px-6">
        <div className="pointer-events-auto flex w-full max-w-3xl items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <SearchBar className="m-0" />
          </div>
          {canvasHeaderControls}
        </div>
      </div>

      {selectedNode?.imageId && selectedItem && imageInfoPanelPosition && (selectedTransformActive || transformPanelKey === selectedKey) && (
        <div
          data-canvas-toolbar
          data-canvas-image-info-panel
          className="absolute z-40 flex h-[80px] w-[140px] flex-col justify-center gap-0.5 rounded-md border border-gray-200 bg-white/95 px-2 py-1.5 shadow-lg backdrop-blur dark:border-white/[0.1] dark:bg-gray-900/95"
          style={{ left: imageInfoPanelPosition.left, top: imageInfoPanelPosition.top }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="mb-1.5 font-sans text-xs font-semibold leading-4 text-gray-700 dark:text-gray-200">图片变换</div>
          <div className="flex h-5 items-center justify-between gap-2">
            <label className="inline-flex items-center gap-1 whitespace-nowrap font-sans text-xs font-medium leading-5 tabular-nums text-[#3f78c5]">
              <AngleIcon className="h-4 w-4" />
              <input
                aria-label="旋转角度"
                type="number"
                min="0"
                max="360"
                step="1"
                value={rotationInput}
                className="h-5 w-12 border-0 bg-transparent p-0 text-right text-xs font-medium leading-5 tabular-nums text-[#3f78c5] outline-none"
                onChange={(event) => setRotationInput(event.target.value)}
                onFocus={() => setEditingTransformField('rotation')}
                onBlur={() => {
                  commitRotationInput()
                  setEditingTransformField((current) => current === 'rotation' ? null : current)
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') {
                    setRotationInput(String(Math.round(selectedRotation)))
                    event.currentTarget.blur()
                  }
                }}
              />
              {editingTransformField !== 'rotation' && '°'}
            </label>
            {selectedRotation !== 0 && (
              <TooltipButton tooltip="恢复旋转" onClick={handleRestoreRotation} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-600 transition hover:bg-gray-100 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white">
                <RefreshIcon className="h-4 w-4" />
              </TooltipButton>
            )}
          </div>
          <div className="flex h-5 items-center justify-between gap-2">
            <label className="inline-flex items-center gap-1 whitespace-nowrap font-sans text-xs font-medium leading-5 tabular-nums text-[#3f78c5]">
              <ScaleIcon className="h-4 w-4" />
              <input
                aria-label="缩放比例"
                type="number"
                min="1"
                max="500"
                step="1"
                value={scaleInput}
                className="h-5 w-14 border-0 bg-transparent p-0 text-right text-xs font-medium leading-5 tabular-nums text-[#3f78c5] outline-none"
                onChange={(event) => setScaleInput(event.target.value)}
                onFocus={() => setEditingTransformField('scale')}
                onBlur={() => {
                  commitScaleInput()
                  setEditingTransformField((current) => current === 'scale' ? null : current)
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') {
                    setScaleInput(String(Math.round(selectedScale * 100)))
                    event.currentTarget.blur()
                  }
                }}
              />
              {editingTransformField !== 'scale' && '%'}
            </label>
            {selectedDimensions && Math.abs(selectedItem.width - selectedDimensions.width) > 0.5 && (
              <TooltipButton tooltip="恢复缩放" onClick={handleRestoreOriginalResolution} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-600 transition hover:bg-gray-100 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white">
                <RefreshIcon className="h-4 w-4" />
              </TooltipButton>
            )}
          </div>
        </div>
      )}

      {nodes.map((node) => {
        const item = nodeItems[node.key]
        if (!item) return null
        return (
          <CanvasEdgeIndicator
            key={`edge:${node.key}`}
            node={node}
            item={item}
            ratio={ratios[node.key] ?? 1}
            viewport={canvas.viewport}
            containerSize={containerSize}
            onClick={() => focusCanvasImage(node.key)}
          />
        )
      })}

      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500">
          {searchQuery || filterFavorite ? '没有找到匹配的图片' : '输入提示词，为当前项目生成第一张图片'}
        </div>
      )}

      {(selectedNode?.imageId || selectedNode?.status === 'error') && toolbarPosition && (
        <div
          ref={toolbarRef}
          data-canvas-toolbar
          className="absolute z-40 flex max-w-[calc(100%-1rem)] items-center gap-0.5 overflow-x-auto rounded-md border border-gray-200 bg-white/95 p-1 shadow-lg backdrop-blur dark:border-white/[0.1] dark:bg-gray-900/95"
          style={{ left: toolbarPosition.left, top: toolbarPosition.top }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {selectedNode.imageId && <>
            <TooltipButton tooltip="收藏" onClick={() => openImageFavoritePicker([selectedNode.imageId!])} className={toolbarButtonClass}><FavoriteIcon filled={getImageFavoriteCollectionIds(selectedNode.imageId, selectedNode.task).length > 0} className="h-4 w-4" /></TooltipButton>
            <div className="relative flex items-center" data-canvas-toolbar>
              <TooltipButton tooltip="下载" onClick={() => void handleDownload()} className={toolbarButtonClass}><DownloadIcon className="h-4 w-4" /></TooltipButton>
              <TooltipButton
                tooltip="导出图片"
                className={`${toolbarButtonClass} w-10 shrink-0 gap-0.5 px-1`}
                onClick={(event) => {
                  const container = containerRef.current
                  const button = event.currentTarget
                  if (container) {
                    const containerRect = container.getBoundingClientRect()
                    const buttonRect = button.getBoundingClientRect()
                    setExportMenuPosition({
                      left: Math.max(4, Math.min(buttonRect.left - containerRect.left, container.clientWidth - 116)),
                      top: buttonRect.bottom - containerRect.top + 4,
                    })
                  }
                  setExportMenuOpen((open) => !open)
                }}
              >
                <ExportIcon className="h-3.5 w-3.5" />
                <ChevronDownIcon className="h-3 w-3" />
              </TooltipButton>
            </div>
            <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-gray-300 dark:bg-white/20" />
            <TooltipButton tooltip="编辑输出" onClick={() => void editOutputImage(selectedNode.task, selectedNode.imageId!)} className={toolbarButtonClass}><EditIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="复用配置" onClick={() => void reuseImageConfig(selectedNode.task, selectedNode.imageId!)} className={toolbarButtonClass}><ReuseConfigIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="保存到素材库" onClick={() => void handleSaveMaterial()} className={toolbarButtonClass}><CloudUploadIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="重试单图" onClick={() => retryImage(selectedNode.task)} className={toolbarButtonClass}><RefreshIcon className="h-4 w-4" /></TooltipButton>
            <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-gray-300 dark:bg-white/20" />
            <TooltipButton tooltip="裁剪图片" onClick={() => setCropImageId(selectedNode.imageId!)} className={toolbarButtonClass}><CropIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="向左旋转 90°" onClick={() => handleRotateBy(-90)} className={toolbarButtonClass}><RotateLeftIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="向右旋转 90°" onClick={() => handleRotateBy(90)} className={toolbarButtonClass}><RotateRightIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="左右翻转" onClick={() => handleFlip('x')} className={toolbarButtonClass}><FlipHorizontalIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="上下翻转" onClick={() => handleFlip('y')} className={toolbarButtonClass}><FlipVerticalIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="图片信息" onClick={() => setDetailImage(selectedNode.task.id, selectedNode.imageId!)} className={toolbarButtonClass}><InfoIcon className="h-4 w-4" /></TooltipButton>
          </>}
          {selectedNode.imageId && <>
            <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-gray-300 dark:bg-white/20" />
            <TooltipButton tooltip="删除当前图片" onClick={handleDelete} className={`${toolbarButtonClass} text-red-500 hover:bg-red-50 hover:text-red-600 dark:text-red-400 dark:hover:bg-red-400/10 dark:hover:text-red-300`}><TrashIcon className="h-4 w-4" /></TooltipButton>
          </>}
          {selectedNode.status === 'error' && <>
            <TooltipButton tooltip="复用配置" onClick={() => void reuseImageConfig(selectedNode.task)} className={toolbarButtonClass}><ReuseConfigIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="重试单图" onClick={() => retryImage(selectedNode.task)} className={toolbarButtonClass}><RefreshIcon className="h-4 w-4" /></TooltipButton>
            <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-gray-300 dark:bg-white/20" />
            <TooltipButton tooltip="图片信息" onClick={() => setDetailTaskId(selectedNode.task.id)} className={toolbarButtonClass}><InfoIcon className="h-4 w-4" /></TooltipButton>
            <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-gray-300 dark:bg-white/20" />
            <TooltipButton tooltip="删除任务" onClick={handleDelete} className={`${toolbarButtonClass} text-red-500 hover:bg-red-50 hover:text-red-600 dark:text-red-400 dark:hover:bg-red-400/10 dark:hover:text-red-300`}><TrashIcon className="h-4 w-4" /></TooltipButton>
          </>}
        </div>
      )}

      {selectedNode?.imageId && exportMenuOpen && exportMenuPosition && (
        <div className="absolute z-50 min-w-28 overflow-hidden rounded-md border border-gray-200 bg-white p-1 text-xs shadow-lg dark:border-white/[0.1] dark:bg-gray-900" style={{ left: exportMenuPosition.left, top: exportMenuPosition.top }} onPointerDown={(event) => event.stopPropagation()}>
          {(['png', 'jpg', 'svg', 'psd'] as ImageExportFormat[]).map((format) => (
            <button key={format} type="button" className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/[0.08]" onClick={() => void handleExport(format)}>
              {format.toUpperCase()}
            </button>
          ))}
        </div>
      )}

      <div
        ref={zoomControlsRef}
        data-canvas-toolbar
        data-canvas-zoom-controls
        className={`pointer-events-auto fixed bottom-2 z-[150] flex items-center rounded-md border border-gray-200 bg-white/95 p-1 text-xs shadow-sm backdrop-blur dark:border-white/[0.1] dark:bg-gray-900/95 sm:bottom-3 ${agentPanelCollapsed ? 'right-2 sm:right-3' : 'right-2 sm:right-3 xl:right-[428px]'}`}
        style={{ zIndex: 150 }}
        onWheel={(event) => event.stopPropagation()}
      >
        {layersOpen && (
          <div data-canvas-layers-panel className="absolute bottom-full left-0 mb-2 w-56 overflow-hidden rounded-md border border-gray-200 bg-white/95 p-2 text-xs shadow-lg backdrop-blur dark:border-white/[0.1] dark:bg-gray-900/95" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
            <div className="mb-1.5 font-medium text-gray-800 dark:text-gray-100">图层</div>
            <div className="max-h-64 overflow-y-auto">
              {[...nodes].sort((a, b) => (nodeItems[b.key]?.z ?? 0) - (nodeItems[a.key]?.z ?? 0)).map((node) => {
                const item = nodeItems[node.key]
                if (!item) return null
                const label = item.name ?? node.placeholderName ?? node.imageId ?? '图片'
                return (
                  <div key={node.key} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 transition ${node.key === selectedKey ? 'bg-[#3f78c5]/12 text-[#3f78c5]' : 'text-gray-700 dark:text-gray-200'}`}>
                    {editingLayerKey === node.key ? (
                      <input
                        autoFocus
                        value={layerNameDraft}
                        maxLength={80}
                        aria-label="图层名称"
                        className="min-w-0 flex-1 border-0 border-b border-[#3f78c5] bg-transparent p-0 text-xs outline-none"
                        onChange={(event) => setLayerNameDraft(event.target.value)}
                        onPointerDown={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur()
                          if (event.key === 'Escape') {
                            setEditingLayerKey(null)
                            setLayerNameDraft('')
                          }
                        }}
                        onBlur={() => {
                          const name = layerNameDraft.trim()
                          if (name && handleRenameImage(node.key, name)) setEditingLayerKey(null)
                          else if (!name) setEditingLayerKey(null)
                        }}
                      />
                    ) : (
                      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => focusCanvasImage(node.key)} onDoubleClick={(event) => { event.stopPropagation(); setLayerNameDraft(label); setEditingLayerKey(node.key) }}>
                        {node.status === 'error' ? <WarningIcon className="h-4 w-4 shrink-0 text-red-500" /> : <ImageIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />}
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                      </button>
                    )}
                    <span className="shrink-0 tabular-nums text-[10px] text-gray-400">z{Math.round(item.z)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {minimapOpen && minimapData && (
          <div className="absolute bottom-full left-0 mb-2 w-60 text-xs shadow-lg" onPointerDown={(event) => event.stopPropagation()}>
            <div className="relative h-36 overflow-hidden rounded border border-gray-200 bg-gray-100 dark:border-white/[0.1] dark:bg-gray-800">
              <div
                className="absolute z-20 cursor-move border border-[#3f78c5] bg-[#3f78c5]/10"
                style={{ left: `${Math.max(0, Math.min(100, minimapData.viewport.left))}%`, top: `${Math.max(0, Math.min(100, minimapData.viewport.top))}%`, width: `${Math.max(2, Math.min(100, minimapData.viewport.width))}%`, height: `${Math.max(2, Math.min(100, minimapData.viewport.height))}%` }}
                onPointerDown={handleMinimapDragStart}
                onPointerMove={handleMinimapDragMove}
                onPointerUp={handleMinimapDragEnd}
                onPointerCancel={handleMinimapDragEnd}
              />
              {minimapData.entries.map(({ node, item, height }) => {
                const label = item.name ?? node.placeholderName ?? node.imageId ?? '图片'
                return (
                  <button
                    key={node.key}
                    type="button"
                    aria-label={`跳转到${label}`}
                    title={label}
                    className={`absolute z-30 min-h-1 min-w-1 rounded-sm ${node.key === selectedKey ? 'bg-[#3f78c5] ring-2 ring-[#3f78c5]/40' : node.status === 'error' ? 'bg-red-500/80' : 'bg-[#3f78c5]/65 hover:bg-[#3f78c5]'}`}
                    style={{ left: `${(item.x - minimapData.bounds.minX) / minimapData.bounds.width * 100}%`, top: `${(item.y - minimapData.bounds.minY) / minimapData.bounds.height * 100}%`, width: `${Math.max(1.5, item.width / minimapData.bounds.width * 100)}%`, height: `${Math.max(1.5, height / minimapData.bounds.height * 100)}%` }}
                    onClick={() => focusCanvasImage(node.key)}
                  />
                )
              })}
            </div>
          </div>
        )}
        <button type="button" className={`flex h-7 w-7 items-center justify-center rounded text-[#3f78c5] transition ${zoomHelpOpen ? 'bg-[#3f78c5]/15' : 'hover:bg-[#3f78c5]/10'}`} aria-label="画布操作说明" title="画布操作说明" onClick={() => { setZoomHelpOpen((open) => !open); setZoomPresetOpen(false) }}><InfoIcon className="h-4 w-4" /></button>
        <button type="button" className={`flex h-7 w-7 items-center justify-center rounded transition ${layersOpen ? 'bg-[#3f78c5]/15 text-[#3f78c5]' : 'hover:bg-gray-100 dark:hover:bg-white/[0.08]'}`} aria-label="图层" title="图层" onClick={() => { setLayersOpen((open) => !open); setMinimapOpen(false); setZoomHelpOpen(false) }}><LayersIcon className="h-4 w-4" /></button>
        <button type="button" className={`flex h-7 w-7 items-center justify-center rounded transition ${minimapOpen ? 'bg-[#3f78c5]/15 text-[#3f78c5]' : 'hover:bg-gray-100 dark:hover:bg-white/[0.08]'}`} aria-label="小地图" title="小地图" onClick={() => { setMinimapOpen((open) => !open); setLayersOpen(false); setZoomHelpOpen(false) }}><MapIcon className="h-4 w-4" /></button>
        <button type="button" className="flex h-7 w-7 items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-white/[0.08]" aria-label="回到画布原点" title="回到画布原点" onClick={() => setViewport({ ...canvas.viewport, x: containerSize.width / 2, y: containerSize.height / 2 })}><HomeIcon className="h-3.5 w-3.5" /></button>
        <button type="button" className="h-7 w-7 rounded hover:bg-gray-100 dark:hover:bg-white/[0.08]" aria-label="缩小画布" title="缩小画布" onClick={() => setViewport(zoomCanvasViewport(canvas.viewport, { x: containerSize.width / 2, y: containerSize.height / 2 }, canvas.viewport.scale / 1.2))}>−</button>
        <div className="relative">
          {zoomEditing ? (
            <input
              ref={zoomInputRef}
              aria-label="输入画布缩放比例"
              type="number"
              min="1"
              max="1000"
              value={zoomInput}
              className="h-7 w-14 rounded border border-[#3f78c5] bg-transparent px-1 text-center tabular-nums text-gray-600 outline-none dark:text-gray-300"
              onChange={(event) => setZoomInput(event.target.value)}
              onBlur={commitCanvasZoomInput}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitCanvasZoomInput()
                if (event.key === 'Escape') setZoomEditing(false)
              }}
            />
          ) : (
            <button
              type="button"
              aria-label="选择画布缩放比例"
              title="点击选择缩放比例，双击输入"
              className="h-7 w-14 rounded px-1 text-center tabular-nums text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/[0.08]"
              onClick={() => {
                setZoomPresetOpen((open) => !open)
                setZoomHelpOpen(false)
              }}
              onDoubleClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setZoomInput(String(Math.round(canvas.viewport.scale * 100)))
                setZoomPresetOpen(false)
                setZoomEditing(true)
              }}
            >{Math.round(canvas.viewport.scale * 100)}%</button>
          )}
          {zoomPresetOpen && !zoomEditing && (
            <div data-canvas-zoom-preset className="absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 gap-1 rounded-md border border-gray-200 bg-white p-1 text-[11px] shadow-lg dark:border-white/[0.1] dark:bg-gray-900" onPointerDown={(event) => event.stopPropagation()}>
              {[50, 100, 200].map((percent) => <button key={percent} type="button" className="rounded px-2 py-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.08]" onClick={() => setCanvasZoomPercent(percent)}>{percent}%</button>)}
            </div>
          )}
        </div>
        <button type="button" className="h-7 w-7 rounded hover:bg-gray-100 dark:hover:bg-white/[0.08]" aria-label="放大画布" title="放大画布" onClick={() => setViewport(zoomCanvasViewport(canvas.viewport, { x: containerSize.width / 2, y: containerSize.height / 2 }, canvas.viewport.scale * 1.2))}>+</button>
        {zoomHelpOpen && (
          <div className="absolute bottom-full right-0 mb-2 w-80 rounded-md border border-gray-200 bg-white p-4 text-xs leading-6 text-gray-600 shadow-lg dark:border-white/[0.1] dark:bg-gray-900 dark:text-gray-300" onPointerDown={(event) => event.stopPropagation()}>
            <div className="mb-1 text-sm font-medium text-gray-800 dark:text-gray-100">画布操作说明</div>
            <div>滚轮 / 双指：缩放画布</div>
            <div>空白拖动：平移画布</div>
            <div>Ctrl + 拖动：框选图片</div>
            <div>Delete / Backspace：删除选中图片</div>
            <div>Ctrl/Cmd + Z：撤销上一步画布操作</div>
            <div>Ctrl/Cmd + Y：重做上一步画布操作</div>
            <div>最多保留 30 层历史记录</div>
            <div>双击右下角比例：输入缩放百分比</div>
            <div className="mt-2 border-t border-gray-100 pt-2 dark:border-white/[0.08]">
              <div className="mb-1 font-medium text-gray-800 dark:text-gray-100">图片菜单说明</div>
              <div>选中图片后，图片上方会显示图片操作菜单。</div>
              <div className="mt-1 flex items-start gap-2"><DownloadIcon className="mt-1 h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" /><span>下载：下载修改前的原图</span></div>
              <div className="flex items-start gap-2"><ExportIcon className="mt-1 h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" /><span>导出：导出裁剪、旋转等操作修改后的图片</span></div>
            </div>
          </div>
        )}
      </div>
      {marquee && <div className="pointer-events-none absolute z-30 border border-[#3f78c5]/70 bg-[#3f78c5]/15" style={{ left: Math.min(marquee.start.x, marquee.current.x), top: Math.min(marquee.start.y, marquee.current.y), width: Math.abs(marquee.current.x - marquee.start.x), height: Math.abs(marquee.current.y - marquee.start.y) }} />}
    </div>
  )
}
