import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTooltip } from '../../hooks/useTooltip'
import type { SkillInfo, SkillTarget } from '../../types'
import { useStore } from '../../store'
import { CheckIcon } from '../editor/EditorControls'
import { ClaudeCodeIcon, CodexIcon, FolderIcon } from '../icons'
import ViewportTooltip from '../ViewportTooltip'

export const SKILL_LABEL: Record<SkillTarget, string> = {
  claude: 'Claude Code',
  agents: 'Codex 等',
}

const SECTION_TITLE = 'text-sm font-bold text-gray-800 dark:text-gray-100'
const ROW_DESC = 'text-xs text-gray-500 dark:text-gray-500'
const CARD = 'overflow-hidden rounded-2xl bg-black/[0.04] divide-y divide-black/[0.05] dark:bg-white/[0.06] dark:divide-white/[0.06]'
const ICON_TILE = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-gray-600 shadow-sm dark:bg-white/[0.08] dark:text-gray-300 dark:shadow-none max-sm:self-start'
const SUBTITLE = 'mt-0.5 block text-xs text-gray-500 dark:text-gray-400'
const SUBTITLE_WARN = 'mt-0.5 block text-xs text-amber-600 dark:text-amber-400/90'
const SMALL_BUTTON = 'rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/[0.08] dark:text-gray-200 dark:shadow-none dark:hover:bg-white/[0.12]'

/** 卡片中的一行：图标、名称、下方的路径或状态说明，右侧为操作；手机宽度下操作移到文字下方 */
function Row({ icon, title, path, note, warn, children }: { icon: ReactNode; title: string; path?: string; note?: string; warn?: boolean; children: ReactNode }) {
  const tooltip = useTooltip()
  return (
    <div className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 max-sm:flex-wrap max-sm:gap-y-2">
      <span className={ICON_TILE}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-gray-800 dark:text-gray-100">{title}</span>
        {path && (
          <span data-selectable-text className={`${SUBTITLE} truncate max-sm:whitespace-normal max-sm:[overflow-wrap:anywhere]`} {...tooltip.handlers}>
            {path}
            <ViewportTooltip visible={tooltip.visible} className="max-w-sm break-all">
              {path}
            </ViewportTooltip>
          </span>
        )}
        {note && <span className={warn ? SUBTITLE_WARN : SUBTITLE}>{note}</span>}
      </span>
      <span className="flex flex-shrink-0 items-center gap-1.5 max-sm:basis-full max-sm:justify-end">{children}</span>
    </div>
  )
}

/** 仅客户端：把随安装包附带的 Skill 安装到 Claude Code 或 `~/.agents/skills`；改动由 Rust 侧完成，只改名为 gpt-image-playground 的文件夹 */
export default function SkillSettingsSection() {
  const showToast = useStore((s) => s.showToast)
  const [info, setInfo] = useState<SkillInfo | null>(null)
  const [error, setError] = useState('')
  // 正在处理的行，处理期间该行的按钮不可用
  const [busy, setBusy] = useState('')

  const load = useCallback(() => {
    invoke<SkillInfo>('skill_info').then(
      (i) => {
        setInfo(i)
        setError('')
      },
      (err) => {
        console.warn('无法读取 Skill 的安装状态：', err)
        setError(typeof err === 'string' ? err : '无法读取 Skill 的安装状态')
      },
    )
  }, [])

  useEffect(load, [load])

  const act = (key: string, cmd: string, args: Record<string, string>, done: string) => {
    setBusy(key)
    invoke<SkillInfo>(cmd, args)
      .then((i) => {
        setInfo(i)
        showToast(done, 'success')
      })
      .catch((err) => {
        console.warn(`${cmd} 失败：`, err)
        showToast(typeof err === 'string' ? err : '操作失败，请重试', 'error')
      })
      .finally(() => setBusy(''))
  }

  const openDir = () => {
    invoke('skill_open_dir').catch((err) => {
      console.warn('打开 Skill 文件夹失败：', err)
      showToast(typeof err === 'string' ? err : '无法打开 Skill 所在的文件夹', 'error')
    })
  }

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h4 className={SECTION_TITLE}>Skill</h4>
        <p data-selectable-text className={ROW_DESC}>
          Skill 为 AI 工具提供 GPT Image Playground CLI 的使用说明，包括何时调用、如何生图与修改设置。Claude Code 读取「~\.claude\skills」，Codex 读取「~\.agents\skills」，Cursor、VS Code 与 OpenCode 两处都会读取，安装其中一处即可。已安装的 Skill 会在客户端启动时自动更新到当前版本。
        </p>
        {error && <p data-selectable-text className="text-xs text-red-500 dark:text-red-400">{error}</p>}
      </div>
      {info && (
        <div className={CARD}>
          {info.skills.map((s) => {
            const key = `skill-${s.id}`
            const note = s.state === 'outdated' ? '与当前版本不一致，需要更新' : s.state === 'invalid' ? '此目录已有另一个名为 gpt-image-playground 的 Skill' : undefined
            return (
              <Row key={s.id} icon={s.id === 'claude' ? <ClaudeCodeIcon className="h-4 w-4" /> : <CodexIcon className="h-4 w-4" />} title={SKILL_LABEL[s.id]} path={note ? undefined : s.path} note={note} warn>
                {s.state === 'added' && (
                  <span className="mr-1 inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400 [&_svg]:h-3.5 [&_svg]:w-3.5">
                    <CheckIcon />
                    已安装
                  </span>
                )}
                {(s.state === 'absent' || s.state === 'outdated') && (
                  <button type="button" className={SMALL_BUTTON} disabled={busy === key} onClick={() => act(key, 'skill_install', { target: s.id }, s.state === 'absent' ? '已安装' : '已更新')}>
                    {s.state === 'absent' ? '安装' : '更新'}
                  </button>
                )}
                {(s.state === 'added' || s.state === 'outdated') && (
                  <button type="button" className={SMALL_BUTTON} disabled={busy === key} onClick={() => act(key, 'skill_remove', { target: s.id }, '已移除')}>
                    移除
                  </button>
                )}
              </Row>
            )
          })}
          <Row icon={<FolderIcon className="h-4 w-4" />} title="Skill 文件夹" path={info.skillDir}>
            <button type="button" className={SMALL_BUTTON} onClick={openDir}>
              打开
            </button>
          </Row>
        </div>
      )}
    </section>
  )
}
