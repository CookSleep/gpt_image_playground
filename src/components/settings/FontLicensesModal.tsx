import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogLayer } from '../../hooks/useDialogLayer'
import { CloseIcon } from '../icons'

interface FontLicensesModalProps {
  onClose: () => void
}

export default function FontLicensesModal({ onClose }: FontLicensesModalProps) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // 清单由 npm run notices 生成，约 700 KB，打开弹窗时才加载，不进主包
  useEffect(() => {
    import('../../assets/third-party-notices.txt?raw')
      .then((mod) => setText(mod.default))
      .catch((err) => {
        console.error('加载第三方许可清单失败', err)
        setFailed(true)
      })
  }, [])

  const layer = useDialogLayer(onClose)
  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        className="relative z-10 w-full max-w-2xl rounded-3xl bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] ring-1 ring-black/5 dark:ring-white/10 animate-confirm-in flex flex-col max-h-[85vh] sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 p-6 pb-2">
          <div className="flex items-center justify-between gap-4">
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-100">第三方许可</h3>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label="关闭"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6 pt-2 custom-scrollbar min-h-0">
          {text === null ? (
            <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">{failed ? '许可清单加载失败，请刷新页面后重试' : '正在加载…'}</div>
          ) : (
            <pre
              data-selectable-text
              className="whitespace-pre-wrap break-words rounded-xl bg-black/[0.04] p-3 font-mono text-[11px] leading-relaxed text-gray-600 dark:bg-white/[0.06] dark:text-gray-300"
            >
              {text}
            </pre>
          )}
        </div>
      </div>
    </div>,
    layer,
  )
}
