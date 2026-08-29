import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { fetchActiveAnnouncement, type Announcement } from '../lib/announcements'
import MarkdownRenderer from './MarkdownRenderer'
import { BellIcon, CloseIcon } from './icons'

const SEEN_ANNOUNCEMENTS_KEY = 'gpt-image-playground:seen-announcements'

function readSeenAnnouncements() {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_ANNOUNCEMENTS_KEY) || '[]')
    return Array.isArray(value) ? new Set(value.filter((item): item is string => typeof item === 'string')) : new Set<string>()
  } catch {
    return new Set<string>()
  }
}

function announcementSeenKey(item: Announcement, userId: string) {
  return `${userId}:${item.id}:${item.starts_at ?? ''}:${item.ends_at ?? ''}`
}

function markAnnouncementSeen(item: Announcement, userId: string) {
  const seen = readSeenAnnouncements()
  seen.add(announcementSeenKey(item, userId))
  try {
    localStorage.setItem(SEEN_ANNOUNCEMENTS_KEY, JSON.stringify([...seen].slice(-100)))
  } catch {
    // localStorage 不可用时只保留当前会话状态。
  }
}

export default function AnnouncementNotice() {
  const { status, user } = useAuth()
  const [announcement, setAnnouncement] = useState<Announcement | null>(null)

  useEffect(() => {
    if (status !== 'authenticated' || !user) return
    let disposed = false
    void fetchActiveAnnouncement().then((item) => {
      if (disposed || !item || readSeenAnnouncements().has(announcementSeenKey(item, user.id))) return
      markAnnouncementSeen(item, user.id)
      setAnnouncement(item)
    }).catch((error) => console.warn('加载公告失败:', error))
    return () => {
      disposed = true
    }
  }, [status, user?.id])

  if (!announcement) return null
  const close = () => setAnnouncement(null)
  const content = (
    <div className="min-w-0">
      {announcement.title && <div className="mb-1 text-base font-medium text-gray-900 dark:text-gray-100">{announcement.title}</div>}
      <MarkdownRenderer content={announcement.content} className="text-sm leading-5 text-gray-700 dark:text-gray-200" />
    </div>
  )

  if (announcement.notification === 'modal') {
    return (
      <div className="fixed inset-0 z-[130] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="公告">
        <div className="absolute inset-0 bg-black/25 backdrop-blur-sm" onClick={close} />
        <div className="relative z-10 w-full max-w-lg rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-white/[0.1] dark:bg-gray-900">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100"><BellIcon className="h-4 w-4 text-blue-500" />公告</div>
            <button type="button" onClick={close} aria-label="关闭公告" title="关闭" className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"><CloseIcon className="h-4 w-4" /></button>
          </div>
          {content}
          <div className="mt-5 flex justify-end"><button type="button" onClick={close} className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600">知道了</button></div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed left-1/2 top-16 z-[130] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2" role="status">
      <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur dark:border-blue-900/60 dark:bg-gray-900/95">
        <BellIcon className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
        {content}
        <button type="button" onClick={close} aria-label="关闭公告" title="关闭" className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"><CloseIcon className="h-4 w-4" /></button>
      </div>
    </div>
  )
}
