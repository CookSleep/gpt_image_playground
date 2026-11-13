import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getInputImageLimit, getInputImageProfile } from '../../lib/inputImageLimits'
import { addImageFromUrl, useStore } from '../../store'
import { isTauri } from '../../lib/platform'
import { useCloseOnEscape } from '../../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../../hooks/usePreventBackgroundScroll'
import { LinkIcon } from '../icons'

/** 以图片链接添加参考图：每行一个链接，按顺序下载入库，并记录原链接 */
export default function AddImageUrlsModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const [errorLines, setErrorLines] = useState<Set<number>>(() => new Set())
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const inputImageLimit = useStore((s) => getInputImageLimit(getInputImageProfile(s)))
  const panelRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)

  const handleClose = () => {
    if (!progress) onClose()
  }

  useCloseOnEscape(true, handleClose)
  usePreventBackgroundScroll(true, panelRef)

  const handleSubmit = async () => {
    if (progress) return
    const showToast = useStore.getState().showToast
    const lines = text.split('\n').map((line) => line.trim())
    if (!lines.some(Boolean)) {
      showToast('请输入图片链接', 'error')
      return
    }

    const invalidLines = lines.flatMap((line, idx) => {
      if (!line) return []
      if (/\s/.test(line)) return [idx]
      try {
        return /^https?:$/.test(new URL(line).protocol) ? [] : [idx]
      } catch {
        return [idx]
      }
    })
    if (invalidLines.length) {
      setErrorLines(new Set(invalidLines))
      showToast(`${invalidLines.length < lines.filter(Boolean).length ? '部分' : ''}链接不是有效的 http / https 链接`, 'error')
      return
    }

    const urls = [...new Set(lines.filter(Boolean))]

    setErrorLines(new Set())
    setProgress({ done: 0, total: urls.length })
    // 弹窗随隐私模式切换卸载时停止添加，避免参考图出现在切换后的输入框中
    const epoch = useStore.getState().privacyModeEpoch
    const countBefore = useStore.getState().inputImages.length
    const failures: Array<{ url: string; reason: string }> = []
    for (const url of urls) {
      if (useStore.getState().privacyModeEpoch !== epoch) return
      try {
        await addImageFromUrl(url)
      } catch (err) {
        console.warn('addImageFromUrl failed', url, err)
        failures.push({
          url,
          // fetch 本身失败时只有 TypeError，没有具体原因
          reason: err instanceof TypeError
            ? isTauri ? '可能是链接失效或网络异常' : '可能是链接不允许跨域访问、链接失效或网络异常'
            : err instanceof Error ? err.message : String(err),
        })
      }
      setProgress((current) => current && { ...current, done: current.done + 1 })
    }
    if (useStore.getState().privacyModeEpoch !== epoch) return

    setProgress(null)
    const added = useStore.getState().inputImages.length - countBefore
    const duplicated = urls.length - failures.length - added
    const summary = [added > 0 && `已添加 ${added} 张参考图`, duplicated > 0 && `跳过 ${duplicated} 张重复图片`].filter(Boolean).join('，')
    if (!failures.length) {
      showToast(summary, 'success')
      onClose()
      return
    }

    // 只留下失败的链接并全部标红，成功的已经添加，不再重复提交
    setText(failures.map((item) => item.url).join('\n'))
    setErrorLines(new Set(failures.map((_, idx) => idx)))
    if (failures.length === 1) {
      const failureText = `链接添加失败，${failures[0].reason}`
      showToast(summary ? `${summary}；${failureText}` : failureText, 'error')
      return
    }

    // 多个链接失败时原因可能各不相同，逐条列出
    useStore.getState().setConfirmDialog({
      title: '部分链接添加失败',
      message: `${summary ? `${summary}。` : ''}以下链接添加失败，已保留在输入框中：`,
      content: (
        <div className="space-y-2">
          {failures.map((item) => (
            <div key={item.url} className="overflow-hidden rounded-lg text-xs leading-relaxed">
              <div className="break-all bg-red-50 px-2 py-1 font-mono text-red-600 dark:bg-red-500/10 dark:text-red-400">{item.url}</div>
              <div className="bg-black/[0.03] px-2 py-1 text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">{item.reason}</div>
            </div>
          ))}
        </div>
      ),
      confirmText: '知道了',
      showCancel: false,
    })
  }

  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      onClick={handleClose}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        ref={panelRef}
        className="relative z-10 flex max-h-full w-full max-w-md flex-col rounded-3xl border border-white/50 bg-white/90 p-6 shadow-[0_8px_40px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl animate-confirm-in dark:border-white/[0.08] dark:bg-gray-900/90 dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 flex shrink-0 items-center gap-2 text-base font-bold text-gray-800 dark:text-gray-100">
          <LinkIcon className="h-5 w-5 shrink-0 text-blue-500" />
          添加链接
        </h3>
        {/* 窗口较矮时只滚动说明和输入框，标题和按钮始终可见 */}
        <div className="custom-scrollbar -mx-2 min-h-0 overflow-y-auto overscroll-contain px-2">
          <p className="mb-3 text-sm leading-relaxed text-gray-500 dark:text-gray-400 text-pretty">
            每行 1 个图片链接，按顺序添加为参考图，当前模型每次最多使用 {inputImageLimit} 张，超限图片会保留并置灰。原链接会随参考图保留，供只接受链接参考图的自定义服务商使用。
          </p>
          {/* 文本框文字透明，文字由下方同样排版的一层绘制，以便把出错行标红；不换行。
              这一层没有滚动条，可滚动范围与文本框不同，因此按文本框的滚动位置整体平移 */}
          <div className="relative h-40">
            <div
              aria-hidden
              className={`absolute inset-0 overflow-hidden whitespace-pre rounded-xl border border-transparent bg-black/[0.04] font-mono text-xs leading-relaxed text-gray-700 dark:bg-white/[0.06] dark:text-gray-200 ${progress ? 'opacity-60' : ''}`}
            >
              <div ref={highlightRef} className="px-3 py-2">
                {text.split('\n').map((line, idx) => (
                  <div key={idx} className={errorLines.has(idx) ? 'text-red-500 dark:text-red-400' : undefined}>
                    {line || ' '}
                  </div>
                ))}
              </div>
            </div>
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setErrorLines(new Set())
              }}
              onScroll={(e) => {
                if (!highlightRef.current) return
                highlightRef.current.style.transform = `translate(${-e.currentTarget.scrollLeft}px, ${-e.currentTarget.scrollTop}px)`
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void handleSubmit()
                }
              }}
              disabled={Boolean(progress)}
              autoFocus
              wrap="off"
              spellCheck={false}
              placeholder={'https://example.com/a.png\nhttps://example.com/b.jpg'}
              className="custom-scrollbar absolute inset-0 h-full w-full resize-none rounded-xl border border-transparent bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-transparent caret-gray-700 outline-none transition placeholder:text-gray-400 focus:border-blue-300 dark:caret-gray-200 dark:placeholder:text-gray-500 dark:focus:border-blue-500/50"
            />
          </div>
        </div>
        <div className="mt-4 flex shrink-0 gap-2">
          <button
            onClick={handleClose}
            disabled={Boolean(progress)}
            className="flex-1 py-2 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] text-sm text-gray-600 dark:text-gray-400 hover:bg-black/[0.07] dark:hover:bg-white/[0.1] transition disabled:cursor-not-allowed disabled:opacity-60"
          >
            取消
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={Boolean(progress)}
            className="flex-1 py-2 rounded-xl bg-blue-500 text-sm font-medium text-white hover:bg-blue-600 transition disabled:cursor-not-allowed disabled:opacity-60"
          >
            {progress ? `添加中 ${progress.done}/${progress.total}` : '添加'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
