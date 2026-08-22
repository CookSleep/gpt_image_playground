import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FavoriteCollection } from '../../types'
import {
  createFavoriteCollection,
  deleteFavoriteCollection,
  renameFavoriteCollection,
  useStore,
} from '../../store'
import { getTaskFavoriteCollectionIds } from '../../lib/favoriteState'
import { useCloseOnEscape } from '../../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../../hooks/usePreventBackgroundScroll'
import { TooltipButton as FavoriteActionButton } from '../TooltipButton'
import { CloseIcon, DragHandleIcon, EditIcon, FavoriteIcon, TrashIcon } from '../icons'

export function ManageCollectionsModal() {
  const open = useStore((s) => s.isManageCollectionsModalOpen)
  const closeManage = useStore((s) => s.closeManageCollectionsModal)
  const collections = useStore((s) => s.favoriteCollections)
  const defaultFavoriteCollectionId = useStore((s) => s.defaultFavoriteCollectionId)
  const setDefaultFavoriteCollectionId = useStore((s) => s.setDefaultFavoriteCollectionId)
  const setFavoriteCollections = useStore((s) => s.setFavoriteCollections)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const tasks = useStore((s) => s.tasks)
  
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const modalRef = useRef<HTMLDivElement>(null)

  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragDropPosition, setDragDropPosition] = useState<'before' | 'after' | null>(null)

  const [touchDragPreview, setTouchDragPreview] = useState<{
    label: string
    x: number
    y: number
    width: number
    height: number
    offsetX: number
    offsetY: number
  } | null>(null)
  const touchDragRef = useRef<{ id: string, startX: number, startY: number, moved: boolean } | null>(null)

  const selectableCollections = collections

  useCloseOnEscape(open, closeManage)
  usePreventBackgroundScroll(open, modalRef)

  useEffect(() => {
    if (!open) return
    setDraft('')
    setEditingId(null)
    setEditingName('')
  }, [open])

  useEffect(() => {
    if (!touchDragPreview) return

    const preventTouchScroll = (event: TouchEvent) => {
      event.preventDefault()
    }
    const listenerOptions = { passive: false, capture: true } as AddEventListenerOptions
    const previousOverflow = document.body.style.overflow
    const previousOverscroll = document.body.style.overscrollBehavior

    document.body.style.overflow = 'hidden'
    document.body.style.overscrollBehavior = 'none'
    window.addEventListener('touchmove', preventTouchScroll, listenerOptions)

    return () => {
      document.body.style.overflow = previousOverflow
      document.body.style.overscrollBehavior = previousOverscroll
      window.removeEventListener('touchmove', preventTouchScroll, listenerOptions)
    }
  }, [touchDragPreview])

  if (!open) return null

  const handleCreate = () => {
    if (!draft.trim()) return
    createFavoriteCollection(draft)
    setDraft('')
  }

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }

  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    const targetElement = e.currentTarget as HTMLElement
    const rect = targetElement.getBoundingClientRect()
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'

    if (dragOverId !== targetId || dragDropPosition !== position) {
      setDragOverId(targetId)
      setDragDropPosition(position)
    }

    const scrollContainer = targetElement.closest('.custom-scrollbar')
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect()
      const scrollThreshold = 30
      if (e.clientY < containerRect.top + scrollThreshold) {
        scrollContainer.scrollTop -= 10
      } else if (e.clientY > containerRect.bottom - scrollThreshold) {
        scrollContainer.scrollTop += 10
      }
    }
  }

  const handleDragEnd = () => {
    setDraggedId(null)
    setDragOverId(null)
    setDragDropPosition(null)
    setTouchDragPreview(null)
    touchDragRef.current = null
  }

  const handleTouchStart = (e: React.TouchEvent, collection: FavoriteCollection | { id: string, name: string }) => {
    if (!(e.target as HTMLElement).closest('[data-drag-handle]')) return
    const touch = e.touches[0]
    const rect = e.currentTarget.getBoundingClientRect()

    e.preventDefault()
    e.stopPropagation()
    touchDragRef.current = { id: collection.id, startX: touch.clientX, startY: touch.clientY, moved: false }
    setDraggedId(collection.id)
    setTouchDragPreview({
      label: collection.name,
      x: touch.clientX,
      y: touch.clientY,
      width: rect.width,
      height: rect.height,
      offsetX: touch.clientX - rect.left,
      offsetY: touch.clientY - rect.top,
    })
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    const drag = touchDragRef.current
    if (!drag) return
    const touch = e.touches[0]

    if (!drag.moved) {
      if (Math.abs(touch.clientX - drag.startX) > 5 || Math.abs(touch.clientY - drag.startY) > 5) {
        drag.moved = true
      } else {
        return
      }
    }

    e.preventDefault()
    setTouchDragPreview((current) => current ? { ...current, x: touch.clientX, y: touch.clientY } : current)

    const el = document.elementFromPoint(touch.clientX, touch.clientY)
    const targetElement = el?.closest('[data-collection-id]') as HTMLElement | null
    if (!targetElement) return

    const targetId = targetElement.getAttribute('data-collection-id')
    if (!targetId) return

    const rect = targetElement.getBoundingClientRect()
    const position = touch.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDragOverId(targetId)
    setDragDropPosition(position)

    const scrollContainer = targetElement.closest('.custom-scrollbar') as HTMLElement | null
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect()
      const scrollThreshold = 30
      if (touch.clientY < containerRect.top + scrollThreshold) {
        scrollContainer.scrollTop -= 10
      } else if (touch.clientY > containerRect.bottom - scrollThreshold) {
        scrollContainer.scrollTop += 10
      }
    }
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    const drag = touchDragRef.current
    if (!drag) return
    if (drag.moved && dragOverId && dragOverId !== drag.id) {
      e.preventDefault()
      const sourceId = drag.id
      const targetId = dragOverId
      
      const sourceIndex = selectableCollections.findIndex((c) => c.id === sourceId)
      const targetIndex = selectableCollections.findIndex((c) => c.id === targetId)
      if (sourceIndex >= 0 && targetIndex >= 0) {
        const newCollections = [...selectableCollections]
        const [removed] = newCollections.splice(sourceIndex, 1)

        let newTargetIndex = targetIndex
        if (dragDropPosition === 'after') newTargetIndex++
        if (sourceIndex < targetIndex) newTargetIndex--

        newCollections.splice(newTargetIndex, 0, removed)
        setFavoriteCollections(newCollections)
      }
    }
    handleDragEnd()
  }

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const sourceId = draggedId || e.dataTransfer.getData('text/plain')
    if (!sourceId || sourceId === targetId) return handleDragEnd()

    const sourceIndex = selectableCollections.findIndex((c) => c.id === sourceId)
    const targetIndex = selectableCollections.findIndex((c) => c.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return handleDragEnd()

    const newCollections = [...selectableCollections]
    const [removed] = newCollections.splice(sourceIndex, 1)

    let newTargetIndex = targetIndex
    if (dragDropPosition === 'after') newTargetIndex++
    if (sourceIndex < targetIndex) newTargetIndex--

    newCollections.splice(newTargetIndex, 0, removed)
    setFavoriteCollections(newCollections)
    handleDragEnd()
  }

  const startRename = (e: React.MouseEvent, collection: { id: string, name: string }) => {
    e.preventDefault()
    e.stopPropagation()
    setEditingId(collection.id)
    setEditingName(collection.name)
  }

  const confirmRename = () => {
    if (editingId && editingName.trim()) renameFavoriteCollection(editingId, editingName.trim())
    setEditingId(null)
    setEditingName('')
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      confirmRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditingId(null)
      setEditingName('')
    }
  }

  const handleDelete = (e: React.MouseEvent, collection: { id: string, name: string }) => {
    e.preventDefault()
    e.stopPropagation()
    if (collections.length <= 1) return
    const collectionTasks = tasks.filter(t => getTaskFavoriteCollectionIds(t, defaultFavoriteCollectionId).includes(collection.id))
    const imageCount = new Set(collectionTasks.flatMap((task) => task.outputImages || [])).size
    setConfirmDialog({
      title: '删除收藏夹',
      message: `确定要删除收藏夹「${collection.name}」吗？`,
      checkbox: imageCount > 0
        ? {
            label: `同时删除收藏夹中的图片（${imageCount} 张）`,
            tone: 'danger',
          }
        : undefined,
      action: (deleteImages = false) => {
        void deleteFavoriteCollection(collection.id, deleteImages)
      },
    })
  }

  const handleSetDefault = (e: React.MouseEvent, collection: { id: string, name: string }) => {
    e.preventDefault()
    e.stopPropagation()
    if (collection.id === defaultFavoriteCollectionId) {
      setDefaultFavoriteCollectionId(null)
      return
    }
    const current = collections.find((item) => item.id === defaultFavoriteCollectionId)
    if (!current) {
      setDefaultFavoriteCollectionId(collection.id)
      return
    }
    setConfirmDialog({
      title: '修改默认收藏夹',
      message: `确定要将默认收藏夹从「${current.name}」改为「${collection.name}」吗？`,
      action: () => setDefaultFavoriteCollectionId(collection.id),
    })
  }

  return createPortal(
    <div data-no-drag-select className="fixed inset-0 z-[105] flex items-center justify-center p-4 sm:p-0" onClick={closeManage}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-overlay-in" />
      <div ref={modalRef} className="relative z-10 flex max-h-[85vh] w-full max-w-[400px] flex-col overflow-hidden rounded-3xl bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] ring-1 ring-black/5 dark:ring-white/10 animate-modal-in" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 pt-6 pb-4 shrink-0 relative border-b border-gray-100 dark:border-[#333]">
          <FavoriteActionButton tooltip="关闭" onClick={closeManage} wrapperClassName="absolute right-5 top-5 inline-flex" className="shrink-0 rounded-full p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200">
            <CloseIcon className="h-5 w-5" />
          </FavoriteActionButton>
          <h2 className="mb-2 pr-8 flex items-center gap-2.5 text-lg font-semibold text-gray-800 dark:text-gray-100 leading-snug">
            管理收藏夹
          </h2>
          <p className="text-[13px] text-gray-500 dark:text-gray-400 leading-relaxed">
            在这里管理你的收藏夹列表及排序。
          </p>
        </div>
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden pt-3 pb-1">
          <div className="flex-1 overflow-y-auto custom-scrollbar relative">
            {selectableCollections.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">暂无收藏夹</div>
            ) : selectableCollections.map((collection) => {
              const isDefault = collection.id === defaultFavoriteCollectionId
              const canDelete = collections.length > 1
              return (
              <div 
                key={collection.id} 
                data-collection-id={collection.id}
                draggable={editingId !== collection.id}
                onDragStart={(e) => handleDragStart(e, collection.id)}
                onDragEnd={handleDragEnd}
                onTouchStart={(e) => handleTouchStart(e, collection)}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleDragEnd}
                className={`group relative flex items-center justify-between transition-colors ${
                  draggedId === collection.id ? 'opacity-40 bg-gray-100 dark:bg-white/[0.04]' : 'hover:bg-gray-50 dark:hover:bg-white/[0.04]'
                }`}
                onDragOver={(e) => handleDragOver(e, collection.id)}
                onDrop={(e) => handleDrop(e, collection.id)}
              >
                {dragOverId === collection.id && dragDropPosition === 'before' && draggedId !== collection.id && (
                  <div className="absolute top-0 left-0 right-0 h-[2px] bg-blue-500 z-40 pointer-events-none" />
                )}
                {dragOverId === collection.id && dragDropPosition === 'after' && draggedId !== collection.id && (
                  <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-blue-500 z-40 pointer-events-none" />
                )}
                <div className="flex h-12 items-center flex-1 min-w-0 gap-3 pl-4 pr-3">
                  <div 
                    data-drag-handle
                    className="flex cursor-grab active:cursor-grabbing items-center justify-center text-gray-400 opacity-60 transition-opacity hover:opacity-100 dark:text-gray-500 shrink-0"
                    style={{ touchAction: 'none' }}
                  >
                    <DragHandleIcon className="h-3.5 w-3.5" />
                  </div>
                  {editingId === collection.id ? (
                    <input
                      type="text"
                      className="h-6 min-w-0 flex-1 rounded border border-blue-400/50 bg-white px-1.5 py-0 text-[15px] leading-6 text-gray-900 shadow-sm outline-none focus:border-blue-500 dark:border-white/20 dark:bg-black/20 dark:text-white dark:focus:border-white/40"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={handleRenameKeyDown}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      onBlur={confirmRename}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-gray-700 dark:text-gray-200" title={collection.name}>{collection.name}</span>
                  )}
                </div>
                <div className={`flex shrink-0 items-center justify-end gap-2 overflow-hidden pr-4 transition-all duration-150 ${editingId === collection.id ? 'w-12' : 'w-28'}`}>
                    {editingId === collection.id ? (
                      <FavoriteActionButton
                        tooltip="确认"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          confirmRename()
                        }}
                        className="p-1.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded-md text-green-500 dark:text-green-400 hover:text-green-600 dark:hover:text-green-300 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      </FavoriteActionButton>
                    ) : (
                      <>
                        <FavoriteActionButton tooltip={isDefault ? '取消默认收藏夹' : '设为默认收藏夹'} onClick={(e) => handleSetDefault(e, collection)} className={`p-1.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded-md transition-colors ${isDefault ? 'text-yellow-500 dark:text-yellow-400' : 'text-gray-400 hover:text-yellow-500 dark:hover:text-yellow-400'}`}><FavoriteIcon filled={isDefault} className="w-3.5 h-3.5" /></FavoriteActionButton>
                        <FavoriteActionButton tooltip="重命名" onClick={(e) => startRename(e, collection)} className="p-1.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"><EditIcon className="w-3.5 h-3.5" /></FavoriteActionButton>
                        <FavoriteActionButton tooltip={canDelete ? '删除' : '至少保留一个收藏夹'} disabled={!canDelete} onClick={(e) => handleDelete(e, collection)} className={`p-1.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded-md transition-colors ${canDelete ? 'text-gray-400 hover:text-red-500 dark:hover:text-red-400' : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'}`}><TrashIcon className="w-3.5 h-3.5" /></FavoriteActionButton>
                      </>
                    )}
                  </div>
              </div>
            )})}
          </div>
        </div>
        <div className="border-t border-gray-200 p-6 dark:border-[#333] shrink-0">
          <div className="flex gap-3">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleCreate()
              }}
              type="text"
              placeholder="新建收藏夹..."
              className="min-w-0 flex-1 rounded-xl border border-gray-300 bg-transparent px-4 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-white/10 dark:text-white dark:focus:border-white/30 dark:focus:ring-white/30"
            />
            <button 
              type="button" 
              onClick={handleCreate} 
              disabled={!draft.trim()}
              className="inline-flex items-center justify-center rounded-xl bg-gray-200 px-5 py-2 text-sm font-medium text-gray-800 transition hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-white/10 dark:text-gray-300 dark:hover:bg-white/20"
            >
              新建
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
