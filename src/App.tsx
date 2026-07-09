import { useEffect, useMemo, useRef, useState } from 'react'
import { apiRequest, imageUrl, type ApiGeneration, type ApiUser } from './lib/minimalApi'

type AuthMode = 'login' | 'register'
type MainView = 'gallery' | 'admin'

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

function userStatusText(status: ApiUser['status']) {
  if (status === 'active') return '正常'
  if (status === 'disabled') return '禁用'
  return '待审核'
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export default function App() {
  const [user, setUser] = useState<ApiUser | null>(null)
  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [view, setView] = useState<MainView>('gallery')
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  async function loadMe() {
    try {
      const payload = await apiRequest<{ user: ApiUser }>('/api/me')
      setUser(payload.user)
      if (payload.user.role !== 'admin') setView('gallery')
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  async function logout() {
    await apiRequest('/api/auth/logout', { method: 'POST' })
    setUser(null)
    setView('gallery')
  }

  useEffect(() => {
    void loadMe()
  }, [])

  if (loading) {
    return <div className="app-loading">正在进入极简生图...</div>
  }

  if (!user) {
    return (
      <AuthPage
        mode={authMode}
        message={message}
        onModeChange={setAuthMode}
        onMessage={setMessage}
        onAuthed={setUser}
      />
    )
  }

  if (user.status === 'pending') {
    return <PendingPage user={user} onLogout={logout} onRefresh={loadMe} />
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
          <button className="quota-pill">剩余额度 <b>{user.quotaRemaining}</b></button>
          <button className={view === 'gallery' ? 'active' : ''} onClick={() => setView('gallery')}>图片库</button>
          {user.role === 'admin' ? <button className={view === 'admin' ? 'active' : ''} onClick={() => setView('admin')}>管理</button> : null}
          <button onClick={logout}>退出</button>
        </nav>
      </header>
      {view === 'admin' && user.role === 'admin' ? (
        <AdminPage currentUser={user} onUserChange={setUser} />
      ) : (
        <GalleryPage user={user} onUserChange={setUser} />
      )}
    </div>
  )
}

function AuthPage(props: {
  mode: AuthMode
  message: string
  onModeChange: (mode: AuthMode) => void
  onMessage: (message: string) => void
  onAuthed: (user: ApiUser) => void
}) {
  const [username, setUsername] = useState('')
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    props.onMessage('')
    try {
      if (props.mode === 'register') {
        await apiRequest('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ username, nickname, password }),
        })
        props.onMessage('注册申请已提交，请等待管理员审核。')
        props.onModeChange('login')
        return
      }
      const payload = await apiRequest<{ user: ApiUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
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
            <span>账号入口</span>
          </div>
        </div>
        <h1>{props.mode === 'login' ? '登录账号' : '注册账号'}</h1>
        <p>登录后可使用图片生成、查看个人历史和剩余额度。</p>
        <form onSubmit={submit}>
          <label>账号<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="请输入账号" autoComplete="username" /></label>
          {props.mode === 'register' ? <label>昵称<input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="请输入昵称" /></label> : null}
          <label>密码<input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="请输入密码" type="password" autoComplete={props.mode === 'login' ? 'current-password' : 'new-password'} /></label>
          <button className="primary full" disabled={busy}>{busy ? '处理中...' : props.mode === 'login' ? '登录' : '提交注册'}</button>
        </form>
        {props.message ? <div className="inline-message">{props.message}</div> : null}
        <button className="link-button" onClick={() => props.onModeChange(props.mode === 'login' ? 'register' : 'login')}>
          {props.mode === 'login' ? '还没有账号？注册账号' : '已有账号？返回登录'}
        </button>
      </section>
      <section className="auth-preview">
        <div className="preview-image" />
        <b>极简产品摄影，上传参考图后继续编辑</b>
        <div className="preview-meta"><span>无需配置 API Key</span><span>额度 12</span></div>
        <div className="pending-card">
          <span>审</span>
          <div>
            <b>账号待审核</b>
            <p>注册后默认待审核，管理员启用并分配额度后即可开始生成。</p>
          </div>
        </div>
      </section>
    </main>
  )
}

function PendingPage(props: { user: ApiUser; onLogout: () => void; onRefresh: () => void }) {
  return (
    <main className="pending-page">
      <section className="pending-box">
        <div className="brand auth-brand">
          <div className="brand-mark">审</div>
          <div>
            <strong>账号待审核</strong>
            <span>{props.user.nickname}</span>
          </div>
        </div>
        <h1>等待管理员启用</h1>
        <p>你的账号已经提交注册申请。管理员启用账号并分配额度后，即可开始生成图片。</p>
        <div className="status-box">
          <b>当前状态：待审核</b>
          <span>当前额度：0</span>
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
  const [selected, setSelected] = useState<ApiGeneration | null>(null)
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState('high')
  const [format, setFormat] = useState('png')
  const [inputImages, setInputImages] = useState<string[]>([])
  const [filter, setFilter] = useState<'all' | ApiGeneration['status']>('all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function refresh() {
    const payload = await apiRequest<{ generations: ApiGeneration[] }>('/api/generations')
    setGenerations(payload.generations)
    const me = await apiRequest<{ user: ApiUser }>('/api/me')
    props.onUserChange(me.user)
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (!generations.some((item) => item.status === 'running')) return
    const timer = window.setInterval(() => void refresh(), 2500)
    return () => window.clearInterval(timer)
  }, [generations])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!prompt.trim()) return
    setBusy(true)
    setError('')
    try {
      const payload = await apiRequest<{ generation: ApiGeneration }>('/api/generations', {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          inputImages,
          params: { size, quality, output_format: format, n: 1 },
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
  const doneCount = generations.filter((item) => item.status === 'done').length

  return (
    <main className="workspace studio-workspace">
      <aside className="side-nav">
        <h2>工作台</h2>
        <p>生成、历史和下载。</p>
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部图片 <span>{generations.length}</span></button>
        <button className={filter === 'done' ? 'active' : ''} onClick={() => setFilter('done')}>生成成功 <span>{doneCount}</span></button>
        <button className={filter === 'running' ? 'active' : ''} onClick={() => setFilter('running')}>生成中 <span>{generations.filter((item) => item.status === 'running').length}</span></button>
        <button className={filter === 'error' ? 'active' : ''} onClick={() => setFilter('error')}>失败未扣费 <span>{generations.filter((item) => item.status === 'error').length}</span></button>
        <div className="quota-card">
          <span>可用额度</span>
          <b>{props.user.quotaRemaining}</b>
          <small>失败不扣，成功扣 1 次</small>
        </div>
      </aside>
      <section className="studio-main">
        <section className="generator-panel">
          <div className="generator-copy">
            <span className="eyebrow">图片生成</span>
            <h1>输入提示词，生成图片</h1>
            <p>支持参考图、尺寸、质量和格式设置。任务提交后可在下方查看状态，成功后扣 1 次额度。</p>
          </div>
          <form className="composer studio-composer" onSubmit={submit}>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="描述你想要的画面，例如：浅蓝背景上的极简产品图，柔和自然光..." />
            {inputImages.length ? (
              <div className="reference-strip">
                {inputImages.map((item, index) => <img key={item} src={item} alt={`参考图 ${index + 1}`} />)}
                <button type="button" onClick={() => setInputImages([])}>清空参考图</button>
              </div>
            ) : null}
            <div className="param-row">
              <select value={size} onChange={(e) => setSize(e.target.value)} aria-label="图片尺寸">{sizeOptions.map((item) => <option key={item}>{item}</option>)}</select>
              <select value={quality} onChange={(e) => setQuality(e.target.value)} aria-label="图片质量">{qualityOptions.map((item) => <option key={item}>{item}</option>)}</select>
              <select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="图片格式">{formatOptions.map((item) => <option key={item}>{item}</option>)}</select>
              <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => void selectFiles(e.target.files)} />
              <button type="button" onClick={() => fileInputRef.current?.click()}>参考图 {inputImages.length ? inputImages.length : ''}</button>
              <button className="primary" disabled={busy || props.user.quotaRemaining <= 0}>{busy ? '提交中...' : '生成图片'}</button>
            </div>
            {error ? <div className="inline-message error">{error}</div> : null}
          </form>
          <div className="generator-stats">
            <div><span>可用额度</span><b>{props.user.quotaRemaining}</b></div>
            <div><span>默认模型</span><b>gpt-image-2</b></div>
            <div><span>成功任务</span><b>{doneCount}</b></div>
          </div>
        </section>

        <section className="gallery-panel">
          <div className="section-head">
            <div>
              <h1>最近任务</h1>
              <p>按状态筛选任务，点击图片查看详情和下载。</p>
            </div>
            <button onClick={refresh}>刷新</button>
          </div>
          <div className="toolbar">
            <span>{visible.length} 条记录</span>
            <div>
              <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button>
              <button className={filter === 'done' ? 'active' : ''} onClick={() => setFilter('done')}>已完成</button>
              <button className={filter === 'running' ? 'active' : ''} onClick={() => setFilter('running')}>生成中</button>
              <button className={filter === 'error' ? 'active' : ''} onClick={() => setFilter('error')}>失败</button>
            </div>
          </div>
          <div className="task-grid">
            {visible.map((item) => (
              <article key={item.id} className="task-card" onClick={() => setSelected(item)}>
                <div className={`thumb ${item.status}`}>
                  {item.images[0] ? <img src={imageUrl(item.images[0].id)} alt={item.prompt} /> : <div className="thumb-placeholder" />}
                  <span>{statusText(item.status)}</span>
                </div>
                <div className="task-body">
                  <b>{item.prompt}</b>
                  <div><span>{item.model}</span><span>{item.elapsedMs ? `${Math.round(item.elapsedMs / 1000)}s` : formatTime(item.createdAt)}</span></div>
                </div>
              </article>
            ))}
          </div>
          {!visible.length ? (
            <div className="empty-state compact">
              <b>还没有图片</b>
              <span>在上方输入提示词，生成后的任务会显示在这里。</span>
            </div>
          ) : null}
        </section>
      </section>
      {selected ? <GenerationDetail generation={selected} onClose={() => setSelected(null)} /> : null}
    </main>
  )
}

function GenerationDetail(props: { generation: ApiGeneration; onClose: () => void }) {
  const firstImage = props.generation.images[0]

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
          <div className="detail-image">{firstImage ? <img src={imageUrl(firstImage.id)} alt={props.generation.prompt} /> : <div className="thumb-placeholder" />}</div>
          <div className="detail-info">
            <h3>提示词</h3>
            <p>{props.generation.prompt}</p>
            <h3>生成参数</h3>
            <dl>
              <dt>模型</dt><dd>{props.generation.model}</dd>
              <dt>尺寸</dt><dd>{props.generation.params.size}</dd>
              <dt>质量</dt><dd>{props.generation.params.quality}</dd>
              <dt>格式</dt><dd>{props.generation.params.output_format}</dd>
              <dt>状态</dt><dd>{statusText(props.generation.status)}</dd>
              <dt>额度</dt><dd>{props.generation.status === 'done' ? '已扣除 1 次' : '未扣费'}</dd>
            </dl>
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

function AdminPage(props: { currentUser: ApiUser; onUserChange: (user: ApiUser) => void }) {
  const [users, setUsers] = useState<ApiUser[]>([])
  const [message, setMessage] = useState('')

  async function refresh() {
    const payload = await apiRequest<{ users: ApiUser[] }>('/api/admin/users')
    setUsers(payload.users.filter((item) => item.role !== 'admin'))
    const me = await apiRequest<{ user: ApiUser }>('/api/me')
    props.onUserChange(me.user)
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function updateStatus(user: ApiUser, status: ApiUser['status']) {
    setMessage('')
    try {
      await apiRequest(`/api/admin/users/${user.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      await refresh()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function adjustQuota(user: ApiUser) {
    const value = window.prompt(`给 ${user.nickname} 调整额度，正数增加、负数扣减`, '10')
    if (value == null) return
    const delta = Number(value)
    if (!Number.isInteger(delta) || delta === 0) {
      setMessage('请输入非 0 整数')
      return
    }
    setMessage('')
    try {
      await apiRequest(`/api/admin/users/${user.id}/quota`, {
        method: 'POST',
        body: JSON.stringify({ delta, reason: '管理员调整' }),
      })
      await refresh()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="admin-workspace">
      <aside className="side-nav">
        <h2>管理后台</h2>
        <p>只保留用户审核、启停和额度管理。</p>
        <button className="active">用户管理</button>
      </aside>
      <section className="admin-content">
        <div className="section-head">
          <div>
            <h1>用户管理</h1>
            <p>审核新用户、启用或禁用账号，并调整可用额度。</p>
          </div>
          <button onClick={refresh}>刷新列表</button>
        </div>
        <div className="summary-row">
          <div className="summary-card focus"><span>待审核</span><b>{users.filter((item) => item.status === 'pending').length}</b></div>
          <div className="summary-card"><span>正常用户</span><b>{users.filter((item) => item.status === 'active').length}</b></div>
          <div className="summary-card"><span>总剩余额度</span><b>{users.reduce((sum, item) => sum + item.quotaRemaining, 0)}</b></div>
          <div className="summary-card"><span>已用额度</span><b>{users.reduce((sum, item) => sum + item.quotaUsed, 0)}</b></div>
        </div>
        {message ? <div className="inline-message error">{message}</div> : null}
        <div className="user-table">
          <div className="user-row head"><span>账号</span><span>昵称</span><span>状态</span><span>剩余额度</span><span>已用</span><span>操作</span></div>
          {users.map((item) => (
            <div className="user-row" key={item.id}>
              <b>{item.username}</b>
              <span>{item.nickname}</span>
              <span className={`badge ${item.status}`}>{userStatusText(item.status)}</span>
              <span>{item.quotaRemaining}</span>
              <span>{item.quotaUsed}</span>
              <span className="actions-cell">
                {item.status !== 'active' ? <button onClick={() => updateStatus(item, 'active')}>启用</button> : null}
                <button onClick={() => adjustQuota(item)}>调额度</button>
                {item.status !== 'disabled' ? <button className="danger" onClick={() => updateStatus(item, 'disabled')}>禁用</button> : null}
              </span>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}
