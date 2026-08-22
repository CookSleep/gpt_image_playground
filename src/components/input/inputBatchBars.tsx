import type { ReactNode } from 'react'

import type { TaskRecord } from '../../types'
import { useTooltip } from '../../hooks/useTooltip'
import ViewportTooltip from '../ViewportTooltip'

function BatchActionButton({
  tooltip,
  className,
  onClick,
  children,
}: {
  tooltip: string
  className: string
  onClick: () => void | Promise<void>
  children: ReactNode
}) {
  const tooltipState = useTooltip()

  return (
    <span className="relative inline-flex" {...tooltipState.handlers}>
      <button
        type="button"
        onClick={() => {
          tooltipState.dismiss()
          void onClick()
        }}
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

export default function InputBatchBars({
  showFavoriteCollectionBatchBar,
  showTaskBatchBar,
  selectedTaskIds,
  tasks,
  clearFavoriteCollectionSelection,
  onSelectAllVisibleFavoriteCollections,
  onInvertVisibleFavoriteCollections,
  onDownloadSelectedFavoriteCollections,
  onDeleteSelectedFavoriteCollections,
  clearSelection,
  onSelectAllVisibleTasks,
  onInvertVisibleTasks,
  onToggleFavorite,
  onDownloadSelected,
  onDeleteSelected,
}: {
  showFavoriteCollectionBatchBar: boolean
  showTaskBatchBar: boolean
  selectedTaskIds: string[]
  tasks: TaskRecord[]
  clearFavoriteCollectionSelection: () => void
  onSelectAllVisibleFavoriteCollections: () => void
  onInvertVisibleFavoriteCollections: () => void
  onDownloadSelectedFavoriteCollections: () => void | Promise<void>
  onDeleteSelectedFavoriteCollections: () => void
  clearSelection: () => void
  onSelectAllVisibleTasks: () => void
  onInvertVisibleTasks: () => void
  onToggleFavorite: () => void
  onDownloadSelected: () => void | Promise<void>
  onDeleteSelected: () => void
}) {
  if (showFavoriteCollectionBatchBar) {
    return (
      <div className="flex justify-center mb-3">
        <div className="bg-white/90 dark:bg-gray-800/90 backdrop-blur shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-lg rounded-full flex items-center p-1 border border-gray-200/50 dark:border-white/10 pointer-events-auto">
          <BatchActionButton
            onClick={clearFavoriteCollectionSelection}
            className="p-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
            tooltip="取消选择"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </BatchActionButton>
          <div className="w-px h-5 bg-gray-200 dark:bg-white/20 mx-1"></div>
          <BatchActionButton
            onClick={onSelectAllVisibleFavoriteCollections}
            className="p-2 text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 transition-colors"
            tooltip="全选收藏夹"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          </BatchActionButton>
          <BatchActionButton
            onClick={onInvertVisibleFavoriteCollections}
            className="p-2 text-purple-500 dark:text-purple-400 hover:text-purple-600 dark:hover:text-purple-300 transition-colors"
            tooltip="反选收藏夹"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path strokeDasharray="4 4" d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" />
              <path d="M8 12h8M13 9l3 3-3 3" />
            </svg>
          </BatchActionButton>
          <div className="w-px h-5 bg-gray-200 dark:bg-white/20 mx-1"></div>
          <BatchActionButton
            onClick={onDownloadSelectedFavoriteCollections}
            className="p-2 text-green-500 dark:text-green-400 hover:text-green-600 dark:hover:text-green-300 transition-colors"
            tooltip="下载选中"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </BatchActionButton>
          <div className="w-px h-5 bg-gray-200 dark:bg-white/20 mx-1"></div>
          <BatchActionButton
            onClick={onDeleteSelectedFavoriteCollections}
            className="p-2 text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors"
            tooltip="删除选中"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </BatchActionButton>
        </div>
      </div>
    )
  }

  if (!showTaskBatchBar) return null

  return (
    <div className="flex justify-center mb-3">
      <div className="bg-white/90 dark:bg-gray-800/90 backdrop-blur shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-lg rounded-full flex items-center p-1 border border-gray-200/50 dark:border-white/10 pointer-events-auto">
        <BatchActionButton
          onClick={clearSelection}
          className="p-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
          tooltip="取消选择"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </BatchActionButton>
        <div className="w-px h-5 bg-gray-200 dark:bg-white/20 mx-1"></div>
        <BatchActionButton
          onClick={onSelectAllVisibleTasks}
          className="p-2 text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 transition-colors"
          tooltip="全选任务"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        </BatchActionButton>
        <BatchActionButton
          onClick={onInvertVisibleTasks}
          className="p-2 text-purple-500 dark:text-purple-400 hover:text-purple-600 dark:hover:text-purple-300 transition-colors"
          tooltip="反选任务"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path strokeDasharray="4 4" d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" />
            <path d="M8 12h8M13 9l3 3-3 3" />
          </svg>
        </BatchActionButton>
        <div className="w-px h-5 bg-gray-200 dark:bg-white/20 mx-1"></div>
        <BatchActionButton
          onClick={onToggleFavorite}
          className="p-2 text-yellow-500 dark:text-yellow-400 hover:text-yellow-600 dark:hover:text-yellow-300 transition-colors"
          tooltip="编辑收藏夹"
        >
          {selectedTaskIds.length > 0 && selectedTaskIds.every((id) => tasks.find((t) => t.id === id)?.isFavorite) ? (
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          )}
        </BatchActionButton>
        <div className="w-px h-5 bg-gray-200 dark:bg-white/20 mx-1"></div>
        <BatchActionButton
          onClick={onDownloadSelected}
          className="p-2 text-green-500 dark:text-green-400 hover:text-green-600 dark:hover:text-green-300 transition-colors"
          tooltip="下载选中"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        </BatchActionButton>
        <div className="w-px h-5 bg-gray-200 dark:bg-white/20 mx-1"></div>
        <BatchActionButton
          onClick={onDeleteSelected}
          className="p-2 text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors"
          tooltip="删除选中"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </BatchActionButton>
      </div>
    </div>
  )
}
