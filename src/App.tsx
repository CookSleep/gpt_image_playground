import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircleIcon, CheckCircleIcon, ChevronRightIcon, ImageIcon, LogOutIcon, RefreshIcon, SparklesIcon } from './components/icons'
import { getGenerationProgress } from './lib/generationProgress'
import { buildGenerationNotice, carouselPosition, cycleIndex, parseStudioDraft, parseStudioLocation, resolveTheme, sanitizeThemePreference, serializeStudioDraft, serializeStudioLocation, wheelCarouselDirection, withSingleRetry, type GenerationFilter, type StudioView, type ThemePreference } from './lib/studioView'
import { apiRequest, imageUrl, type ApiGeneration, type ApiKeyOption, type ApiUser } from './lib/minimalApi'

const clientLoggedOutKey = 'minimal-image-site-client-logged-out'
const themePreferenceKey = 'aurora-studio-theme'
const studioDraftKey = 'aurora-studio-draft'
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
    return <div className="app-loading">正在进入 Aurora Studio...</div>
  }

  if (!user) {
    return <AuthPage message={message} onMessage={setMessage} onAuthed={handleAuthed} />
  }

  if (user.status === 'disabled') {
    return <AccountDisabledPage user={user} onLogout={logout} onRefresh={loadMe} />
  }

  return <GalleryPage user={user} onUserChange={setUser} onLogout={logout} />
}

