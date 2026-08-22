import type { AppSettings } from '../../types'
import Select from '../Select'

interface GeneralSettingsTabProps {
  draft: AppSettings
  zipDownloadRouteSummary: string
  commitSettings: (nextDraft: AppSettings) => void
  onOpenZipDownloadRouteManager: () => void
  toggleTaskCompletionNotification: () => Promise<void>
}

export default function GeneralSettingsTab({
  draft,
  zipDownloadRouteSummary,
  commitSettings,
  onOpenZipDownloadRouteManager,
  toggleTaskCompletionNotification,
}: GeneralSettingsTabProps) {
  return (
    <div className="space-y-4">
      <div className="hidden sm:block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">任务提交方式</span>
          <div className="w-28 shrink-0">
            <Select
              value={draft.enterSubmit ? 'enter' : 'ctrl-enter'}
              onChange={(val) => commitSettings({ ...draft, enterSubmit: val === 'enter' })}
              options={[
                { label: navigator.userAgent.includes('Mac') ? '⌘ + Enter' : 'Ctrl + Enter', value: 'ctrl-enter' },
                { label: 'Enter', value: 'enter' }
              ]}
              className="w-full px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none"
            />
          </div>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          选择 {navigator.userAgent.includes('Mac') ? '⌘ + Enter' : 'Ctrl + Enter'} 时，Enter 换行；选择 Enter 时，Shift + Enter 换行。
        </div>
      </div>
      <div className="sm:hidden">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">任务提交方式</span>
          <div className="w-28 shrink-0">
            <Select
              value={draft.enterSubmit ? 'enter' : 'button'}
              onChange={(val) => commitSettings({ ...draft, enterSubmit: val === 'enter' })}
              options={[
                { label: '发送按钮', value: 'button' },
                { label: '回车/发送按钮', value: 'enter' }
              ]}
              className="w-full px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none"
            />
          </div>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          选择回车/发送按钮时，回车可提交；否则仅使用发送按钮提交。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">提交任务后清空输入框</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, clearInputAfterSubmit: !draft.clearInputAfterSubmit })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.clearInputAfterSubmit ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.clearInputAfterSubmit}
            aria-label="提交任务后清空输入框"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.clearInputAfterSubmit ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，提交成功创建任务时会清空提示词和参考图。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">使用压缩包进行的批量下载途径</span>
          <button
            type="button"
            onClick={onOpenZipDownloadRouteManager}
            className="shrink-0 rounded-xl border border-gray-200/80 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 hover:text-gray-900 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
          >
            管理
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {zipDownloadRouteSummary}
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">重启后加载上次的输入框</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, persistInputOnRestart: !draft.persistInputOnRestart })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.persistInputOnRestart ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.persistInputOnRestart}
            aria-label="重启后加载上次的输入框"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.persistInputOnRestart ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          关闭后，不再持久化提示词和参考图，下次启动会使用空输入框。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">复用配置时临时复用该任务的 API 配置</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, reuseTaskApiProfileTemporarily: !draft.reuseTaskApiProfileTemporarily })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.reuseTaskApiProfileTemporarily ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.reuseTaskApiProfileTemporarily}
            aria-label="复用配置时临时复用该任务的 API 配置"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.reuseTaskApiProfileTemporarily ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，复用历史任务时会临时使用该任务的 API 配置，找不到该配置时提交会提示；关闭后，会继续使用当前的 API 配置。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">成功任务仍然展示重试按钮</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, alwaysShowRetryButton: !draft.alwaysShowRetryButton })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.alwaysShowRetryButton ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.alwaysShowRetryButton}
            aria-label="成功任务仍然展示重试按钮"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.alwaysShowRetryButton ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，即使任务成功生成，也会在任务卡片和详情页显示重试按钮。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">允许模型改写优化提示词</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, allowPromptRewrite: !draft.allowPromptRewrite })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.allowPromptRewrite ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.allowPromptRewrite}
            aria-label="允许模型改写优化提示词"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.allowPromptRewrite ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，Codex CLI 兼容模式下的 Image API 请求和所有 Responses API 请求都不再附加防改写提示词，允许模型按服务商策略优化提示词。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">任务完成后发送系统通知</span>
          <button
            type="button"
            onClick={() => { void toggleTaskCompletionNotification() }}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.taskCompletionNotification ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.taskCompletionNotification}
            aria-label="任务完成后发送系统通知"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.taskCompletionNotification ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，画廊模式图像生成完成、Agent 模式回复结束时，会发送浏览器系统通知。浏览器可能会请求通知权限或默认拒绝，请查看相关提示。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">发送消息后自动滚动到底部</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, agentScrollToBottomAfterSubmit: !draft.agentScrollToBottomAfterSubmit })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.agentScrollToBottomAfterSubmit ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.agentScrollToBottomAfterSubmit}
            aria-label="发送消息后自动滚动到底部"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.agentScrollToBottomAfterSubmit ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，在 Agent 模式发送消息成功后会自动滚动到对话底部。
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">公式输出提示</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, agentMathFormattingPrompt: !draft.agentMathFormattingPrompt })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.agentMathFormattingPrompt ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.agentMathFormattingPrompt}
            aria-label="公式输出提示"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.agentMathFormattingPrompt ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，Agent 会被要求使用 <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.9em] text-gray-700 dark:bg-white/10 dark:text-gray-200">$...$</code> 和 <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.9em] text-gray-700 dark:bg-white/10 dark:text-gray-200">$$...$$</code> 输出数学公式，确保渲染效果正常。
        </div>
      </div>
    </div>
  )
}
