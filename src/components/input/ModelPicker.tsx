import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ApiProfileModelGroup } from '../../lib/apiProfiles'
import { DROPDOWN_PANEL_CLASS, DROPDOWN_SCROLL_CLASS, getDropdownSpace } from '../../lib/dropdown'
import { dismissAllTooltips } from '../../lib/tooltipDismiss'
import { usePopoverDismiss } from '../../hooks/usePopoverDismiss'
import { ChevronDownIcon, SearchIcon, SettingsIcon } from '../icons'
import { CHIP_BASE_CLASS, CHIP_IDLE_CLASS } from './paramPopoverChip'
import ViewportTooltip from '../ViewportTooltip'

const PANEL_MAX_WIDTH = 340
// 模型列表比参数下拉框更需要一屏看全，最大高度放宽到常见视口的一半左右
const PANEL_MAX_HEIGHT = 340
const PANEL_MIN_HEIGHT = 160

interface ModelPickerProps {
  value: string
  groups: ApiProfileModelGroup[]
  activeProfileId: string
  /** 选择其他配置时一并切换当前配置；为 false 时只切换模型 */
  canSwitchProfile: boolean
  onChange: (profileId: string, model: string) => void
  onOpenSettings: () => void
}

/** 首页输入框模型列表：当前配置和勾选了展示在列表中的配置按配置分组，可搜索，选择其他配置时同时切换配置 */
export default function ModelPicker({ value, groups, activeProfileId, canSwitchProfile, onChange, onOpenSettings }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [offsetLeft, setOffsetLeft] = useState<number | null>(null)
  const [panelWidth, setPanelWidth] = useState(PANEL_MAX_WIDTH)
  const [maxHeight, setMaxHeight] = useState(PANEL_MAX_HEIGHT)
  const [openUp, setOpenUp] = useState(false)
  const [hoveredModel, setHoveredModel] = useState<string | null>(null)
  const tooltipTimerRef = useRef<number | null>(null)
  const longPressTriggeredRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const activeProfileName = groups.find((group) => group.profileId === activeProfileId)?.name

  const clearTooltipTimer = () => {
    if (tooltipTimerRef.current == null) return
    window.clearTimeout(tooltipTimerRef.current)
    tooltipTimerRef.current = null
  }

  const visibleGroups = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return groups
    // 配置名称或服务商命中时列出该配置的全部模型，否则只列命中的模型
    return groups.flatMap((group) => {
      const groupMatched = group.name.toLowerCase().includes(keyword) || group.providerLabel.toLowerCase().includes(keyword)
      const models = groupMatched ? group.models : group.models.filter((model) => model.toLowerCase().includes(keyword))
      return models.length ? [{ ...group, models }] : []
    })
  }, [groups, query])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setHoveredModel(null)
      longPressTriggeredRef.current = false
      return
    }
    inputRef.current?.focus()
    return clearTooltipTimer
  }, [open])

  useLayoutEffect(() => {
    if (!open) return

    const updatePlacement = () => {
      const trigger = triggerRef.current
      const root = rootRef.current
      if (!trigger || !root) return
      const rect = trigger.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      const space = getDropdownSpace(trigger)
      // 先决定上下：下方放不下最小高度时改为向上
      const nextOpenUp = space.below < PANEL_MIN_HEIGHT && space.above > space.below
      setOpenUp(nextOpenUp)
      // 面板比胶囊宽，靠近窗口边时向内收，左右都留出间距
      const viewportPadding = 12
      const panelWidth = Math.max(0, Math.min(PANEL_MAX_WIDTH, window.innerWidth - viewportPadding * 2))
      const panelLeft = Math.min(
        Math.max(viewportPadding, rect.left),
        window.innerWidth - viewportPadding - panelWidth,
      )
      setOffsetLeft(panelLeft - rootRect.left)
      setPanelWidth(panelWidth)
      // 高度只受展开方向那一侧的空间限制，搜索框和底部入口用 flex 分配，不预留估算值
      const available = nextOpenUp ? space.above : space.below
      setMaxHeight(Math.max(0, Math.min(PANEL_MAX_HEIGHT, Math.floor(available))))
    }

    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [open])

  usePopoverDismiss(open, [rootRef], () => setOpen(false))

  return (
    <div className="min-w-0 max-sm:flex-auto">
      <div ref={rootRef} className="relative flex min-w-0 flex-col justify-center max-sm:h-8" data-model-picker>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            dismissAllTooltips()
            setOpen((current) => !current)
          }}
          aria-expanded={open}
          aria-label={`模型 ${value}`}
          className={`flex w-full items-center gap-1 min-w-0 ${CHIP_BASE_CLASS} ${CHIP_IDLE_CLASS} ${open ? '!bg-black/[0.07] dark:!bg-white/[0.1]' : ''}`}
        >
          <span className="min-w-0 truncate">{value}</span>
          {canSwitchProfile && groups.length > 1 && activeProfileName && (
            <span className="flex-shrink-0 truncate text-gray-400 dark:text-gray-500">· {activeProfileName}</span>
          )}
          <ChevronDownIcon className={`w-3.5 h-3.5 flex-shrink-0 text-gray-400 dark:text-gray-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <div
            ref={panelRef}
            className={`absolute z-50 ${DROPDOWN_PANEL_CLASS} ${
              openUp ? 'bottom-[calc(100%+6px)] animate-dropdown-up' : 'top-full mt-1.5 animate-dropdown-down'
            }`}
            style={{
              left: offsetLeft ?? 0,
              width: panelWidth,
              maxHeight,
            }}
          >
            <div className="flex-shrink-0 border-b border-black/5 px-3 py-2 dark:border-white/[0.06]">
              <div className="flex items-center gap-2">
                <SearchIcon className="h-4 w-4 flex-shrink-0 text-gray-400 dark:text-gray-500" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索模型"
                  className="min-w-0 flex-1 bg-transparent text-xs text-gray-700 outline-none placeholder:text-gray-400 dark:text-gray-200 dark:placeholder:text-gray-500"
                />
              </div>
            </div>
            <div className={`${DROPDOWN_SCROLL_CLASS} flex-1 rounded-none`}>
              {visibleGroups.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-gray-400 dark:text-gray-500">没有匹配的模型</div>
              )}
              {visibleGroups.map((group) => (
                <div key={group.profileId}>
                  <div className="flex items-center justify-between gap-2 px-3 pb-0.5 pt-2.5 text-[10px] text-gray-400 dark:text-gray-500">
                    <span className="min-w-0 truncate">{group.name}</span>
                    <span className="flex-shrink-0">{group.providerLabel}</span>
                  </div>
                  {group.models.map((model) => {
                    const current = group.profileId === activeProfileId && model === value
                    const key = `${group.profileId}:${model}`
                    return (
                      <button
                        key={key}
                        type="button"
                        onPointerDown={() => { longPressTriggeredRef.current = false }}
                        onClick={() => {
                          clearTooltipTimer()
                          // 触摸事件可能是被动监听，长按后的兼容点击也在这里拦截
                          if (longPressTriggeredRef.current) {
                            longPressTriggeredRef.current = false
                            return
                          }
                          setHoveredModel(null)
                          setOpen(false)
                          onChange(group.profileId, model)
                        }}
                        onMouseEnter={() => setHoveredModel(key)}
                        onMouseLeave={() => setHoveredModel(null)}
                        onTouchStart={() => {
                          clearTooltipTimer()
                          longPressTriggeredRef.current = false
                          tooltipTimerRef.current = window.setTimeout(() => {
                            longPressTriggeredRef.current = true
                            setHoveredModel(key)
                            tooltipTimerRef.current = null
                          }, 500)
                        }}
                        onTouchEnd={(event) => {
                          clearTooltipTimer()
                          if (longPressTriggeredRef.current && event.cancelable) event.preventDefault()
                        }}
                        onTouchCancel={() => {
                          clearTooltipTimer()
                          longPressTriggeredRef.current = false
                          setHoveredModel(null)
                        }}
                        onTouchMove={() => {
                          clearTooltipTimer()
                          setHoveredModel(null)
                        }}
                        className={`relative flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors ${
                          current
                            ? 'bg-black/[0.05] font-medium text-blue-600 dark:bg-white/[0.08] dark:text-blue-400'
                            : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                        }`}
                      >
                        <span className="min-w-0 truncate">{model}</span>
                        {current && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-500" />}
                        <ViewportTooltip visible={hoveredModel === key} className="max-w-[300px] break-words whitespace-pre-wrap">
                          {model}
                        </ViewportTooltip>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
            {canSwitchProfile && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onOpenSettings()
                }}
                className="flex w-full items-center gap-1.5 border-t border-black/5 px-3 py-2 text-left text-[11px] text-gray-500 transition-colors hover:bg-gray-50 dark:border-white/[0.06] dark:text-gray-400 dark:hover:bg-white/[0.06]"
              >
                <SettingsIcon className="h-3.5 w-3.5 flex-shrink-0" />
                在设置中把其他配置加入此列表
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
