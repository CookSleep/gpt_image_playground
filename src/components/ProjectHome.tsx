import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, TaskRecord } from '../types'
import { useAuth } from '../auth/AuthContext'
import { fetchApiKeys, type ApiKeyItem } from '../auth/oidcResource'
import { LOCAL_PROJECT_ID, ensureImageThumbnailCached, submitTask, useStore } from '../store'
import { DEFAULT_IMAGES_MODEL } from '../lib/apiProfiles'
import { updateProjectUrl } from '../lib/projectRoute'
import { readCachedApiKey, writeCachedApiKey } from '../lib/oidcApiKeySelection'
import Select from './Select'
import { ArrowUpIcon, EditIcon, KeyIcon, OpenAIIcon, PlusIcon, TrashIcon } from './icons'

const HOME_MODEL_OPTIONS = [{
  label: 'GPT Image 2',
  value: DEFAULT_IMAGES_MODEL,
  description: 'OpenAI',
  icon: (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-950 text-white shadow-sm dark:bg-white dark:text-gray-950">
      <OpenAIIcon className="h-4 w-4" />
    </span>
  ),
}]

const HOME_API_KEY_ICON = (
  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
    <KeyIcon className="h-4 w-4" />
  </span>
)

function ProjectCover({ task }: { task?: TaskRecord }) {
  const [src, setSrc] = useState('')

  useEffect(() => {
    const imageId = task?.outputImages[0]
    setSrc('')
    if (!imageId) return

    let cancelled = false
    void ensureImageThumbnailCached(imageId).then((thumbnail) => {
      if (!cancelled && thumbnail) setSrc(thumbnail.dataUrl)
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [task?.outputImages])

  if (src) return <img src={src} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]" />

  return (
    <div className="flex h-full w-full items-center justify-center bg-gray-100 text-gray-300 dark:bg-gray-900 dark:text-gray-700">
      <svg className="h-14 w-14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.2} d="M4 16l4.6-4.6a2 2 0 012.8 0L16 16m-2-2 1.6-1.6a2 2 0 012.8 0L20 14M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    </div>
  )
}

function ProjectCard({ project, task, isLegacy = false }: { project: Project; task?: TaskRecord; isLegacy?: boolean }) {
  const setAppMode = useStore((s) => s.setAppMode)
  const setActiveProjectId = useStore((s) => s.setActiveProjectId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const deleteProject = useStore((s) => s.deleteProject)
  const renameProject = useStore((s) => s.renameProject)
  const taskCount = useStore((s) => s.tasks.filter((item) => isLegacy ? !item.projectId : item.projectId === project.id).length)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(project.title)

  useEffect(() => {
    setTitle(project.title)
  }, [project.title])

  const openProject = () => {
    setAppMode('gallery')
    setActiveProjectId(project.id)
    updateProjectUrl(project.id)
    window.scrollTo({ top: 0 })
  }

  const commitTitle = () => {
    const value = title.trim()
    if (value) renameProject(project.id, value)
    else setTitle(project.title)
    setEditing(false)
  }

  return (
    <article className="group min-w-0">
      <button
        type="button"
        onClick={openProject}
        className="relative block aspect-[4/3] w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-100 text-left shadow-sm transition hover:border-gray-300 hover:shadow-md dark:border-white/[0.08] dark:bg-gray-900 dark:hover:border-white/[0.16]"
      >
        <ProjectCover task={task} />
        {task?.status === 'running' && (
          <span className="absolute left-3 top-3 rounded bg-white/90 px-2 py-1 text-[11px] font-medium text-gray-700 shadow-sm backdrop-blur dark:bg-gray-950/85 dark:text-gray-200">
            生成中
          </span>
        )}
      </button>
      <div className="mt-3 flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={title}
              maxLength={36}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitTitle()
                if (event.key === 'Escape') {
                  setTitle(project.title)
                  setEditing(false)
                }
              }}
              className="block h-7 w-full rounded border border-gray-300 bg-white px-2 text-sm font-semibold text-gray-900 outline-none focus:border-gray-500 dark:border-white/[0.16] dark:bg-gray-900 dark:text-gray-100"
              aria-label="项目名称"
            />
          ) : (
            <button type="button" onClick={openProject} className="block w-full text-left">
              <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100" title={project.title}>{project.title}</h3>
            </button>
          )}
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            更新于 {new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(project.updatedAt)} · {taskCount} 个作品{isLegacy ? ' · 未保存' : ''}
          </p>
        </div>
        {!isLegacy && <button
          type="button"
          onClick={() => setEditing(true)}
          className="mt-0.5 rounded p-1.5 text-gray-400 opacity-100 transition hover:bg-gray-100 hover:text-gray-700 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
          aria-label={`重命名项目：${project.title}`}
          title="重命名项目"
        >
          <EditIcon className="h-4 w-4" />
        </button>}
        {!isLegacy && <button
          type="button"
          onClick={() => setConfirmDialog({
            title: '移除项目',
            message: '项目中的生成记录会保留在「全部作品」中。确定移除这个项目吗？',
            confirmText: '移除',
            tone: 'danger',
            action: () => void deleteProject(project.id),
          })}
          className="mt-0.5 rounded p-1.5 text-gray-400 opacity-0 transition hover:bg-gray-100 hover:text-red-500 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-white/[0.06]"
          aria-label={`移除项目：${project.title}`}
          title="移除项目"
        >
          <TrashIcon className="h-4 w-4" />
        </button>}
      </div>
    </article>
  )
}

