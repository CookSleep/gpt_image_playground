import { useEffect } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { normalizeBaseUrl } from './lib/api'
import type { ApiMode } from './types'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import ImageContextMenu from './components/ImageContextMenu'
import { isApplyingWebDavSnapshot, scheduleWebDavSync, setupWebDavAutoSync, syncWebDavOnLaunch } from './lib/webdavSync'

export default function App() {
  const setSettings = useStore((s) => s.setSettings)

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings: { baseUrl?: string; apiKey?: string; codexCli?: boolean; apiMode?: ApiMode } = {}

    const apiUrlParam = searchParams.get('apiUrl')
    if (apiUrlParam !== null) {
      nextSettings.baseUrl = normalizeBaseUrl(apiUrlParam.trim())
    }

    const apiKeyParam = searchParams.get('apiKey')
    if (apiKeyParam !== null) {
      nextSettings.apiKey = apiKeyParam.trim()
    }

    const codexCliParam = searchParams.get('codexCli')
    if (codexCliParam !== null) {
      nextSettings.codexCli = codexCliParam.trim().toLowerCase() === 'true'
    }

    const apiModeParam = searchParams.get('apiMode')
    if (apiModeParam === 'images' || apiModeParam === 'responses') {
      nextSettings.apiMode = apiModeParam
    }

    if (searchParams.has('apiUrl') || searchParams.has('apiKey') || searchParams.has('codexCli') || searchParams.has('apiMode')) {
      setSettings(nextSettings)
      searchParams.delete('apiUrl')
      searchParams.delete('apiKey')
      searchParams.delete('codexCli')
      searchParams.delete('apiMode')

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    let disposed = false
    let unsubscribeStore: (() => void) | null = null
    let cleanupAutoSync: (() => void) | null = null

    void (async () => {
      await initStore()
      await syncWebDavOnLaunch()

      if (disposed) return

      cleanupAutoSync = setupWebDavAutoSync()
      unsubscribeStore = useStore.subscribe((state, prevState) => {
        if (isApplyingWebDavSnapshot()) return
        if (state.settings.storageMode !== 'webdav') return
        if (!state.settings.webdav.url.trim()) return

        const tasksChanged = state.tasks !== prevState.tasks
        const settingsChanged =
          state.settings !== prevState.settings &&
          (
            state.settings.baseUrl !== prevState.settings.baseUrl ||
            state.settings.apiKey !== prevState.settings.apiKey ||
            state.settings.model !== prevState.settings.model ||
            state.settings.timeout !== prevState.settings.timeout ||
            state.settings.apiMode !== prevState.settings.apiMode ||
            state.settings.codexCli !== prevState.settings.codexCli ||
            state.settings.storageMode !== prevState.settings.storageMode ||
            state.settings.webdav.url !== prevState.settings.webdav.url ||
            state.settings.webdav.username !== prevState.settings.webdav.username ||
            state.settings.webdav.password !== prevState.settings.webdav.password ||
            state.settings.webdav.syncOnStartup !== prevState.settings.webdav.syncOnStartup
          )

        if (tasksChanged || settingsChanged) {
          scheduleWebDavSync()
        }
      })
    })()

    return () => {
      disposed = true
      unsubscribeStore?.()
      cleanupAutoSync?.()
    }
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
      <Header />
      <main className="max-w-7xl mx-auto px-4 pb-48">
        <SearchBar />
        <TaskGrid />
      </main>
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <Toast />
      <ImageContextMenu />
    </>
  )
}
