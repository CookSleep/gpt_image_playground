import { useEffect, useState } from 'react'
import { listAnnouncementHistory, type Announcement } from '../lib/announcements'
import MarkdownRenderer from './MarkdownRenderer'
import { BellIcon, ChevronLeftIcon, CloseIcon } from './icons'

function formatAnnouncementTime(value?: string) {
  if (!value) return ''
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(time).replace(/\//g, '-')
}

export default function AnnouncementHistoryModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Announcement[]>([])
  const [selected, setSelected] = useState<Announcement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    void listAnnouncementHistory().then((next) => {
      if (!disposed) setItems(next)
    }).catch((err) => {
      if (!disposed) setError(err instanceof Error ? err.message : '公告加载失败')
    }).finally(() => {
      if (!disposed) setLoading(false)
    })
    return () => {
      disposed = true
    }
  }, [])

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="历史公告" onClick={onClose}>
      <div className="absolute inset-0 bg-black/25 backdrop-blur-sm" />
      <div className="relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-gray-200 bg-white shadow-xl dark:border-white/[0.1] dark:bg-gray-900" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4 dark:border-white/[0.08]">
          {selected ? <button type="button" onClick={() => setSelected(null)} className="flex items-center gap-1 rounded px-1 py-0.5 text-sm font-medium text-gray-900 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-white/[0.08]"><ChevronLeftIcon className="h-4 w-4" />历史公告</button> : <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100"><BellIcon className="h-4 w-4 text-blue-500" />历史公告</div>}
          <button type="button" onClick={onClose} aria-label="关闭历史公告" title="关闭" className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"><CloseIcon className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? <div className="text-sm text-gray-500">加载中...</div> : error ? <div className="text-sm text-red-500">{error}</div> : selected ? <article>
            <div className="mb-4 flex items-baseline justify-between gap-3">
              <h3 className="min-w-0 text-base font-medium text-gray-900 dark:text-gray-100">{selected.title || '未命名公告'}</h3>
              <time className="shrink-0 text-xs text-gray-400">{formatAnnouncementTime(selected.created_at)}</time>
            </div>
            <MarkdownRenderer content={selected.content} className="text-sm leading-5 text-gray-700 dark:text-gray-200" />
          </article> : items.length === 0 ? <div className="text-sm text-gray-500">暂无公告</div> : <div className="divide-y divide-gray-100 dark:divide-white/[0.08]">
            {items.map((item) => <button key={item.id} type="button" onClick={() => setSelected(item)} className="flex w-full items-center justify-between gap-3 py-3 text-left first:pt-0 last:pb-0 hover:text-blue-600 dark:hover:text-blue-400">
              <span className="min-w-0 truncate text-sm text-gray-800 dark:text-gray-100">{item.title || '未命名公告'}</span>
              <time className="shrink-0 text-xs text-gray-400">{formatAnnouncementTime(item.created_at)}</time>
            </button>)}
          </div>}
        </div>
      </div>
    </div>
  )
}
