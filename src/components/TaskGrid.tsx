import { useMemo, useRef, useCallback } from 'react'
import { ALL_FAVORITES_COLLECTION_ID, ALL_PROJECTS_ID, LOCAL_PROJECT_ID, getTaskFavoriteCollectionIds, useStore, reuseConfig, editOutputs, removeTask, taskMatchesFilterStatus, taskMatchesSearchQuery } from '../store'
import { useDragSelect } from '../hooks/useDragSelect'
import TaskCard from './TaskCard'

export default function TaskGrid() {
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const suppressClickUntil = useRef(0)
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  const handleSelectionChange = useCallback((ids: string[]) => {
    setSelectedTaskIds(ids)
  }, [setSelectedTaskIds])

  const { selectionBox } = useDragSelect({
    containerSelector: '[data-project-workspace]',
    itemSelector: '.task-card-wrapper',
    getItemId: (element) => element.getAttribute('data-task-id'),
    onSelectionChange: handleSelectionChange,
    initialSelectedIds: selectedTaskIds,
    allowDraggableSelection: true,
    onSuppressClick: () => {
      suppressClickUntil.current = Date.now() + 250
    },
  })

  const filteredTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
    const q = searchQuery.trim().toLowerCase()
    
    return sorted.filter((t) => {
      if (activeProjectId === LOCAL_PROJECT_ID && t.projectId) return false
      if (activeProjectId && activeProjectId !== ALL_PROJECTS_ID && activeProjectId !== LOCAL_PROJECT_ID && t.projectId !== activeProjectId) return false
      if (filterFavorite) {
        if (!t.isFavorite) return false
        if (activeFavoriteCollectionId && activeFavoriteCollectionId !== ALL_FAVORITES_COLLECTION_ID && !getTaskFavoriteCollectionIds(t).includes(activeFavoriteCollectionId)) return false
      }
      if (!taskMatchesFilterStatus(t, filterStatus)) return false
      return taskMatchesSearchQuery(t, q)
    })
  }, [tasks, searchQuery, filterStatus, filterFavorite, activeFavoriteCollectionId, activeProjectId])

  const handleDelete = (task: typeof tasks[0]) => {
    setConfirmDialog({
      title: '删除任务',
      message: '确定要删除这个任务吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
      action: () => removeTask(task),
    })
  }

  if (!filteredTasks.length) {
    return (
      <div className="text-center py-20 text-gray-400 dark:text-gray-500">
        {searchQuery || filterFavorite ? (
          <p className="text-sm">没有找到匹配的任务</p>
        ) : (
          <>
            <svg
              className="w-16 h-16 mx-auto mb-4 text-gray-200 dark:text-gray-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <p className="text-sm">输入提示词，为当前项目生成第一张图片</p>
          </>
        )}
      </div>
    )
  }

  return (
    <div 
      data-task-grid-root
      data-drag-select-surface
      className="relative min-h-[calc(100vh-7rem)]"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-10">
        {filteredTasks.map((task) => (
          <div key={task.id} className="task-card-wrapper" data-task-id={task.id}>
            <TaskCard
              task={task}
              onClick={(e) => {
                if (Date.now() < suppressClickUntil.current) {
                  e.preventDefault()
                  return
                }
                suppressClickUntil.current = 0
                const isCtrl = isMac ? e.metaKey : e.ctrlKey
                if (isCtrl) {
                  useStore.getState().toggleTaskSelection(task.id)
                  return
                }

                setDetailTaskId(task.id)
              }}
              onReuse={() => reuseConfig(task)}
              onEditOutputs={() => editOutputs(task)}
              onDelete={() => handleDelete(task)}
              isSelected={selectedTaskIds.includes(task.id)}
            />
          </div>
        ))}
      </div>
      {selectionBox && (
        <div
          className="fixed bg-blue-500/20 border border-blue-500/50 pointer-events-none z-[30]"
          style={{
            left: Math.min(selectionBox.startPageX, selectionBox.currentPageX) - window.scrollX,
            top: Math.min(selectionBox.startPageY, selectionBox.currentPageY) - window.scrollY,
            width: Math.abs(selectionBox.currentPageX - selectionBox.startPageX),
            height: Math.abs(selectionBox.currentPageY - selectionBox.startPageY),
          }}
        />
      )}
    </div>
  )
}
