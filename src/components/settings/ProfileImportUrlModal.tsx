import { createPortal } from 'react-dom'
import type { ApiProfile } from '../../types'
import { Checkbox } from '../Checkbox'
import { CloseIcon, CopyIcon } from '../icons'

export interface CopyImportUrlOptions {
  useNewApiAddress: boolean
  useNewApiKey: boolean
  useNewApiModel: boolean
}

interface ProfileImportUrlModalProps {
  profile: ApiProfile
  options: CopyImportUrlOptions
  onOptionsChange: (patch: Partial<CopyImportUrlOptions>) => void
  onCopy: (includeApiKey: boolean) => void
  onClose: () => void
}

export default function ProfileImportUrlModal({
  profile,
  options,
  onOptionsChange,
  onCopy,
  onClose,
}: ProfileImportUrlModalProps) {
  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        className="relative bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] max-w-sm w-full p-6 z-10 ring-1 ring-black/5 dark:ring-white/10 animate-confirm-in"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 shrink-0 rounded-full p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
          aria-label="关闭"
        >
          <CloseIcon className="h-5 w-5" />
        </button>

        <h3 className="mb-3 pr-8 flex items-start gap-2.5 text-base font-bold text-gray-800 dark:text-gray-100 leading-snug">
          <CopyIcon className="h-5 w-5 shrink-0 text-blue-500 mt-0.5" />
          <span>复制导入配置「{profile.name}」的 URL</span>
        </h3>
        <div className="text-[13px] text-gray-500 dark:text-gray-400 mb-5 leading-relaxed">
          是否包含 API Key？如果选择「不包含」，可额外配置是否使用 New API 变量。
        </div>

        <div className="mb-6 rounded-2xl bg-gray-50/80 p-4 dark:bg-white/[0.03] ring-1 ring-black/5 dark:ring-white/5">
          <div className="text-[13px] font-bold text-gray-700 dark:text-gray-300 mb-3.5">New API 变量配置</div>
          <div className="space-y-3">
            <Checkbox
              checked={options.useNewApiAddress}
              onChange={(checked) => onOptionsChange({ useNewApiAddress: checked })}
              label={<>使用 <code className="mx-0.5 rounded bg-gray-100 px-1.5 py-0.5 text-[0.85em] font-mono text-gray-700 dark:bg-white/[0.08] dark:text-gray-200">{'{address}'}</code> (不含 /v1)</>}
            />
            <Checkbox
              checked={options.useNewApiKey}
              onChange={(checked) => onOptionsChange({ useNewApiKey: checked })}
              label={<>使用 <code className="mx-0.5 rounded bg-gray-100 px-1.5 py-0.5 text-[0.85em] font-mono text-gray-700 dark:bg-white/[0.08] dark:text-gray-200">{'{key}'}</code></>}
            />
            <Checkbox
              checked={options.useNewApiModel}
              onChange={(checked) => onOptionsChange({ useNewApiModel: checked })}
              label={<>使用 <code className="mx-0.5 rounded bg-gray-100 px-1.5 py-0.5 text-[0.85em] font-mono text-gray-700 dark:bg-white/[0.08] dark:text-gray-200">{'{model}'}</code></>}
            />
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onCopy(false)}
            className="flex-1 py-2 rounded-xl border border-gray-200 dark:border-white/[0.08] text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.06] transition"
          >
            不包含
          </button>
          <button
            onClick={() => onCopy(true)}
            className="flex-1 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition shadow-sm shadow-blue-500/20"
          >
            包含 API Key
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
