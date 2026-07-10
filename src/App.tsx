import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircleIcon, CheckCircleIcon, ChevronRightIcon, ImageIcon, LogOutIcon, RefreshIcon, SparklesIcon } from './components/icons'
import { getGenerationProgress } from './lib/generationProgress'
import { apiRequest, imageUrl, type ApiGeneration, type ApiKeyOption, type ApiUser } from './lib/minimalApi'

const clientLoggedOutKey = 'minimal-image-site-client-logged-out'
const sizeOptions = ['1024x1024', '1024x1536', '1536x1024']
const qualityOptions = ['auto', 'low', 'medium', 'high']
const formatOptions = ['png', 'jpeg', 'webp']

function formatTime(value: string | null) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function statusText(status: ApiGeneration['status']) {
  if (status === 'done') return '已完成'
  if (status === 'running') return '生成中'
  return '失败'
}

function accountName(user: ApiUser) {
  return user.nickname || user.email || user.username
}

function keyLabel(key: ApiKeyOption | null) {
  if (!key) return '未选择'
  return key.groupName ? `${key.name} · ${key.groupName}` : key.name
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function isClientLoggedOut() {
  try {
    return window.localStorage.getItem(clientLoggedOutKey) === '1'
  } catch {
    return false
  }
}

function markClientLoggedOut() {
  try {
    window.localStorage.setItem(clientLoggedOutKey, '1')
  } catch {
    // localStorage may be disabled; server-side logout still runs below.
  }
}

function clearClientLoggedOut() {
  try {
    window.localStorage.removeItem(clientLoggedOutKey)
  } catch {
    // Ignore storage failures so login/logout remains usable.
  }
}

export default function App() {
  const [user, setUser] = useState<ApiUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  async function loadMe() {
    if (isClientLoggedOut()) {
      setUser(null)
      setLoading(false)
      return
    }
    try {
      const payload = await apiRequest<{ user: ApiUser }>('/api/me')
      setUser(payload.user)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  async function logout() {
    markClientLoggedOut()
    setUser(null)
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' })
    } catch {
      // The user should still leave the app even if the backend is restarting.
    }
  }

  function handleAuthed(nextUser: ApiUser) {
    clearClientLoggedOut()
    setUser(nextUser)
  }

  useEffect(() => {
    void loadMe()
  }, [])

  if (loading) {
    return <div className="app-loading">正在进入极简生图...</div>
  }

  if (!user) {
    return <AuthPage message={message} onMessage={setMessage} onAuthed={handleAuthed} />
  }

  if (user.status === 'disabled') {
    return <AccountDisabledPage user={user} onLogout={logout} onRefresh={loadMe} />
  }

  return (
    <div className="minimal-app">
      <header className="app-topbar studio-topbar">
        <div className="brand">
          <div className="brand-mark"><ImageIcon /></div>
          <div>
            <strong>极简生图</strong>
            <span>让创作只保留必要步骤</span>
          </div>
        </div>
        <div className="studio-top-actions">
          <div className="service-status"><i />服务运行正常</div>
          <div className="studio-account-chip">
            <span>{accountName(user).slice(0, 1).toUpperCase()}</span>
            <div><b>{accountName(user)}</b><small>sub2api 账号</small></div>
          </div>
          <button className="topbar-icon-button" onClick={logout} title="退出" aria-label="退出"><LogOutIcon /></button>
        </div>
      </header>
      <GalleryPage user={user} onUserChange={setUser} />
    </div>
  )
}

function AuthPage(props: {
  message: string
  onMessage: (message: string) => void
  onAuthed: (user: ApiUser) => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    props.onMessage('')
    try {
      const payload = await apiRequest<{ user: ApiUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      props.onAuthed(payload.user)
    } catch (err) {
      props.onMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page auth-v3">
      <section className="auth-preview">
        <div className="brand auth-preview-brand">
          <div className="brand-mark"><ImageIcon /></div>
          <div><strong>极简生图</strong><span>Image creation studio</span></div>
        </div>
        <div className="auth-preview-copy">
          <span>FOCUSED IMAGE WORKSPACE</span>
          <h1>专注图片生成，<br />从描述到成图只需一个页面。</h1>
          <p>选择已授权的 API Key，输入画面描述，即可创建图片任务并查看完整生成记录。</p>
        </div>
        <div className="auth-preview-grid">
          <article>
            <div className="auth-preview-image completed"><span><i />已完成 · 38 秒</span></div>
            <div><b>透明香水产品图</b><small>1024×1024 · High</small></div>
          </article>
          <article>
            <div className="auth-preview-image running">
              <span><i />生成中 · 00:27</span>
              <div><b>正在精炼材质与光线</b><i><span /></i></div>
            </div>
            <div><b>未来感随身相机</b><small>预计 30–90 秒</small></div>
          </article>
        </div>
        <div className="auth-feature-list">
          <span><CheckCircleIcon />直接使用 sub2api 已有账号和 API Key</span>
          <span><CheckCircleIcon />API Key 明文仅由服务端读取</span>
          <span><CheckCircleIcon />生成历史仅与当前登录账号关联</span>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-panel-inner">
          <div className="auth-panel-heading">
            <span>ACCOUNT ACCESS</span>
            <h1>登录极简生图</h1>
            <p>使用你的 sub2api 账号进入图片工作台。</p>
          </div>
          <form onSubmit={submit}>
            <label><span>邮箱</span><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="请输入 sub2api 账号邮箱" type="email" autoComplete="email" required /></label>
            <label><span>密码</span><input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="请输入账号密码" type="password" autoComplete="current-password" required /></label>
            <button className="primary full auth-submit" disabled={busy}>{busy ? '正在验证账号…' : '登录并进入工作台'}<ChevronRightIcon /></button>
          </form>
          {props.message ? <div className="inline-message error auth-error"><AlertCircleIcon />{props.message}</div> : null}
          <div className="auth-security-note">
            <span><i />安全说明</span>
            <p>账号认证、API Key 和计费由 sub2api 统一管理。本站不会在浏览器中保存 API Key 明文。</p>
          </div>
        </div>
      </section>
    </main>
  )
}

function AccountDisabledPage(props: { user: ApiUser; onLogout: () => void; onRefresh: () => void }) {
  return (
    <main className="pending-page disabled-v3">
      <section className="pending-box">
        <div className="disabled-icon"><AlertCircleIcon /></div>
        <span className="disabled-eyebrow">ACCOUNT STATUS</span>
        <h1>当前账号不可用</h1>
        <p>该账号目前无法使用图片生成服务。请前往 sub2api 检查账号状态，恢复后重新进入工作台。</p>
        <dl className="disabled-details">
          <div><dt>当前账号</dt><dd>{accountName(props.user)}</dd></div>
          <div><dt>账号状态</dt><dd><span>已停用</span></dd></div>
          <div><dt>处理位置</dt><dd>sub2api 控制台</dd></div>
        </dl>
        <div className="button-row">
          <button className="primary" onClick={props.onRefresh}><RefreshIcon />重新检查账号状态</button>
          <button onClick={props.onLogout}><LogOutIcon />退出登录</button>
        </div>
      </section>
    </main>
  )
}

function GalleryPage(props: { user: ApiUser; onUserChange: (user: ApiUser) => void }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [generations, setGenerations] = useState<ApiGeneration[]>([])
  const [apiKeys, setApiKeys] = useState<ApiKeyOption[]>([])
  const [selectedApiKeyId, setSelectedApiKeyId] = useState('')
  const [selected, setSelected] = useState<ApiGeneration | null>(null)
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState('high')
  const [format, setFormat] = useState('png')
  const [imageCount, setImageCount] = useState(1)
  const [inputImages, setInputImages] = useState<string[]>([])
  const [filter, setFilter] = useState<'all' | ApiGeneration['status']>('all')
  const [busy, setBusy] = useState(false)
  const [keysLoading, setKeysLoading] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const selectedKey = useMemo(
    () => apiKeys.find((item) => item.id === selectedApiKeyId) ?? null,
    [apiKeys, selectedApiKeyId],
  )

  async function refresh() {
    const payload = await apiRequest<{ generations: ApiGeneration[] }>('/api/generations')
    setGenerations(payload.generations)
    const me = await apiRequest<{ user: ApiUser }>('/api/me')
    props.onUserChange(me.user)
  }

  async function refreshKeys() {
    setKeysLoading(true)
    try {
      const payload = await apiRequest<{ keys: ApiKeyOption[] }>('/api/sub2api/keys')
      setApiKeys(payload.keys)
      setSelectedApiKeyId((current) => {
        if (current && payload.keys.some((item) => item.id === current)) return current
        return payload.keys[0]?.id ?? ''
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setKeysLoading(false)
    }
  }

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)))
    void refreshKeys()
  }, [])

  useEffect(() => {
    if (!generations.some((item) => item.status === 'running')) return
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 2500)
    return () => window.clearInterval(timer)
  }, [generations])

  useEffect(() => {
    if (!generations.some((item) => item.status === 'running')) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [generations])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!prompt.trim()) return
    if (!selectedApiKeyId) {
      setError('请先选择 sub2api API Key')
      return
    }
    setBusy(true)
    setError('')
    try {
      const payload = await apiRequest<{ generation: ApiGeneration }>('/api/generations', {
        method: 'POST',
        body: JSON.stringify({
          apiKeyId: selectedApiKeyId,
          prompt,
          inputImages,
          params: { size, quality, output_format: format, n: imageCount },
        }),
      })
      setGenerations((current) => [payload.generation, ...current.filter((item) => item.id !== payload.generation.id)])
      setPrompt('')
      setInputImages([])
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function selectFiles(files: FileList | null) {
    if (!files?.length) return
    const values = await Promise.all(Array.from(files).slice(0, 4).map(fileToDataUrl))
    setInputImages(values)
  }

  const visible = useMemo(() => generations.filter((item) => filter === 'all' || item.status === filter), [generations, filter])
  const selectedGeneration = selected ? generations.find((item) => item.id === selected.id) ?? selected : null
  const doneCount = generations.filter((item) => item.status === 'done').length
  const runningCount = generations.filter((item) => item.status === 'running').length
  const errorCount = generations.filter((item) => item.status === 'error').length

  return (
    <main className="workspace studio-workspace studio-v3">
      <section className="studio-main studio-content">
        <div className="studio-heading">
          <div>
            <span>IMAGE CREATION STUDIO</span>
            <h1>今天想创造什么画面？</h1>
            <p>选择已授权的 Key，描述画面，其余流程交给系统。</p>
          </div>
          <div className="studio-heading-meta"><i />GPT-IMAGE-2</div>
        </div>
        <section className="generator-panel">
          <form className="prompt-form" onSubmit={submit}>
            <section className="prompt-stage">
              <div className="prompt-stage-head">
                <div><h2>画面描述</h2><p>描述主体、环境、光线和构图，可获得更稳定的结果。</p></div>
                <span><i />GPT-IMAGE-2</span>
              </div>
              <div className="prompt-editor">
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={2000} placeholder="例如：浅蓝背景上的极简产品图，柔和自然光，干净构图..." aria-label="提示词" />
                <div><span>提示词仅用于本次图片生成</span><b>{prompt.length} / 2000</b></div>
              </div>
              <div className="reference-strip">
                <span>参考图</span>
                {inputImages.map((item, index) => <img key={item} src={item} alt={`参考图 ${index + 1}`} />)}
                <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => void selectFiles(e.target.files)} />
                <button type="button" className="reference-add" onClick={() => fileInputRef.current?.click()}>+</button>
                {inputImages.length ? <button type="button" className="reference-clear" onClick={() => setInputImages([])}>清空</button> : null}
                <small>最多 4 张</small>
              </div>
            </section>

            <aside className="generation-controls">
              <div className="controls-head"><h2>生成设置</h2><span>前端不显示 Key 明文</span></div>
              <label><span>API Key</span><select className="api-key-select" value={selectedApiKeyId} onChange={(e) => setSelectedApiKeyId(e.target.value)} aria-label="sub2api API Key"><option value="">{keysLoading ? '正在读取 Key...' : '选择 API Key'}</option>{apiKeys.map((item) => <option key={item.id} value={item.id}>{keyLabel(item)}</option>)}</select></label>
              <div className="control-group"><span>画面尺寸</span><div className="segment-options">{sizeOptions.map((item) => <button key={item} type="button" className={size === item ? 'active' : ''} onClick={() => setSize(item)}>{item.replace('x', '×')}</button>)}</div></div>
              <div className="control-group"><span>生成质量</span><div className="segment-options four">{qualityOptions.map((item) => <button key={item} type="button" className={quality === item ? 'active' : ''} onClick={() => setQuality(item)}>{item}</button>)}</div></div>
              <div className="control-row">
                <label><span>输出格式</span><select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="图片格式">{formatOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
                <label><span>图片数量</span><select value={imageCount} onChange={(e) => setImageCount(Number(e.target.value))} aria-label="图片数量">{[1, 2, 3, 4].map((item) => <option key={item} value={item}>{item} 张</option>)}</select></label>
              </div>
              <div className="billing-note"><span>计费方式</span><b>按次（图片）</b></div>
              <button type="submit" className="primary generate-button" disabled={busy || keysLoading || !selectedApiKeyId || !prompt.trim()}><SparklesIcon />{busy ? '提交中...' : '生成图片'}</button>
              {error ? <div className="inline-message error">{error}</div> : null}
            </aside>
          </form>
        </section>

        <section className="gallery-panel">
          <div className="section-head">
            <div><h1>最近创作</h1><p>任务状态、生成时长和结果集中展示，点击图片查看详情和下载。</p></div>
            <div className="gallery-actions">
              <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button>
              <button className={filter === 'done' ? 'active' : ''} onClick={() => setFilter('done')}>已完成</button>
              <button className={filter === 'running' ? 'active' : ''} onClick={() => setFilter('running')}>生成中</button>
              <button className={filter === 'error' ? 'active' : ''} onClick={() => setFilter('error')}>失败</button>
              <button onClick={() => void refresh()}><RefreshIcon />刷新</button>
            </div>
          </div>
          <div className="task-grid">
            {visible.map((item) => {
              const progress = getGenerationProgress(item, now)
              return (
                <article key={item.id} className="task-card" onClick={() => setSelected(item)}>
                  <div className={`thumb ${item.status}`}>
                    {item.images[0] ? <img src={imageUrl(item.images[0].id)} alt={item.prompt} /> : <div className="thumb-placeholder" />}
                    <span className="task-status"><i />{statusText(item.status)}</span>
                    {item.status === 'running' ? <div className="task-running-overlay"><div><span>{progress.hint || '正在生成图片'}</span><b>{progress.timingText}</b></div><i><span /></i></div> : null}
                  </div>
                  <div className="task-body">
                    <b>{item.prompt}</b>
                    <div className="task-meta"><span>{item.apiKeyName || item.model}</span><span>{progress.timingText || formatTime(item.createdAt)}</span></div>
                    {progress.hint ? <p className="task-progress-hint">{progress.hint}</p> : null}
                  </div>
                </article>
              )
            })}
          </div>
          {!visible.length ? (
            <div className="empty-state compact">
              <b>还没有图片</b>
              <span>选择 API Key 并输入提示词，生成后的任务会显示在这里。</span>
            </div>
          ) : null}
        </section>
      </section>
      {selectedGeneration ? <GenerationDetail generation={selectedGeneration} now={now} onClose={() => setSelected(null)} /> : null}
    </main>
  )
}

function GenerationDetail(props: { generation: ApiGeneration; now: number; onClose: () => void }) {
  const firstImage = props.generation.images[0]
  const imageCount = props.generation.images.length || props.generation.params.n || 1
  const progress = getGenerationProgress(props.generation, props.now)

  function download() {
    if (!firstImage) return
    const link = document.createElement('a')
    link.href = imageUrl(firstImage.id)
    link.download = `generation-${props.generation.id}.${props.generation.params.output_format}`
    link.click()
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <section className="detail-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>任务详情</b>
          <button onClick={props.onClose}>关闭</button>
        </header>
        <div className="detail-body">
          <div className="detail-preview">
            <div className="detail-image">{firstImage ? <img src={imageUrl(firstImage.id)} alt={props.generation.prompt} /> : <div className="thumb-placeholder" />}</div>
            <span>{statusText(props.generation.status)}</span>
            <strong>{progress.detailText}</strong>
            {progress.hint ? <small>{progress.hint}</small> : null}
          </div>
          <div className="detail-info">
            <section className="detail-section">
              <h3>提示词</h3>
              <p>{props.generation.prompt}</p>
            </section>
            <section className="detail-section">
              <h3>生成参数</h3>
              <dl>
                <div><dt>API Key</dt><dd>{props.generation.apiKeyName || '-'}</dd></div>
                <div><dt>模型</dt><dd>{props.generation.model}</dd></div>
                <div><dt>尺寸</dt><dd>{props.generation.params.size}</dd></div>
                <div><dt>质量</dt><dd>{props.generation.params.quality}</dd></div>
                <div><dt>格式</dt><dd>{props.generation.params.output_format}</dd></div>
                <div><dt>图片数</dt><dd>{imageCount} 张</dd></div>
                <div><dt>进度</dt><dd>{progress.detailText}</dd></div>
                <div><dt>计费</dt><dd>由 sub2api 处理</dd></div>
              </dl>
            </section>
            {props.generation.error ? <div className="inline-message error">{props.generation.error}</div> : null}
            <div className="button-row">
              <button className="primary" disabled={!firstImage} onClick={download}>下载图片</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
