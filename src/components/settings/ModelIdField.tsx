import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ApiProfile } from '../../types'
import { normalizeBaseUrl, shouldUseApiProxy } from '../../lib/devProxy'
import { getDropdownMaxHeight } from '../../lib/dropdown'
import { fetchProviderModelIds, pickImageModelIds } from '../../lib/modelList'
import { ChevronDownIcon } from '../icons'

interface ModelIdFieldProps {
  label: string
  value: string
  placeholder: string
  profile: ApiProfile
  disabled: boolean
  canFetch: boolean
  imageModelsOnly: boolean
  emptyLabel?: string
  onChange: (value: string) => void
  onCommit: (value: string) => void
  children: ReactNode
}

export default function ModelIdField({ label, value, placeholder, profile, disabled, canFetch, imageModelsOnly, emptyLabel, onChange, onCommit, children }: ModelIdFieldProps) {
  const inputId = useId()
  const [fetching, setFetching] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [error, setError] = useState('')
  const [listOpen, setListOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom')
  const [listMaxHeight, setListMaxHeight] = useState(224)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const baseUrl = normalizeBaseUrl(profile.baseUrl)
  const apiKey = profile.apiKey.trim()
  const listId = `${inputId}-models`
  const options = models.length ? [
    ...(emptyLabel ? [{ label: emptyLabel, value: '' }] : []),
    ...models.map((id) => ({ label: id, value: id })),
  ] : []
  const showList = listOpen && options.length > 0 && !disabled

  // 配置变化或关闭设置时取消请求，避免旧接口的结果出现在新配置中。
  useEffect(() => {
    setFetching(false)
    setModels([])
    setError('')
    setListOpen(false)
    setActiveIdx(-1)
    return () => requestRef.current?.abort()
  }, [profile.id, profile.provider, baseUrl, apiKey, profile.apiProxy, profile.apiMode, imageModelsOnly, canFetch, disabled])

  useEffect(() => {
    if (!showList) return
    const updatePosition = () => {
      const input = inputRef.current
      if (!input) return
      const below = getDropdownMaxHeight(input, 224)
      let top = 0
      let parent = input.parentElement
      while (parent && parent !== document.body) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowY}`)) {
          top = Math.max(top, parent.getBoundingClientRect().top)
        }
        parent = parent.parentElement
      }
      const above = Math.max(0, Math.min(224, input.getBoundingClientRect().top - top - 8))
      const openAbove = below < 120 && above > below
      setPlacement(openAbove ? 'top' : 'bottom')
      setListMaxHeight(openAbove ? above : below)
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [showList])

  useEffect(() => {
    if (showList) listRef.current?.children[activeIdx]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIdx, showList])

  const pick = (id: string) => {
    onCommit(id)
    setListOpen(false)
    setActiveIdx(-1)
  }

  const fetchModels = async () => {
    const missing = [
      ...(!profile.baseUrl.trim() && !shouldUseApiProxy(profile.apiProxy) ? ['API URL'] : []),
      ...(!apiKey ? ['API Key'] : []),
    ]
    if (missing.length) {
      setError(`请先填写 ${missing.join(' 和 ')}，再拉取模型`)
      return
    }
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setFetching(true)
    setModels([])
    setError('')
    setListOpen(false)
    setActiveIdx(-1)
    try {
      const ids = await fetchProviderModelIds({
        baseUrl,
        apiKey,
        apiProxy: profile.apiProxy,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setModels(imageModelsOnly ? pickImageModelIds(ids) : ids)
      if (!ids.length) setError('接口没有返回任何模型，请确认该服务商支持 /v1/models')
      if (ids.length) {
        inputRef.current?.focus()
        setListOpen(true)
      }
    } catch (err) {
      if (controller.signal.aborted) return
      console.warn('拉取模型失败：', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!controller.signal.aborted) setFetching(false)
    }
  }

  return (
    <div className="block">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label htmlFor={inputId} className="block text-sm text-gray-600 dark:text-gray-300">{label}</label>
        {canFetch && !disabled && (
          <button
            type="button"
            onMouseDown={(e) => {
              // 地址框失焦时会补回默认值，保留焦点以校验用户当前输入。
              e.preventDefault()
            }}
            onClick={fetchModels}
            disabled={fetching}
            className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-blue-600 transition hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-500/15"
          >
            {fetching && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
            {fetching ? '拉取中' : '拉取模型'}
          </button>
        )}
      </div>
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setListOpen(false)
            setActiveIdx(-1)
          }}
          onFocus={() => setListOpen(true)}
          onBlur={(e) => {
            onCommit(e.target.value)
            setListOpen(false)
            setActiveIdx(-1)
          }}
          onKeyDown={(e) => {
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && options.length) {
              e.preventDefault()
              setListOpen(true)
              setActiveIdx((idx) => e.key === 'ArrowDown' ? (idx + 1) % options.length : (idx <= 0 ? options.length - 1 : idx - 1))
              return
            }
            if (e.key === 'Enter' && showList && activeIdx >= 0) {
              e.preventDefault()
              pick(options[activeIdx].value)
              return
            }
            if (e.key === 'Escape' && showList) {
              e.stopPropagation()
              setListOpen(false)
              setActiveIdx(-1)
            }
          }}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-autocomplete="list"
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={showList && activeIdx >= 0 ? `${listId}-${activeIdx}` : undefined}
          autoComplete="off"
          disabled={disabled}
          placeholder={placeholder}
          className={`w-full rounded-xl border border-transparent bg-black/[0.04] px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:bg-white/[0.06] dark:text-gray-200 dark:focus:border-blue-500/50 ${models.length ? 'pr-10' : ''}`}
        />
        {models.length > 0 && !disabled && (
          <button
            type="button"
            aria-label={`选择${label}`}
            aria-expanded={showList}
            aria-controls={showList ? listId : undefined}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              inputRef.current?.focus()
              setListOpen(!showList)
              setActiveIdx(-1)
            }}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-xl text-gray-400 transition hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          >
            <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${showList ? 'rotate-180' : ''}`} />
          </button>
        )}
        {showList && (
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={`${label}候选模型`}
            className={`custom-scrollbar absolute inset-x-0 z-50 overflow-y-auto rounded-xl bg-white p-1 shadow-lg ring-1 ring-black/5 dark:bg-gray-800 dark:ring-white/10 ${placement === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}
            style={{ maxHeight: listMaxHeight }}
          >
            {options.map((option, idx) => (
              <li
                key={option.value}
                id={`${listId}-${idx}`}
                role="option"
                aria-selected={option.value === value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(option.value)}
                onMouseEnter={() => setActiveIdx(idx)}
                title={option.label}
                className={`cursor-pointer truncate rounded-lg px-3 py-2 text-xs transition-colors ${option.value === value ? 'font-medium text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-200'} ${idx === activeIdx ? 'bg-black/[0.05] dark:bg-white/[0.08]' : 'hover:bg-gray-50 dark:hover:bg-white/[0.06]'}`}
              >
                {option.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <div data-selectable-text role="alert" className="mt-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-500 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}
      {children}
    </div>
  )
}
