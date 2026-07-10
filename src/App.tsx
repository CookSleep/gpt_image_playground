import { useEffect, useMemo, useRef, useState } from 'react'
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
      <header className="app-topbar">
        <div className="brand">
          <div className="brand-mark">图</div>
          <div>
            <strong>极简生图</strong>
            <span>只做图片生成</span>
          </div>
        </div>
        <nav>
          <div className="account-pill"><span>sub2api</span><b>{accountName(user)}</b></div>
          <button className="logout-button" onClick={logout}>退出</button>
        </nav>
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
    <main className="auth-page">
      <section className="auth-panel">
        <div className="brand auth-brand">
          <div className="brand-mark">图</div>
          <div>
            <strong>极简生图</strong>
            <span>sub2api 账号入口</span>
          </div>
        </div>
        <h1>登录 sub2api 账号</h1>
        <p>登录后选择你在 sub2api 已创建的 API Key，再生成图片。Key 明文只在后端使用。</p>
        <form onSubmit={submit}>
          <label>邮箱<input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="请输入 sub2api 邮箱" autoComplete="email" /></label>
          <label>密码<input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="请输入密码" type="password" autoComplete="current-password" /></label>
          <button className="primary full" disabled={busy}>{busy ? '登录中...' : '登录'}</button>
        </form>
        {props.message ? <div className="inline-message error">{props.message}</div> : null}
      </section>
      <section className="auth-preview">
        <div className="preview-image" />
        <b>用 sub2api 已有 Key 生成图片</b>
        <div className="preview-meta"><span>前端不显示 API Key</span><span>计费走 sub2api</span></div>
        <div className="pending-card">
          <span>钥</span>
          <div>
            <b>按次(图片)</b>
            <p>本站只负责选择 Key、提交生成和保存历史，账号与计费由 sub2api 统一管理。</p>
          </div>
        </div>
      </section>
    </main>
  )
}

function AccountDisabledPage(props: { user: ApiUser; onLogout: () => void; onRefresh: () => void }) {
  return (
    <main className="pending-page">
      <section className="pending-box">
        <div className="brand auth-brand">
          <div className="brand-mark">停</div>
          <div>
            <strong>账号不可用</strong>
            <span>{accountName(props.user)}</span>
          </div>
        </div>
        <h1>sub2api 账号已停用</h1>
        <p>当前账号状态不可生成图片。请先在 sub2api 中确认账号状态，恢复后刷新页面。</p>
        <div className="status-box">
          <b>当前状态：禁用</b>
          <span>图片站不会单独管理账号和额度。</span>
        </div>
        <div className="button-row">
          <button className="primary" onClick={props.onRefresh}>刷新状态</button>
          <button onClick={props.onLogout}>退出登录</button>
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
    <main className="workspace studio-workspace">
      <aside className="side-nav">
        <div className="side-heading">
          <span>LIBRARY</span>
          <h2>图片库</h2>
        </div>
        <nav className="task-filters">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}><i className="filter-dot all" />全部图片 <span>{generations.length}</span></button>
          <button className={filter === 'running' ? 'active' : ''} onClick={() => setFilter('running')}><i className="filter-dot running" />生成中 <span>{runningCount}</span></button>
          <button className={filter === 'done' ? 'active' : ''} onClick={() => setFilter('done')}><i className="filter-dot done" />已完成 <span>{doneCount}</span></button>
          <button className={filter === 'error' ? 'active' : ''} onClick={() => setFilter('error')}><i className="filter-dot error" />失败 <span>{errorCount}</span></button>
        </nav>
        <div className="side-foot"><span>MODEL</span><b>gpt-image-2</b><small>计费由 sub2api 处理</small></div>
      </aside>
      <section className="studio-main">
        <section className="generator-panel">
          <div className="generator-copy">
            <div>
              <span className="eyebrow">CREATE / IMAGE</span>
              <h1>描述你想生成的画面</h1>
              <p>选择已有 Key，设置画面规格，然后提交生成。</p>
            </div>
            <div className="generator-context"><span>gpt-image-2</span><span>按次（图片）</span></div>
          </div>
          <form className="prompt-form" onSubmit={submit}>
            <label className="prompt-editor">
              <span><b>画面描述</b><small>尽量描述主体、环境、光线与构图</small></span>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="例如：一张极简产品摄影，冷白背景，柔和侧光，干净构图，细腻材质..." />
            </label>
            {inputImages.length ? (
              <div className="reference-strip">
                {inputImages.map((item, index) => <img key={item} src={item} alt={`参考图 ${index + 1}`} />)}
                <button type="button" onClick={() => setInputImages([])}>清空参考图</button>
              </div>
            ) : null}
            <div className="param-row">
              <label className="control-field key-field"><span>API KEY</span><select className="api-key-select" value={selectedApiKeyId} onChange={(e) => setSelectedApiKeyId(e.target.value)} aria-label="sub2api API Key">
                  <option value="">{keysLoading ? '正在读取 Key...' : '选择 API Key'}</option>
                  {apiKeys.map((item) => <option key={item.id} value={item.id}>{keyLabel(item)}</option>)}
                </select></label>
              <label className="control-field"><span>尺寸</span><select value={size} onChange={(e) => setSize(e.target.value)} aria-label="图片尺寸">{sizeOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label className="control-field"><span>质量</span><select value={quality} onChange={(e) => setQuality(e.target.value)} aria-label="图片质量">{qualityOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label className="control-field"><span>格式</span><select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="图片格式">{formatOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label className="control-field"><span>数量</span><select value={imageCount} onChange={(e) => setImageCount(Number(e.target.value))} aria-label="图片数量">{[1, 2, 3, 4].map((item) => <option key={item} value={item}>{item} 张</option>)}</select></label>
              <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => void selectFiles(e.target.files)} />
              <button className="reference-action" type="button" onClick={() => fileInputRef.current?.click()}>＋ 参考图 {inputImages.length ? inputImages.length : ''}</button>
              <button type="submit" className="primary generate-action" disabled={busy || keysLoading || !selectedApiKeyId}>{busy ? '提交中...' : '生成图片 →'}</button>
            </div>
            {error ? <div className="inline-message error">{error}</div> : null}
          </form>
        </section>

        <section className="gallery-panel">
          <div className="section-head">
            <div>
              <h1>最近任务</h1>
              <p>按状态筛选任务，点击图片查看详情和下载。</p>
            </div>
            <button onClick={() => void refresh()}>刷新</button>
          </div>
          <div className="toolbar">
            <span>{visible.length} 条记录</span>
            <div><span>{filter === 'all' ? '全部状态' : statusText(filter)}</span></div>
          </div>
          <div className="task-grid">
            {visible.map((item) => {
              const progress = getGenerationProgress(item, now)
              return (
                <article key={item.id} className="task-card" onClick={() => setSelected(item)}>
                  <div className={`thumb ${item.status}`}>
                    {item.images[0] ? <img src={imageUrl(item.images[0].id)} alt={item.prompt} /> : <div className="thumb-placeholder" />}
                    <span>{statusText(item.status)}</span>
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
