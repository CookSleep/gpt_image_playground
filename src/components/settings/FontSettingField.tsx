import { useEffect, useId, useRef, useState } from 'react'
import type { FontMode } from '../../types'
import { buildFontStack, getFontLabel, resolveFont, resolveSlotFont, type FontSlot, type ResolvedFont } from '../../lib/fonts'
import Select from '../Select'

interface FontSettingFieldProps {
  slot: FontSlot
  label: string
  description: string
  mode: FontMode
  name: string
  onChange: (mode: FontMode, name: string) => void
}

type LocalFontWindow = Window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> }

const PREVIEW_TEXT = {
  ui: '永和九年，岁在癸丑 The quick brown fox 0123456789',
  mono: 'const value = fn(42) => "你好" // 0O 1lI',
}

// 本机字体列表在模块级缓存，两个字段共用，只请求一次，避免反复弹出权限提示
let localFamiliesPromise: Promise<string[]> | null = null

function loadLocalFamilies() {
  localFamiliesPromise ??= (async () => {
    const query = (window as LocalFontWindow).queryLocalFonts
    if (typeof query !== 'function') return []
    try {
      const fonts = await query()
      return Array.from(new Set(fonts.map((font) => font.family))).sort((a, b) => a.localeCompare(b))
    } catch (err) {
      // 不支持、被拒绝或失败时静默退回手动输入
      console.warn('读取本机字体失败：', err)
      return []
    }
  })()
  return localFamiliesPromise
}

export default function FontSettingField({ slot, label, description, mode, name, onChange }: FontSettingFieldProps) {
  const [nameInput, setNameInput] = useState(name)
  const [localFamilies, setLocalFamilies] = useState<string[]>([])
  const [listOpen, setListOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()

  useEffect(() => {
    setNameInput(name)
  }, [name])

  useEffect(() => {
    listRef.current?.children[activeIdx]?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const commitName = (value: string) => {
    const trimmed = value.trim()
    setNameInput(trimmed)
    if (trimmed !== name) onChange(mode, trimmed)
  }

  const keyword = nameInput.trim().toLowerCase()
  const filtered = localFamilies.filter((family) => family.toLowerCase().includes(keyword))
  const showList = listOpen && filtered.length > 0

  const pick = (family: string) => {
    commitName(family)
    setListOpen(false)
    setActiveIdx(-1)
  }

  // 第一项即部署默认对应的选项（保存为 default），其余选项不再重复该模式；部署默认为自定义字体名时仍保留“自定义”
  const deployFont = resolveSlotFont(slot, 'default', '')
  const otherModes = (['builtin', 'system', 'custom'] as const).filter((m) => m !== deployFont.source || m === 'custom')
  // 选项用各自的字体渲染；字体未加载时自然回退，不为预览主动加载字体文件
  const optionStyle = (font: ResolvedFont) => ({ fontFamily: buildFontStack(slot, font) })
  const previewFont = mode === 'custom' ? resolveFont('custom', nameInput, '') : resolveSlotFont(slot, mode, name)

  return (
    <div className="block">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="block text-sm text-gray-600 dark:text-gray-300">{label}</span>
        <div className="w-28 shrink-0">
          <Select
            value={mode !== 'custom' && mode === deployFont.source ? 'default' : mode}
            onChange={(val) => onChange(val as FontMode, name)}
            options={[
              { label: getFontLabel(deployFont), value: 'default', style: optionStyle(deployFont) },
              ...otherModes.map((m) => m === 'custom'
                ? { label: '自定义', value: m }
                : { label: getFontLabel({ source: m }), value: m, style: optionStyle({ source: m }) }),
            ]}
            className="w-full px-3 py-1.5 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] text-xs transition-all duration-200 text-gray-700 dark:text-gray-200 outline-none"
          />
        </div>
      </div>
      {mode === 'custom' && (
        <div className="relative mb-1.5">
          <input
            value={nameInput}
            onChange={(e) => {
              setNameInput(e.target.value)
              setListOpen(true)
              setActiveIdx(-1)
            }}
            onFocus={() => {
              setListOpen(true)
              void loadLocalFamilies().then(setLocalFamilies)
            }}
            onBlur={(e) => {
              commitName(e.target.value)
              setListOpen(false)
              setActiveIdx(-1)
            }}
            onKeyDown={(e) => {
              if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && filtered.length) {
                e.preventDefault()
                setListOpen(true)
                setActiveIdx((i) => e.key === 'ArrowDown' ? (i + 1) % filtered.length : (i <= 0 ? filtered.length - 1 : i - 1))
                return
              }
              if (e.key === 'Enter') {
                if (showList && filtered[activeIdx]) pick(filtered[activeIdx])
                else commitName(e.currentTarget.value)
                setListOpen(false)
                setActiveIdx(-1)
                return
              }
              // 只关闭候选列表，不关闭设置弹窗
              if (e.key === 'Escape' && showList) {
                e.stopPropagation()
                setListOpen(false)
                setActiveIdx(-1)
              }
            }}
            placeholder="本机已安装的字体名称"
            aria-label={`${label}名称`}
            role="combobox"
            aria-expanded={showList}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={showList && activeIdx >= 0 ? `${listId}-${activeIdx}` : undefined}
            className="w-full rounded-xl border border-transparent bg-black/[0.04] px-3 py-1.5 text-xs text-gray-700 outline-none transition focus:border-blue-300 dark:bg-white/[0.06] dark:text-gray-200 dark:focus:border-blue-500/50"
          />
          {showList && (
            <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-black/5 dark:bg-gray-800 dark:ring-white/10">
              <ul
                ref={listRef}
                id={listId}
                role="listbox"
                className="custom-scrollbar ios-rounded-scroll-fix max-h-56 overflow-y-auto rounded-xl p-1"
              >
                {filtered.map((family, idx) => (
                  <li
                    key={family}
                    id={`${listId}-${idx}`}
                    role="option"
                    aria-selected={idx === activeIdx}
                    onMouseDown={(e) => {
                      // 阻止输入框失焦，保证点击能选中
                      e.preventDefault()
                      pick(family)
                    }}
                    onMouseEnter={() => setActiveIdx(idx)}
                    className={`cursor-pointer truncate rounded-lg px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 ${idx === activeIdx ? 'bg-black/[0.05] dark:bg-white/[0.08]' : ''}`}
                    style={optionStyle({ source: 'custom', name: family })}
                  >
                    {family}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div
        className="mb-1.5 truncate rounded-xl bg-black/[0.02] px-3 py-2 text-sm text-gray-700 dark:bg-white/[0.03] dark:text-gray-200"
        style={{ fontFamily: buildFontStack(slot, previewFont) }}
      >
        {PREVIEW_TEXT[slot]}
      </div>
      <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
        {description}
      </div>
    </div>
  )
}
