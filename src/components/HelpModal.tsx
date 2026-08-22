import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { AppMode } from '../types'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'

interface HelpModalProps {
  appMode: AppMode
  isFavoriteCollectionOverview?: boolean
  onClose: () => void
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isMobile
}

export default function HelpModal({ appMode, isFavoriteCollectionOverview = false, onClose }: HelpModalProps) {
  const isMobile = useIsMobile()
  const modalRef = useRef<HTMLDivElement>(null)
  const isAgentMode = appMode === 'agent'
  useCloseOnEscape(true, onClose)
  usePreventBackgroundScroll(true, modalRef)

  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" />
      <div
        ref={modalRef}
        className="relative z-10 w-full max-w-md rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10 flex flex-col max-h-[85vh] custom-scrollbar"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <path d="M12 17h.01" />
            </svg>
            操作指南
          </h3>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label="关闭"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain mb-6 text-sm text-gray-600 dark:text-gray-300 space-y-6 custom-scrollbar pr-2">
          {isAgentMode ? (
            <>
              <section>
                <div className="space-y-4">
                  <ul className="list-disc pl-4 space-y-2">
                    <li>需要使用 Responses API 配置。</li>
                    <li>如需 Agent 搜索互联网或读取 URL 内容，可在设置的 Agent 配置中开启“网络搜索”。</li>
                    <li>输入 <strong className="text-blue-500 dark:text-blue-400 font-medium">@</strong> 可引用参考图或前面轮次生成的图片；Agent 也会自行参考上下文中的图片。</li>
                    <li>编辑某轮消息重新发送，或重新生成某轮消息，会产生可切换的分支。</li>
                    <li>生成的图片会同步到画廊；删除对话默认不会删除画廊中的任务。</li>
                  </ul>
                </div>
              </section>
            </>
          ) : isFavoriteCollectionOverview ? (
            <>
              <section>
                <h4 className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                  <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                  </svg>
                  多选收藏夹
                </h4>
                <div className="space-y-4">
                  {isMobile ? (
                    <p>在收藏夹卡片上<strong className="text-blue-500 dark:text-blue-400 font-medium">左右滑动</strong>即可选中或取消选中该卡片。</p>
                  ) : (
                    <ul className="list-disc pl-4 space-y-2">
                      <li>使用鼠标在空白处<strong className="text-blue-500 dark:text-blue-400 font-medium">拖拽框选</strong>收藏夹卡片。</li>
                      <li>按住 <kbd className="px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs font-sans">Ctrl</kbd> 或 <kbd className="px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs font-sans">⌘</kbd> 并点击卡片，可添加或移除单项。</li>
                      <li>再次框选已选中的卡片会将其取消选中。</li>
                      <li>点击卡片外任意空白处可取消所有选择。</li>
                    </ul>
                  )}
                </div>
              </section>
              <section>
                <h4 className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                  <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  批量操作
                </h4>
                <div className="space-y-4">
                  <p>选中一个或多个收藏夹后，页面底部会出现操作栏，支持<strong className="text-gray-500 dark:text-gray-400 font-medium">取消选择</strong>、<strong className="text-blue-500 dark:text-blue-400 font-medium">全选收藏夹</strong>、<strong className="text-purple-500 dark:text-purple-400 font-medium">反选收藏夹</strong>、<strong className="text-green-500 dark:text-green-400 font-medium">下载选中</strong>，和<strong className="text-red-500 dark:text-red-400 font-medium">删除选中</strong>。</p>
                </div>
              </section>
            </>
          ) : isMobile ? (
            <>
              <section>
                <h4 className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                  <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                  </svg>
                  多选任务
                </h4>
                <div className="space-y-4">
                  <p>在历史任务卡片上<strong className="text-blue-500 dark:text-blue-400 font-medium">左右滑动</strong>即可选中或取消选中该卡片。</p>
                </div>
              </section>
              <section>
                <h4 className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                  <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  批量操作
                </h4>
                <div className="space-y-4">
                  <p>选中一个或多个任务后，页面底部会出现操作栏，支持<strong className="text-gray-500 dark:text-gray-400 font-medium">取消选择</strong>、<strong className="text-blue-500 dark:text-blue-400 font-medium">全选任务</strong>、<strong className="text-purple-500 dark:text-purple-400 font-medium">反选任务</strong>、<strong className="text-yellow-500 dark:text-yellow-400 font-medium">编辑收藏夹</strong>、<strong className="text-green-500 dark:text-green-400 font-medium">下载选中</strong>，和<strong className="text-red-500 dark:text-red-400 font-medium">删除选中</strong>。</p>
                </div>
              </section>
            </>
          ) : (
            <>
              <section>
                <h4 className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                  <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                  </svg>
                  多选任务
                </h4>
                <div className="space-y-4">
                  <ul className="list-disc pl-4 space-y-2">
                    <li>使用鼠标在空白处<strong className="text-blue-500 dark:text-blue-400 font-medium">拖拽框选</strong>。</li>
                    <li>按住 <kbd className="px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs font-sans">Ctrl</kbd> 或 <kbd className="px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs font-sans">⌘</kbd> 并点击卡片，可添加或移除单项。</li>
                    <li>再次框选已选中的卡片会将其取消选中。</li>
                    <li>点击卡片外任意空白处可取消所有选择。</li>
                  </ul>
                </div>
              </section>
              <section>
                <h4 className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                  <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  批量操作
                </h4>
                <div className="space-y-4">
                  <p>选中一个或多个任务后，页面底部会出现操作栏，支持<strong className="text-gray-500 dark:text-gray-400 font-medium">取消选择</strong>、<strong className="text-blue-500 dark:text-blue-400 font-medium">全选任务</strong>、<strong className="text-purple-500 dark:text-purple-400 font-medium">反选任务</strong>、<strong className="text-yellow-500 dark:text-yellow-400 font-medium">编辑收藏夹</strong>、<strong className="text-green-500 dark:text-green-400 font-medium">下载选中</strong>，和<strong className="text-red-500 dark:text-red-400 font-medium">删除选中</strong>。</p>
                </div>
              </section>
            </>
          )}
        </div>

        <div className="pt-4 border-t border-gray-200 dark:border-white/[0.08] flex justify-center">
          <a
            href="https://github.com/CookSleep/gpt_image_playground"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors group"
          >
            <svg className="w-5 h-5 group-hover:scale-110 transition-transform" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            @CookSleep
          </a>
        </div>
      </div>
    </div>,
    document.body
  )
}
