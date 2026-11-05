import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { SkillInfo } from './types'
import { initStore, useStore } from './store'
import { clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { createDefaultOpenAIProfile, hasDefaultPresetConfig, isAgentTextApiProfile, normalizeSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, hasEmbeddedDefaultConfig, loadCustomProviderSettingsFromUrl, loadEmbeddedDefaultConfig } from './lib/customProviderConfigUrl'
import { getDefaultPresetProfileId, getPresetProfileIds, isPresetConfigOnlyEnabled, setPresetConfig } from './lib/presetConfig'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import { useAppFonts } from './hooks/useAppFonts'
import { useColorMode } from './hooks/useColorMode'
import { useCloseConfirm } from './hooks/useCloseConfirm'
import { promptImportLink, useImportLinks } from './hooks/useImportLinks'
import { useAutoUpdateCheck } from './hooks/useReleaseUpdates'
import { useSaveLocationPrompt } from './hooks/useSaveLocationPrompt'
import { usePrivacyModeShortcut } from './hooks/usePrivacyMode'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import UpdateModal from './components/UpdateModal'
import ConfirmDialog from './components/ConfirmDialog'
import DataProgressDialog from './components/DataProgressDialog'
import Toast from './components/Toast'
import DbBlockedNotice from './components/DbBlockedNotice'
import MaskEditorModal from './components/MaskEditorModal'
import SketchBoardModal from './components/SketchBoardModal'
import TitleBar from './components/TitleBar'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import AnnouncementModal from './components/AnnouncementModal'
import { preloadMarkdownRenderer } from './components/MarkdownRenderer'
import { SKILL_LABEL } from './components/settings/SkillSettingsSection'
import { FavoriteCollectionPickerModal, FavoriteCollectionsView, ManageCollectionsModal } from './components/FavoriteCollections'
import { showStartupNotices, type NoticeSection } from './components/startupNotice'
import { useGlobalClickSuppression } from './lib/clickSuppression'
import { takeDataDirNotice } from './lib/dbTauri'
import { installCliBridge } from './lib/cliBridge'
import { isTauri, TITLEBAR_HEIGHT } from './lib/platform'
import { setSaveToDefaultDir } from './lib/saveFile'
import { setTauriLogEnabled } from './lib/tauriLog'
import { getTauriStorageLoadError } from './lib/tauriStorage'

let defaultConfigImportStarted = false

export default function App() {
  const appMode = useStore((s) => s.appMode)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const writeLogFile = useStore((s) => s.settings.writeLogFile)
  const saveLocationMode = useStore((s) => s.settings.saveLocationMode)
  const autoCheckUpdate = useStore((s) => s.settings.autoCheckUpdate)
  const privacyModeEpoch = useStore((s) => s.privacyModeEpoch)
  const settingsModalEpoch = useStore((s) => s.settingsModalEpoch)
  const [startupImportDone, setStartupImportDone] = useState(false)
  useDockerApiUrlMigrationNotice()
  useAppFonts()
  useColorMode()
  useGlobalClickSuppression()
  useCloseConfirm()
  useSaveLocationPrompt()
  useAutoUpdateCheck(autoCheckUpdate)
  usePrivacyModeShortcut()
  // 运行中的链接导入要等启动时的预置配置写入完，否则会被启动流程覆盖
  useImportLinks(startupImportDone)

  useEffect(() => {
    if (isTauri) return installCliBridge()
  }, [])

  useEffect(() => {
    if (!isTauri) return
    // 安装的 Skill 是复制过去的，不会随客户端升级；启动时把内容已过时的更新为当前版本，未安装的不处理
    void invoke<SkillInfo>('skill_info')
      .then(async (info) => {
        const outdated = info.skills.filter((s) => s.state === 'outdated')
        if (!outdated.length) return
        // 各处分别更新，一处失败不影响另一处；失败时原有的 Skill 保持不变
        const failed: string[] = []
        for (const s of outdated) {
          try {
            await invoke('skill_install', { target: s.id })
          } catch (err) {
            console.warn(`自动更新 ${SKILL_LABEL[s.id]} 的 Skill 失败：`, err)
            failed.push(SKILL_LABEL[s.id])
          }
        }
        useStore.getState().showToast(
          failed.length ? `Skill 自动更新失败（${failed.join('、')}），可在「设置 → Skill」中手动更新` : 'Skill 已更新到当前版本',
          failed.length ? 'error' : 'success',
        )
      })
      .catch((err) => console.warn('读取 Skill 的安装状态失败：', err))
  }, [])

  useEffect(() => {
    if (!('requestIdleCallback' in window)) {
      const timer = setTimeout(preloadMarkdownRenderer, 1_000)
      return () => clearTimeout(timer)
    }
    const id = window.requestIdleCallback(preloadMarkdownRenderer, { timeout: 3_000 })
    return () => window.cancelIdleCallback(id)
  }, [])

  useEffect(() => {
    if (!isTauri) return
    // 启动时的提示合并到一个弹窗中，避免后到的覆盖先到的：存储无法使用的原因，以及更改数据目录的结果
    void takeDataDirNotice()
      .catch((err) => {
        console.error('读取数据目录提示失败：', err)
        return { notices: [], custom: false }
      })
      .then(({ notices, custom }) => {
        const state = useStore.getState()
        const success = notices.find((notice) => notice.kind === 'success')
        if (success) state.showToast(success.message, 'success')
        const sections: NoticeSection[] = []
        const err = getTauriStorageLoadError()
        if (err) {
          // unavailable 涵盖目录不可写、数据库版本过高、版本信息损坏、无法打开数据库等，按 Rust 侧的说明区分建议
          const unavailable = err.code === 'unavailable'
          const advice = !unavailable
            ? '读取设置时数据库出错，可能已损坏。可以先在「设置 → 数据管理」中尝试导出备份，再反馈问题。'
            : err.message.includes('不可写')
              ? custom
                ? '请在「设置 → 数据管理」中把数据目录改到有写权限的位置。'
                : '可能装在了需要管理员权限的位置，比如 C:\\Program Files。可以重新安装到其他位置，或在「设置 → 数据管理」中更改数据目录。'
              : err.message.includes('高于当前客户端')
                ? '数据目录由更新版本的客户端创建，请升级到最新版本的客户端后再打开。'
                : '数据库可能被其他程序占用或已损坏，关闭相关程序后重启再尝试。'
          sections.push({
            title: '无法保存数据',
            message: unavailable
              ? '数据目录无法使用，这次的改动不会被保存。'
              : '读取设置失败，当前是默认设置，这次的改动不会被保存。',
            details: [`原因：${err.message}`, advice],
          })
        }
        sections.push(...notices.filter((notice) => notice.kind === 'warning'))
        showStartupNotices(sections)
      })
  }, [])

  useEffect(() => {
    if (isTauri) setTauriLogEnabled(writeLogFile)
  }, [writeLogFile])

  useEffect(() => {
    // 网页版始终由浏览器下载，忽略备份中带来的该设置
    setSaveToDefaultDir(isTauri && saveLocationMode === 'default')
  }, [saveLocationMode])

  useEffect(() => {
    if (defaultConfigImportStarted) return
    defaultConfigImportStarted = true

    // 链接中的设置参数先取出留待确认，再立即从地址栏清除，避免刷新后再次提示或密钥留在地址栏
    const searchParams = new URLSearchParams(window.location.search)
    const importParams = hasUrlSettingParams(searchParams) ? new URLSearchParams(searchParams) : null
    if (importParams) {
      clearUrlSettingParams(searchParams)
      const nextSearch = searchParams.toString()
      window.history.replaceState(null, '', `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`)
    }

    const customProviderConfigUrl = getCustomProviderConfigUrl()
    const embeddedDefaultConfig = hasEmbeddedDefaultConfig()
    const loadDefaultConfig = () => embeddedDefaultConfig
      ? Promise.resolve().then(() => loadEmbeddedDefaultConfig())
      : loadCustomProviderSettingsFromUrl(customProviderConfigUrl)

    void initStore()
      .then(async () => {
        const importedSettings = embeddedDefaultConfig || customProviderConfigUrl
          ? await loadDefaultConfig()
          : hasDefaultPresetConfig()
            ? {
                customProviders: [],
                profiles: [{ ...createDefaultOpenAIProfile(), isDefault: true }],
              }
            : null
        setPresetConfig(importedSettings)

        const state = useStore.getState()
        if (importedSettings) {
          await state.setPresetImportedSettings(importedSettings)
        } else if (state.previousPresetConfig) {
          await state.setPresetImportedSettings({ customProviders: [], profiles: [] })
        }

        const syncedState = useStore.getState()
        if (!importedSettings) {
          useStore.setState({ dismissedPresetProfileIds: [], dismissedPresetProviderIds: [] })
          if (syncedState.settings.profiles.some((profile) => profile.isDefault)) {
            syncedState.setSettings({
              profiles: syncedState.settings.profiles.map((profile) => profile.isDefault ? { ...profile, isDefault: undefined } : profile),
            })
          }
        }

        const current = useStore.getState()
        const presetIds = getPresetProfileIds()
        const defaultPresetId = getDefaultPresetProfileId()
        const settings = isPresetConfigOnlyEnabled()
          ? normalizeSettings({
              ...current.settings,
              activeProfileId: presetIds.has(current.settings.activeProfileId)
                ? current.settings.activeProfileId
                : defaultPresetId ?? [...presetIds][0],
              agentTextProfileId: current.settings.agentTextProfileId && presetIds.has(current.settings.agentTextProfileId)
                ? current.settings.agentTextProfileId
                : current.settings.profiles.find((profile) => presetIds.has(profile.id) && isAgentTextApiProfile(profile))?.id ?? null,
              agentImageProfileId: current.settings.agentImageProfileId && presetIds.has(current.settings.agentImageProfileId)
                ? current.settings.agentImageProfileId
                : defaultPresetId ?? [...presetIds][0],
            })
          : current.settings
        current.setSettings(settings)
      })
      .catch((error) => {
        console.warn('Failed to import preset config:', error)
        setPresetConfig(null)
      })
      .finally(() => {
        // 不等待用户确认，客户端的剪贴板和 deep link 监听依赖它
        setStartupImportDone(true)
        // 预置配置写入后再提示，确认框按导入前的实际设置描述变化
        if (importParams) promptImportLink(importParams, true)
      })
  }, [])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  // 进入隐私模式时重新挂载带有内部弹窗或菜单的组件，直接丢弃其中未保存的内容
  return (
    <>
      <div data-page-scroll>
        <Header />
        {appMode === 'agent' ? (
          <AgentWorkspace />
        ) : (
          <main data-home-main data-drag-select-surface className="pb-48">
            <div className="safe-area-x max-w-7xl mx-auto">
              <SearchBar />
              {filterFavorite && !activeFavoriteCollectionId ? <FavoriteCollectionsView /> : <TaskGrid />}
            </div>
          </main>
        )}
      </div>
      <InputBar key={`input-${privacyModeEpoch}`} />
      <DetailModal key={`detail-${privacyModeEpoch}`} />
      <Lightbox key={`lightbox-${privacyModeEpoch}`} />
      <SettingsModal key={`settings-${settingsModalEpoch}`} />
      <UpdateModal />
      <DataProgressDialog />
      <ConfirmDialog />
      <SupportPromptModal />
      {/* 等启动时的任务加载和预置配置导入完成，再按图片数量等条件筛选公告 */}
      <AnnouncementModal ready={startupImportDone} />
      <FavoriteCollectionPickerModal />
      <ManageCollectionsModal />
      <Toast />
      <DbBlockedNotice />
      <MaskEditorModal key={`mask-${privacyModeEpoch}`} />
      <SketchBoardModal key={`sketch-${privacyModeEpoch}`} />
      <ImageContextMenu key={`menu-${privacyModeEpoch}`} />
      {TITLEBAR_HEIGHT > 0 && <TitleBar />}
    </>
  )
}
