import { useEffect, useState } from 'react'
import type { AppSettings } from '../../types'
import { markSaveLocationAsked } from '../../hooks/useSaveLocationPrompt'
import { DEFAULT_PRIVACY_MODE_SHORTCUT } from '../../lib/keyboardShortcut'
import { isTauri } from '../../lib/platform'
import { getDefaultSaveDir, openDefaultSaveDir } from '../../lib/saveFile'
import { openTauriLogDir } from '../../lib/tauriLog'
import { useStore } from '../../store'
import Select from '../Select'
import ProxySettingsSection from './ProxySettingsSection'
import ShortcutRecorder from './ShortcutRecorder'
import { changeSaveDirWithMigration } from './saveDirMigration'

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
  const showToast = useStore((s) => s.showToast)
  const [defaultSaveDir, setDefaultSaveDir] = useState('')

  useEffect(() => {
    if (!isTauri) return
    getDefaultSaveDir().then(setDefaultSaveDir).catch((err) => {
      console.error('读取默认保存地址失败：', err)
      setDefaultSaveDir(typeof err === 'string' ? err : '读取失败')
    })
  }, [])

  const handleChangeDefaultSaveDir = async () => {
    try {
      const dir = await changeSaveDirWithMigration()
      if (dir) setDefaultSaveDir(dir)
    } catch (err) {
      console.error('更改默认保存地址失败：', err)
      showToast(typeof err === 'string' ? err : '更改默认保存地址失败', 'error')
    }
  }

  const handleOpenDefaultSaveDir = async () => {
    try {
      await openDefaultSaveDir()
    } catch (err) {
      console.error('打开默认保存地址失败：', err)
      showToast(typeof err === 'string' ? err : '打开默认保存地址失败', 'error')
    }
  }

  const handleOpenLogDir = async () => {
    try {
      await openTauriLogDir()
    } catch (err) {
      console.error('打开日志目录失败：', err)
      showToast(typeof err === 'string' ? err : '打开日志目录失败', 'error')
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">输入</h4>
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
                className="w-full px-3 py-1.5 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] text-xs transition-all duration-200 text-gray-700 dark:text-gray-200 outline-none"
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
                className="w-full px-3 py-1.5 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] text-xs transition-all duration-200 text-gray-700 dark:text-gray-200 outline-none"
              />
            </div>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            选择回车/发送按钮时，回车可提交；否则仅使用发送按钮提交。
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">多提示词批量提交</span>
            <button
              type="button"
              onClick={() => commitSettings({ ...draft, showBatchPrompt: !draft.showBatchPrompt })}
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.showBatchPrompt ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              role="switch"
              aria-checked={draft.showBatchPrompt}
              aria-label="多提示词批量提交"
            >
              <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.showBatchPrompt ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
            </button>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            开启后，首页参数栏会显示“批量”选项，可将空两行分隔的多条提示词一次提交，支持排队或并发执行。
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
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">参考图编辑方式</span>
            <div className="w-28 shrink-0">
              <Select
                value={draft.referenceImageEditAction}
                onChange={(val) => commitSettings({ ...draft, referenceImageEditAction: val as AppSettings['referenceImageEditAction'] })}
                options={[
                  { label: '每次询问', value: 'ask' },
                  { label: '画板', value: 'sketch' },
                  { label: '遮罩', value: 'mask' },
                ]}
                className="w-full px-3 py-1.5 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] text-xs transition-all duration-200 text-gray-700 dark:text-gray-200 outline-none"
              />
            </div>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            控制在参考图预览中点击“编辑图片”时，是每次询问，还是直接用画板标注或添加遮罩。
          </div>
        </div>
      </section>
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">任务与下载</h4>
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
            <span className="block text-sm text-gray-600 dark:text-gray-300">收藏夹页的新任务加入当前收藏夹</span>
            <button
              type="button"
              onClick={() => commitSettings({ ...draft, saveTasksToActiveFavoriteCollection: !draft.saveTasksToActiveFavoriteCollection })}
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.saveTasksToActiveFavoriteCollection ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              role="switch"
              aria-checked={draft.saveTasksToActiveFavoriteCollection}
              aria-label="收藏夹页的新任务加入当前收藏夹"
            >
              <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.saveTasksToActiveFavoriteCollection ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
            </button>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            开启后，在收藏夹页提交或重试出的新任务会自动加入当前收藏夹，重试出的任务同时沿用原任务的收藏夹；在收藏夹总览或“全部收藏”中提交的任务加入默认收藏夹。
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
            开启后，即使任务成功生成，也会在任务卡片上显示重试按钮。
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">重试方式</span>
            <div className="w-32 shrink-0">
              <Select
                value={draft.retryMode}
                onChange={(val) => commitSettings({ ...draft, retryMode: val as AppSettings['retryMode'] })}
                options={[
                  { label: '新建任务', value: 'new' },
                  { label: '覆盖失败任务', value: 'overwriteFailed' },
                  ...(draft.alwaysShowRetryButton ? [{ label: '覆盖任何任务', value: 'overwriteAll' }] : []),
                ]}
                className="w-full px-3 py-1.5 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] text-xs transition-all duration-200 text-gray-700 dark:text-gray-200 outline-none"
              />
            </div>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            覆盖时保留原任务的创建时间和收藏，清空旧的结果和耗时后重新生成；重试 Agent 对话中的图片卡片时，始终新建任务。
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
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">使用压缩包进行的批量下载途径</span>
            <button
              type="button"
              onClick={onOpenZipDownloadRouteManager}
              className="shrink-0 rounded-xl border border-transparent bg-black/[0.04] px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-black/[0.07] hover:text-gray-900 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white"
            >
              管理
            </button>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {zipDownloadRouteSummary}
          </div>
        </div>
        {isTauri && (
          <>
            <div className="block">
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="block text-sm text-gray-600 dark:text-gray-300">文件保存位置</span>
                <div className="w-28 shrink-0">
                  <Select
                    value={draft.saveLocationMode}
                    onChange={(val) => {
                      markSaveLocationAsked()
                      commitSettings({ ...draft, saveLocationMode: val as AppSettings['saveLocationMode'] })
                    }}
                    options={[
                      { label: '每次询问', value: 'ask' },
                      { label: '默认地址', value: 'default' },
                    ]}
                    className="w-full px-3 py-1.5 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] text-xs transition-all duration-200 text-gray-700 dark:text-gray-200 outline-none"
                  />
                </div>
              </div>
              <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
                下载图片、压缩包和导出备份时，每次选择保存位置，或直接保存到默认保存地址；直接保存时遇到同名文件会自动加序号，不会覆盖。
              </div>
            </div>
            <div className="block">
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="block text-sm text-gray-600 dark:text-gray-300">默认保存地址</span>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={handleChangeDefaultSaveDir}
                    className="shrink-0 rounded-xl border border-transparent bg-black/[0.04] px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-black/[0.07] hover:text-gray-900 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white"
                  >
                    更改
                  </button>
                  <button
                    type="button"
                    onClick={handleOpenDefaultSaveDir}
                    className="shrink-0 rounded-xl border border-transparent bg-black/[0.04] px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-black/[0.07] hover:text-gray-900 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white"
                  >
                    打开
                  </button>
                </div>
              </div>
              <div data-selectable-text className="break-all text-xs text-gray-500 dark:text-gray-500">
                {defaultSaveDir || '读取中…'}
              </div>
            </div>
          </>
        )}
      </section>
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">通知</h4>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">任务完成或失败时发送系统通知</span>
            <button
              type="button"
              onClick={() => { void toggleTaskCompletionNotification() }}
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.taskCompletionNotification ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              role="switch"
              aria-checked={draft.taskCompletionNotification}
              aria-label="任务完成或失败时发送系统通知"
            >
              <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.taskCompletionNotification ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
            </button>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {isTauri
              ? '开启后，画廊模式图像生成和 Agent 模式回复结束时（无论成功或失败）都会发送系统通知。如果没有收到通知，请检查 Windows 设置中本应用的通知开关。'
              : '开启后，画廊模式图像生成和 Agent 模式回复结束时（无论成功或失败）都会发送浏览器系统通知。浏览器可能会请求通知权限或默认拒绝，请查看相关提示。'}
          </div>
        </div>
      </section>
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">隐私</h4>
        <div className="block">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">隐私模式快捷键</span>
            <ShortcutRecorder
              value={draft.privacyModeShortcut}
              defaultValue={DEFAULT_PRIVACY_MODE_SHORTCUT}
              onChange={(value) => commitSettings({ ...draft, privacyModeShortcut: value })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            按下后关闭所有弹窗，隐藏历史记录、收藏夹和输入框内容，之前任务的通知不再提示；再按一次恢复。点击按钮后按下新组合即可修改。
          </div>
        </div>
      </section>
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">Agent 对话</h4>
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
      </section>
      {isTauri && <ProxySettingsSection />}
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">更新</h4>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">自动检查更新</span>
            <button
              type="button"
              onClick={() => commitSettings({ ...draft, autoCheckUpdate: !draft.autoCheckUpdate })}
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.autoCheckUpdate ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              role="switch"
              aria-checked={draft.autoCheckUpdate}
              aria-label="自动检查更新"
            >
              <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.autoCheckUpdate ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
            </button>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            开启后，启动时会从 GitHub 获取版本信息，有新版本时在左上角显示 NEW 提示。关闭后可在“关于”中手动检查更新。
          </div>
        </div>
      </section>
      {isTauri && (
        <section className="space-y-4">
          <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">诊断</h4>
          <div className="block">
            <div className="mb-1 flex items-center justify-between">
              <span className="block text-sm text-gray-600 dark:text-gray-300">写入日志文件</span>
              <button
                type="button"
                onClick={() => commitSettings({ ...draft, writeLogFile: !draft.writeLogFile })}
                className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.writeLogFile ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                role="switch"
                aria-checked={draft.writeLogFile}
                aria-label="写入日志文件"
              >
                <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.writeLogFile ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
              </button>
            </div>
            <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
              记录警告和错误，便于排查问题。
            </div>
          </div>
          <div className="block">
            <div className="mb-1 flex items-center justify-between gap-3">
              <span className="block text-sm text-gray-600 dark:text-gray-300">日志目录</span>
              <button
                type="button"
                onClick={handleOpenLogDir}
                className="shrink-0 rounded-xl border border-transparent bg-black/[0.04] px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-black/[0.07] hover:text-gray-900 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white"
              >
                打开
              </button>
            </div>
            <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
              日志保存在数据目录的 logs 文件夹中，反馈问题时可以附上。
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
