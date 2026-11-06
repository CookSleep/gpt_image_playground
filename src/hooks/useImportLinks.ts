import { createElement, useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { readText } from '@tauri-apps/plugin-clipboard-manager'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import type { AppSettings } from '../types'
import { restoreExplicitPresetConfig, useStore } from '../store'
import { normalizeSettings } from '../lib/apiProfiles'
import { describeImportLink, handledImportLinks, parseImportLink } from '../lib/importLink'
import { isTauri } from '../lib/platform'
import { readRuntimeEnv } from '../lib/runtimeEnv'
import { buildSettingsFromUrlParams, getExplicitUrlSettingsIds } from '../lib/urlSettings'
import ImportLinkDiff from '../components/ImportLinkDiff'

/** 按链接参数计算导入后的设置；需在预置配置加载完成后调用 */
export async function applyUrlSettings(baseSettings: Partial<AppSettings>, searchParams: URLSearchParams) {
  const ids = getExplicitUrlSettingsIds(searchParams)
  const restored = await restoreExplicitPresetConfig(ids)
  const restoredSettings = useStore.getState().settings
  const sourceSettings = restored
    ? { ...restoredSettings, ...baseSettings, customProviders: restoredSettings.customProviders, profiles: restoredSettings.profiles }
    : baseSettings
  const nextSettings = buildSettingsFromUrlParams(sourceSettings, searchParams)
  return Object.keys(nextSettings).length ? nextSettings : sourceSettings
}

let promptQueue = Promise.resolve()
// 冷启动的 deep link 只读取一次，StrictMode 下 effect 会执行两次
let launchLinkChecked = false

/** 等待没有其他对话框且设置弹窗已关闭；设置弹窗中的草稿会在保存时覆盖导入结果 */
function waitIdle() {
  const idle = () => {
    const state = useStore.getState()
    return !state.confirmDialog && !state.showSettings
  }
  return new Promise<void>((resolve) => {
    if (idle()) return resolve()
    const unsubscribe = useStore.subscribe(() => {
      if (!idle()) return
      unsubscribe()
      resolve()
    })
  })
}

/**
 * 提示导入链接中的配置。input 为链接文本，或网页版启动时已从地址栏取出的参数。
 * opened 表示用户主动打开的链接（deep link 或网页链接）；剪贴板中的同一条链接本次运行只处理一次
 */
export function promptImportLink(input: string | URLSearchParams, opened = false) {
  const link = typeof input === 'string' ? input.trim() : ''
  if (!opened && handledImportLinks.has(link)) return
  const params = typeof input === 'string' ? parseImportLink(link) : input
  if (!params) return
  if (link) handledImportLinks.add(link)

  // 对话框只有一个，多个链接同时到达时依次提示，也不覆盖其他正在显示的对话框
  promptQueue = promptQueue.then(async () => {
    // 用户刚打开的链接暂缓时告知原因；剪贴板触发的不提示，避免打扰
    if (opened && useStore.getState().showSettings) useStore.getState().showToast('关闭设置后将处理导入配置', 'info')
    await waitIdle()
    const desc = describeImportLink(params, useStore.getState().settings)
    const dialog: NonNullable<ReturnType<typeof useStore.getState>['confirmDialog']> = {
      title: '导入配置',
      message: desc.summary,
      content: desc.notes.length || desc.groups.length ? createElement(ImportLinkDiff, { desc }) : undefined,
      confirmText: '导入',
      icon: 'info',
      awaitAction: true,
      action: async () => {
        try {
          const state = useStore.getState()
          const before = normalizeSettings(state.settings)
          state.setSettings(await applyUrlSettings(state.settings, params))
          // 以写入后 store 中的实际结果判断，部署策略可能把修改还原
          const after = normalizeSettings(useStore.getState().settings)
          if (JSON.stringify(after) === JSON.stringify(before)) return
          // 恢复原活动配置时同步还原地址、模型等派生字段，只剩切换时配置内容应一致
          const switched = after.activeProfileId !== before.activeProfileId
            && JSON.stringify(normalizeSettings({ ...after, activeProfileId: before.activeProfileId })) === JSON.stringify(before)
          state.showToast(switched ? `已切换到「${after.profiles.find((profile) => profile.id === after.activeProfileId)?.name}」` : '配置已导入', 'success')
        } catch (err) {
          console.error('导入链接中的配置失败：', err)
          useStore.getState().showToast('导入配置失败', 'error')
        }
      },
    }
    if (!desc.hasConfigChanges || readRuntimeEnv(import.meta.env.VITE_SHOW_CONFIG_CHANGE_DIALOG) === 'false') {
      await dialog.action?.()
      return
    }
    useStore.getState().setConfirmDialog(dialog)
    await new Promise<void>((resolve) => {
      const unsubscribe = useStore.subscribe((state) => {
        if (state.confirmDialog === dialog) return
        // 被其他对话框替换或因进入隐私模式关闭时用户没有做出选择，允许下次再提示
        if (state.confirmDialog || state.privacyMode) handledImportLinks.delete(link)
        unsubscribe()
        resolve()
      })
    })
  })
}

/** 客户端中识别剪贴板和 deep link 里的导入链接；ready 表示启动时的预置配置已写入 */
export function useImportLinks(ready: boolean) {
  useEffect(() => {
    if (!isTauri || !ready) return

    // 剪贴板为空或不是文本时 readText 会报错，属于正常情况，直接忽略
    const checkClipboard = () => void readText().then((text) => promptImportLink(text), () => {})
    const unlisteners = [
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) checkClipboard()
      }),
      onOpenUrl((urls) => urls.forEach((url) => promptImportLink(url, true))),
    ]
    // 通过 deep link 启动时，链接在前端监听之前就已到达，需主动读取一次
    if (!launchLinkChecked) {
      launchLinkChecked = true
      getCurrent()
        .then((urls) => urls?.forEach((url) => promptImportLink(url, true)))
        .catch((err) => console.warn('读取启动链接失败：', err))
    }
    checkClipboard()

    return () => {
      for (const unlisten of unlisteners) void unlisten.then((fn) => fn())
    }
  }, [ready])
}
