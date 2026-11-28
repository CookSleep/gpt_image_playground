import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogLayer } from '../../hooks/useDialogLayer'
import type { ApiProfile, CustomProviderDefinition } from '../../types'
import { splitModelList } from '../../lib/apiProfiles'
import { createRequestTimeoutError } from '../../lib/imageApiShared'
import { fetchProviderModels } from '../../lib/providerModels'
import { Checkbox } from '../Checkbox'
import { CloseIcon, SearchIcon } from '../icons'

interface Props {
  mapping?: CustomProviderDefinition['modelList']
  profile: ApiProfile
  onClose: () => void
  onSave: (models: string[]) => void
}

export default function ModelListModal({ profile, mapping, onClose, onSave }: Props) {
  const [catalog, setCatalog] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [textMode, setTextMode] = useState(false)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let closed = false
    const timer = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)
    setError('')
    fetchProviderModels(profile, profile.apiProxy, controller.signal, mapping).then((models) => {
      if (closed) return
      setCatalog(models)
      setDraft(models.join('\n'))
    }).catch((err) => {
      if (closed) return
      const reason = controller.signal.reason ?? err
      console.warn('获取模型列表失败', reason)
      setError(reason instanceof Error ? reason.message : '获取模型列表失败')
    }).finally(() => clearTimeout(timer))
    return () => {
      closed = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [profile, mapping, attempt])

  const selected = new Set(splitModelList(draft.replace(/[\r\n]+/g, ',')))
  const keyword = query.trim().toLowerCase()
  const visible = (catalog ?? []).filter((model) => model.toLowerCase().includes(keyword))
  const changeSelection = (models: string[], checked: boolean) => {
    for (const model of models) {
      if (checked) selected.add(model)
      else selected.delete(model)
    }
    setDraft([...selected].join('\n'))
  }
  const bulkButton = 'rounded-md px-2 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-200/70 dark:text-gray-300 dark:hover:bg-white/10'
  const layer = useDialogLayer(onClose)
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="获取模型列表" data-no-drag-select
      className="fixed inset-0 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[85dvh] w-full max-w-lg flex-col gap-3 rounded-3xl bg-white/95 p-5 text-gray-700 shadow-xl ring-1 ring-black/5 animate-confirm-in dark:bg-gray-900/95 dark:text-gray-200 dark:ring-white/10">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">获取模型列表</h3>
          <button aria-label="关闭" onClick={onClose} className="rounded-full p-1 text-gray-400 hover:text-gray-600"><CloseIcon className="h-5 w-5" /></button>
        </div>
        {error ? (
          <div role="alert" className="custom-scrollbar overflow-auto break-words text-sm">
            {error} <button className="text-blue-500" onClick={() => setAttempt(attempt + 1)}>重试</button>
          </div>
        ) : catalog === null ? <p role="status" className="text-sm">正在获取模型列表…</p> : (
          <>
            <div className="flex shrink-0 gap-5 border-b border-gray-200 dark:border-white/10">
              {['卡片列表', '文本列表'].map((label, i) => (
                <button key={label} aria-pressed={textMode === Boolean(i)} onClick={() => {
                  if (textMode && i === 0) setCatalog([...new Set([...catalog, ...selected])])
                  setTextMode(i === 1)
                }}
                  className="-mb-px border-b-2 border-transparent pb-2 text-sm font-medium text-gray-500 hover:text-gray-800 aria-pressed:border-blue-500 aria-pressed:text-blue-600 dark:text-gray-400 dark:hover:text-white dark:aria-pressed:text-blue-400">{label}</button>
              ))}
            </div>
            {textMode ? (
              <textarea aria-label="模型列表" placeholder="每行一个模型 ID" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)}
                className="custom-scrollbar ios-rounded-scroll-fix [scrollbar-gutter:stable] h-[22rem] min-h-0 resize-none overflow-y-auto rounded-xl border border-gray-200 bg-transparent px-3.5 py-3 font-mono text-sm leading-6 focus:border-blue-400 focus:outline-none dark:border-white/10 dark:focus:border-blue-400" />
            ) : (
              <div className="flex h-[22rem] min-h-0 flex-col gap-2.5">
                <div className="flex shrink-0 items-center gap-2">
                  <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-black/[0.04] px-3 focus-within:ring-2 focus-within:ring-blue-500/20 dark:bg-white/[0.06]">
                    <SearchIcon className="h-4 w-4 shrink-0 text-gray-400" />
                    <input type="search" aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={(e) => setQuery(e.target.value)}
                      className="min-w-0 flex-1 bg-transparent py-2 text-sm placeholder:text-gray-400 focus:outline-none" />
                  </label>
                  <div className="flex shrink-0">
                    <button className={bulkButton} onClick={() => changeSelection(visible, true)}>全选</button>
                    <button className={bulkButton} onClick={() => changeSelection(visible, false)}>清除</button>
                  </div>
                </div>
                <div className="custom-scrollbar [scrollbar-gutter:stable] min-h-0 flex-1 space-y-2 overflow-y-auto">
                  {visible.map((model) => <Checkbox key={model} checked={selected.has(model)} onChange={(checked) => changeSelection([model], checked)}
                    className="min-h-11 break-all rounded-2xl bg-black/[0.04] px-3.5 py-2 transition-colors hover:bg-black/[0.07] has-[:checked]:bg-blue-50 dark:bg-white/[0.06] dark:hover:bg-white/[0.08] dark:has-[:checked]:bg-blue-500/[0.1]" label={model} />)}
                  {!visible.length && <p className="px-3 py-6 text-center text-sm text-gray-500">{query ? '没有匹配的模型' : '供应商未返回模型'}</p>}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">已选 {selected.size} 个模型</span>
              <button disabled={!selected.size} className="rounded-xl bg-blue-500 px-5 py-2 text-sm text-white hover:bg-blue-600 disabled:opacity-50"
                onClick={() => onSave([...selected])}>保存</button>
            </div>
          </>
        )}
      </div>
    </div>,
    layer,
  )
}
