import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogLayer } from '../hooks/useDialogLayer'
import { refreshClientUpdate, requestClientUpdateInstall, startClientUpdateDownload, useClientUpdate } from '../hooks/useClientUpdate'
import { PULL_THRESHOLD, usePullUpToLoad } from '../hooks/usePullUpToLoad'
import { checkForUpdates, ignoreReleaseVersion, loadOlderReleases, setUpdateModalOpen, useReleaseUpdates } from '../hooks/useReleaseUpdates'
import { formatUpdateProgress } from '../lib/clientUpdate'
import { isTauri, openExternal } from '../lib/platform'
import { compareVersions, MANUAL_CHECK_MIN_INTERVAL_MS, RELEASES_PAGE_URL, shouldShowUpdate, stripReleaseHeading } from '../lib/releaseUpdates'
import { useStore } from '../store'
import MarkdownRenderer from './MarkdownRenderer'
import { CloseIcon, ExternalLinkIcon } from './icons'

function formatReleaseDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

const CLIENT_UPDATE_LABELS = {
  idle: '下载',
  downloading: '下载中…',
  ready: '安装',
  installing: '安装中…',
}

// 下载进度更新频繁，按钮单独订阅 store，避免整个弹窗随之重渲染
function ClientUpdateButton({ version }: { version: string }) {
  const status = useClientUpdate((s) => s.status)
  const progress = useClientUpdate((s) => s.progress)

  // 最新版本变化时重新检查本地安装包
  useEffect(() => {
    void refreshClientUpdate()
  }, [version])

  const handleClick = () => {
    if (status !== 'ready') return void startClientUpdateDownload(version)
    requestClientUpdateInstall(version)
  }

  const label = status === 'downloading' && progress ? `下载中 ${formatUpdateProgress(progress)}` : CLIENT_UPDATE_LABELS[status]
  return (
    <button
      type="button"
      disabled={status === 'downloading' || status === 'installing'}
      onClick={handleClick}
      className="whitespace-nowrap rounded-xl bg-blue-500 px-3 py-2 text-sm font-medium text-white tabular-nums sm:px-4 transition hover:bg-blue-600 disabled:cursor-default disabled:opacity-70 disabled:hover:bg-blue-500"
    >
      {label}
    </button>
  )
}

