import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { extractBalance, fetchApiKeys, fetchUsage, type ApiKeyItem } from '../auth/oidcResource'
import { useStore } from '../store'
import { readCachedApiKey, writeCachedApiKey } from '../lib/oidcApiKeySelection'
import Select from './Select'
import { KeyIcon } from './icons'

const API_KEY_ICON = (
  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
    <KeyIcon className="h-4 w-4" />
  </span>
)

export function ProjectApiKeySelect() {
  const { user } = useAuth()
  const oidcApiOverride = useStore((s) => s.oidcApiOverride)
  const setOidcApiOverride = useStore((s) => s.setOidcApiOverride)
  const [apiKeys, setApiKeys] = useState<string[]>([])
  const [apiKeyItems, setApiKeyItems] = useState<ApiKeyItem[]>([])
  const [apiKey, setApiKey] = useState('')
  const [apiKeysLoading, setApiKeysLoading] = useState(false)
  const [apiKeysError, setApiKeysError] = useState('')

  const apiKeyOptions = useMemo(() => {
    if (apiKeys.length === 0) {
      return [{
        label: apiKeysLoading ? '正在加载 API Key' : apiKeysError ? 'API Key 加载失败' : '没有可用的 API Key',
        value: '',
        description: apiKeysError || '请检查 OIDC Provider 账户',
        icon: API_KEY_ICON,
      }]
    }

    return [
      {
        label: '选择 API Key',
        value: '',
        description: '用于生成请求',
        icon: API_KEY_ICON,
      },
      ...apiKeys.map((key) => {
        const item = apiKeyItems.find((candidate) => candidate.key === key)
        const keyPreview = key.length > 12 ? `${key.slice(0, 5)}…${key.slice(-4)}` : key
        const label = item?.name || item?.groupName || 'API Key'
        const description = [item?.name ? item.groupName : '', keyPreview].filter(Boolean).join(' · ')
        return { label, value: key, description, icon: API_KEY_ICON }
      }),
    ]
  }, [apiKeyItems, apiKeys, apiKeysError, apiKeysLoading])

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
    void fetchApiKeys().then((res) => {
      if (cancelled) return
      const keys = res.sub2api_apikeys || []
      setApiKeys(keys)
      setApiKeyItems(res.items || [])
      const current = oidcApiOverride?.apiKey
      const cached = readCachedApiKey(user.id)
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
  }, [user, oidcApiOverride?.apiKey])

  useEffect(() => {
    if (!apiKey) return
    const current = useStore.getState().oidcApiOverride
    const platform = apiKeyItems.find((item) => item.key === apiKey)?.platform
    if (current?.apiKey === apiKey && current.platform === platform) return
    setOidcApiOverride({
      ...(current?.model ? { model: current.model } : {}),
      apiKey,
      ...(platform ? { platform } : {}),
    })
  }, [apiKey, apiKeyItems, setOidcApiOverride])

  const handleApiKeyChange = (value: string) => {
    setApiKey(value)
    writeCachedApiKey(user?.id, value)
    const current = useStore.getState().oidcApiOverride
    const platform = apiKeyItems.find((item) => item.key === value)?.platform
    setOidcApiOverride({
      ...(current?.model ? { model: current.model } : {}),
      ...(value ? { apiKey: value } : {}),
      ...(platform ? { platform } : {}),
    })
  }

  return (
    <div className="min-w-0 w-28 shrink-0 sm:w-48">
      <Select
        value={apiKey}
        onChange={(value) => handleApiKeyChange(String(value))}
        disabled={apiKeysLoading || apiKeys.length === 0}
        options={apiKeyOptions}
        className="h-[42px] rounded-xl border border-gray-200 bg-white px-2.5 text-xs font-semibold leading-4 text-gray-800 shadow-sm transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-white/[0.06]"
        menuClassName="!py-0"
      />
    </div>
  )
}

export function ProjectBalance() {
  const apiKey = useStore((s) => s.oidcApiOverride?.apiKey || '')
  const [balance, setBalance] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!apiKey) {
      setBalance('')
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    void fetchUsage(apiKey)
      .then((usage) => {
        if (!cancelled) setBalance(extractBalance(usage))
      })
      .catch((err) => {
        if (!cancelled) {
          setBalance('')
          console.warn('[ProjectBalance] fetchUsage failed:', err)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [apiKey])

  return (
    <div className="hidden h-8 shrink-0 items-center gap-1.5 rounded-lg bg-gray-100 px-2.5 text-xs dark:bg-white/[0.05] sm:flex">
      <span className="text-gray-500 dark:text-gray-400">余额</span>
      <span className="font-mono font-medium text-gray-800 dark:text-gray-100">
        {loading ? '加载中...' : balance || '--'}
      </span>
    </div>
  )
}
