import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { ZipDownloadRoute } from '../../types'
import { Checkbox } from '../Checkbox'
import { CloseIcon } from '../icons'

export const ZIP_DOWNLOAD_ROUTE_OPTIONS: Array<{ route: ZipDownloadRoute; label: string; description: string }> = [
  { route: 'task-selection', label: '任务列表 > 多选', description: '主页或收藏夹详情中框选、Ctrl/⌘ 点选或移动端滑动选中任务后的“下载选中”。' },
  { route: 'favorite-collection-selection', label: '收藏夹列表 > 多选', description: '收藏夹概览页选中一个或多个收藏夹后的“下载选中”。' },
  { route: 'image-context-menu-all', label: '图片右键菜单 > 下载全部', description: '右键图片时下载同一组输出图片。' },
  { route: 'task-detail-all', label: '任务详情 > 下载全部', description: '任务详情弹窗中下载当前任务的所有输出图。' },
  { route: 'task-detail-partial', label: '任务详情 > 下载中间步骤图', description: '任务详情弹窗中下载流式生成保留的中间步骤图。' },
  { route: 'agent-round-all', label: 'Agent 对话轮次 > 下载所有图片', description: 'Agent 对话中下载某轮回复关联的全部图片。' },
]

interface ZipDownloadRouteModalProps {
  routes: ZipDownloadRoute[]
  scrollBoundaryRef: RefObject<HTMLDivElement | null>
  onSetEnabled: (route: ZipDownloadRoute, enabled: boolean) => void
  onClose: () => void
}

export default function ZipDownloadRouteModal({
  routes,
  scrollBoundaryRef,
  onSetEnabled,
  onClose,
}: ZipDownloadRouteModalProps) {
  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        className="relative z-10 w-full max-w-md rounded-3xl bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] ring-1 ring-black/5 dark:ring-white/10 animate-confirm-in flex flex-col max-h-[85vh] sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 p-6 pb-2">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-100">使用压缩包进行批量下载</h3>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label="关闭"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>

          <div data-selectable-text className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
            开启后，在对应途径进行批量下载时会将结果下载为一个 ZIP，而不是多个图片文件。
          </div>
        </div>

        <div ref={scrollBoundaryRef} className="flex-1 overflow-y-auto px-6 space-y-3 custom-scrollbar min-h-0 py-2">
          {ZIP_DOWNLOAD_ROUTE_OPTIONS.map((option) => {
            const isChecked = routes.includes(option.route)
            return (
              <div
                key={option.route}
                role="checkbox"
                aria-checked={isChecked}
                tabIndex={0}
                onClick={() => onSetEnabled(option.route, !isChecked)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onSetEnabled(option.route, !isChecked)
                }}
                className={`cursor-pointer rounded-2xl border p-3.5 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${isChecked ? 'border-blue-500/30 bg-blue-50/50 dark:border-blue-400/30 dark:bg-blue-500/[0.05]' : 'border-gray-100 bg-gray-50/70 hover:bg-gray-100/70 dark:border-white/[0.06] dark:bg-white/[0.03] dark:hover:bg-white/[0.05]'}`}
              >
                <div onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    checked={isChecked}
                    onChange={(checked) => onSetEnabled(option.route, checked)}
                    label={<span className="text-sm font-medium text-gray-700 dark:text-gray-200">{option.label}</span>}
                  />
                </div>
                <div data-selectable-text className="mt-1.5 pl-6 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                  {option.description}
                </div>
              </div>
            )
          })}
        </div>

        <div className="shrink-0 p-6 pt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl bg-blue-500 py-2 text-sm font-medium text-white transition hover:bg-blue-600"
          >
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
