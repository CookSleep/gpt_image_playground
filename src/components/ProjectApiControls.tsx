import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { extractBalance, fetchApiKeys, fetchBalance, type ApiKeyItem } from '../auth/oidcResource'
import { useStore } from '../store'
import { readCachedApiKey, writeCachedApiKey } from '../lib/oidcApiKeySelection'
import Select from './Select'
import { KeyIcon } from './icons'

const API_KEY_ICON = (
  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
    <KeyIcon className="h-4 w-4" />
  </span>
)
const COMPACT_API_KEY_ICON = (
  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-emerald-600 dark:text-emerald-300">
    <KeyIcon className="h-3.5 w-3.5" />
  </span>
)

export function ProjectApiKeySelect({ scope = 'gallery', compact = false, iconOnly = false }: { scope?: 'gallery' | 'agent'; compact?: boolean; iconOnly?: boolean } = {}) {
  const { user } = useAuth()
  const oidcApiOverride = useStore((s) => scope === 'agent' ? s.agentOidcApiOverride : s.oidcApiOverride)
  const setOidcApiOverride = useStore((s) => scope === 'agent' ? s.setAgentOidcApiOverride : s.setOidcApiOverride)
  const [apiKeys, setApiKeys] = useState<string[]>([])
  const [apiKeyItems, setApiKeyItems] = useState<ApiKeyItem[]>([])
  const [apiKey, setApiKey] = useState('')
  const [apiKeysLoading, setApiKeysLoading] = useState(false)
  const [apiKeysError, setApiKeysError] = useState('')
  const compactOptions = compact && !iconOnly
  const selectedKeyItem = apiKeyItems.find((item) => item.key === apiKey)
  const selectedKeyLabelRaw = selectedKeyItem?.name || selectedKeyItem?.groupName || (apiKey ? apiKey.slice(0, 8) : 'API Key')
  const selectedKeyLabelChars = Array.from(selectedKeyLabelRaw)
  const iconOnlyLabel = selectedKeyLabelChars.length > 5
    ? `${selectedKeyLabelChars.slice(0, 5).join('')}...`
    : selectedKeyLabelRaw

  const apiKeyOptions = useMemo(() => {
    if (apiKeys.length === 0) {
      return [{
        label: compactOptions
          ? apiKeysLoading ? '加载中' : apiKeysError ? '加载失败' : '无可用 Key'
          : apiKeysLoading ? '正在加载 API Key' : apiKeysError ? 'API Key 加载失败' : '没有可用的 API Key',
        value: '',
        ...(!compactOptions ? { description: apiKeysError || '请检查 OIDC Provider 账户' } : {}),
        icon: compactOptions ? COMPACT_API_KEY_ICON : API_KEY_ICON,
      }]
    }

    return [
      {
        label: compactOptions ? 'API Key' : '选择 API Key',
        value: '',
        ...(compactOptions ? {} : { description: '用于生成请求' }),
        icon: compactOptions ? COMPACT_API_KEY_ICON : API_KEY_ICON,
      },
      ...apiKeys.map((key) => {
        const item = apiKeyItems.find((candidate) => candidate.key === key)
        const keyPreview = key.length > 12 ? `${key.slice(0, 5)}…${key.slice(-4)}` : key
        const label = compactOptions ? (item?.name || keyPreview) : (item?.name || item?.groupName || 'API Key')
        const description = [item?.name ? item.groupName : '', keyPreview].filter(Boolean).join(' · ')
        return {
          label,
          value: key,
          ...(compactOptions ? {} : { description }),
          icon: compactOptions ? COMPACT_API_KEY_ICON : API_KEY_ICON,
        }
      }),
    ]
  }, [apiKeyItems, apiKeys, apiKeysError, apiKeysLoading, compactOptions])

  useEffect(() => {
    if (!user) {
      setApiKeys([])
      setApiKeyItems([])
      setApiKey('')
      setApiKeysError('')
      setApiKeysLoading(false)
      return
    }

    let cancelled = false
    setApiKeysLoading(true)
    setApiKeysError('')
    void fetchApiKeys(scope === 'agent' ? 'agent' : 'image').then((res) => {
      if (cancelled) return
      const keys = res.sub2api_apikeys || []
      setApiKeys(keys)
      setApiKeyItems(res.items || [])
      const current = oidcApiOverride?.apiKey
      const cached = readCachedApiKey(user.id, scope)
      setApiKey(current && keys.includes(current) ? current : cached && keys.includes(cached) ? cached : '')
    }).catch((err) => {
      if (cancelled) return
      setApiKeys([])
      setApiKeyItems([])
      setApiKey('')
      setApiKeysError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      if (!cancelled) setApiKeysLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [oidcApiOverride?.apiKey, scope, user])

  useEffect(() => {
    if (!apiKey) return
    const current = scope === 'agent'
      ? useStore.getState().agentOidcApiOverride
      : useStore.getState().oidcApiOverride
    const platform = apiKeyItems.find((item) => item.key === apiKey)?.platform
    if (current?.apiKey === apiKey && current.platform === platform) return
    setOidcApiOverride({
      ...(current?.model ? { model: current.model } : {}),
      apiKey,
      ...(platform ? { platform } : {}),
    })
  }, [apiKey, apiKeyItems, scope, setOidcApiOverride])

  const handleApiKeyChange = (value: string) => {
    setApiKey(value)
    writeCachedApiKey(user?.id, value, scope)
    const current = scope === 'agent'
      ? useStore.getState().agentOidcApiOverride
      : useStore.getState().oidcApiOverride
    const platform = apiKeyItems.find((item) => item.key === value)?.platform
    setOidcApiOverride({
      ...(current?.model ? { model: current.model } : {}),
      ...(value ? { apiKey: value } : {}),
      ...(platform ? { platform } : {}),
    })
  }

  return (
    <div className={iconOnly ? 'min-w-0 w-28 shrink-0 mr-1.5' : compact ? 'min-w-0 w-28 shrink-0 sm:w-36' : 'min-w-0 w-28 shrink-0 sm:w-48'}>
      <Select
        value={apiKey}
        onChange={(value) => handleApiKeyChange(String(value))}
        disabled={apiKeysLoading || apiKeys.length === 0}
        options={apiKeyOptions}
        className={iconOnly
          ? 'h-8 w-28 rounded-lg border border-transparent bg-emerald-50 pl-2 pr-3 text-[11px] font-medium text-emerald-700 shadow-none transition hover:bg-emerald-100 dark:border-transparent dark:bg-emerald-400/10 dark:text-emerald-300 dark:hover:bg-emerald-400/20'
          : compact
          ? 'h-8 rounded-lg border border-gray-200/70 bg-gray-50/80 px-1.5 text-[11px] font-medium leading-4 text-gray-700 shadow-none transition hover:border-gray-300 hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.08]'
          : 'h-[42px] rounded-xl border border-gray-200 bg-white px-2.5 text-xs font-semibold leading-4 text-gray-800 shadow-sm transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-white/[0.06]'}
        menuClassName={iconOnly ? '!left-auto !right-0 !w-64 !py-0' : '!py-0'}
        iconOnly={iconOnly}
        iconOnlyIcon={iconOnly ? COMPACT_API_KEY_ICON : undefined}
        iconOnlyLabel={iconOnly ? iconOnlyLabel : undefined}
        ariaLabel={scope === 'agent' ? '选择 Agent API Key' : '选择 API Key'}
      />
    </div>
  )
}

export function ProjectBalance() {
  const [balance, setBalance] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchBalance()
      .then((data) => {
        if (!cancelled) setBalance(extractBalance(data))
      })
      .catch((err) => {
        if (!cancelled) {
          setBalance('')
          console.warn('[ProjectBalance] fetchBalance failed:', err)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="hidden h-8 shrink-0 items-center gap-1.5 rounded-lg bg-gray-100 px-2.5 text-xs dark:bg-white/[0.05] sm:flex">
      <span className="text-gray-500 dark:text-gray-400">余额</span>
      <span className="font-mono font-medium text-gray-800 dark:text-gray-100">
        {loading ? '加载中...' : balance || '--'}
      </span>
    </div>
  )
}
