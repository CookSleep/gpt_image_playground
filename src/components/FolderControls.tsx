import { useEffect, useMemo, useRef, useState, type CSSProperties, type SVGProps } from 'react'
import { createPortal } from 'react-dom'
import {
  createTaskFolder,
  deleteTaskFolder,
  getFolderTaskCounts,
  getTaskFolders,
  moveTasksToFolder,
  normalizeTaskFolderName,
  renameTaskFolder,
  useStore,
} from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { ChevronDownIcon, CloseIcon, EditIcon, PlusIcon, SettingsIcon, TrashIcon } from './icons'

const UNFILED = ''
const UNFILED_LABEL = '未归类'
const MENU_WIDTH = 256
const MENU_MARGIN = 8

function FolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4.172a2 2 0 011.414.586L12 7h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    </svg>
  )
}

function useFolderSummary() {
  const tasks = useStore((s) => s.tasks)
  const taskFolders = useStore((s) => s.taskFolders)
  const counts = useMemo(() => getFolderTaskCounts(tasks), [tasks])
  const folders = useMemo(() => {
    const fromTasks = getTaskFolders(tasks)
    return Array.from(new Set([...taskFolders, ...fromTasks])).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }, [taskFolders, tasks])
  return { tasks, counts, folders, total: tasks.length, unfiledCount: counts.get(UNFILED) ?? 0 }
}

type FolderMenuProps = {
  taskIds?: string[]
  align?: 'left' | 'right'
  floatingStyle?: CSSProperties
  onClose: () => void
}

function FolderMenu({ taskIds, align = 'left', floatingStyle, onClose }: FolderMenuProps) {
  const { folders, counts, total, unfiledCount } = useFolderSummary()
  const activeFolder = useStore((s) => s.activeFolder)
  const setActiveFolder = useStore((s) => s.setActiveFolder)
  const setShowFolderManager = useStore((s) => s.setShowFolderManager)
  const [draft, setDraft] = useState('')
  const isArchiveMenu = Boolean(taskIds?.length)

  const chooseFolder = (folder: string | null) => {
    if (isArchiveMenu && taskIds?.length) {
      void moveTasksToFolder(taskIds, folder ?? '')
    } else {
      setActiveFolder(folder)
    }
    onClose()
  }

  const createAndChoose = async () => {
    const name = normalizeTaskFolderName(draft)
    if (!name) return
    await createTaskFolder(name)
    if (isArchiveMenu && taskIds?.length) {
      await moveTasksToFolder(taskIds, name)
    } else {
      setActiveFolder(name)
    }
    setDraft('')
    onClose()
  }

  const menuClass = align === 'right' ? 'right-0' : 'left-0'

  return (
    <div
      className={`${floatingStyle ? 'fixed' : `absolute top-full mt-1.5 ${menuClass}`} z-[80] w-64 overflow-hidden rounded-xl border border-gray-200/70 bg-white/95 shadow-xl ring-1 ring-black/5 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10`}
      style={floatingStyle}
    >
      <div className="max-h-72 overflow-y-auto p-1.5 custom-scrollbar">
        {isArchiveMenu && (
          <div className="px-2.5 py-1.5 text-[11px] text-gray-400 dark:text-gray-500">
            移动到
          </div>
        )}
        {!isArchiveMenu && (
          <button
            type="button"
            onClick={() => chooseFolder(null)}
            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${activeFolder === null ? 'bg-[#D97757]/10 text-[#C86A4D] dark:text-[#E08A6D]' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}
          >
            <FolderIcon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">全部记录</span>
            <span className="shrink-0 text-[11px] text-gray-400">{total}</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => chooseFolder(UNFILED)}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${activeFolder === UNFILED && !isArchiveMenu ? 'bg-[#D97757]/10 text-[#C86A4D] dark:text-[#E08A6D]' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}
        >
          <FolderIcon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{UNFILED_LABEL}</span>
          <span className="shrink-0 text-[11px] text-gray-400">{unfiledCount}</span>
        </button>
        {folders.map((folder) => (
          <button
            key={folder}
            type="button"
            onClick={() => chooseFolder(folder)}
            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${activeFolder === folder && !isArchiveMenu ? 'bg-[#D97757]/10 text-[#C86A4D] dark:text-[#E08A6D]' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}
            title={folder}
          >
            <FolderIcon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{folder}</span>
            <span className="shrink-0 text-[11px] text-gray-400">{counts.get(folder) ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="border-t border-gray-100 p-1.5 dark:border-white/[0.08]">
        <div className="flex gap-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createAndChoose()
            }}
            type="text"
            placeholder="新建文件夹"
            className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-[#D97757] focus:ring-2 focus:ring-[#D97757]/20 dark:border-white/[0.08] dark:bg-gray-950"
          />
          <button
            type="button"
            onClick={() => void createAndChoose()}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#D97757] text-white transition-colors hover:bg-[#C86A4D]"
            title="新建文件夹"
          >
            <PlusIcon className="h-4 w-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowFolderManager(true)
            onClose()
          }}
          className="mt-1.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-gray-600 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]"
        >
          <SettingsIcon className="h-4 w-4" />
          管理文件夹
        </button>
      </div>
    </div>
  )
}

function getFloatingMenuStyle(anchor: HTMLElement, align: 'left' | 'right'): CSSProperties {
  const rect = anchor.getBoundingClientRect()
  const maxLeft = Math.max(MENU_MARGIN, window.innerWidth - MENU_WIDTH - MENU_MARGIN)
  const preferredLeft = align === 'right' ? rect.right - MENU_WIDTH : rect.left
  const left = Math.min(Math.max(preferredLeft, MENU_MARGIN), maxLeft)
  const spaceBelow = window.innerHeight - rect.bottom
  const menuMaxHeight = Math.min(360, Math.max(240, window.innerHeight - MENU_MARGIN * 2))
  const top = spaceBelow >= 260 ? rect.bottom + 6 : Math.max(MENU_MARGIN, rect.top - menuMaxHeight - 6)

  return {
    left,
    top,
    maxHeight: `calc(100vh - ${MENU_MARGIN * 2}px)`,
  }
}

export function FolderFilterButton() {
  const activeFolder = useStore((s) => s.activeFolder)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const label = activeFolder === null ? '全部文件夹' : activeFolder || UNFILED_LABEL

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | TouchEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close, true)
    document.addEventListener('touchstart', close, true)
    return () => {
      document.removeEventListener('mousedown', close, true)
      document.removeEventListener('touchstart', close, true)
    }
  }, [open])

  return (
    <div ref={ref} className="relative w-36 shrink-0 max-sm:w-[9.5rem]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`flex h-10 w-full items-center justify-between gap-2 rounded-xl border px-3 text-sm transition-colors ${activeFolder === null ? 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]' : 'border-[#D97757]/30 bg-[#D97757]/10 text-[#C86A4D] dark:text-[#E08A6D]'}`}
        title={label}
      >
        <span className="flex min-w-0 items-center gap-2">
          <FolderIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{label}</span>
        </span>
        <ChevronDownIcon className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <FolderMenu align="right" onClose={() => setOpen(false)} />}
    </div>
  )
}

