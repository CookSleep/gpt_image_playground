import { useEffect, useState } from 'react'
import { LOCAL_PROJECT_ID, initStore, useStore } from './store'
import { activateFirstImportedProfile, buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { isDefaultConfigOnlyEnabled, mergeImportedSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, loadCustomProviderSettingsFromUrl } from './lib/customProviderConfigUrl'
import { getAppViewFromUrl, getProjectIdFromUrl, updateMaterialsUrl, updateWorkspaceUrl } from './lib/projectRoute'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import type { AppSettings } from './types'
import Header from './components/Header'
import ProjectHome from './components/ProjectHome'
import LegacyProjectToolbar from './components/LegacyProjectToolbar'
import SearchBar from './components/SearchBar'
import { ProjectApiKeySelect } from './components/ProjectApiControls'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import AppSidebar, { type AppView } from './components/AppSidebar'
import MaterialLibrary from './components/MaterialLibrary'
import SupportPromptModal from './components/SupportPromptModal'
import { FavoriteCollectionPickerModal, FavoriteCollectionsView, ManageCollectionsModal } from './components/FavoriteCollections'
import { useGlobalClickSuppression } from './lib/clickSuppression'
import { ChevronLeftIcon } from './components/icons'

let customProviderConfigUrlImportStarted = false

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const appMode = useStore((s) => s.appMode)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(false)
  const [view, setView] = useState<AppView>(() => getAppViewFromUrl())

  const navigateView = (nextView: AppView) => {
    setView(nextView)
    if (nextView === 'materials') {
      useStore.getState().setActiveProjectId(null)
      updateMaterialsUrl()
      return
    }
    useStore.getState().setActiveProjectId(null)
    updateWorkspaceUrl(null)
  }

  useEffect(() => {
    setAgentPanelCollapsed(false)
  }, [activeProjectId])
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    const syncProjectFromUrl = () => {
      setView(getAppViewFromUrl())
      useStore.getState().setActiveProjectId(getProjectIdFromUrl())
    }

    syncProjectFromUrl()
    window.addEventListener('popstate', syncProjectFromUrl)
    return () => window.removeEventListener('popstate', syncProjectFromUrl)
  }, [])

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const customProviderConfigUrl = getCustomProviderConfigUrl()
    const defaultConfigOnly = isDefaultConfigOnlyEnabled()

    const applyUrlSettings = (baseSettings: Partial<AppSettings>) => {
      const nextSettings = buildSettingsFromUrlParams(baseSettings, searchParams)
      return Object.keys(nextSettings).length ? nextSettings : baseSettings
    }

    const clearAppliedUrlSettings = () => {
      if (!hasUrlSettingParams(searchParams)) return

      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    if (customProviderConfigUrl && defaultConfigOnly && !customProviderConfigUrlImportStarted) {
      customProviderConfigUrlImportStarted = true
      void loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
        .then((importedSettings) => {
          const state = useStore.getState()
          const baseSettings = importedSettings
            ? activateFirstImportedProfile(mergeImportedSettings(state.settings, importedSettings), importedSettings)
            : state.settings
          state.setSettings(applyUrlSettings(baseSettings))
          clearAppliedUrlSettings()
        })
        .catch((error) => {
          console.warn('Failed to import custom provider config URL:', error)
          const state = useStore.getState()
          state.setSettings(applyUrlSettings(state.settings))
          clearAppliedUrlSettings()
        })

      initStore()
      return
    }

    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    clearAppliedUrlSettings()

    if (customProviderConfigUrl && !customProviderConfigUrlImportStarted) {
      customProviderConfigUrlImportStarted = true
      void loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
        .then((importedSettings) => {
          if (!importedSettings) return
          const state = useStore.getState()
          state.setSettings(mergeImportedSettings(state.settings, importedSettings))
        })
        .catch((error) => {
          console.warn('Failed to import custom provider config URL:', error)
        })
    }

    initStore()
  }, [setSettings])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  return (
    <>
      <Header view={view} onNavigate={navigateView} />
      <AppSidebar view={view} onChange={navigateView} />
      {view === 'materials' ? (
        <div data-material-library-root data-drag-select-surface className="min-h-[calc(100vh-4rem)] pt-11 lg:pl-56 lg:pt-0">
          <MaterialLibrary />
        </div>
      ) : (
        <div className="pt-11 lg:pl-56 lg:pt-0">
          {activeProjectId === null ? <ProjectHome /> : (
        <div data-project-workspace data-drag-select-surface className="relative min-h-[calc(100vh-4rem)] w-full">
          <div className={`safe-area-x mx-auto grid w-full max-w-[1600px] ${agentPanelCollapsed ? 'xl:grid-cols-1' : 'xl:grid-cols-[minmax(0,1fr)_420px] xl:gap-4'}`}>
            <main
              data-home-main
              data-drag-select-surface
              className={`${appMode === 'agent' ? 'hidden xl:block' : ''} relative min-h-[calc(100vh-4rem)] min-w-0 pb-48`}
            >
              <div className="mt-6 mb-4 flex min-w-0 items-center gap-3">
                <div className="min-w-0 flex-1">
                  <SearchBar className="m-0" />
                </div>
                <ProjectApiKeySelect />
              </div>
              {activeProjectId === LOCAL_PROJECT_ID && <LegacyProjectToolbar />}
              {filterFavorite && !activeFavoriteCollectionId ? <FavoriteCollectionsView /> : <TaskGrid />}
            </main>
            {!agentPanelCollapsed && <div data-no-drag-select className={`${appMode === 'gallery' ? 'hidden xl:block' : ''} relative min-w-0 border-gray-200 xl:border-l dark:border-white/[0.08] xl:fixed xl:right-0 xl:top-14 xl:bottom-0 xl:z-30 xl:w-[420px] xl:overflow-hidden`}>
              <AgentWorkspace embedded onCollapse={() => setAgentPanelCollapsed(true)} />
              {appMode === 'agent' && <InputBar hideApiKeyBalance hideModeToggle />}
              {appMode === 'gallery' && (
                <div className="hidden xl:block">
                  <InputBar embeddedAgent hideApiKeyBalance hideModeToggle moveModelToAttachment />
                </div>
              )}
            </div>}
            {agentPanelCollapsed && (
              <button
                type="button"
                onClick={() => setAgentPanelCollapsed(false)}
                className="fixed right-0 top-16 z-30 rounded-l-lg border border-r-0 border-gray-200 bg-white/90 p-2 text-gray-500 shadow-sm backdrop-blur transition-colors hover:bg-gray-100 hover:text-gray-800 dark:border-white/[0.08] dark:bg-gray-900/90 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
                title="展开 Agent"
                aria-label="展开 Agent"
              >
                <ChevronLeftIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
          )}
        </div>
      )}
      {view === 'workspace' && activeProjectId !== null && appMode !== 'agent' && <InputBar hideApiKeyBalance hideModeToggle moveModelToAttachment hideModeration />}
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <SupportPromptModal />
      <FavoriteCollectionPickerModal />
      <ManageCollectionsModal />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
