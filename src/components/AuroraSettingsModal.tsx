import { useEffect, useState } from 'react'
import { apiRequest, type ApiKeyOption, type ApiSettings } from '../lib/minimalApi'
import { AlertCircleIcon, CheckCircleIcon, CloseIcon, SettingsIcon } from './icons'

function keyLabel(key: ApiKeyOption) {
  return key.groupName ? `${key.name} · ${key.groupName}` : key.name
}

export function AuroraSettingsModal(props: {
  apiKeys: ApiKeyOption[]
  settings: ApiSettings | null
  loading: boolean
  onSaved: (settings: ApiSettings) => void
  onClose: () => void
}) {
  const [imageApiKeyId, setImageApiKeyId] = useState('')
  const [promptApiKeyId, setPromptApiKeyId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setImageApiKeyId(props.settings?.imageApiKeyId ?? '')
    setPromptApiKeyId(props.settings?.promptApiKeyId ?? '')
  }, [props.settings])

  function hasMissingOption(id: string) {
    return Boolean(id && !props.apiKeys.some((key) => key.id === id))
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      const result = await apiRequest<{ settings: ApiSettings }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ imageApiKeyId, promptApiKeyId }),
      })
      props.onSaved(result.settings)
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="aurora-modal-backdrop" onClick={props.onClose}>
      <section className="aurora-settings-modal" role="dialog" aria-modal="true" aria-labelledby="aurora-settings-title" onClick={(event) => event.stopPropagation()}>
        <header><span><SettingsIcon /></span><div><small>CREATION SETTINGS</small><h2 id="aurora-settings-title">创作设置</h2></div><button type="button" onClick={props.onClose} aria-label="关闭"><CloseIcon /></button></header>
        <p className="aurora-settings-intro">为图片生成与提示词优化分别选择 Aurora API Key。浏览器不会获得或保存 Key 明文。</p>
        <label><span>图片生成 Key</span><small>用于调用 gpt-image-2 生成图片</small><select value={imageApiKeyId} onChange={(event) => setImageApiKeyId(event.target.value)} disabled={props.loading}>{hasMissingOption(imageApiKeyId) ? <option value={imageApiKeyId}>已失效或不存在的 Key</option> : null}<option value="">请选择 API Key</option>{props.apiKeys.map((key) => <option key={key.id} value={key.id}>{keyLabel(key)}</option>)}</select></label>
        <label><span>提示词优化 Key</span><small>用于调用 gpt-5.5 优化生图文案</small><select value={promptApiKeyId} onChange={(event) => setPromptApiKeyId(event.target.value)} disabled={props.loading}>{hasMissingOption(promptApiKeyId) ? <option value={promptApiKeyId}>已失效或不存在的 Key</option> : null}<option value="">请选择 API Key</option>{props.apiKeys.map((key) => <option key={key.id} value={key.id}>{keyLabel(key)}</option>)}</select></label>
        {!props.apiKeys.length && !props.loading ? <a className="aurora-console-link" href="https://x.wfjpg.cc/" target="_blank" rel="noreferrer">前往 Aurora 控制台创建 API Key</a> : null}
        {error ? <div className="aurora-settings-error"><AlertCircleIcon />{error}</div> : null}
        <footer><span>{imageApiKeyId && promptApiKeyId ? <><CheckCircleIcon />配置完整</> : '需要选择两个 Key 才能开始创作'}</span><button type="button" disabled={busy || props.loading || !imageApiKeyId || !promptApiKeyId} onClick={() => void save()}>{busy ? '正在保存…' : '保存设置'}</button></footer>
      </section>
    </div>
  )
}