export function TaskFolderButton({ taskId, folder }: { taskId: string; folder?: string }) {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const active = Boolean(folder)

  useEffect(() => {
    if (!open || !ref.current) {
      setMenuStyle(null)
      return
    }

    const updatePosition = () => {
      if (!ref.current) return
      setMenuStyle(getFloatingMenuStyle(ref.current, 'right'))
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | TouchEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      const target = event.target
      if (target instanceof Element && target.closest('[data-folder-menu]')) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close, true)
    document.addEventListener('touchstart', close, true)
    return () => {
      document.removeEventListener('mousedown', close, true)
      document.removeEventListener('touchstart', close, true)
    }
  }, [open])

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`p-1.5 rounded-md transition ${active ? 'text-[#D97757] hover:bg-[#D97757]/10' : 'text-gray-400 hover:text-[#D97757] hover:bg-[#D97757]/10'}`}
        aria-label="归档到文件夹"
        title={active ? `已归档：${folder}` : '归档到文件夹'}
      >
        <FolderIcon className="h-4 w-4" />
      </button>
      {open && menuStyle && createPortal(
        <div data-folder-menu>
          <FolderMenu taskIds={[taskId]} align="right" floatingStyle={menuStyle} onClose={() => setOpen(false)} />
        </div>,
        document.body,
      )}
    </span>
  )
}