function UpdateModalContent() {
  const releases = useReleaseUpdates((s) => s.releases)
  const hasMore = useReleaseUpdates((s) => s.hasMore)
  const ignoredVersion = useReleaseUpdates((s) => s.ignoredVersion)
  const checkError = useReleaseUpdates((s) => s.checkError)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // 加载新一页后要滚动到的条目序号，-1 表示不滚动
  const scrollToRef = useRef(-1)
  const close = () => setUpdateModalOpen(false)
  const layer = useDialogLayer(close)
  const updateModalScrollRef = useRef<HTMLDivElement>(null)

  const latest = releases[0]

  const run = async (task: () => Promise<unknown>) => {
    setLoading(true)
    setError('')
    try {
      await task()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const loadMore = () => {
    if (loading || !hasMore) return
    scrollToRef.current = releases.length
    void run(() => loadOlderReleases())
  }

  const { pull, dragging, armed } = usePullUpToLoad(updateModalScrollRef, loadMore)

  useEffect(() => {
    // 直接打开弹窗但还没有数据时（例如启动检查失败），补一次请求
    if (!useReleaseUpdates.getState().releases.length) void run(() => checkForUpdates())
  }, [])

  useEffect(() => {
    // 新一页显示后滚到它的第一条，让用户看到加载结果
    const idx = scrollToRef.current
    if (idx < 0 || idx >= releases.length) return
    scrollToRef.current = -1
    const el = updateModalScrollRef.current
    const item = el?.querySelector<HTMLElement>(`[data-release-index="${idx}"]`)
    if (el && item) el.scrollTo({ top: item.offsetTop - 12, behavior: 'smooth' })
  }, [releases.length])

  const hasUpdate = Boolean(latest && compareVersions(latest.version, __APP_VERSION__) > 0)
  const showClientUpdate = isTauri && hasUpdate
  // 没有版本列表时正文已显示加载中或失败详情，标题下只给简短状态，不重复
  const status = !releases.length
    ? !loading && (error || checkError)
      ? { label: '检查失败', text: 'text-red-600 dark:text-red-400', dot: 'bg-red-500 ring-red-500/20' }
      : { label: '当前版本', text: 'text-gray-500 dark:text-gray-400', dot: 'bg-gray-300 ring-gray-300/25 dark:bg-gray-600 dark:ring-gray-600/30' }
    : hasUpdate
      ? { label: '有新版本可用', text: 'font-medium text-blue-600 dark:text-blue-400', dot: 'bg-blue-500 ring-blue-500/20' }
      : checkError
        ? { label: `检查失败：${checkError}`, text: 'text-red-600 dark:text-red-400', dot: 'bg-red-500 ring-red-500/20' }
        : { label: '当前已是最新版本', text: 'text-gray-500 dark:text-gray-400', dot: 'bg-emerald-500 ring-emerald-500/20' }
  const pullText = loading
    ? '正在加载…'
    : !hasMore
      ? '没有更早的版本了'
      : armed
        ? '松开加载更早的版本'
        : '继续上滑加载更早的版本'
  const progress = loading ? 0 : Math.min(pull / PULL_THRESHOLD, 1)

  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 flex items-center justify-center p-4"
      onClick={close}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" />
      <div
        className="relative z-10 flex h-[85vh] max-h-[720px] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-white/50 bg-white/95 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-gray-100 px-5 py-4 dark:border-white/[0.08]">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h3 className="text-base font-bold text-gray-800 dark:text-gray-100">版本更新</h3>
              {isTauri && (
                <button
                  type="button"
                  onClick={() => void openExternal(latest?.url ?? RELEASES_PAGE_URL)}
                  className="flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-blue-500 dark:text-gray-500 dark:hover:text-blue-400"
                >
                  <ExternalLinkIcon className="h-3.5 w-3.5" />
                  在 GitHub 打开
                </button>
              )}
            </div>
            {/* 检查失败时列表可能来自过期缓存，不能断言已是最新；有新版本时仍以新版本信息优先 */}
            <div className={`mt-1.5 flex min-w-0 items-center gap-2 text-xs ${status.text}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ring-[3px] ${status.dot}`} />
              <span title={status.label} className="min-w-0 truncate">{status.label}</span>
              <span data-selectable-text className="shrink-0 font-mono text-gray-400 dark:text-gray-500">
                {hasUpdate ? `v${__APP_VERSION__} → ${latest?.tag}` : `v${__APP_VERSION__}`}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="-mr-1 shrink-0 rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            ref={updateModalScrollRef}
            className={`custom-scrollbar relative h-full overflow-y-auto overscroll-contain px-5 py-4 ${dragging ? '' : 'transition-transform duration-200 ease-out'}`}
            style={{ transform: pull ? `translateY(${-pull}px)` : undefined }}
          >
            {releases.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-gray-500 dark:text-gray-400">
                {loading ? '正在获取版本信息…' : error ? (
                  <>
                    <span>获取版本信息失败：{error}</span>
                    <button type="button" onClick={() => void run(() => checkForUpdates(MANUAL_CHECK_MIN_INTERVAL_MS))} className="text-blue-500 hover:underline">重试</button>
                  </>
                ) : '暂无版本信息'}
              </div>
            ) : (
              <div className="space-y-4">
                {releases.map((release, idx) => {
                  const cmp = compareVersions(release.version, __APP_VERSION__)
                  return (
                    <section
                      key={release.tag}
                      data-release-index={idx}
                      className={`rounded-2xl p-4 ${cmp > 0 ? 'bg-blue-50/80 ring-1 ring-blue-100 dark:bg-blue-500/[0.08] dark:ring-blue-400/15' : 'bg-black/[0.03] dark:bg-white/[0.04]'}`}
                    >
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <h4 className="text-[15px] font-bold text-gray-800 dark:text-gray-100">{release.tag}</h4>
                        {idx === 0 && cmp > 0 && <span className="text-xs font-medium text-blue-500 dark:text-blue-400">最新</span>}
                        {cmp === 0 && <span className="text-xs text-gray-400 dark:text-gray-500">当前版本</span>}
                        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">{formatReleaseDate(release.publishedAt)}</span>
                      </div>
                      <div data-selectable-text className="text-sm leading-relaxed text-gray-700 dark:text-gray-200">
                        <MarkdownRenderer content={stripReleaseHeading(release.body, release.version).trim() || '暂无更新说明。'} />
                      </div>
                    </section>
                  )
                })}
                {/* 随列表一起被拉起，松手后一起落回 */}
                <div className={`flex items-center justify-center gap-2 pb-2 text-xs transition-colors ${armed && hasMore && !loading ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500'}`}>
                  {error && !loading ? (
                    <>
                      <span>加载失败：{error}</span>
                      <button type="button" onClick={loadMore} className="text-blue-500 hover:underline">重试</button>
                    </>
                  ) : (
                    <>
                      {(loading || hasMore) && (
                        <span
                          className={`inline-flex ${dragging ? '' : 'transition-transform duration-200 ease-out'}`}
                          style={{ transform: `rotate(${progress * 360}deg)` }}
                        >
                          <svg className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
                            <circle
                              cx="12"
                              cy="12"
                              r="9"
                              stroke="currentColor"
                              strokeWidth="3"
                              strokeLinecap="round"
                              pathLength={100}
                              strokeDasharray={`${loading ? 25 : 10 + progress * 65} 100`}
                              transform="rotate(-90 12 12)"
                            />
                          </svg>
                        </span>
                      )}
                      <span>{pullText}</span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-gray-100 p-3 dark:border-white/[0.08] sm:p-4">
          {latest && shouldShowUpdate(latest, __APP_VERSION__, ignoredVersion) && (
            <button
              type="button"
              onClick={() => {
                ignoreReleaseVersion(latest.version)
                close()
              }}
              className="whitespace-nowrap rounded-xl px-2 py-2 text-xs text-gray-500 transition sm:px-3 sm:text-sm hover:bg-black/[0.05] hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            >
              忽略当前最新版本
            </button>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={close}
              className="whitespace-nowrap rounded-xl border border-transparent bg-black/[0.04] px-3 py-2 text-sm text-gray-600 sm:px-4 transition hover:bg-black/[0.07] dark:bg-white/[0.06] dark:text-gray-400 dark:hover:bg-white/[0.1]"
            >
              关闭
            </button>
            {!isTauri && (
              <button
                type="button"
                onClick={() => void openExternal(latest?.url ?? RELEASES_PAGE_URL)}
                className="whitespace-nowrap rounded-xl bg-blue-500 px-3 py-2 text-sm font-medium text-white sm:px-4 transition hover:bg-blue-600"
              >
                前往 GitHub 查看
              </button>
            )}
            {showClientUpdate && latest && <ClientUpdateButton version={latest.version} />}
          </div>
        </div>
      </div>
    </div>,
    layer,
  )
}

export default function UpdateModal() {
  const modalOpen = useReleaseUpdates((s) => s.modalOpen)
  if (!modalOpen) return null
  return <UpdateModalContent />
}
