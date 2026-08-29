import { useEffect, useRef, useState } from 'react'
import { LOCAL_PROJECT_ID, useStore } from '../store'
import { useVersionCheck } from '../hooks/useVersionCheck'
import { useTooltip } from '../hooks/useTooltip'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import { updateWorkspaceUrl } from '../lib/projectRoute'
import ViewportTooltip from './ViewportTooltip'
import HistoryModal from './HistoryModal'
import AnnouncementHistoryModal from './AnnouncementHistoryModal'
import { useFavoriteCollectionTitle } from './FavoriteCollections'
import { BellIcon, EditIcon, HistoryIcon, InstallIcon, SettingsIcon } from './icons'
import UserMenu from '../auth/UserMenu'
import { useAuth } from '../auth/AuthContext'
import { ProjectBalance } from './ProjectApiControls'
import type { AppView } from './AppSidebar'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function isInstalledPwa() {
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true
}

export default function Header({ view = 'workspace', onNavigate }: { view?: AppView; onNavigate?: (view: AppView) => void } = {}) {
  const appMode = useStore((s) => s.appMode)
  const setAppMode = useStore((s) => s.setAppMode)
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const setActiveProjectId = useStore((s) => s.setActiveProjectId)
  const renameProject = useStore((s) => s.renameProject)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const agentMobileHeaderVisible = useStore((s) => s.agentMobileHeaderVisible)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const activeProject = projects.find((project) => project.id === activeProjectId)
  const activeProjectTitle = activeProjectId === LOCAL_PROJECT_ID ? '本地数据' : activeProject?.title
  const isProjectPage = view === 'workspace' && activeProjectId !== null
  const favoriteCollectionTitle = useFavoriteCollectionTitle()
  const showFavoriteCollectionTitle = appMode === 'gallery' && Boolean(activeFavoriteCollectionId)
  const { hasUpdate, latestRelease, dismiss } = useVersionCheck()
  // 新版本 NEW 徽标只给管理员看：普通用户/未登录/未启用认证都不显示
  const { user } = useAuth()
  const showUpdateBadge = hasUpdate && !!latestRelease && !!user?.is_admin
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isPwaInstalled, setIsPwaInstalled] = useState(isInstalledPwa)
  const [hintVisible, setHintVisible] = useState(false)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [showAnnouncementHistory, setShowAnnouncementHistory] = useState(false)
  const [editingProjectName, setEditingProjectName] = useState(false)
  const [projectName, setProjectName] = useState('')
  const historyButtonRef = useRef<HTMLButtonElement>(null)
  const createConversation = useStore((s) => s.createAgentConversation)

  useEffect(() => {
    setEditingProjectName(false)
    setProjectName(activeProject?.title ?? '')
  }, [activeProject?.id, activeProject?.title])

  const commitProjectName = () => {
    const value = projectName.trim()
    if (activeProject && value) renameProject(activeProject.id, value)
    else setProjectName(activeProject?.title ?? '')
    setEditingProjectName(false)
  }

  const cancelProjectName = () => {
    setProjectName(activeProject?.title ?? '')
    setEditingProjectName(false)
  }

  const openHome = () => {
    onNavigate?.('workspace')
    setActiveProjectId(null)
    updateWorkspaceUrl(null, true)
  }


  useEffect(() => {
    if (appMode === 'agent' && !agentMobileHeaderVisible) {
      setHintVisible(true)
      const timer = setTimeout(() => {
        setHintVisible(false)
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [appMode, agentMobileHeaderVisible])

  const installTooltip = useTooltip()
  const announcementTooltip = useTooltip()
  const settingsTooltip = useTooltip()

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
      setIsPwaInstalled(false)
    }

    const handleAppInstalled = () => {
      setInstallPrompt(null)
      setIsPwaInstalled(true)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
    }
  }, [])

  const handleInstallClick = async () => {
    if (installPrompt) {
      const promptEvent = installPrompt
      setInstallPrompt(null)

      try {
        await promptEvent.prompt()
        const choice = await promptEvent.userChoice
        setIsPwaInstalled(choice.outcome === 'accepted')
      } catch {
        setIsPwaInstalled(isInstalledPwa())
      }
    } else {
      const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      if (isIos) {
        setConfirmDialog({
          title: '安装为应用',
          message: '在 Safari 浏览器中，点击底部「分享」按钮，选择「添加到主屏幕」即可安装此应用。',
          showCancel: false,
          confirmText: '我知道了',
          icon: 'info',
          action: () => {},
        })
      } else {
        setConfirmDialog({
          title: '安装为应用',
          message: '请在浏览器的菜单中选择「添加到主屏幕」或「安装应用」。\n\n（如果在微信等内置浏览器中，请先在外部浏览器打开）',
          showCancel: false,
          confirmText: '我知道了',
          icon: 'info',
          action: () => {},
        })
      }
    }
  }

  return (
    <>
      <header data-no-drag-select className={`safe-area-top fixed top-0 left-0 right-0 z-40 bg-white/80 dark:bg-gray-950/80 backdrop-blur border-b border-gray-200 dark:border-white/[0.08] transition-transform duration-300 ease-in-out ${appMode === 'agent' && !agentMobileHeaderVisible ? '-translate-y-full sm:translate-y-0' : 'translate-y-0'}`}>
        <div className={`safe-area-x safe-header-inner flex items-center justify-between relative ${isProjectPage ? 'w-full max-w-none' : 'max-w-7xl mx-auto'}`}>
          <div className="flex-1 min-w-0 pr-2 flex items-center gap-2">
            <h1 className="inline-flex min-w-0 items-center relative mr-2 gap-2">
              <img src="/logo.png" alt="" className="h-6 w-6 shrink-0 rounded-md object-cover sm:h-7 sm:w-7" />
              {showFavoriteCollectionTitle ? (
                <>
                  <span className="min-w-0 truncate text-[17px] font-bold tracking-tight text-gray-800 dark:text-gray-100 sm:hidden" title={favoriteCollectionTitle}>{favoriteCollectionTitle}</span>
                  <button
                    type="button"
                    onClick={openHome}
                    className="hidden text-lg font-bold tracking-tight text-gray-800 transition-colors hover:text-gray-600 dark:text-gray-100 dark:hover:text-gray-300 sm:inline"
                  >
                  {view === 'materials' ? '素材库' : view === 'admin' ? '公告管理' : 'OpenToken Images'}
                  </button>
                </>
              ) : (
                <>
                  {activeProject ? (
                    <div className="flex min-w-0 items-center gap-1 sm:hidden">
                      {editingProjectName ? (
                        <div className="flex min-w-0 flex-1 items-center gap-1">
                          <input
                            autoFocus
                            value={projectName}
                            maxLength={36}
                            onChange={(event) => setProjectName(event.target.value)}
                            onBlur={commitProjectName}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') commitProjectName()
                              if (event.key === 'Escape') cancelProjectName()
                            }}
                            className="h-8 min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 text-sm font-semibold text-gray-900 outline-none dark:border-white/[0.16] dark:bg-gray-900 dark:text-gray-100"
                            aria-label="项目名称"
                          />
                          <div className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              data-project-name-action
                              onPointerDown={(event) => event.preventDefault()}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={commitProjectName}
                              className="rounded px-1.5 py-1 text-xs font-medium text-green-600 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-500/10"
                            >
                              确定
                            </button>
                            <button
                              type="button"
                              data-project-name-action
                              onPointerDown={(event) => event.preventDefault()}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={cancelProjectName}
                              className="rounded px-1.5 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/[0.08]"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <span className="max-w-36 truncate text-[17px] font-bold text-gray-800 dark:text-gray-100" title={activeProject.title}>{activeProject.title}</span>
                      )}
                      {!editingProjectName && <button
                        type="button"
                        onClick={() => setEditingProjectName(true)}
                        className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                        aria-label="重命名项目"
                        title="重命名项目"
                      >
                        <EditIcon className="h-4 w-4" />
                      </button>}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={openHome}
                    className={`${activeProject ? 'hidden sm:inline' : ''} min-w-0 max-w-full truncate whitespace-nowrap text-[17px] font-bold tracking-tight text-gray-800 transition-colors hover:text-gray-600 dark:text-gray-100 dark:hover:text-gray-300 sm:text-lg`}
                  >
                    {view === 'materials' ? '素材库' : view === 'admin' ? '公告管理' : 'OpenToken Images'}
                  </button>
                </>
              )}
              {showUpdateBadge && (
                <a
                  href={latestRelease!.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={dismiss}
                  className="absolute -right-1 -top-1 translate-x-full -translate-y-1/4 px-1 py-0.5 rounded-[4px] border border-red-500/30 text-[9px] font-black bg-red-500 text-white hover:bg-red-600 transition-all animate-fade-in leading-none shadow-sm"
                  title={`新版本 ${latestRelease!.tag}`}
                >
                  NEW
                </a>
              )}
            </h1>
            {appMode === 'agent' && <div className="hidden sm:flex items-center gap-1 relative">
              <button
                ref={historyButtonRef}
                type="button"
                onClick={() => setShowHistoryModal((visible) => !visible)}
                className="p-1.5 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.04] rounded-lg transition-colors"
                title="历史任务"
              >
                <HistoryIcon className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setAppMode('agent')
                  createConversation()
                }}
                className="p-1.5 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.04] rounded-lg transition-colors"
                title="新对话"
              >
                <EditIcon className="w-5 h-5" />
              </button>
              {showHistoryModal && (
                <HistoryModal onClose={() => setShowHistoryModal(false)} ignoreOutsideClickRef={historyButtonRef} />
              )}
            </div>}
          </div>
          {activeProjectTitle && !showFavoriteCollectionTitle && (
            <div className="absolute left-1/2 top-1/2 hidden max-w-[30%] -translate-x-1/2 -translate-y-1/2 sm:flex">
              {activeProject && editingProjectName ? (
                <div className="flex max-w-full items-center gap-1">
                  <input
                    autoFocus
                    value={projectName}
                    maxLength={36}
                    onChange={(event) => setProjectName(event.target.value)}
                    onBlur={commitProjectName}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitProjectName()
                      if (event.key === 'Escape') cancelProjectName()
                    }}
                    className="h-8 min-w-0 w-48 flex-1 rounded border border-gray-300 bg-white px-2 text-center text-sm font-semibold text-gray-900 outline-none dark:border-white/[0.16] dark:bg-gray-900 dark:text-gray-100"
                    aria-label="项目名称"
                  />
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      data-project-name-action
                      onPointerDown={(event) => event.preventDefault()}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={commitProjectName}
                      className="rounded px-2 py-1 text-xs font-medium text-green-600 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-500/10"
                    >
                      确定
                    </button>
                    <button
                      type="button"
                      data-project-name-action
                      onPointerDown={(event) => event.preventDefault()}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={cancelProjectName}
                      className="rounded px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/[0.08]"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-1">
                  <div className="truncate rounded px-2 py-1 text-sm font-semibold text-gray-700 dark:text-gray-300" title={activeProjectTitle}>
                    {activeProjectTitle}
                  </div>
                  {activeProject && <button
                    type="button"
                    onClick={() => setEditingProjectName(true)}
                    className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                    aria-label="重命名项目"
                    title="重命名项目"
                  >
                    <EditIcon className="h-3.5 w-3.5" />
                  </button>}
                </div>
              )}
            </div>
          )}
          {showFavoriteCollectionTitle && (
            <div className="absolute left-1/2 top-1/2 hidden max-w-[30%] -translate-x-1/2 -translate-y-1/2 sm:flex">
              <div className="truncate rounded px-2 py-1 text-sm font-semibold text-gray-700 dark:text-gray-300" title={favoriteCollectionTitle}>
                {favoriteCollectionTitle}
              </div>
            </div>
          )}
          <div className="flex items-center gap-1 shrink-0">
            {user && <div
              className="relative"
              {...announcementTooltip.handlers}
            >
              <button
                type="button"
                onClick={() => {
                  dismissAllTooltips()
                  setShowAnnouncementHistory(true)
                }}
                className="rounded-lg p-2 transition-colors hover:bg-gray-100 dark:hover:bg-gray-900"
                aria-label="公告"
              >
                <BellIcon className="h-5 w-5 text-gray-600 dark:text-gray-400" />
              </button>
              <ViewportTooltip visible={announcementTooltip.visible} className="whitespace-nowrap">
                公告
              </ViewportTooltip>
            </div>}
            {!isPwaInstalled && (
              <div
                className="relative"
                {...installTooltip.handlers}
              >
                <button
                  onClick={() => {
                    dismissAllTooltips()
                    handleInstallClick()
                  }}
                  className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                  aria-label="安装为应用"
                >
                  <InstallIcon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                </button>
                <ViewportTooltip visible={installTooltip.visible} className="whitespace-nowrap">
                  安装为应用
                </ViewportTooltip>
              </div>
            )}
            <div
              className="relative"
              {...settingsTooltip.handlers}
            >
              <button
                onClick={() => setShowSettings(true)}
                className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                aria-label="设置"
              >
                <SettingsIcon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
              </button>
              <ViewportTooltip visible={settingsTooltip.visible} className="whitespace-nowrap">
                设置
              </ViewportTooltip>
            </div>
            {user && <ProjectBalance />}
            <UserMenu />
          </div>
        </div>
      </header>
      
      {/* Hint for sliding down */}
      <div className={`fixed top-0 left-0 right-0 z-30 flex justify-center pointer-events-none transition-all duration-300 ease-in-out sm:hidden ${appMode === 'agent' && hintVisible && !agentMobileHeaderVisible ? 'translate-y-[env(safe-area-inset-top,0px)] opacity-100' : '-translate-y-full opacity-0'}`}>
        <div className="bg-black/60 backdrop-blur-sm text-white text-xs px-3 py-1.5 rounded-b-xl shadow-lg">
          下拉展示顶栏
        </div>
      </div>

      <div className={`safe-area-top invisible pointer-events-none transition-all duration-300 ease-in-out ${appMode === 'agent' && !agentMobileHeaderVisible ? 'max-h-0 sm:max-h-[500px] opacity-0 sm:opacity-100 overflow-hidden sm:overflow-visible' : 'max-h-[500px] opacity-100'}`} aria-hidden="true">
        <div className="safe-header-inner" />
      </div>
      {showAnnouncementHistory && <AnnouncementHistoryModal onClose={() => setShowAnnouncementHistory(false)} />}
    </>
  )
}
