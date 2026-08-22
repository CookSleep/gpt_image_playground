import { useEffect, useRef, useState, type SVGProps } from 'react'
import type { TaskRecord, FavoriteCollection } from '../../types'
import { ensureImageThumbnailCached, subscribeImageThumbnail } from '../../lib/imageCache'
import { TooltipButton as FavoriteActionButton } from '../TooltipButton'
import { EditIcon, FavoriteIcon, TrashIcon } from '../icons'
import type { CollectionCard } from './favoriteUtils'

function FolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4.172a2 2 0 011.414.586L12 7h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    </svg>
  )
}

function CoverThumbnail({ task }: { task?: TaskRecord }) {
  const [src, setSrc] = useState('')
  const imageId = task?.outputImages?.[0]

  useEffect(() => {
    setSrc('')
    if (!imageId) return
    let cancelled = false
    const unsubscribe = subscribeImageThumbnail(imageId, (thumbnail) => {
      if (!cancelled) setSrc(thumbnail.dataUrl)
    })
    ensureImageThumbnailCached(imageId).then((thumbnail) => {
      if (!cancelled && thumbnail) setSrc(thumbnail.dataUrl)
    }).catch(() => {})
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [imageId])

  if (src) return <img src={src} alt="" className="h-full w-full object-cover" />
  return (
    <div className="flex h-full w-full items-center justify-center bg-yellow-50 text-yellow-500 dark:bg-[#2a2211] dark:text-yellow-500">
      <FavoriteIcon filled className="h-8 w-8 opacity-80" />
    </div>
  )
}


export function FavoriteCollectionOverviewCard({
  card,
  coverTask,
  isVirtualAll,
  isDefault,
  canDelete,
  isSelected,
  editingId,
  editingName,
  setEditingName,
  confirmRename,
  handleRenameKeyDown,
  startRename,
  handleSetDefault,
  handleDelete,
  onOpen,
  onToggleSelection,
  suppressClickUntilRef,
}: {
  card: CollectionCard
  coverTask?: TaskRecord
  isVirtualAll: boolean
  isDefault: boolean
  canDelete: boolean
  isSelected: boolean
  editingId: string | null
  editingName: string
  setEditingName: (value: string) => void
  confirmRename: () => void
  handleRenameKeyDown: (e: React.KeyboardEvent) => void
  startRename: (e: React.MouseEvent, collection: FavoriteCollection) => void
  handleSetDefault: (collection: FavoriteCollection) => void
  handleDelete: (collection: FavoriteCollection, collectionTasks: TaskRecord[]) => void
  onOpen: () => void
  onToggleSelection: () => void
  suppressClickUntilRef: { current: number }
}) {
  const [isSwiping, setIsSwiping] = useState(false)
  const [swipeStartedSelected, setSwipeStartedSelected] = useState(false)
  const [swipeActionActive, setSwipeActionActive] = useState(false)
  const [swipeDirection, setSwipeDirection] = useState<-1 | 0 | 1>(0)
  const cardRef = useRef<HTMLElement>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const horizontalSwipeRef = useRef(false)
  const suppressSwipeClickUntilRef = useRef(0)
  const swipeResetTimerRef = useRef<number | null>(null)
  const swipeFrameRef = useRef<number | null>(null)
  const swipeOffsetRef = useRef(0)
  const pendingSwipeOffsetRef = useRef(0)

  const applySwipeOffset = (offset: number) => {
    swipeOffsetRef.current = offset
    if (cardRef.current) cardRef.current.style.transform = offset ? `translateX(${offset}px)` : ''
  }

  const cancelSwipeFrame = () => {
    if (swipeFrameRef.current != null) {
      window.cancelAnimationFrame(swipeFrameRef.current)
      swipeFrameRef.current = null
    }
  }

  const scheduleSwipeOffset = (offset: number) => {
    if (swipeFrameRef.current == null && swipeOffsetRef.current === offset) return
    pendingSwipeOffsetRef.current = offset
    if (swipeFrameRef.current != null) return
    swipeFrameRef.current = window.requestAnimationFrame(() => {
      swipeFrameRef.current = null
      applySwipeOffset(pendingSwipeOffsetRef.current)
    })
  }

  const resetSwipe = () => {
    touchStartRef.current = null
    horizontalSwipeRef.current = false
    setIsSwiping(false)
    setSwipeDirection(0)
    setSwipeActionActive(false)
    cancelSwipeFrame()
    applySwipeOffset(0)
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, textarea, select')) {
      resetSwipe()
      return
    }
    if (swipeResetTimerRef.current != null) {
      window.clearTimeout(swipeResetTimerRef.current)
      swipeResetTimerRef.current = null
    }
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    horizontalSwipeRef.current = false
    setSwipeStartedSelected(isSelected)
    setSwipeActionActive(false)
    setSwipeDirection(0)
    cancelSwipeFrame()
    applySwipeOffset(0)
    setIsSwiping(true)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return
    const deltaX = e.touches[0].clientX - touchStartRef.current.x
    const deltaY = e.touches[0].clientY - touchStartRef.current.y
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
      horizontalSwipeRef.current = true
      e.preventDefault()
      const boundedOffset = Math.max(-60, Math.min(60, deltaX))
      setSwipeDirection(boundedOffset > 0 ? 1 : boundedOffset < 0 ? -1 : 0)
      setSwipeActionActive(Math.abs(deltaX) >= 40)
      scheduleSwipeOffset(boundedOffset)
    }
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    setIsSwiping(false)
    cancelSwipeFrame()
    setSwipeDirection(0)
    if (!touchStartRef.current) return
    const deltaX = e.changedTouches[0].clientX - touchStartRef.current.x
    touchStartRef.current = null
    const isSwipeAction = horizontalSwipeRef.current && Math.abs(deltaX) > 40
    horizontalSwipeRef.current = false
    setSwipeActionActive(isSwipeAction)
    swipeResetTimerRef.current = window.setTimeout(() => {
      setSwipeActionActive(false)
      swipeResetTimerRef.current = null
    }, 220)
    if (isSwipeAction) {
      suppressSwipeClickUntilRef.current = Date.now() + 350
      e.preventDefault()
      e.stopPropagation()
      onToggleSelection()
    }
  }

  useEffect(() => () => {
    if (swipeResetTimerRef.current != null) window.clearTimeout(swipeResetTimerRef.current)
    cancelSwipeFrame()
  }, [])

  useEffect(() => {
    if (!isSwiping) applySwipeOffset(0)
  }, [isSwiping])

  const showSwipeAction = swipeActionActive
  const swipeBgClass = showSwipeAction
    ? swipeStartedSelected
      ? 'bg-gray-500 dark:bg-gray-600'
      : 'bg-blue-500'
    : 'bg-gray-200 dark:bg-gray-700'

  return (
    <div className="relative rounded-xl">
      <div className={`absolute inset-0 rounded-xl flex items-center transition-opacity duration-200 pointer-events-none ${isSwiping || swipeDirection !== 0 || swipeActionActive ? 'opacity-100' : 'opacity-0'} ${swipeBgClass} ${swipeDirection > 0 ? 'justify-start pl-6' : 'justify-end pr-6'}`}>
        <svg className={`w-8 h-8 transition-transform duration-150 ${showSwipeAction ? 'scale-110 text-white' : 'scale-90 text-white/60'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {swipeStartedSelected && showSwipeAction ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          )}
        </svg>
      </div>
      <article
        ref={cardRef}
        className={`relative bg-white dark:bg-gray-900 rounded-xl border overflow-hidden cursor-pointer touch-pan-y will-change-transform duration-200 hover:shadow-lg dark:hover:bg-gray-800/80 ${!isSwiping ? 'transition-[box-shadow,border-color,background-color,transform]' : 'transition-[box-shadow,border-color,background-color]'} ${isSelected ? 'border-blue-500 shadow-md ring-2 ring-blue-500/50' : 'border-gray-200 dark:border-white/[0.08] hover:border-gray-300 dark:hover:border-white/[0.18]'}`}
        onClick={(e) => {
          if (Date.now() < suppressClickUntilRef.current || Date.now() < suppressSwipeClickUntilRef.current) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
          const isCtrl = /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey
          if (isCtrl) {
            e.preventDefault()
            onToggleSelection()
            return
          }
          onOpen()
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={resetSwipe}
      >
        <div className="flex h-40">
          <div className="w-40 min-w-[10rem] h-full bg-gray-100 dark:bg-black/20 relative flex items-center justify-center overflow-hidden flex-shrink-0">
            <CoverThumbnail task={coverTask} />
          </div>
          <div className="flex-1 p-3 flex flex-col min-w-0">
            <div className="flex-1 min-h-0 mb-2 overflow-hidden">
              <div className="flex items-center gap-2 text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">
                {isVirtualAll ? <FavoriteIcon filled className="h-4 w-4 shrink-0 text-yellow-500" /> : <FolderIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-400" />}
                {editingId === card.id ? (
                  <input
                    type="text"
                    className="h-6 min-w-0 flex-1 rounded border border-blue-400/50 bg-white px-1.5 py-0 text-[14px] leading-6 text-gray-900 shadow-sm outline-none focus:border-blue-500 dark:border-white/20 dark:bg-black/20 dark:text-white dark:focus:border-white/40"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                    onBlur={confirmRename}
                  />
                ) : (
                  <span className="truncate" title={card.name}>{card.name}</span>
                )}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{card.tasks.length} 条任务</p>
            </div>
            <div className="mt-auto flex items-center justify-end gap-1">
              {!isVirtualAll && card.collection && (
                <>
                  <FavoriteActionButton
                    tooltip={isDefault ? '取消默认收藏夹' : '设为默认收藏夹'}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleSetDefault(card.collection!)
                    }}
                    className={`p-1.5 rounded-md transition ${isDefault ? 'text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-500/10' : 'text-gray-400 hover:text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-500/10'}`}
                  >
                    <FavoriteIcon filled={isDefault} className="w-4 h-4" />
                  </FavoriteActionButton>
                  {editingId === card.id ? (
                    <FavoriteActionButton
                      tooltip="确认"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        confirmRename()
                      }}
                      className="p-1.5 rounded-md hover:bg-green-50 dark:hover:bg-green-950/30 text-green-500 hover:text-green-600 dark:text-green-400 dark:hover:text-green-300 transition"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </FavoriteActionButton>
                  ) : (
                    <FavoriteActionButton
                      tooltip="编辑名称"
                      onClick={(e) => startRename(e, card.collection!)}
                      className="p-1.5 rounded-md hover:bg-green-50 dark:hover:bg-green-950/30 text-gray-400 hover:text-green-500 transition"
                    >
                      <EditIcon className="w-4 h-4" />
                    </FavoriteActionButton>
                  )}
                  <FavoriteActionButton
                    tooltip={canDelete ? '删除收藏夹' : '至少保留一个收藏夹'}
                    disabled={!canDelete}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(card.collection!, card.tasks)
                    }}
                    className={`p-1.5 rounded-md transition ${canDelete ? 'hover:bg-red-50 dark:hover:bg-red-950/30 text-gray-400 hover:text-red-500' : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'}`}
                  >
                    <TrashIcon className="w-4 h-4" />
                  </FavoriteActionButton>
                </>
              )}
            </div>
          </div>
        </div>
      </article>
    </div>
  )
}