function AuthPage(props: {
  message: string
  onMessage: (message: string) => void
  onAuthed: (user: ApiUser) => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [showcaseIndex, setShowcaseIndex] = useState(1)
  const [showcasePaused, setShowcasePaused] = useState(false)
  const showcase = [
    { src: '/showcase/interior.webp', alt: 'AI 生成的室内作品', fit: 'cover' },
    { src: '/showcase/portrait.webp', alt: 'AI 生成的人像作品', fit: 'contain' },
    { src: '/showcase/architecture.webp', alt: 'AI 生成的建筑作品', fit: 'cover' },
  ]

  useEffect(() => {
    if (showcasePaused) return
    const timer = window.setInterval(() => setShowcaseIndex((current) => cycleIndex(current, 1, showcase.length)), 4200)
    return () => window.clearInterval(timer)
  }, [showcasePaused])

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
    <main className="immersive-auth">
      <div className="auth-ambient" />
      <section className="auth-showcase">
        <div className="brand auth-studio-brand">
          <img className="brand-logo" src="/pwa-icon.svg?v=20260711" alt="Aurora Studio" />
          <div><strong>Aurora Studio</strong><span>PERSONAL AI IMAGE SPACE</span></div>
        </div>
        <div className="auth-art-stack" onMouseEnter={() => setShowcasePaused(true)} onMouseLeave={() => setShowcasePaused(false)}>
          {showcase.map((item, index) => {
            const offset = (index - showcaseIndex + showcase.length) % showcase.length
            const position = offset === 0 ? 'current' : offset === 1 ? 'next' : 'previous'
            return <button key={item.src} type="button" className={`auth-art-card ${position} fit-${item.fit}`} onClick={() => setShowcaseIndex(index)} aria-label={`查看${item.alt}`}><img src={item.src} alt={item.alt} /></button>
          })}
          <div className="auth-art-controls"><button type="button" onClick={() => setShowcaseIndex((current) => cycleIndex(current, -1, showcase.length))}>‹</button><span>{showcase.map((item, index) => <button key={item.src} type="button" className={index === showcaseIndex ? 'active' : ''} onClick={() => setShowcaseIndex(index)} aria-label={`切换到第 ${index + 1} 张`} />)}</span><button type="button" onClick={() => setShowcaseIndex((current) => cycleIndex(current, 1, showcase.length))}>›</button></div>
        </div>
        <div className="auth-showcase-copy">
          <span>CREATE · VIEW · MANAGE</span>
          <h1>让每一次生成，都成为你的作品。</h1>
          <p>从提示词到成图，从版本对比到图片资产，在一个沉浸空间里完成。</p>
        </div>
      </section>
      <section className="auth-access">
        <div className="auth-access-inner">
          <span className="panel-eyebrow">ACCOUNT ACCESS</span>
          <h1>欢迎回来</h1>
          <p>使用你的 sub2api 账号进入私人图片空间。</p>
          <form onSubmit={submit}>
            <label><span>邮箱</span><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="请输入 sub2api 账号邮箱" type="email" autoComplete="email" required /></label>
            <label><span>密码</span><input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="请输入账号密码" type="password" autoComplete="current-password" required /></label>
            <button className="auth-studio-submit" disabled={busy}>{busy ? '正在验证账号…' : '进入 Aurora Studio'}<ChevronRightIcon /></button>
          </form>
          {props.message ? <div className="inline-message error auth-error"><AlertCircleIcon />{props.message}</div> : null}
          <div className="auth-studio-security"><CheckCircleIcon /><span><b>安全登录</b>API Key 明文只由服务端读取，浏览器不会保存。</span></div>
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

function GalleryPage(props: { user: ApiUser; onUserChange: (user: ApiUser) => void; onLogout: () => void }) {
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
  const initialLocation = useMemo(() => parseStudioLocation(window.location.search), [])
  const [filter, setFilter] = useState<GenerationFilter>(initialLocation.filter)
  const [busy, setBusy] = useState(false)
  const [keysLoading, setKeysLoading] = useState(false)
  const [generationsLoading, setGenerationsLoading] = useState(true)
  const [generationsError, setGenerationsError] = useState('')
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [view, setView] = useState<StudioView>(initialLocation.view)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentGenerationId, setCurrentGenerationId] = useState(initialLocation.generationId)
  const [generationNotice, setGenerationNotice] = useState('')
  const [trackedGenerationId, setTrackedGenerationId] = useState('')
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    try {
      return sanitizeThemePreference(window.localStorage.getItem(themePreferenceKey))
    } catch {
      return 'system'
    }
  })
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)

  const selectedKey = useMemo(
    () => apiKeys.find((item) => item.id === selectedApiKeyId) ?? null,
    [apiKeys, selectedApiKeyId],
  )
  const resolvedTheme = resolveTheme(themePreference, prefersDark)

  useEffect(() => {
    try {
      const draft = parseStudioDraft(window.localStorage.getItem(studioDraftKey))
      if (!draft) return
      setPrompt(draft.prompt)
      setSize(draft.size)
      setQuality(draft.quality)
      setFormat(draft.format)
      setImageCount(draft.imageCount)
      setSelectedApiKeyId(draft.selectedApiKeyId)
    } catch {
      // 无法读取草稿时继续使用默认值。
    }
  }, [])

  async function refreshGenerations(retry = false) {
    setGenerationsLoading(true)
    try {
      const request = () => apiRequest<{ generations: ApiGeneration[] }>('/api/generations')
      const payload = retry ? await withSingleRetry(request) : await request()
      setGenerations(payload.generations)
      setGenerationsError('')
    } catch (err) {
      setGenerationsError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerationsLoading(false)
    }
  }

  async function refreshUser() {
    try {
      const me = await apiRequest<{ user: ApiUser }>('/api/me')
      props.onUserChange(me.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function refresh() {
    await Promise.all([refreshGenerations(), refreshUser()])
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
    void refreshGenerations(true)
    void refreshUser()
    void refreshKeys()
  }, [])

  useEffect(() => {
    if (!generations.some((item) => item.status === 'running')) return
    const timer = window.setInterval(() => void refreshGenerations(), 2500)
    return () => window.clearInterval(timer)
  }, [generations])

  useEffect(() => {
    if (!generations.some((item) => item.status === 'running')) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [generations])

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!query) return
    const update = () => setPrefersDark(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(themePreferenceKey, themePreference)
    } catch {
      // 主题仍可在当前会话中切换。
    }
  }, [themePreference])

  useEffect(() => {
    try {
      window.localStorage.setItem(studioDraftKey, serializeStudioDraft({ prompt, size, quality, format, imageCount, selectedApiKeyId }))
    } catch {
      // 草稿持久化失败不影响生成。
    }
  }, [format, imageCount, prompt, quality, selectedApiKeyId, size])

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
      setTrackedGenerationId(payload.generation.id)
      setGenerationNotice(buildGenerationNotice(payload.generation.status, payload.generation.prompt))
      setCurrentIndex(0)
      setCurrentGenerationId(payload.generation.id)
      await refreshGenerations()
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
  const completed = useMemo(() => generations.filter((item) => item.status === 'done' && item.images[0]), [generations])
  const currentGeneration = generations.find((item) => item.id === currentGenerationId) ?? completed[currentIndex] ?? visible[0] ?? generations[0] ?? null
  const previousGeneration = completed[cycleIndex(currentIndex, -1, completed.length)] ?? null
  const nextGeneration = completed[cycleIndex(currentIndex, 1, completed.length)] ?? null
  const selectedGeneration = selected ? generations.find((item) => item.id === selected.id) ?? selected : null
  const currentProgress = currentGeneration ? getGenerationProgress(currentGeneration, now) : null
  const doneCount = generations.filter((item) => item.status === 'done').length
  const runningCount = generations.filter((item) => item.status === 'running').length
  const errorCount = generations.filter((item) => item.status === 'error').length
  const availableQuota = apiKeys.reduce((total, item) => total + Math.max(0, item.quota - item.quotaUsed), 0)
  const backgroundImage = currentGeneration?.images[0] ? imageUrl(currentGeneration.images[0].id) : ''

  useEffect(() => {
    const search = serializeStudioLocation({ view, filter, generationId: currentGeneration?.id ?? currentGenerationId })
    window.history.replaceState(null, '', `${window.location.pathname}${search}${window.location.hash}`)
  }, [currentGeneration?.id, currentGenerationId, filter, view])

  useEffect(() => {
    if (!trackedGenerationId) return
    const tracked = generations.find((item) => item.id === trackedGenerationId)
    if (!tracked) return
    setGenerationNotice(buildGenerationNotice(tracked.status, tracked.prompt))
    if (tracked.status !== 'running') setTrackedGenerationId('')
  }, [generations, trackedGenerationId])

  useEffect(() => {
    if (currentIndex < completed.length) return
    setCurrentIndex(0)
  }, [completed.length, currentIndex])

  useEffect(() => {
    if (view !== 'gallery' || completed.length < 2) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      setCurrentIndex((current) => { const next = cycleIndex(current, event.key === 'ArrowLeft' ? -1 : 1, completed.length); setCurrentGenerationId(completed[next]?.id ?? ''); return next })
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [completed.length, view])

  function setTheme(preference: ThemePreference) {
    setThemePreference(preference)
  }

  function reuseCurrentImage() {
    if (!currentGeneration?.images[0]) return
    setInputImages([imageUrl(currentGeneration.images[0].id)])
    setView('workspace')
  }

  return (
    <main className={`immersive-studio theme-${resolvedTheme} ${view}-mode`} style={backgroundImage ? { '--studio-background': `url(${backgroundImage})` } as React.CSSProperties : undefined}>
      <div className="studio-background" />
      <div className="studio-noise" />
      <header className="immersive-topbar">
        <div className="brand">
          <img className="brand-logo" src="/pwa-icon.svg?v=20260711" alt="Aurora Studio" />
          <div><strong>Aurora Studio</strong><span>PERSONAL AI IMAGE SPACE</span></div>
        </div>
        <nav className="immersive-nav" aria-label="主要导航">
          <button className={view === 'gallery' ? 'active' : ''} onClick={() => setView('gallery')}>我的作品</button>
          <button className={view === 'workspace' ? 'active' : ''} onClick={() => setView('workspace')}>创作工作台</button>
          <button className={view === 'assets' ? 'active' : ''} onClick={() => setView('assets')}>图片资产</button>
        </nav>
        <div className="immersive-account">
          <span>{availableQuota} CREDITS</span>
          <div className="theme-switcher" aria-label="主题设置">
            <button className={themePreference === 'light' ? 'active' : ''} onClick={() => setTheme('light')} title="浅色模式">☀</button>
            <button className={themePreference === 'system' ? 'active' : ''} onClick={() => setTheme('system')} title="跟随系统">◐</button>
            <button className={themePreference === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')} title="深色模式">☾</button>
          </div>
          <button className="immersive-logout" onClick={props.onLogout} title="退出登录" aria-label="退出登录"><LogOutIcon /></button>
        </div>
      </header>

      {view === 'gallery' ? (
        <section className="immersive-gallery">
          {generationsLoading && !generations.length ? <div className="gallery-loading"><span className="gallery-loading-orb" /><b>正在同步你的作品</b><p>从后端恢复任务与图片资产…</p></div> : generationsError && !generations.length ? <div className="gallery-loading error"><AlertCircleIcon /><b>作品加载失败</b><p>{generationsError}</p><button onClick={() => void refreshGenerations(true)}>重新加载</button></div> : <>
          <div className="immersive-heading">
            <span>YOUR LATEST CREATIONS</span>
            <h1>{completed.length ? '继续欣赏你的创作' : '从第一张作品开始'}</h1>
            <p>{completed.length ? '点击两侧作品或使用方向键切换' : '展开创作工作台，输入提示词生成图片。'}</p>
          </div>
          <div className="carousel-stage" onWheel={(event) => {
            const direction = wheelCarouselDirection(event.deltaX, event.deltaY)
            if (completed.length < 2 || !direction) return
            event.preventDefault()
            setCurrentIndex((current) => { const next = cycleIndex(current, direction, completed.length); setCurrentGenerationId(completed[next]?.id ?? ''); return next })
          }}>
            {completed.map((item, index) => {
              const position = carouselPosition(index, currentIndex, completed.length)
              const progress = getGenerationProgress(item, now)
              return <article key={item.id} className={`carousel-card ${position}`} aria-hidden={position === 'hidden'}>
                <img src={imageUrl(item.images[0].id)} alt={position === 'hidden' ? '' : item.prompt} />
                {position === 'previous' || position === 'next' ? <button className="carousel-card-hit" type="button" aria-label={`切换到${position === 'previous' ? '上一张' : '下一张'}作品`} onClick={() => { setCurrentIndex(index); setCurrentGenerationId(item.id) }}><span>{position === 'previous' ? '‹' : '›'}</span></button> : null}
                {position === 'current' ? <><span className={`current-status ${item.status}`}>{statusText(item.status)} · {progress.timingText || formatTime(item.createdAt)}</span><div className="current-caption"><h2>{item.prompt}</h2><p>{item.params.size.replace('x', ' × ')} · {item.params.quality} · {item.model}</p></div></> : null}
              </article>
            })}
            {!completed.length ? <article className="carousel-card current"><div className="immersive-empty"><ImageIcon /><b>还没有完成的作品</b><span>创作完成后，图片会出现在这里。</span></div></article> : null}
            {completed.length ? <div className="carousel-film">{completed.slice(0, 8).map((item, index) => <button key={item.id} className={index === currentIndex ? 'active' : ''} onClick={() => { setCurrentIndex(index); setCurrentGenerationId(item.id) }}><img src={imageUrl(item.images[0].id)} alt="" /></button>)}</div> : null}
          </div>
          <div className="gallery-dock">
            <div className="gallery-meta">
              <span><small>生成时间</small><b>{currentGeneration ? formatTime(currentGeneration.createdAt) : '-'}</b></span>
              <span><small>图片尺寸</small><b>{currentGeneration?.params.size.replace('x', ' × ') || '-'}</b></span>
              <span><small>当前模型</small><b>{currentGeneration?.model || 'gpt-image-2'}</b></span>
            </div>
            <div className="gallery-dock-actions">
              <button disabled={!currentGeneration?.images[0]} onClick={reuseCurrentImage}>设为参考图</button>
              <button disabled={!currentGeneration} onClick={() => currentGeneration && setSelected(currentGeneration)}>查看详情</button>
              <button className="create-entry" onClick={() => setView('workspace')}><SparklesIcon />创作新图片</button>
            </div>
          </div>
          </>}
        </section>
      ) : view === 'assets' ? (
        <section className="asset-library">
          <div className="asset-library-head"><div><span className="panel-eyebrow">PERSISTED IMAGE LIBRARY</span><h1>图片资产</h1><p>这里展示后端已保存的生成结果，刷新或重新登录后仍然存在。</p></div><div><button onClick={() => void refresh()}><RefreshIcon />刷新资产</button><button className="asset-create" onClick={() => setView('workspace')}><SparklesIcon />创作新图片</button></div></div>
          <div className="asset-summary"><span><b>{doneCount}</b>已保存作品</span><span><b>{generations.reduce((total, item) => total + item.images.length, 0)}</b>图片文件</span><span><b>{runningCount}</b>生成中任务</span><span><b>{errorCount}</b>失败任务</span></div>
          <div className="asset-grid">{completed.map((item) => <article key={item.id} onClick={() => setSelected(item)}><div><img src={imageUrl(item.images[0].id)} alt={item.prompt} /><span>{item.params.size.replace('x', ' × ')}</span></div><h2>{item.prompt}</h2><p><span>{item.apiKeyName || item.model}</span><time>{formatTime(item.createdAt)}</time></p></article>)}</div>
          {!completed.length ? <div className="asset-empty"><ImageIcon /><b>还没有已保存的图片</b><span>生成完成后的图片会由后端保存并出现在这里。</span><button onClick={() => setView('workspace')}>开始第一次创作</button></div> : null}
        </section>
      ) : (
        <section className="creation-workspace">
          <form className="creation-panel studio-glass" onSubmit={submit}>
            <span className="panel-eyebrow">CREATE</span>
            <h1>把脑海里的画面<br />变成作品</h1>
            <div className="workspace-prompt"><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={2000} placeholder="描述你想生成的画面……" aria-label="提示词" /><small>{prompt.length} / 2000</small></div>
            <div className="workspace-references">
              <div>{inputImages.map((item, index) => <img key={`${item}-${index}`} src={item} alt={`参考图 ${index + 1}`} />)}<button type="button" onClick={() => fileInputRef.current?.click()}>＋</button></div>
              <span>{inputImages.length ? `已添加 ${inputImages.length} 张参考图` : '添加参考图'}<small>最多 4 张 · JPG / PNG / WEBP</small></span>
              {inputImages.length ? <button type="button" onClick={() => setInputImages([])}>清空</button> : null}
              <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => void selectFiles(e.target.files)} />
            </div>
            <label className="workspace-select"><span>API Key</span><select value={selectedApiKeyId} onChange={(e) => setSelectedApiKeyId(e.target.value)} aria-label="sub2api API Key"><option value="">{keysLoading ? '正在读取 Key...' : '选择 API Key'}</option>{apiKeys.map((item) => <option key={item.id} value={item.id}>{keyLabel(item)}</option>)}</select></label>
            <div className="workspace-setting"><span>画面尺寸</span><div>{sizeOptions.map((item) => <button key={item} type="button" className={size === item ? 'active' : ''} onClick={() => setSize(item)}>{item.replace('x', '×')}</button>)}</div></div>
            <div className="workspace-setting"><span>生成质量</span><div>{qualityOptions.map((item) => <button key={item} type="button" className={quality === item ? 'active' : ''} onClick={() => setQuality(item)}>{item}</button>)}</div></div>
            <div className="workspace-inline-selects"><label><span>格式</span><select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="图片格式">{formatOptions.map((item) => <option key={item}>{item}</option>)}</select></label><label><span>数量</span><select value={imageCount} onChange={(e) => setImageCount(Number(e.target.value))} aria-label="图片数量">{[1, 2, 3, 4].map((item) => <option key={item} value={item}>{item} 张</option>)}</select></label></div>
            {error ? <div className="inline-message error">{error}</div> : null}
            {generationNotice ? <div className={`generation-notice ${trackedGenerationId ? 'running' : ''}`}><span>{trackedGenerationId ? <i /> : <CheckCircleIcon />}</span><div><b>{generationNotice}</b><small>{trackedGenerationId ? '任务已写入后端，完成后会自动更新并加入图片资产。' : '生成记录和图片已由后端保存。'}</small></div></div> : null}
            <button type="submit" className="workspace-generate" disabled={busy || keysLoading || !selectedApiKeyId || !prompt.trim()}><span className="generate-icon"><SparklesIcon /></span><b>{busy ? '正在提交...' : !prompt.trim() ? '输入提示词后生成' : '开始生成'}</b><span className="generate-shortcut">⌘ ↵</span></button>
            <button type="button" className="back-to-gallery" onClick={() => setView('gallery')}>‹ 返回沉浸浏览</button>
          </form>

          <section className={`workspace-canvas ${visible.length ? 'has-film' : 'without-film'}`}>
            <div className="canvas-toolbar"><span><b>当前画布</b> · {currentGeneration ? '已同步作品' : '未命名创作'}</span><div><button onClick={() => void refresh()}><RefreshIcon />刷新</button><button onClick={() => setSelected(currentGeneration)} disabled={!currentGeneration}>查看详情</button></div></div>
            <div className="canvas-image">
              {currentGeneration?.images[0] ? <img src={imageUrl(currentGeneration.images[0].id)} alt={currentGeneration.prompt} /> : <div className="immersive-empty"><ImageIcon /><b>{runningCount ? '图片正在生成' : '画布等待创作'}</b><span>{runningCount ? '生成完成后会自动显示。' : '从左侧输入提示词开始。'}</span></div>}
              {currentGeneration ? <div className="canvas-actions"><button type="button" onClick={reuseCurrentImage}>设为参考图</button><button type="button" onClick={() => setSelected(currentGeneration)}>详情与下载</button></div> : null}
            </div>
            {visible.length ? <div className="workspace-film"><div><b>本次创作</b><small>{generations.length} 个任务</small></div>{visible.slice(0, 8).map((item) => <button key={item.id} className={item.id === currentGeneration?.id ? 'active' : ''} onClick={() => {
              const nextIndex = completed.findIndex((entry) => entry.id === item.id)
              if (nextIndex >= 0) { setCurrentIndex(nextIndex); setCurrentGenerationId(item.id) }
              else setSelected(item)
            }}>{item.images[0] ? <img src={imageUrl(item.images[0].id)} alt="" /> : <span className={item.status}>{statusText(item.status)}</span>}</button>)}</div> : null}
          </section>

          <aside className="versions-panel studio-glass">
            <span className="panel-eyebrow">GENERATIONS</span>
            <div className="versions-heading"><h2>生成结果</h2><span>{doneCount} 完成</span></div>
            <div className="versions-filter">{(['all', 'done', 'running', 'error'] as const).map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item === 'all' ? '全部' : statusText(item)} {item === 'all' ? generations.length : item === 'done' ? doneCount : item === 'running' ? runningCount : errorCount}</button>)}</div>
            <div className="version-list">{visible.slice(0, 6).map((item) => {
              const progress = getGenerationProgress(item, now)
              return <button key={item.id} className={item.id === currentGeneration?.id ? 'active' : ''} onClick={() => item.status === 'done' ? (() => { setCurrentIndex(Math.max(0, completed.findIndex((entry) => entry.id === item.id))); setCurrentGenerationId(item.id) })() : setSelected(item)}>{item.images[0] ? <img src={imageUrl(item.images[0].id)} alt="" /> : <span className={`version-placeholder ${item.status}`}><ImageIcon /></span>}<span><b>{item.prompt}</b><small>{item.error || `${statusText(item.status)} · ${progress.timingText || formatTime(item.createdAt)}`}</small></span></button>
            })}</div>
            {generationsLoading && !generations.length ? <div className="generation-state">正在恢复任务记录…</div> : null}
            {generationsError ? <div className="generation-state error"><span>{generationsError}</span><button onClick={() => void refreshGenerations()}>重试</button></div> : null}
            {currentGeneration ? <dl className="current-metadata"><div><dt>API Key</dt><dd>{currentGeneration.apiKeyName || '-'}</dd></div><div><dt>尺寸</dt><dd>{currentGeneration.params.size.replace('x', ' × ')}</dd></div><div><dt>质量</dt><dd>{currentGeneration.params.quality}</dd></div><div><dt>格式</dt><dd>{currentGeneration.params.output_format}</dd></div></dl> : null}
            <div className="versions-actions"><button disabled={!currentGeneration} onClick={() => currentGeneration && setSelected(currentGeneration)}>详情与下载</button><button onClick={() => void refresh()}><RefreshIcon />刷新任务</button></div>
          </aside>
        </section>
      )}
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
