import { useEffect, useRef, useState, useCallback } from 'react'
import { normalizeBaseUrl } from '../lib/api'
import { isApiProxyAvailable, readClientDevProxyConfig } from '../lib/devProxy'
import { useStore, exportData, importData, clearAllData } from '../store'
import {
  createDefaultFalProfile,
  createDefaultOaiProfile,
  DEFAULT_FAL_BASE_URL,
  DEFAULT_FAL_MODEL,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_RESPONSES_MODEL,
  DEFAULT_SETTINGS,
  getActiveApiProfile,
  normalizeSettings,
  type ApiProfile,
  type AppSettings,
} from '../types'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import Select from './Select'

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function cloneProfile(profile: ApiProfile): ApiProfile {
  return {
    ...profile,
    id: newId(profile.provider),
    name: `${profile.name} 副本`,
  }
}

function providerLabel(profile: ApiProfile) {
  return profile.provider === 'fal' ? 'fal.ai' : 'OAI-like'
}

export default function SettingsModal() {
  const showSettings = useStore((s) => s.showSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const importInputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<AppSettings>(normalizeSettings(settings))
  const [editingProfileId, setEditingProfileId] = useState(getActiveApiProfile(settings).id)
  const [timeoutInput, setTimeoutInput] = useState(String(getActiveApiProfile(settings).timeout))
  const [showApiKey, setShowApiKey] = useState(false)
  const apiProxyAvailable = isApiProxyAvailable(readClientDevProxyConfig())
  const editingProfile = draft.profiles.find((profile) => profile.id === editingProfileId) ?? getActiveApiProfile(draft)
  const apiProxyEnabled = apiProxyAvailable && editingProfile.provider === 'oai-like' && editingProfile.apiProxy

  const getDefaultModelForMode = (apiMode: AppSettings['apiMode']) =>
    apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL

  // 只在弹窗打开时同步一次，避免保存设置后重置正在编辑的 Provider
  const wasSettingsOpenRef = useRef(false)

  useEffect(() => {
    if (!showSettings) {
      wasSettingsOpenRef.current = false
      return
    }
    if (wasSettingsOpenRef.current) return

    wasSettingsOpenRef.current = true
    const nextDraft = normalizeSettings(apiProxyAvailable ? settings : {
      ...settings,
      profiles: settings.profiles.map((profile) => ({ ...profile, apiProxy: false })),
    })
    setDraft(nextDraft)
    const activeProfile = getActiveApiProfile(nextDraft)
    setEditingProfileId(activeProfile.id)
    setTimeoutInput(String(activeProfile.timeout))
  }, [apiProxyAvailable, showSettings, settings])

  useEffect(() => {
    setTimeoutInput(String(editingProfile.timeout))
  }, [editingProfile.id, editingProfile.timeout])

  const commitSettings = (nextDraft: AppSettings) => {
    const normalizedProfiles = nextDraft.profiles.map((profile) => {
      const normalizedBaseUrl = profile.provider === 'fal'
        ? profile.baseUrl.trim().replace(/\/+$/, '') || DEFAULT_FAL_BASE_URL
        : normalizeBaseUrl(profile.baseUrl.trim() || DEFAULT_SETTINGS.baseUrl)
      const defaultModel = profile.provider === 'fal' ? DEFAULT_FAL_MODEL : getDefaultModelForMode(profile.apiMode)
      return {
        ...profile,
        name: profile.name.trim() || providerLabel(profile),
        baseUrl: normalizedBaseUrl,
        model: profile.model.trim() || defaultModel,
        timeout: Number(profile.timeout) || DEFAULT_SETTINGS.timeout,
        apiProxy: profile.provider === 'oai-like' && apiProxyAvailable ? profile.apiProxy : false,
        codexCli: profile.provider === 'oai-like' ? profile.codexCli : false,
      }
    })
    const fallbackProfile = createDefaultOaiProfile({ id: newId('oai') })
    const normalizedDraft = normalizeSettings({
      ...nextDraft,
      profiles: normalizedProfiles.length ? normalizedProfiles : [fallbackProfile],
      activeProfileId: normalizedProfiles.some((profile) => profile.id === nextDraft.activeProfileId)
        ? nextDraft.activeProfileId
        : (normalizedProfiles[0]?.id ?? fallbackProfile.id),
    })
    setDraft(normalizedDraft)
    setSettings(normalizedDraft)
  }

  const updateProfile = (profileId: string, patch: Partial<ApiProfile>, commit = false) => {
    const nextDraft = normalizeSettings({
      ...draft,
      profiles: draft.profiles.map((profile) => profile.id === profileId ? { ...profile, ...patch } : profile),
    })
    setDraft(nextDraft)
    if (commit) commitSettings(nextDraft)
  }

  const handleClose = () => {
    const nextTimeout = Number(timeoutInput)
    const normalizedTimeout =
      timeoutInput.trim() === '' || Number.isNaN(nextTimeout)
        ? DEFAULT_SETTINGS.timeout
        : nextTimeout
    const nextDraft = normalizeSettings({
      ...draft,
      profiles: draft.profiles.map((profile) =>
        profile.id === editingProfile.id ? { ...profile, timeout: normalizedTimeout } : profile,
      ),
    })
    commitSettings(nextDraft)
    setShowSettings(false)
  }

  const commitTimeout = useCallback(() => {
    const nextTimeout = Number(timeoutInput)
    const normalizedTimeout =
      timeoutInput.trim() === '' ? DEFAULT_SETTINGS.timeout : Number.isNaN(nextTimeout) ? editingProfile.timeout : nextTimeout
    setTimeoutInput(String(normalizedTimeout))
    updateProfile(editingProfile.id, { timeout: normalizedTimeout }, true)
  }, [draft, editingProfile.id, editingProfile.timeout, timeoutInput])

  useCloseOnEscape(showSettings, handleClose)

  if (!showSettings) return null

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) importData(file)
    e.target.value = ''
  }

  const addProfile = (provider: ApiProfile['provider']) => {
    const profile = provider === 'fal'
      ? createDefaultFalProfile({ id: newId('fal') })
      : createDefaultOaiProfile({ id: newId('oai'), name: 'OAI-like 中转站' })
    const nextDraft = normalizeSettings({ ...draft, profiles: [...draft.profiles, profile] })
    setEditingProfileId(profile.id)
    commitSettings(nextDraft)
  }

  const removeProfile = (profile: ApiProfile) => {
    if (draft.profiles.length <= 1) return
    const nextProfiles = draft.profiles.filter((item) => item.id !== profile.id)
    const nextDraft = normalizeSettings({
      ...draft,
      profiles: nextProfiles,
      activeProfileId: draft.activeProfileId === profile.id ? nextProfiles[0].id : draft.activeProfileId,
    })
    setEditingProfileId(nextDraft.activeProfileId)
    commitSettings(nextDraft)
  }

  return (
    <div data-no-drag-select className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in"
        onClick={handleClose}
      />
      <div
        className="relative z-10 w-full max-w-4xl rounded-3xl border border-white/50 bg-white p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 dark:ring-white/10 overflow-y-auto max-h-[85vh] custom-scrollbar"
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
            <div className="mb-4 flex items-center justify-between gap-3">
              <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                API 配置
              </h4>
              <div className="flex gap-2">
                <button onClick={() => addProfile('oai-like')} className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs text-gray-600 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]">+ OAI-like</button>
                <button onClick={() => addProfile('fal')} className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs text-gray-600 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]">+ fal.ai</button>
              </div>
            </div>

            <div className="grid gap-5 md:grid-cols-[260px_1fr]">
              <div className="space-y-2">
                {draft.profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => setEditingProfileId(profile.id)}
                    className={`w-full rounded-xl border px-3 py-2 text-left transition ${profile.id === editingProfile.id ? 'border-blue-200 bg-blue-50/60 dark:border-blue-500/30 dark:bg-blue-500/10' : 'border-gray-200/70 bg-white/50 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:bg-white/[0.06]'}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{profile.name}</div>
                        <div className="mt-0.5 truncate text-[11px] text-gray-400 dark:text-gray-500">{providerLabel(profile)} · {profile.model}</div>
                      </div>
                      {profile.id === draft.activeProfileId && <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-[10px] text-green-700 dark:bg-green-500/15 dark:text-green-300">当前</span>}
                    </div>
                  </button>
                ))}
              </div>

              <div className="min-w-0">
                <div className="mb-4 flex items-center justify-between gap-2 border-t border-gray-100 pt-4 md:border-t-0 md:pt-0 dark:border-white/[0.08]">
              <div>
                <div className="text-sm font-medium text-gray-800 dark:text-gray-100">编辑 Provider</div>
                <div className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{editingProfile.name}</div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => { const copied = cloneProfile(editingProfile); const nextDraft = normalizeSettings({ ...draft, profiles: [...draft.profiles, copied] }); setEditingProfileId(copied.id); commitSettings(nextDraft) }} className="rounded-lg bg-gray-100 px-2 py-1 text-xs text-gray-600 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]">复制</button>
                <button type="button" onClick={() => commitSettings({ ...draft, activeProfileId: editingProfile.id })} className="rounded-lg bg-gray-100 px-2 py-1 text-xs text-gray-600 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]">设为当前</button>
                <button type="button" disabled={draft.profiles.length <= 1} onClick={() => setConfirmDialog({ title: '删除 Provider', message: `确定删除「${editingProfile.name}」吗？`, action: () => removeProfile(editingProfile) })} className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-500 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-red-500/10 dark:text-red-300">删除</button>
              </div>
            </div>

            <div className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">名称</span>
                <input value={editingProfile.name} onChange={(e) => updateProfile(editingProfile.id, { name: e.target.value })} onBlur={() => commitSettings(draft)} className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50" />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Provider 类型</span>
                <Select value={editingProfile.provider} onChange={(value) => { const provider = value as ApiProfile['provider']; const nextPatch: Partial<ApiProfile> = provider === 'fal' ? { provider, baseUrl: DEFAULT_FAL_BASE_URL, model: DEFAULT_FAL_MODEL, apiMode: 'images', codexCli: false, apiProxy: false } : { provider, baseUrl: DEFAULT_SETTINGS.baseUrl, model: DEFAULT_IMAGES_MODEL }; updateProfile(editingProfile.id, nextPatch, true) }} options={[{ label: 'OAI-like / new-api', value: 'oai-like' }, { label: 'fal.ai', value: 'fal' }]} className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50" />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">API URL</span>
                <input value={editingProfile.baseUrl} onChange={(e) => updateProfile(editingProfile.id, { baseUrl: e.target.value })} onBlur={() => commitSettings(draft)} disabled={apiProxyEnabled} placeholder={editingProfile.provider === 'fal' ? DEFAULT_FAL_BASE_URL : DEFAULT_SETTINGS.baseUrl} className={`w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50 ${apiProxyEnabled ? 'opacity-50 cursor-not-allowed' : ''}`} />
                <div data-selectable-text className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">{editingProfile.provider === 'fal' ? <>fal.ai 使用官方 SDK 调用 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{editingProfile.model || DEFAULT_FAL_MODEL}</code>。</> : <>适用于 OpenAI 官方、new-api、one-api 等兼容 /v1/images 或 /v1/responses 的服务。</>}</div>
              </label>

              <div className="block">
                <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API Key</span>
                <div className="relative">
                  <input value={editingProfile.apiKey} onChange={(e) => updateProfile(editingProfile.id, { apiKey: e.target.value })} onBlur={() => commitSettings(draft)} type={showApiKey ? 'text' : 'password'} placeholder={editingProfile.provider === 'fal' ? 'FAL_KEY' : 'sk-... / new-api key'} className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 pr-10 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50" />
                  <button type="button" onClick={() => setShowApiKey((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 transition-colors" tabIndex={-1}>
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
              </div>

              {editingProfile.provider === 'oai-like' && (
                <>
                  <label className="block">
                    <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API 接口</span>
                    <Select value={editingProfile.apiMode} onChange={(value) => { const apiMode = value as AppSettings['apiMode']; const nextModel = editingProfile.model === DEFAULT_IMAGES_MODEL || editingProfile.model === DEFAULT_RESPONSES_MODEL ? getDefaultModelForMode(apiMode) : editingProfile.model; updateProfile(editingProfile.id, { apiMode, model: nextModel }, true) }} options={[{ label: 'Images API (/v1/images)', value: 'images' }, { label: 'Responses API (/v1/responses)', value: 'responses' }]} className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50" />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <button type="button" onClick={() => updateProfile(editingProfile.id, { codexCli: !editingProfile.codexCli }, true)} className={`rounded-xl border px-3 py-2 text-left text-xs transition ${editingProfile.codexCli ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300' : 'border-gray-200 bg-white/60 text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400'}`}>Codex CLI：{editingProfile.codexCli ? '开' : '关'}</button>
                    {apiProxyAvailable && <button type="button" onClick={() => updateProfile(editingProfile.id, { apiProxy: !editingProfile.apiProxy }, true)} className={`rounded-xl border px-3 py-2 text-left text-xs transition ${editingProfile.apiProxy ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300' : 'border-gray-200 bg-white/60 text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400'}`}>API 代理：{editingProfile.apiProxy ? '开' : '关'}</button>}
                  </div>
                </>
              )}

              <label className="block">
                <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">模型 ID</span>
                <input value={editingProfile.model} onChange={(e) => updateProfile(editingProfile.id, { model: e.target.value })} onBlur={() => commitSettings(draft)} placeholder={editingProfile.provider === 'fal' ? DEFAULT_FAL_MODEL : getDefaultModelForMode(editingProfile.apiMode)} className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50" />
                <div data-selectable-text className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">{editingProfile.provider === 'fal' ? <>当前适配 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">openai/gpt-image-2</code>，支持文生图、参考图编辑和 mask edit。</> : <>OAI-like 可填写 GPT Image 模型或支持 image_generation 工具的 Responses 模型。</>}</div>
              </label>

              <label className="block">
                <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">请求超时 (秒)</span>
                <input value={timeoutInput} onChange={(e) => setTimeoutInput(e.target.value)} onBlur={commitTimeout} type="number" min={10} max={600} className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50" />
              </label>
              </div>
            </div>
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
                <button onClick={() => exportData()} className="flex-1 rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm text-gray-600 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] flex items-center justify-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  导出
                </button>
                <button onClick={() => importInputRef.current?.click()} className="flex-1 rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm text-gray-600 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] flex items-center justify-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  导入
                </button>
                <input ref={importInputRef} type="file" accept=".zip" className="hidden" onChange={handleImport} />
              </div>
              <button onClick={() => setConfirmDialog({ title: '清空所有数据', message: '确定要清空所有任务记录和图片数据吗？此操作不可恢复。', action: () => clearAllData() })} className="w-full rounded-xl border border-red-200/80 bg-red-50/50 px-4 py-2.5 text-sm text-red-500 transition hover:bg-red-100/80 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20">
                清空所有数据
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