export function SelectedTasksFolderButton({ taskIds }: { taskIds: string[] }) {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open || !ref.current) {
      setMenuStyle(null)
      return
    }

    const updatePosition = () => {
      if (!ref.current) return
      setMenuStyle(getFloatingMenuStyle(ref.current, 'right'))
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | TouchEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      const target = event.target
      if (target instanceof Element && target.closest('[data-folder-menu]')) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close, true)
    document.addEventListener('touchstart', close, true)
    return () => {
      document.removeEventListener('mousedown', close, true)
      document.removeEventListener('touchstart', close, true)
    }
  }, [open])

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="p-2 text-[#D97757] dark:text-[#E08A6D] hover:text-[#C86A4D] dark:hover:text-[#F0A184] transition-colors"
        title="移动到文件夹"
      >
        <FolderIcon className="h-5 w-5" />
      </button>
      {open && menuStyle && createPortal(
        <div data-folder-menu>
          <FolderMenu taskIds={taskIds} align="right" floatingStyle={menuStyle} onClose={() => setOpen(false)} />
        </div>,
        document.body,
      )}
    </span>
  )
}

export function FolderManagerModal() {
  const open = useStore((s) => s.showFolderManager)
  const setOpen = useStore((s) => s.setShowFolderManager)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const { folders, counts, unfiledCount } = useFolderSummary()
  const [draft, setDraft] = useState('')
  const modalRef = useRef<HTMLDivElement>(null)

  useCloseOnEscape(open, () => setOpen(false))
  usePreventBackgroundScroll(open, modalRef)

  if (!open) return null

  const handleCreate = async () => {
    const name = normalizeTaskFolderName(draft)
    if (!name) return
    await createTaskFolder(name)
    setDraft('')
  }

  const askRename = (folder: string) => {
    const next = window.prompt('重命名文件夹', folder)
    if (next == null) return
    const normalized = normalizeTaskFolderName(next)
    if (!normalized || normalized === folder) return
    void renameTaskFolder(folder, normalized)
  }

  const askDelete = (folder: string) => {
    const taskCount = counts.get(folder) ?? 0
    setConfirmDialog({
      title: '清空文件夹',
      message: `将「${folder}」中的 ${taskCount} 条记录移回未归类，并移除这个文件夹。`,
      confirmText: '确认清空',
      action: () => {
        void deleteTaskFolder(folder)
      },
    })
  }

  return createPortal(
    <div data-no-drag-select className="fixed inset-0 z-[105] flex items-center justify-center p-4">
      <button className="absolute inset-0 cursor-default bg-black/20 backdrop-blur-md dark:bg-black/40" onClick={() => setOpen(false)} aria-label="关闭" />
      <div ref={modalRef} className="relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/60 bg-white/95 shadow-2xl ring-1 ring-black/5 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-white/[0.08]">
          <div className="flex items-center gap-2">
            <FolderIcon className="h-5 w-5 text-[#D97757]" />
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">管理文件夹</h2>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-200">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          <div className="mb-3 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate()
              }}
              type="text"
              placeholder="新建文件夹"
              className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#D97757] focus:ring-2 focus:ring-[#D97757]/20 dark:border-white/[0.08] dark:bg-gray-950"
            />
            <button type="button" onClick={() => void handleCreate()} className="inline-flex items-center gap-1.5 rounded-xl bg-[#D97757] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[#C86A4D]">
              <PlusIcon className="h-4 w-4" />
              新建
            </button>
          </div>
          <div className="rounded-xl border border-gray-100 dark:border-white/[0.08]">
            <div className="flex items-center gap-3 border-b border-gray-100 px-3 py-2 text-sm text-gray-500 dark:border-white/[0.08] dark:text-gray-400">
              <FolderIcon className="h-4 w-4" />
              <span className="min-w-0 flex-1">{UNFILED_LABEL}</span>
              <span className="text-xs">{unfiledCount}</span>
            </div>
            {folders.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-gray-400">还没有自定义文件夹</div>
            ) : folders.map((folder) => (
              <div key={folder} className="flex items-center gap-3 border-b border-gray-100 px-3 py-2 last:border-b-0 dark:border-white/[0.08]">
                <FolderIcon className="h-4 w-4 shrink-0 text-[#D97757]" />
                <span className="min-w-0 flex-1 truncate text-sm text-gray-700 dark:text-gray-200" title={folder}>{folder}</span>
                <span className="shrink-0 text-xs text-gray-400">{counts.get(folder) ?? 0}</span>
                <button type="button" onClick={() => askRename(folder)} className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-200" title="重命名">
                  <EditIcon className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => askDelete(folder)} className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10 dark:hover:text-red-400" title="清空文件夹">
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
