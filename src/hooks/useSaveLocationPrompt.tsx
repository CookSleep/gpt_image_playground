import { useEffect } from 'react'
import type { SaveLocationMode } from '../types'
import { readLocal, writeLocal } from '../lib/localRecord'
import { isTauri } from '../lib/platform'
import { getDefaultSaveDir, setBeforeSave, setSaveToDefaultDir } from '../lib/saveFile'
import { useStore } from '../store'

// 与默认保存地址一样只属于本机，不放进设置，不会随备份带到其他设备
const ASKED_KEY = 'save-location-asked'

type ConfirmDialogState = NonNullable<ReturnType<typeof useStore.getState>['confirmDialog']>

/** 用户已选择过保存方式（首次询问或在设置中手动更改），之后不再询问 */
export function markSaveLocationAsked() {
  writeLocal(ASKED_KEY, '1')
}

// 同时发起的多个保存共用一次询问
let pending: Promise<boolean> | null = null

async function askSaveLocation() {
  // 先读取地址再弹窗：调用方可能在其他确认框的按钮回调中同步发起保存，确认框随后会被关闭
  const dir = await getDefaultSaveDir().catch((err) => {
    console.warn('读取默认保存地址失败：', err)
    return typeof err === 'string' ? err : '读取失败'
  })
  return await new Promise<boolean>((resolve) => {
    const choose = (mode: SaveLocationMode) => {
      markSaveLocationAsked()
      // App 要到下次渲染才按设置同步，本次保存需立即按所选方式进行
      setSaveToDefaultDir(mode === 'default')
      useStore.getState().setSettings({ saveLocationMode: mode })
      resolve(true)
    }
    const dialog: ConfirmDialogState = {
      title: '选择保存方式',
      message: '保存图片和备份时，「每次询问」会弹出窗口选择保存位置；「默认地址」直接保存到下方地址，遇到同名文件自动加序号，不会覆盖。\n选择之后可在「设置 → 习惯配置」中更改。',
      content: (
        <div data-selectable-text className="break-all rounded-xl bg-black/[0.03] px-3 py-2 text-xs leading-relaxed text-gray-600 dark:bg-white/[0.04] dark:text-gray-300">
          {dir}
        </div>
      ),
      buttons: [
        { label: '每次询问', tone: 'secondary', action: () => choose('ask') },
        { label: '默认地址', tone: 'primary', action: () => choose('default') },
      ],
    }
    useStore.getState().setConfirmDialog(dialog)
    // 按 Esc、点击遮罩或被其他对话框替换时取消本次保存，下次保存时再询问
    const unsubscribe = useStore.subscribe((s) => {
      if (s.confirmDialog === dialog) return
      unsubscribe()
      resolve(false)
    })
  })
}

/** 仅客户端：首次保存文件前询问保存方式；已在设置中选择过“默认地址”的不再询问 */
export function useSaveLocationPrompt() {
  useEffect(() => {
    if (!isTauri) return
    setBeforeSave(async () => {
      if (readLocal(ASKED_KEY) || useStore.getState().settings.saveLocationMode === 'default') return true
      pending ??= askSaveLocation().finally(() => {
        pending = null
      })
      return await pending
    })
    return () => setBeforeSave(null)
  }, [])
}
