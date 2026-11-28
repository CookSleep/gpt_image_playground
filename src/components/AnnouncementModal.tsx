import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { getAppLayer } from '../lib/dialogLayers'
import { useStore } from '../store'
import { useAnnouncements } from '../hooks/useAnnouncements'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { useIsDarkMode } from '../hooks/useColorMode'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { useReleaseUpdates } from '../hooks/useReleaseUpdates'
import MarkdownRenderer from './MarkdownRenderer'
import { CloseIcon } from './icons'

export default function AnnouncementModal({ ready }: { ready: boolean }) {
  const { pending, dismiss } = useAnnouncements(ready)
  const announcement = pending[0]
  const scrollRef = useRef<HTMLDivElement>(null)
  // 启动时可能同时出现导入确认、存储错误等弹窗，公告让位于其他弹窗，关闭后再显示；隐私模式中暂不显示，不记为已读
  const blocked = useStore((s) => Boolean(
    s.privacyMode || s.confirmDialog || s.supportPromptOpen || s.showSettings || s.detailTaskId || s.lightboxImageId || s.maskEditorImageId || s.sketchBoard
    || s.isManageCollectionsModalOpen || s.favoritePickerTaskIds,
  ))
  const updateModalOpen = useReleaseUpdates((s) => s.modalOpen)
  const isDark = useIsDarkMode()
  const visible = Boolean(announcement) && !blocked && !updateModalOpen
  // X、Esc、点遮罩表示不想看公告，把剩下的未读公告一并记为已读；“下一条”和主按钮只读掉当前一条
  const close = () => dismiss(pending.map((item) => item.id))
  const next = () => dismiss([announcement.id])

  useCloseOnEscape(visible, close)
  usePreventBackgroundScroll(visible, scrollRef)

  if (!visible || !announcement) return null
  const media = announcement.media
  // 沙箱页面跨源，读不到应用的颜色模式，通过地址参数告知
  const frameSrc = media?.type === 'html' ? new URL(media.src) : null
  frameSrc?.searchParams.set('theme', isDark ? 'dark' : 'light')
  // 一句话的正文居中；多段或含列表的长正文左对齐，便于阅读
  const longContent = /\n\s*\n|^\s*([-*+]|\d+\.)\s/m.test(announcement.content.trim())

  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      onClick={close}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" />
      <div
        className="relative z-10 flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-white/50 bg-white/95 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={close}
          className="absolute right-3 top-3 z-10 rounded-full bg-white/70 p-1 text-gray-400 backdrop-blur transition hover:bg-gray-100 hover:text-gray-600 dark:bg-gray-900/60 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
          aria-label="关闭"
        >
          <CloseIcon className="h-5 w-5" />
        </button>
        <div key={announcement.id} ref={scrollRef} className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-5 pb-3 text-center">
          {media && (
            <div
              className="mb-5 overflow-hidden rounded-2xl bg-black/[0.03] ring-1 ring-black/5 dark:bg-white/[0.04] dark:ring-white/[0.08]"
              style={{ aspectRatio: media.aspectRatio }}
            >
              {/* 只作演示：不给 same-origin，页面拿不到应用的存储；不接收指针和焦点，Esc 与点击仍由弹窗处理 */}
              {media.type === 'html' ? (
                <iframe
                  src={frameSrc?.href}
                  title={announcement.title}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  tabIndex={-1}
                  aria-hidden="true"
                  className="pointer-events-none block h-full w-full border-0"
                />
              ) : (
                <img src={media.src} alt="" className="block h-full w-full object-cover" />
              )}
            </div>
          )}
          <h3 className={`text-lg font-bold text-gray-800 dark:text-gray-100 ${media ? '' : 'px-6'}`}>{announcement.title}</h3>
          <div data-selectable-text className={`mt-2 text-[15px] leading-relaxed text-gray-600 dark:text-gray-300 ${longContent ? 'text-left' : ''}`}>
            <MarkdownRenderer content={announcement.content} />
          </div>
          {announcement.note && (
            <p data-selectable-text className="mt-3 whitespace-pre-line text-xs leading-relaxed text-gray-400 dark:text-gray-500">{announcement.note}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-center gap-2 px-5 pt-2 pb-5">
          <button
            type="button"
            onClick={next}
            className="whitespace-nowrap rounded-xl border border-transparent px-4 py-2 text-sm text-gray-600 transition hover:bg-black/[0.07] dark:bg-white/[0.06] dark:text-gray-400 dark:hover:bg-white/[0.1]"
          >
            {pending.length > 1 ? '下一条' : '知道了'}
          </button>
          {announcement.action && (
            <a
              href={announcement.action.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={next}
              className="whitespace-nowrap rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600"
            >
              {announcement.action.label}
            </a>
          )}
        </div>
      </div>
    </div>,
    getAppLayer(),
  )
}