export default function ProjectHome() {
  const { user } = useAuth()
  const projects = useStore((s) => s.projects)
  const projectsLoaded = useStore((s) => s.projectsLoaded)
  const tasks = useStore((s) => s.tasks)
  const createProject = useStore((s) => s.createProject)
  const [prompt, setPrompt] = useState('')
  const [apiKeys, setApiKeys] = useState<string[]>([])
  const [apiKeyItems, setApiKeyItems] = useState<ApiKeyItem[]>([])
  const [apiKey, setApiKey] = useState('')
  const [apiKeysLoading, setApiKeysLoading] = useState(false)
  const [apiKeysError, setApiKeysError] = useState('')
  const [model, setModel] = useState(DEFAULT_IMAGES_MODEL)
  const [submitting, setSubmitting] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const legacyTasks = useMemo(() => tasks.filter((task) => !task.projectId), [tasks])

  const latestTaskByProject = useMemo(() => {
    const latest = new Map<string, TaskRecord>()
    for (const task of [...tasks].sort((a, b) => b.createdAt - a.createdAt)) {
      if (!task.projectId) continue
      const current = latest.get(task.projectId)
      if (!current || (current.outputImages.length === 0 && task.outputImages.length > 0)) {
        latest.set(task.projectId, task)
      }
    }
    return latest
  }, [tasks])
  const latestLegacyTask = useMemo(() => {
    const sorted = [...legacyTasks].sort((a, b) => b.createdAt - a.createdAt)
    return sorted.find((task) => task.outputImages.length > 0) ?? sorted[0]
  }, [legacyTasks])

  const homeApiKeyOptions = useMemo(() => {
    if (apiKeys.length === 0) {
      return [{
        label: apiKeysLoading ? '正在加载 API Key' : apiKeysError ? 'API Key 加载失败' : '没有可用的 API Key',
        value: '',
        description: apiKeysError || '请检查 OIDC Provider 账户',
        icon: HOME_API_KEY_ICON,
      }]
    }

    return [
      {
        label: '选择 API Key',
        value: '',
        description: '用于本次生成请求',
        icon: HOME_API_KEY_ICON,
      },
      ...apiKeys.map((key) => {
        const item = apiKeyItems.find((candidate) => candidate.key === key)
        const keyPreview = key.length > 12 ? `${key.slice(0, 5)}…${key.slice(-4)}` : key
        const label = item?.name || item?.groupName || 'API Key'
        const description = [item?.name ? item.groupName : '', keyPreview].filter(Boolean).join(' · ')
        return { label, value: key, description, icon: HOME_API_KEY_ICON }
      }),
    ]
  }, [apiKeyItems, apiKeys, apiKeysError, apiKeysLoading])
  const legacyProject = useMemo<Project | null>(() => {
    if (legacyTasks.length === 0) return null
    const createdAt = Math.min(...legacyTasks.map((task) => task.createdAt))
    const updatedAt = Math.max(...legacyTasks.map((task) => task.finishedAt ?? task.createdAt))
    return {
      id: LOCAL_PROJECT_ID,
      title: '本地数据',
      initialPrompt: '',
      storage: 'local',
      createdAt,
      updatedAt,
    }
  }, [legacyTasks])

  useEffect(() => {
    if (user == null) {
      setApiKeys([])
      setApiKeyItems([])
      setApiKey('')
      setApiKeysError('')
      setApiKeysLoading(false)
      return
    }

    let cancelled = false
    const run = async () => {
      setApiKeysLoading(true)
      setApiKeysError('')
      try {
        const res = await fetchApiKeys()
        if (cancelled) return
        const keys = res.sub2api_apikeys || []
        setApiKeys(keys)
        setApiKeyItems(res.items || [])
        const cached = readCachedApiKey(user.id)
        setApiKey(cached && keys.includes(cached) ? cached : '')
      } catch (err) {
        if (cancelled) return
        console.error('[ProjectHome] fetchApiKeys failed:', err)
        setApiKeys([])
        setApiKeyItems([])
        setApiKey('')
        setApiKeysError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setApiKeysLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [user])

  useEffect(() => {
    useStore.getState().setOidcApiOverride(apiKey ? { apiKey, model } : { model })
  }, [apiKey, model])

  const setHomeApiKey = (value: string) => {
    setApiKey(value)
    writeCachedApiKey(user?.id, value)
    useStore.getState().setOidcApiOverride(value ? { apiKey: value, model } : { model })
  }

  const startProject = async () => {
    const value = prompt.trim()
    if (!value || submitting) return
    if (apiKey === '') {
      useStore.getState().showToast('请先选择 API Key', 'error')
      return
    }

    setSubmitting(true)
    let projectId: string | null = null
    try {
      const state = useStore.getState()
      const apiOverride = { ...state.oidcApiOverride, apiKey, model }
      state.setOidcApiOverride(apiOverride)
      writeCachedApiKey(user?.id, apiKey)

      projectId = createProject(value)
      updateProjectUrl(projectId)
      const latestState = useStore.getState()
      latestState.clearInputImages()
      latestState.clearMaskDraft()
      latestState.setReusedTaskApiProfile(null)
      latestState.setPrompt(value)
      await submitTask({ apiOverride })
    } finally {
      if (projectId && !useStore.getState().tasks.some((task) => task.projectId === projectId)) {
        await useStore.getState().deleteProject(projectId)
        updateProjectUrl(null, true)
      }
      setSubmitting(false)
    }
  }

  return (
    <main className="safe-area-x mx-auto w-full max-w-7xl px-4 pb-20 sm:px-6">
      <section className="mx-auto flex min-h-[46vh] max-w-4xl flex-col items-center justify-center pb-8 pt-10 text-center sm:min-h-[52vh] sm:pt-16">
        <h1 className="flex items-center justify-center gap-3 text-2xl font-normal leading-tight text-gray-950 dark:text-white sm:text-4xl">
          <img src="/logo.png" alt="" className="h-8 w-8 shrink-0 rounded-lg object-cover sm:h-10 sm:w-10" />
          <span className="font-[Poppins,HarmonyOS_Sans_SC,PingFang_SC,Microsoft_YaHei,sans-serif] tracking-wide">OpenToken 和AI一起设计</span>
        </h1>
        <p className="mt-3 text-lg font-medium text-gray-500 dark:text-gray-400 sm:text-xl">马上开始设计</p>
        <div className="mt-8 w-full rounded-2xl border border-gray-200 bg-white p-2 text-left shadow-[0_18px_60px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.03] dark:border-white/[0.1] dark:bg-gray-900 dark:shadow-[0_18px_60px_rgba(0,0,0,0.35)] dark:ring-white/[0.04] sm:rounded-3xl sm:p-3">
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void startProject()
              }
            }}
            rows={3}
            placeholder="描述你想生成的画面..."
            className="block min-h-28 w-full resize-none bg-transparent px-3 py-3 text-base leading-7 text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-600 sm:px-4 sm:text-lg"
          />
          <div className="flex flex-wrap items-center gap-2 px-1 pb-1 sm:px-2">
            <div className="min-w-0 w-48 max-w-full shrink-0">
              <Select
                value={model}
                onChange={(value) => setModel(String(value))}
                options={HOME_MODEL_OPTIONS}
                className="h-11 rounded-xl border border-transparent bg-gray-50 px-2.5 text-sm font-semibold leading-4 text-gray-800 transition hover:border-gray-200 hover:bg-gray-100 dark:bg-white/[0.05] dark:text-gray-100 dark:hover:border-white/[0.08] dark:hover:bg-white/[0.08]"
                menuClassName="!py-0"
              />
            </div>
            <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
              <div className="min-w-0 w-44 shrink-0 sm:w-48">
                <Select
                  value={apiKey}
                  onChange={(value) => setHomeApiKey(String(value))}
                  disabled={apiKeysLoading || apiKeys.length === 0}
                  options={homeApiKeyOptions}
                  className="h-11 rounded-xl border border-transparent bg-gray-50 px-2.5 text-xs font-semibold leading-4 text-gray-800 transition hover:border-gray-200 hover:bg-gray-100 dark:bg-white/[0.05] dark:text-gray-100 dark:hover:border-white/[0.08]"
                  menuClassName="!py-0"
                />
              </div>
              <button
                type="button"
                onClick={() => void startProject()}
                disabled={!prompt.trim() || submitting}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-950 text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200 dark:disabled:bg-gray-800 dark:disabled:text-gray-600"
                aria-label="创建项目并开始生成"
                title="创建项目并开始生成"
              >
                <ArrowUpIcon className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="recent-projects-title">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h2 id="recent-projects-title" className="text-xl font-semibold text-gray-950 dark:text-white">最近项目</h2>
            <p className="mt-1 text-sm text-gray-400 dark:text-gray-500">继续上次的创作</p>
          </div>
          <span className="text-sm tabular-nums text-gray-400 dark:text-gray-500">{projects.length + (legacyProject ? 1 : 0)}</span>
        </div>

        {projectsLoaded && (
          <div className="grid grid-cols-1 gap-x-5 gap-y-9 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <article className="group min-w-0">
              <button
                type="button"
                onClick={() => {
                  promptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  window.setTimeout(() => promptRef.current?.focus(), 300)
                }}
                className="flex aspect-[4/3] w-full items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 text-gray-400 transition hover:border-gray-400 hover:bg-gray-100 hover:text-gray-800 dark:border-white/[0.14] dark:bg-white/[0.025] dark:text-gray-600 dark:hover:border-white/[0.24] dark:hover:bg-white/[0.05] dark:hover:text-gray-200"
                aria-label="新建项目"
                title="新建项目"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-full border border-current">
                  <PlusIcon className="h-5 w-5" />
                </span>
              </button>
              <h3 className="mt-3 text-sm font-semibold text-gray-700 dark:text-gray-300">新建项目</h3>
            </article>
            {legacyProject && <ProjectCard project={legacyProject} task={latestLegacyTask} isLegacy />}
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} task={latestTaskByProject.get(project.id)} />
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
