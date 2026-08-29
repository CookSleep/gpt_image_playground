import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ProjectCanvasItem, ProjectCanvasState, ProjectCanvasViewport, TaskRecord } from '../types'
import {
  ALL_FAVORITES_COLLECTION_ID,
  ALL_PROJECTS_ID,
  LOCAL_PROJECT_ID,
  editOutputImage,
  ensureImageCached,
  ensureImageThumbnailCached,
  getImageFavoriteCollectionIds,
  removeOutputImage,
  reuseImageConfig,
  retryImage,
  subscribeImageThumbnail,
  taskMatchesFilterStatus,
  taskMatchesSearchQuery,
  useStore,
} from '../store'
import {
  ensureProjectCanvas,
  getDefaultCanvasItem,
  isCanvasRectVisible,
  zoomCanvasViewport,
} from '../lib/projectCanvas'
import { copyImageSourceToClipboard, copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { downloadImageIds } from '../lib/downloadImages'
import { uploadMaterialImage } from '../lib/materialApi'
import { TooltipButton } from './TooltipButton'
import ImageCropModal from './ImageCropModal'
import {
  CloudUploadIcon,
  CropIcon,
  CopyIcon,
  DownloadIcon,
  EditIcon,
  FavoriteIcon,
  HelpCircleIcon,
  HomeIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  RotateIcon,
  TrashIcon,
} from './icons'

type CanvasNode = {
  key: string
  imageId?: string
  task: TaskRecord
  status: 'done' | 'running' | 'error'
  previewSrc?: string
  error?: string
}

const EMPTY_PROJECT_CANVAS_CACHE: Record<string, ProjectCanvasState> = {}

function sameCanvas(a: ProjectCanvasState | undefined, b: ProjectCanvasState) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function centroid(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
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
  onCopyImageId,
  interactionActive,
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
  onCopyImageId: (imageId: string) => void
  interactionActive: boolean
}) {
  const [src, setSrc] = useState(node.previewSrc ?? '')
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const onRatioRef = useRef(onRatio)

  const updateDimensions = (width?: number, height?: number) => {
    if (!width || !height) return
    setDimensions((current) => current?.width === width && current.height === height ? current : { width, height })
    onRatioRef.current(width / height)
  }

  useEffect(() => {
    onRatioRef.current = onRatio
  }, [onRatio])

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

  return (
    <div
      data-canvas-node
      data-node-key={node.key}
      className="absolute select-none"
      style={{
        left: item.x,
        top: item.y,
        width: item.width,
        transform: `rotate(${item.rotation ?? 0}deg)`,
        transformOrigin: 'center center',
        zIndex: selected || multiSelected ? Math.max(item.z, 1000) : item.z,
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={onDoubleClick}
      title={node.error}
    >
      <div className={`relative overflow-hidden bg-white shadow-sm dark:bg-gray-900 ${selected || multiSelected ? 'ring-2 ring-[#5b91df]' : 'ring-1 ring-black/10 dark:ring-white/10'}`}>
        {src ? (
          <img
            src={src}
            data-image-id={node.imageId}
            data-output-image-ids={node.imageId}
            draggable={false}
            alt=""
            className="block h-auto w-full object-contain"
            onLoad={(event) => updateDimensions(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
          />
        ) : (
          <div className="flex aspect-square w-full items-center justify-center bg-gray-100 text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
            {node.status === 'running' ? (
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#5b91df] border-t-transparent" />
                {statusText}
              </span>
            ) : statusText}
          </div>
        )}
        {statusText && src && (
          <span className={`absolute bottom-2 left-2 rounded px-2 py-1 text-xs text-white backdrop-blur ${node.status === 'running' ? 'bg-[#5b91df]/85' : 'bg-red-500/85'}`}>
            {statusText}
          </span>
        )}
      </div>
      {selected && node.imageId && (
        <div className="absolute bottom-full left-0 mb-0.5 flex max-w-44 items-end gap-1 text-[#5b91df]" title={node.imageId}>
          <span className="min-w-0 truncate font-sans text-[11px] leading-4">{item.name ?? node.imageId}</span>
          <button
            type="button"
            data-canvas-handle
            aria-label="复制图片 ID"
            title="复制图片 ID"
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[#5b91df] hover:bg-[#5b91df]/15 hover:text-[#5b91df]"
            onClick={() => onCopyImageId(node.imageId!)}
          >
            <CopyIcon className="h-3 w-3" />
          </button>
        </div>
      )}
      {selected && dimensions && <span className="absolute bottom-full right-0 mb-0.5 whitespace-nowrap text-[11px] leading-4 text-[#5b91df]">{dimensions.width} × {dimensions.height}</span>}
      {selected && <>
        {(['nw', 'ne', 'sw', 'se'] as ResizeCorner[]).map((corner) => <button
          key={corner}
          type="button"
          data-canvas-handle
          aria-label={`调整图片${corner}`}
          className={`absolute h-2.5 w-2.5 rounded-sm border border-[#5b91df] bg-white shadow-sm ${corner === 'nw' ? '-left-1 -top-1 cursor-nwse-resize' : corner === 'ne' ? '-right-1 -top-1 cursor-nesw-resize' : corner === 'sw' ? '-bottom-1 -left-1 cursor-nesw-resize' : '-bottom-1 -right-1 cursor-nwse-resize'}`}
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
          className="absolute left-1/2 top-0 flex -translate-x-1/2 -translate-y-[26px] cursor-grab items-center justify-center rounded-full bg-[#5b91df] p-1 text-white shadow-sm active:cursor-grabbing"
          onPointerDown={onRotateStart}
          onPointerMove={onRotateMove}
          onPointerUp={onRotateEnd}
          onPointerCancel={onRotateEnd}
        ><RotateIcon className="h-3.5 w-3.5" /></button>
        <span className="pointer-events-none absolute left-1/2 top-0 h-5 -translate-x-1/2 -translate-y-5 border-l border-[#5b91df]" />
      </>}
    </div>
  )
}

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

export default function ProjectCanvas({ agentPanelCollapsed = false }: { agentPanelCollapsed?: boolean }) {
  const tasks = useStore((s) => s.tasks)
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const projectsLoaded = useStore((s) => s.projectsLoaded)
  const projectCanvasCache = useStore((s) => s.projectCanvasCache) ?? EMPTY_PROJECT_CANVAS_CACHE
  const streamPreviewSlots = useStore((s) => s.streamPreviewSlots)
  const updateProjectCanvas = useStore((s) => s.updateProjectCanvas)
  const setDetailImage = useStore((s) => s.setDetailImage)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const openImageFavoritePicker = useStore((s) => s.openImageFavoritePicker)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const activeProject = projects.find((project) => project.id === activeProjectId)
  const canvasProjectId = activeProject?.id ?? (activeProjectId === LOCAL_PROJECT_ID ? LOCAL_PROJECT_ID : null)
  const containerRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<ProjectCanvasState>(ensureProjectCanvas((canvasProjectId ? projectCanvasCache[canvasProjectId] : undefined) ?? activeProject?.canvas, []))
  const persistTimerRef = useRef<number | null>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const panRef = useRef<{ pointerId: number; start: { x: number; y: number }; viewport: ProjectCanvasViewport; moved: boolean } | null>(null)
  const pinchRef = useRef<{ distance: number; screenCentroid: { x: number; y: number }; canvasCentroid: { x: number; y: number }; viewport: ProjectCanvasViewport; moved: boolean } | null>(null)
  const dragRef = useRef<{ keys: string[]; pointerId: number; start: { x: number; y: number }; items: Record<string, ProjectCanvasItem>; moved: boolean } | null>(null)
  const resizeRef = useRef<{ key: string; pointerId: number; corner: ResizeCorner; start: { x: number; y: number }; item: ProjectCanvasItem; moved: boolean } | null>(null)
  const rotateRef = useRef<{ key: string; pointerId: number; center: { x: number; y: number }; startAngle: number; startRotation: number; moved: boolean } | null>(null)
  const marqueeRef = useRef<{ pointerId: number; start: { x: number; y: number }; initial: string[] } | null>(null)
  const [canvas, setCanvas] = useState(canvasRef.current)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [interactionKeys, setInteractionKeys] = useState<string[]>([])
  const [multiSelectedKeys, setMultiSelectedKeys] = useState<string[]>([])
  const [marquee, setMarquee] = useState<{ start: { x: number; y: number }; current: { x: number; y: number } } | null>(null)
  const [ratios, setRatios] = useState<Record<string, number>>({})
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [toolbarSize, setToolbarSize] = useState({ width: 0, height: 0 })
  const [cropImageId, setCropImageId] = useState<string | null>(null)

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
  const legacyFavoriteIdsByImage = useMemo(() => Object.fromEntries(projectTasks.flatMap((task) =>
    task.outputImages.map((imageId) => [imageId, task.isFavorite ? getImageFavoriteCollectionIds(imageId, task) : []]),
  )), [projectTasks])

  useEffect(() => {
    const next = ensureProjectCanvas((canvasProjectId ? projectCanvasCache[canvasProjectId] : undefined) ?? activeProject?.canvas ?? canvasRef.current, projectImageIds, legacyFavoriteIdsByImage, imageZById)
    canvasRef.current = next
    setCanvas(next)
    if (canvasProjectId && (activeProject || projectsLoaded) && !sameCanvas(activeProject?.canvas, next)) updateProjectCanvas(canvasProjectId, next)
  }, [activeProject, activeProject?.canvas, activeProject?.id, canvasProjectId, imageZById, legacyFavoriteIdsByImage, projectCanvasCache, projectImageIds, projectsLoaded, updateProjectCanvas])

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
    if (persistTimerRef.current == null) return
    window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = null
    if (canvasProjectId) updateProjectCanvas(canvasProjectId, canvasRef.current)
  }, [canvasProjectId, updateProjectCanvas])

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

  const persistCanvas = (next: ProjectCanvasState, delay = 0) => {
    canvasRef.current = next
    setCanvas(next)
    if (!canvasProjectId) return
    if (persistTimerRef.current != null) window.clearTimeout(persistTimerRef.current)
    if (delay <= 0) {
      persistTimerRef.current = null
      updateProjectCanvas(canvasProjectId, next)
      return
    }
    persistTimerRef.current = window.setTimeout(() => {
      updateProjectCanvas(canvasProjectId, canvasRef.current)
      persistTimerRef.current = null
    }, delay)
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = container.getBoundingClientRect()
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const factor = Math.exp(-event.deltaY * 0.0015)
      setViewport(zoomCanvasViewport(canvasRef.current.viewport, point, canvasRef.current.viewport.scale * factor), 180)
    }
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [activeProject?.id])

  const nodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const result: CanvasNode[] = []
    for (const task of projectTasks) {
      if (!taskMatchesFilterStatus(task, filterStatus) || !taskMatchesSearchQuery(task, q)) continue
      for (const imageId of task.outputImages) {
        const favoriteIds = getImageFavoriteCollectionIds(imageId, task)
        if (filterFavorite && favoriteIds.length === 0) continue
        if (filterFavorite && activeFavoriteCollectionId && activeFavoriteCollectionId !== ALL_FAVORITES_COLLECTION_ID && !favoriteIds.includes(activeFavoriteCollectionId)) continue
        result.push({ key: imageId, imageId, task, status: 'done' })
      }
      if (filterFavorite) continue

      const previews = streamPreviewSlots[task.id] ?? {}
      if (task.status === 'running') {
        const count = Math.max(0, task.params.n - task.outputImages.length - (task.outputErrors?.length ?? 0))
        for (let index = 0; index < count; index++) {
          const slot = String(task.outputImages.length + index)
          result.push({ key: `${task.id}:running:${slot}`, task, status: 'running', previewSrc: previews[slot] })
        }
      }
      if (task.status === 'error' && task.outputImages.length === 0 && !task.outputErrors?.length) {
        result.push({ key: `${task.id}:error`, task, status: 'error', error: task.error ?? undefined })
      }
      for (const error of task.outputErrors ?? []) {
        result.push({ key: `${task.id}:error:${error.requestIndex}`, task, status: 'error', error: error.error })
      }
    }
    return result
  }, [activeFavoriteCollectionId, filterFavorite, filterStatus, projectTasks, searchQuery, streamPreviewSlots])

  const nodeItems = useMemo(() => {
    const items: Record<string, ProjectCanvasItem> = {}
    let fallbackIndex = projectImageIds.length
    for (const node of nodes) {
      const imageIndex = node.imageId ? projectImageIds.indexOf(node.imageId) : -1
      const fallback = getDefaultCanvasItem(fallbackIndex++)
      const existing = node.imageId ? canvas.items[node.imageId] : undefined
      if (existing) {
        items[node.key] = existing.name || imageIndex < 0 ? existing : { ...existing, name: `图片 ${imageIndex + 1}` }
        continue
      }
      items[node.key] = node.imageId && imageIndex >= 0
        ? { ...fallback, name: `图片 ${imageIndex + 1}` }
        : fallback
    }
    return items
  }, [canvas.items, nodes, projectImageIds])

  const visibleNodes = useMemo(() => nodes.filter((node) => {
    if (node.key === selectedKey) return true
    const item = nodeItems[node.key]
    const ratio = ratios[node.key] ?? 1
    return isCanvasRectVisible(item, item.width / ratio, canvas.viewport, containerSize)
  }), [canvas.viewport, containerSize, nodeItems, nodes, ratios, selectedKey])
  const selectedNode = nodes.find((node) => node.key === selectedKey)
  const selectedItem = selectedKey ? nodeItems[selectedKey] : undefined
  const selectedRatio = selectedKey ? ratios[selectedKey] ?? 1 : 1

  const toolbarPosition = selectedItem ? (() => {
    const width = selectedItem.width * canvas.viewport.scale
    const height = (selectedItem.width / selectedRatio) * canvas.viewport.scale
    const center = selectedItem.x * canvas.viewport.scale + canvas.viewport.x + width / 2
    const toolbarHeight = toolbarSize.height || 42
    const halfWidth = toolbarSize.width > 0 ? toolbarSize.width / 2 : Math.min(200, Math.max(0, containerSize.width - 16) / 2)
    const above = selectedItem.y * canvas.viewport.scale + canvas.viewport.y - toolbarHeight - 34
    const preferredTop = above >= 8 ? above : selectedItem.y * canvas.viewport.scale + canvas.viewport.y + height + 8
    return {
      left: Math.min(Math.max(center, halfWidth + 8), Math.max(halfWidth + 8, containerSize.width - halfWidth - 8)),
      top: Math.min(Math.max(preferredTop, 8), Math.max(8, containerSize.height - toolbarHeight - 8)),
    }
  })() : null

  const setViewport = (viewport: ProjectCanvasViewport, persistDelay = 0) => {
    persistCanvas({ ...canvasRef.current, viewport }, persistDelay)
  }

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-canvas-node], [data-canvas-toolbar], button')) return
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
      }, 180)
      return
    }

    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    const deltaX = event.clientX - pan.start.x
    const deltaY = event.clientY - pan.start.y
    pan.moved = pan.moved || Math.hypot(deltaX, deltaY) > 3
    setViewport({ ...pan.viewport, x: pan.viewport.x + deltaX, y: pan.viewport.y + deltaY }, 180)
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
    const shouldPersist = Boolean(panRef.current?.moved || pinchRef.current?.moved)
    pointersRef.current.delete(event.pointerId)
    panRef.current = null
    pinchRef.current = null
    if (shouldPersist) persistCanvas(canvasRef.current, 0)
  }

  const handleNodePointerDown = (node: CanvasNode, event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    event.stopPropagation()
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
    for (const key of drag.keys) {
      const item = drag.items[key]
      if (!item) continue
      items[key] = { ...item, x: item.x + deltaX, y: item.y + deltaY }
    }
    canvasRef.current = { ...canvasRef.current, items }
    setCanvas(canvasRef.current)
  }

  const handleNodePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setInteractionKeys([])
    if (drag.moved) persistCanvas(canvasRef.current, 0)
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
    const items = { ...canvasRef.current.items, [resize.key]: {
      ...resize.item,
      width,
      x: resize.corner.endsWith('e') ? resize.item.x : resize.item.x - actualDelta,
      y: resize.corner.startsWith('s') ? resize.item.y : resize.item.y - actualDelta / ratio,
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
      startRotation: item.rotation ?? 0,
      moved: false,
    }
  }

  const handleRotateMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const rotate = rotateRef.current
    if (!rotate || rotate.pointerId !== event.pointerId) return
    const angle = Math.atan2(event.clientY - rotate.center.y, event.clientX - rotate.center.x)
    const rotation = rotate.startRotation + (angle - rotate.startAngle) * 180 / Math.PI
    rotate.moved = rotate.moved || Math.abs(rotation - rotate.startRotation) > 0.01
    const items = { ...canvasRef.current.items, [rotate.key]: { ...canvasRef.current.items[rotate.key], rotation: (rotation + 360) % 360 } }
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

  const getSelectedSource = async () => {
    if (!selectedNode?.imageId) return null
    return await ensureImageCached(selectedNode.imageId)
  }

  const handleCopy = async () => {
    try {
      const src = await getSelectedSource()
      if (!src) throw new Error('图片已不存在')
      await copyImageSourceToClipboard(src)
      showToast('图片已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制失败', err), 'error')
    }
  }

  const handleDownload = async () => {
    if (!selectedNode?.imageId) return
    const result = await downloadImageIds([selectedNode.imageId], `image-${selectedNode.imageId}`)
    showToast(result.successCount ? '下载成功' : '下载失败', result.successCount ? 'success' : 'error')
  }

  const handleCopyImageId = async (imageId: string) => {
    try {
      await copyTextToClipboard(imageId)
      showToast('image_id 已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制 image_id 失败', err), 'error')
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
    if (!selectedNode?.imageId) return
    const imageId = selectedNode.imageId
    const task = selectedNode.task
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
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.scale})` }}
      >
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
              if (node.imageId) setLightboxImageId(node.imageId, nodes.flatMap((item) => item.imageId ? [item.imageId] : []))
            }}
            onRatio={(ratio) => setRatios((current) => current[node.key] === ratio ? current : { ...current, [node.key]: ratio })}
            onCopyImageId={handleCopyImageId}
            interactionActive={interactionKeys.includes(node.key)}
          />
        ))}
      </div>

      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500">
          {searchQuery || filterFavorite ? '没有找到匹配的图片' : '输入提示词，为当前项目生成第一张图片'}
        </div>
      )}

      {selectedNode && toolbarPosition && (
        <div
          ref={toolbarRef}
          data-canvas-toolbar
          className="absolute z-40 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-md border border-gray-200 bg-white/95 p-1 shadow-lg backdrop-blur dark:border-white/[0.1] dark:bg-gray-900/95"
          style={{ left: toolbarPosition.left, top: toolbarPosition.top }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {selectedNode.imageId && <>
            <TooltipButton tooltip="查看大图" onClick={() => setLightboxImageId(selectedNode.imageId!, nodes.flatMap((item) => item.imageId ? [item.imageId] : []))} className={toolbarButtonClass}><SearchIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="图片信息" onClick={() => setDetailImage(selectedNode.task.id, selectedNode.imageId!)} className={toolbarButtonClass}><HelpCircleIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="收藏" onClick={() => openImageFavoritePicker([selectedNode.imageId!])} className={toolbarButtonClass}><FavoriteIcon filled={getImageFavoriteCollectionIds(selectedNode.imageId, selectedNode.task).length > 0} className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="下载" onClick={() => void handleDownload()} className={toolbarButtonClass}><DownloadIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="复制" onClick={() => void handleCopy()} className={toolbarButtonClass}><CopyIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="加入参考图" onClick={() => void editOutputImage(selectedNode.task, selectedNode.imageId!)} className={toolbarButtonClass}><PlusIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="编辑输出" onClick={() => void editOutputImage(selectedNode.task, selectedNode.imageId!)} className={toolbarButtonClass}><EditIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="裁剪图片" onClick={() => setCropImageId(selectedNode.imageId!)} className={toolbarButtonClass}><CropIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="复用配置" onClick={() => void reuseImageConfig(selectedNode.task, selectedNode.imageId!)} className={toolbarButtonClass}><RefreshIcon className="h-4 w-4" /></TooltipButton>
            <TooltipButton tooltip="保存到素材库" onClick={() => void handleSaveMaterial()} className={toolbarButtonClass}><CloudUploadIcon className="h-4 w-4" /></TooltipButton>
          </>}
          <TooltipButton tooltip="重试单图" onClick={() => retryImage(selectedNode.task)} className={toolbarButtonClass}><RefreshIcon className="h-4 w-4" /></TooltipButton>
          {selectedNode.imageId && <TooltipButton tooltip="删除当前图片" onClick={handleDelete} className={`${toolbarButtonClass} hover:text-red-500 dark:hover:text-red-400`}><TrashIcon className="h-4 w-4" /></TooltipButton>}
        </div>
      )}

      <div
        data-canvas-toolbar
        data-canvas-zoom-controls
        className={`pointer-events-auto fixed bottom-2 z-[150] flex items-center rounded-md border border-gray-200 bg-white/95 p-1 text-xs shadow-sm backdrop-blur dark:border-white/[0.1] dark:bg-gray-900/95 sm:bottom-3 ${agentPanelCollapsed ? 'right-2 sm:right-3' : 'right-2 sm:right-3 xl:right-[428px]'}`}
        style={{ zIndex: 150 }}
        onWheel={(event) => event.stopPropagation()}
      >
        <button type="button" className="flex h-7 w-7 items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-white/[0.08]" aria-label="回到画布原点" title="回到画布原点" onClick={() => setViewport({ x: containerSize.width / 2, y: containerSize.height / 2, scale: 1 }, 0)}><HomeIcon className="h-3.5 w-3.5" /></button>
        <button type="button" className="h-7 w-7 rounded hover:bg-gray-100 dark:hover:bg-white/[0.08]" aria-label="缩小画布" title="缩小画布" onClick={() => setViewport(zoomCanvasViewport(canvas.viewport, { x: containerSize.width / 2, y: containerSize.height / 2 }, canvas.viewport.scale / 1.2), 0)}>−</button>
        <span className="w-12 text-center tabular-nums text-gray-500 dark:text-gray-400">{Math.round(canvas.viewport.scale * 100)}%</span>
        <button type="button" className="h-7 w-7 rounded hover:bg-gray-100 dark:hover:bg-white/[0.08]" aria-label="放大画布" title="放大画布" onClick={() => setViewport(zoomCanvasViewport(canvas.viewport, { x: containerSize.width / 2, y: containerSize.height / 2 }, canvas.viewport.scale * 1.2), 0)}>+</button>
      </div>
      {cropImageId && <ImageCropModal imageId={cropImageId} onClose={() => setCropImageId(null)} />}
      {marquee && <div className="pointer-events-none absolute z-30 border border-[#5b91df]/70 bg-[#5b91df]/15" style={{ left: Math.min(marquee.start.x, marquee.current.x), top: Math.min(marquee.start.y, marquee.current.y), width: Math.abs(marquee.current.x - marquee.start.x), height: Math.abs(marquee.current.y - marquee.start.y) }} />}
    </div>
  )
}
