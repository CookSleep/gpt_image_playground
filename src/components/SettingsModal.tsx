import { useEffect, useRef, useState, useCallback } from 'react'
import { normalizeBaseUrl } from '../lib/api'
import { useStore, exportData, importData, clearAllData } from '../store'
import { DEFAULT_IMAGES_MODEL, DEFAULT_RESPONSES_MODEL, DEFAULT_SETTINGS, type AppSettings } from '../types'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { syncWithWebDav, testWebDavDirectory } from '../lib/webdavSync'
import Select from './Select'

export default function SettingsModal() {
  const showSettings = useStore((s) => s.showSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const importInputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [timeoutInput, setTimeoutInput] = useState(String(settings.timeout))
  const [showApiKey, setShowApiKey] = useState(false)

  const getDefaultModelForMode = (apiMode: AppSettings['apiMode']) =>
    apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL

  useEffect(() => {
    if (showSettings) {
      setDraft(settings)
      setTimeoutInput(String(settings.timeout))
    }
  }, [showSettings, settings])

  const commitSettings = (nextDraft: AppSettings) => {
    const apiMode = nextDraft.apiMode === 'responses' ? 'responses' : DEFAULT_SETTINGS.apiMode
    const storageMode = nextDraft.storageMode === 'webdav' ? 'webdav' : DEFAULT_SETTINGS.storageMode
    const defaultModel = getDefaultModelForMode(apiMode)
    const normalizedDraft = {
      ...nextDraft,
      apiMode,
      storageMode,
      baseUrl: normalizeBaseUrl(nextDraft.baseUrl.trim() || DEFAULT_SETTINGS.baseUrl),
      apiKey: nextDraft.apiKey,
      model: nextDraft.model.trim() || defaultModel,
      timeout: Number(nextDraft.timeout) || DEFAULT_SETTINGS.timeout,
      webdav: {
        ...DEFAULT_SETTINGS.webdav,
        ...nextDraft.webdav,
      },
    }
    setDraft(normalizedDraft)
    setSettings(normalizedDraft)
  }

  const handleClose = () => {
    const nextTimeout = Number(timeoutInput)
    commitSettings({
      ...draft,
      timeout:
        timeoutInput.trim() === '' || Number.isNaN(nextTimeout)
          ? DEFAULT_SETTINGS.timeout
          : nextTimeout,
    })
    setShowSettings(false)
  }

  const commitTimeout = useCallback(() => {
    const nextTimeout = Number(timeoutInput)
    const normalizedTimeout =
      timeoutInput.trim() === '' ? DEFAULT_SETTINGS.timeout : Number.isNaN(nextTimeout) ? draft.timeout : nextTimeout
    setTimeoutInput(String(normalizedTimeout))
    commitSettings({ ...draft, timeout: normalizedTimeout })
  }, [draft, timeoutInput])

  useCloseOnEscape(showSettings, handleClose)

  if (!showSettings) return null

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) importData(file)
    e.target.value = ''
  }

  const handleSyncNow = async () => {
    try {
      await syncWithWebDav()
    } catch (err) {
      useStore.getState().showToast(
        `WebDAV 同步失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  const handleTestDirectory = async () => {
    try {
      await testWebDavDirectory()
    } catch (err) {
      useStore.getState().showToast(
        `WebDAV 目录测试失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in"
        onClick={handleClose}
      />
      <div
        className="relative z-10 w-full max-w-md rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10 overflow-y-auto max-h-[85vh] custom-scrollbar"
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            设置
          </h3>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 dark:text-gray-500 font-mono select-none">v{__APP_VERSION__}</span>
            <button
              onClick={handleClose}
              className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label="关闭"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="space-y-6">
          <section>
            <h4 className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
              <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              API 配置
            </h4>
            <div className="space-y-4">
              <label className="block">
                <div className="mb-1 flex items-center justify-between">
                  <span className="block text-xs text-gray-500 dark:text-gray-400">API URL</span>
                  <div
                    onClick={(e) => {
                      e.preventDefault()
                      const nextDraft = { ...draft, codexCli: !draft.codexCli }
                      setDraft(nextDraft)
                      commitSettings(nextDraft)
                    }}
                    className="flex cursor-pointer items-center gap-1.5"
                    role="switch"
                    aria-checked={draft.codexCli}
                  >
                    <span className={`text-[10px] transition-colors ${draft.codexCli ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500'}`}>Codex CLI</span>
                    <span className={`relative inline-flex h-3.5 w-6 items-center rounded-full transition-colors ${draft.codexCli ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                      <span className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white shadow transition-transform ${draft.codexCli ? 'translate-x-[11px]' : 'translate-x-[2px]'}`} />
                    </span>
                  </div>
                </div>
                <input
                  value={draft.baseUrl}
                  onChange={(e) => setDraft((prev) => ({ ...prev, baseUrl: e.target.value }))}
                  onBlur={(e) => commitSettings({ ...draft, baseUrl: e.target.value })}
                  type="text"
                  placeholder={DEFAULT_SETTINGS.baseUrl}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
                <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                  支持通过查询参数覆盖：<code className="bg-gray-100 dark:bg-white/[0.06] px-1 py-0.5 rounded">?apiUrl=</code>，<code className="bg-gray-100 dark:bg-white/[0.06] px-1 py-0.5 rounded">codexCli=true</code>
                </div>
              </label>

              <div className="block">
                <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API Key</span>
                <div className="relative">
                  <input
                    value={draft.apiKey}
                    onChange={(e) => setDraft((prev) => ({ ...prev, apiKey: e.target.value }))}
                    onBlur={(e) => commitSettings({ ...draft, apiKey: e.target.value })}
                    type={showApiKey ? 'text' : 'password'}
                    placeholder="sk-..."
                    className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 pr-10 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 transition-colors"
                    tabIndex={-1}
                  >
                    {showApiKey ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                        <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    )}
                  </button>
                </div>
                <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                  支持通过查询参数覆盖：<code className="bg-gray-100 dark:bg-white/[0.06] px-1 py-0.5 rounded">?apiKey=</code>
                </div>
              </div>

              <label className="block">
                <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">存储模式</span>
                <Select
                  value={draft.storageMode ?? DEFAULT_SETTINGS.storageMode}
                  onChange={(value) => {
                    const storageMode: AppSettings['storageMode'] = value === 'webdav' ? 'webdav' : 'local'
                    const nextDraft: AppSettings = { ...draft, storageMode }
                    setDraft(nextDraft)
                    commitSettings(nextDraft)
                  }}
                  options={[
                    { label: '本地存储（IndexedDB）', value: 'local' },
                    { label: '远端同步（WebDAV）', value: 'webdav' },
                  ]}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
                <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                  选择 WebDAV 后，设置和图片快照会按远端地址同步；本地仍保留一份缓存。页面回到前台、重新联网，以及停留期间会自动检测并补同步。
                </div>
              </label>

              {draft.storageMode === 'webdav' && (
                <div className="space-y-4 rounded-2xl border border-dashed border-blue-200/70 bg-blue-50/40 p-4 dark:border-blue-500/20 dark:bg-blue-500/10">
                  <label className="block">
                    <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">WebDAV 快照地址</span>
                    <input
                      value={draft.webdav.url}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          webdav: { ...prev.webdav, url: e.target.value },
                        }))
                      }
                      onBlur={(e) =>
                        commitSettings({
                          ...draft,
                          webdav: { ...draft.webdav, url: e.target.value },
                        })
                      }
                      type="text"
                      placeholder="https://dav.example.com/path/gptimage/"
                      className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                    />
                    <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                      这里填写 WebDAV 目录地址，程序会在其下读写 <code className="bg-gray-100 dark:bg-white/[0.06] px-1 py-0.5 rounded">manifest.json</code> 和图片文件。
                    </div>
                  </label>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block">
                      <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">用户名</span>
                      <input
                        value={draft.webdav.username}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            webdav: { ...prev.webdav, username: e.target.value },
                          }))
                        }
                        onBlur={(e) =>
                          commitSettings({
                            ...draft,
                            webdav: { ...draft.webdav, username: e.target.value },
                          })
                        }
                        type="text"
                        placeholder="username"
                        className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                      />
                    </label>
                    <label className="block">
                      <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">密码</span>
                      <input
                        value={draft.webdav.password}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            webdav: { ...prev.webdav, password: e.target.value },
                          }))
                        }
                        onBlur={(e) =>
                          commitSettings({
                            ...draft,
                            webdav: { ...draft.webdav, password: e.target.value },
                          })
                        }
                        type="password"
                        placeholder="password"
                        className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                      />
                    </label>
                  </div>

                  <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={draft.webdav.syncOnStartup}
                      onChange={(e) => {
                        const nextDraft = {
                          ...draft,
                          webdav: { ...draft.webdav, syncOnStartup: e.target.checked },
                        }
                        setDraft(nextDraft)
                        commitSettings(nextDraft)
                      }}
                      className="h-4 w-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500 dark:border-white/[0.12]"
                    />
                    启动时自动同步
                  </label>
                  <div className="-mt-2 text-[10px] text-gray-400 dark:text-gray-500">
                    开启后，首次打开页面会自动同步；后续本地生成、删除、导入等变更会延迟自动推送，前台页面也会定时检查远端更新。
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleTestDirectory}
                      className="flex-1 rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]"
                      disabled={!draft.webdav.url.trim()}
                    >
                      测试目录
                    </button>
                    <button
                      type="button"
                      onClick={handleSyncNow}
                      className="flex-1 rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:opacity-50"
                      disabled={!draft.webdav.url.trim()}
                    >
                      立即同步
                    </button>
                  </div>
                </div>
              )}

              <label className="block">
                <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API 接口</span>
                <Select
                  value={draft.apiMode ?? DEFAULT_SETTINGS.apiMode}
                  onChange={(value) => {
                    const apiMode = value as AppSettings['apiMode']
                    const nextModel =
                      draft.model === DEFAULT_IMAGES_MODEL || draft.model === DEFAULT_RESPONSES_MODEL
                        ? getDefaultModelForMode(apiMode)
                        : draft.model
                    const nextDraft = { ...draft, apiMode, model: nextModel }
                    setDraft(nextDraft)
                    commitSettings(nextDraft)
                  }}
                  options={[
                    { label: 'Images API (/v1/images)', value: 'images' },
                    { label: 'Responses API (/v1/responses)', value: 'responses' },
                  ]}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
                <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                  支持通过查询参数覆盖：<code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">apiMode=images</code> 或 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">apiMode=responses</code>。
                </div>
              </label>

              <label className="block">
                <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                  模型 ID
                </span>
                <input
                  value={draft.model}
                  onChange={(e) => setDraft((prev) => ({ ...prev, model: e.target.value }))}
                  onBlur={(e) => commitSettings({ ...draft, model: e.target.value })}
                  type="text"
                  placeholder={getDefaultModelForMode(draft.apiMode ?? DEFAULT_SETTINGS.apiMode)}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
                <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                  {(draft.apiMode ?? DEFAULT_SETTINGS.apiMode) === 'responses' ? (
                    <>Responses API 需要使用支持 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">image_generation</code> 工具的文本模型，例如 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{DEFAULT_RESPONSES_MODEL}</code>。</>
                  ) : (
                    <>Images API 需要使用 GPT Image 模型，例如 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{DEFAULT_IMAGES_MODEL}</code>。</>
                  )}
                </div>
              </label>

              <label className="block">
                <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">请求超时 (秒)</span>
                <input
                  value={timeoutInput}
                  onChange={(e) => setTimeoutInput(e.target.value)}
                  onBlur={commitTimeout}
                  type="number"
                  min={10}
                  max={600}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </label>
            </div>
          </section>

          <section className="pt-6 border-t border-gray-100 dark:border-white/[0.08]">
            <h4 className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
              <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
              </svg>
              数据管理
            </h4>
            <div className="space-y-3">
              <div className="flex gap-2">
                <button
                  onClick={() => exportData()}
                  className="flex-1 rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm text-gray-600 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] flex items-center justify-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  导出
                </button>
                <button
                  onClick={() => importInputRef.current?.click()}
                  className="flex-1 rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm text-gray-600 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] flex items-center justify-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  导入
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={handleImport}
                />
              </div>
              <button
                onClick={() =>
                  setConfirmDialog({
                    title: '清空所有数据',
                    message: '确定要清空所有任务记录和图片数据吗？此操作不可恢复。',
                    action: () => clearAllData(),
                  })
                }
                className="w-full rounded-xl border border-red-200/80 bg-red-50/50 px-4 py-2.5 text-sm text-red-500 transition hover:bg-red-100/80 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
              >
                清空所有数据
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
