import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ALL_FAVORITES_COLLECTION_ID, ALL_PROJECTS_ID, LOCAL_PROJECT_ID, clearFailedTasks, getImageFavoriteCollectionIds, useStore, taskMatchesFilterStatus, taskMatchesSearchQuery } from '../store'
import { useTooltip } from '../hooks/useTooltip'
import Select from './Select'
import { CollectionManageIcon, FavoriteIcon, TrashIcon } from './icons'
import ViewportTooltip from './ViewportTooltip'

function SearchActionButton({
  tooltip,
  className,
  disabled = false,
  onClick,
  children,
}: {
  tooltip: string
  className: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  const tooltipState = useTooltip()

  return (
    <span className="relative inline-flex" {...tooltipState.handlers}>
      <button
        type="button"
        onClick={() => {
          tooltipState.dismiss()
          if (disabled) return
          onClick()
        }}
        disabled={disabled}
        className={className}
        aria-label={tooltip}
      >
        {children}
      </button>
      <ViewportTooltip visible={tooltipState.visible} className="whitespace-nowrap">
        {tooltip}
      </ViewportTooltip>
    </span>
  )
}

export default function SearchBar({ className = 'mt-6 mb-4' }: { className?: string } = {}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchQuery = useStore((s) => s.searchQuery)
  const setSearchQuery = useStore((s) => s.setSearchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const setFilterStatus = useStore((s) => s.setFilterStatus)
  const clearSelection = useStore((s) => s.clearSelection)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const setFilterFavorite = useStore((s) => s.setFilterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const setActiveFavoriteCollectionId = useStore((s) => s.setActiveFavoriteCollectionId)
  const allFavoriteCollections = useStore((s) => s.favoriteCollections) ?? []
  const activeProjectId = useStore((s) => s.activeProjectId)
  const openManageCollectionsModal = useStore((s) => s.openManageCollectionsModal)
  const [favoriteMenuOpen, setFavoriteMenuOpen] = useState(false)
  const favoriteProjectId = activeProjectId && activeProjectId !== ALL_PROJECTS_ID && activeProjectId !== LOCAL_PROJECT_ID ? activeProjectId : undefined
  const favoriteCollections = useMemo(
    () => allFavoriteCollections.filter((collection) => collection.projectId === favoriteProjectId),
    [allFavoriteCollections, favoriteProjectId],
  )
  const failedCount = useStore((s) => {
    void s.projects
    const q = s.searchQuery.trim().toLowerCase()
    return s.tasks.filter((task) => {
      if (!taskMatchesFilterStatus(task, 'error')) return false
      if (s.filterFavorite) {
        const matchesFavorite = task.outputImages.some((imageId) => {
          const ids = getImageFavoriteCollectionIds(imageId, task)
          return s.activeFavoriteCollectionId && s.activeFavoriteCollectionId !== ALL_FAVORITES_COLLECTION_ID
            ? ids.includes(s.activeFavoriteCollectionId)
            : ids.length > 0
        })
        if (!matchesFavorite) return false
      }
      return taskMatchesSearchQuery(task, q)
    }).length
  })
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const inCollectionOverview = filterFavorite && !activeFavoriteCollectionId
  const isFailedFilter = filterStatus === 'error'
  const favoriteTooltip = filterFavorite ? '退出收藏夹' : '收藏夹'

  useEffect(() => {
    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (document.activeElement !== inputRef.current) return

      const target = event.target instanceof Element ? event.target : document.elementFromPoint(event.clientX, event.clientY)
      if (!target) return
      if (rootRef.current?.contains(target)) return
      if (!target.closest('[data-drag-select-surface]')) return
      if (target.closest('.task-card-wrapper, .favorite-collection-card-wrapper')) return

      inputRef.current?.blur()
    }

    document.addEventListener('mousedown', handleDocumentMouseDown, true)
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown, true)
  }, [])

  const handleFavoriteClick = () => {
    if (filterFavorite) {
      setFilterFavorite(false)
      return
    }
    if (favoriteCollections.length === 1) {
      setActiveFavoriteCollectionId(favoriteCollections[0].id)
      setFilterFavorite(true)
      return
    }
    setFavoriteMenuOpen((open) => !open)
  }

  const handleFavoriteCollectionSelect = (collectionId: string) => {
    setFavoriteMenuOpen(false)
    setActiveFavoriteCollectionId(collectionId)
    setFilterFavorite(true)
  }

  useEffect(() => {
    if (!favoriteMenuOpen) return
    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setFavoriteMenuOpen(false)
    }
    document.addEventListener('mousedown', handleDocumentMouseDown)
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown)
  }, [favoriteMenuOpen])

  useEffect(() => {
    if (favoriteCollections.length <= 1) setFavoriteMenuOpen(false)
  }, [favoriteCollections.length])

  const handleClearFailed = () => {
    const state = useStore.getState()
    const q = state.searchQuery.trim().toLowerCase()
    const failedTaskIds = state.tasks
      .filter((task) => {
        if (!taskMatchesFilterStatus(task, 'error')) return false
        if (state.filterFavorite) {
          const matchesFavorite = task.outputImages.some((imageId) => {
            const ids = getImageFavoriteCollectionIds(imageId, task)
            return state.activeFavoriteCollectionId && state.activeFavoriteCollectionId !== ALL_FAVORITES_COLLECTION_ID
              ? ids.includes(state.activeFavoriteCollectionId)
              : ids.length > 0
          })
          if (!matchesFavorite) return false
        }
        return taskMatchesSearchQuery(task, q)
      })
      .map((task) => task.id)
    const failedTaskCount = failedTaskIds.length
    if (failedTaskCount === 0) return

    setConfirmDialog({
      title: '清除失败记录',
      message: `确定清除筛选范围内的失败记录吗？\n纯失败任务会被删除；部分失败任务只会清除失败标记，保留已成功图片。共 ${failedTaskCount} 条记录。`,
      confirmText: '清除',
      cancelText: '取消',
      tone: 'danger',
      action: () => clearFailedTasks(failedTaskIds),
    })
  }

  const handleStatusChange = (val: any) => {
    if (val === filterStatus) return
    setFilterStatus(val)
    clearSelection()
  }

  return (
    <div ref={rootRef} data-no-drag-select className={`${className} flex gap-3`}>
      <div className="flex gap-2 flex-shrink-0 z-20">
        <div className="relative">
          <SearchActionButton
            tooltip={favoriteTooltip}
            onClick={handleFavoriteClick}
            className={`p-2.5 rounded-xl border transition-all ${
              filterFavorite
                ? 'border-yellow-400 bg-yellow-50 dark:bg-yellow-500/10 text-yellow-500'
                : 'border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.06]'
            }`}
          >
            <FavoriteIcon filled={filterFavorite} className="w-5 h-5" />
          </SearchActionButton>
          {favoriteMenuOpen && favoriteCollections.length > 1 && (
            <div className="absolute left-0 top-full z-50 mt-2 w-52 overflow-hidden rounded-xl border border-gray-200/60 bg-white/95 py-1 text-sm shadow-[0_8px_30px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] dark:ring-white/10">
              <div className="px-3 py-2 text-xs font-medium text-gray-400 dark:text-gray-500">选择收藏夹</div>
              {favoriteCollections.map((collection) => (
                <button
                  key={collection.id}
                  type="button"
                  aria-label={`选择收藏夹：${collection.name}`}
                  className="flex w-full items-center px-3 py-2 text-left text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-white/[0.06]"
                  onClick={() => handleFavoriteCollectionSelect(collection.id)}
                >
                  <FavoriteIcon className="mr-2 h-4 w-4 shrink-0 text-yellow-500" />
                  <span className="min-w-0 truncate">{collection.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {inCollectionOverview && (
          <SearchActionButton
            tooltip="管理收藏夹"
            onClick={openManageCollectionsModal}
            className="p-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.06] transition-all"
          >
            <CollectionManageIcon className="w-5 h-5" />
          </SearchActionButton>
        )}
        {!inCollectionOverview && (
          <>
            <div className="relative w-[72px]">
              <Select
                value={filterStatus}
                onChange={handleStatusChange}
                options={[
                  { label: '全部', value: 'all' },
                  { label: '已完成', value: 'done' },
                  { label: '生成中', value: 'running' },
                  { label: '失败', value: 'error' },
                ]}
                className="px-3 py-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-white/[0.06] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
              />
            </div>
            {isFailedFilter && (
              <button
                type="button"
                onClick={handleClearFailed}
                disabled={failedCount === 0}
                title={failedCount > 0 ? `清除 ${failedCount} 条失败记录` : '没有失败记录'}
                aria-label={failedCount > 0 ? `清除 ${failedCount} 条失败记录` : '没有失败记录'}
                className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-400 transition-all hover:bg-gray-50 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-white disabled:hover:text-gray-400 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-500 dark:hover:bg-white/[0.06] dark:hover:text-gray-300 dark:disabled:hover:bg-gray-900 dark:disabled:hover:text-gray-500"
              >
                <TrashIcon className="h-[18px] w-[18px]" />
              </button>
            )}
          </>
        )}
      </div>
      <div className="relative z-10 flex-1">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          ref={inputRef}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          type="text"
          placeholder={inCollectionOverview ? '搜索收藏夹名称...' : '搜索图片名、提示词、参数...'}
          className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
        />
      </div>
    </div>
  )
}
