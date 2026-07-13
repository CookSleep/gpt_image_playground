import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_DROPDOWN_MAX_HEIGHT } from '../lib/dropdown'
import { ChevronDownIcon, EditIcon, PlusIcon, TrashIcon, DragHandleIcon } from './icons'
import ViewportTooltip from './ViewportTooltip'
import { useTooltip } from '../hooks/useTooltip'

interface Option {
  label: string
  value: string | number
  variant?: 'action' | 'danger'
  draggable?: boolean
  actions?: Array<{
    label: string
    variant?: 'danger'
    onClick: () => void
  }>
}

interface SelectProps {
  value: string | number
  onChange: (value: any) => void
  onReorder?: (sourceValue: string | number, targetValue: string | number, position: 'before' | 'after' | null) => void
  options: Option[]
  disabled?: boolean
  className?: string
  onOpenChange?: (isOpen: boolean) => void
  showValueTooltips?: boolean
}

export default function Select({ value, onChange, onReorder, options, disabled, className, onOpenChange, showValueTooltips = true }: SelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [menuMaxHeight, setMenuMaxHeight] = useState(DEFAULT_DROPDOWN_MAX_HEIGHT)
  const [placement, setPlacement] = useState<'bottom' | 'top'>('bottom')
  const [draggedValue, setDraggedValue] = useState<string | number | null>(null)
  const [dragOverValue, setDragOverValue] = useState<string | number | null>(null)
  const [dragDropPosition, setDragDropPosition] = useState<'before' | 'after' | null>(null)
  const [touchDragPreview, setTouchDragPreview] = useState<{
    label: string
    x: number
    y: number
    width: number
    height: number
    offsetX: number
    offsetY: number
  } | null>(null)
  const touchDragRef = useRef<{ value: string | number, startX: number, startY: number, moved: boolean } | null>(null)
  const dragScrollIntervalRef = useRef<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)

  const triggerTooltip = useTooltip()
  const [hoveredOptionTooltip, setHoveredOptionTooltip] = useState<string | number | null>(null)
  const optionTooltipTimerRef = useRef<number | null>(null)
  const optionLongPressTriggeredRef = useRef(false)

  const clearOptionTooltipTimer = () => {
    if (optionTooltipTimerRef.current) {
      window.clearTimeout(optionTooltipTimerRef.current)
      optionTooltipTimerRef.current = null
    }
  }

  const selectedOption = options.find((o) => o.value === value)

  useEffect(() => {
    return () => {
      if (dragScrollIntervalRef.current) clearInterval(dragScrollIntervalRef.current)
      clearOptionTooltipTimer()
    }
  }, [])

  useEffect(() => {
    onOpenChange?.(isOpen)
    if (!isOpen) {
      clearOptionTooltipTimer()
      setHoveredOptionTooltip(null)
      optionLongPressTriggeredRef.current = false
    }
  }, [isOpen, onOpenChange])

  useEffect(() => {
    if (!touchDragPreview) return

    const preventTouchScroll = (event: TouchEvent) => {
      event.preventDefault()
    }
    const listenerOptions = { passive: false, capture: true } as AddEventListenerOptions
    const previousOverflow = document.body.style.overflow
    const previousOverscroll = document.body.style.overscrollBehavior

    document.body.style.overflow = 'hidden'
    document.body.style.overscrollBehavior = 'none'
    window.addEventListener('touchmove', preventTouchScroll, listenerOptions)

    return () => {
      document.body.style.overflow = previousOverflow
      document.body.style.overscrollBehavior = previousOverscroll
      window.removeEventListener('touchmove', preventTouchScroll, listenerOptions)
    }
  }, [touchDragPreview])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (!isOpen) return

    const updateMenuMaxHeight = () => {
      if (!triggerRef.current) return
      const trigger = triggerRef.current
      const rect = trigger.getBoundingClientRect()
      
      let availableBelow = window.innerHeight - rect.bottom - 8
      let availableAbove = rect.top - 8
      
      let parent = trigger.parentElement
      while (parent && parent !== document.body) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowY}`)) {
          const parentRect = parent.getBoundingClientRect()
          availableBelow = Math.min(availableBelow, parentRect.bottom - rect.bottom - 8)
          availableAbove = Math.min(availableAbove, rect.top - parentRect.top - 8)
        }
        parent = parent.parentElement
      }
      
      let newPlacement: 'bottom' | 'top' = 'bottom'
      let maxHeight = DEFAULT_DROPDOWN_MAX_HEIGHT
      
      if (availableBelow < 120 && availableAbove > availableBelow) {
        newPlacement = 'top'
        maxHeight = Math.min(DEFAULT_DROPDOWN_MAX_HEIGHT, Math.floor(availableAbove))
      } else {
        newPlacement = 'bottom'
        maxHeight = Math.min(DEFAULT_DROPDOWN_MAX_HEIGHT, Math.floor(availableBelow))
      }
      
      setPlacement(newPlacement)
      setMenuMaxHeight(Math.max(0, maxHeight))
    }

    updateMenuMaxHeight()
    window.addEventListener('resize', updateMenuMaxHeight)
    window.addEventListener('scroll', updateMenuMaxHeight, true)
    return () => {
      window.removeEventListener('resize', updateMenuMaxHeight)
      window.removeEventListener('scroll', updateMenuMaxHeight, true)
    }
  }, [isOpen])

  const handleToggle = (e: React.MouseEvent) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()
    // 动画和位置的计算在 useEffect 中进行，这里可以先假设一个默认值或保留当前状态
    setIsOpen(!isOpen)
  }

  const clearTouchDrag = () => {
    touchDragRef.current = null
    setTouchDragPreview(null)
    setDraggedValue(null)
    setDragOverValue(null)
    setDragDropPosition(null)
    clearOptionTooltipTimer()
    optionLongPressTriggeredRef.current = false
    if (dragScrollIntervalRef.current) {
      clearInterval(dragScrollIntervalRef.current)
      dragScrollIntervalRef.current = null
    }
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <div
        ref={triggerRef}
        {...(showValueTooltips ? triggerTooltip.handlers : {})}
        onClick={(e) => {
          if (showValueTooltips) triggerTooltip.handlers.onClick?.()
          handleToggle(e)
          triggerTooltip.dismiss()
        }}
        className={`flex items-center justify-between gap-1 w-full cursor-pointer select-none ${className ?? ''} ${
          disabled ? '!opacity-50 !cursor-not-allowed !bg-gray-100/50 dark:!bg-white/[0.05]' : ''
        }`}
      >
        <span className="truncate">{selectedOption?.label ?? value}</span>
        <ChevronDownIcon className={`w-3.5 h-3.5 flex-shrink-0 text-gray-400 dark:text-gray-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        {showValueTooltips && (
          <ViewportTooltip visible={triggerTooltip.visible} className="max-w-[300px] break-words whitespace-pre-wrap">
            {selectedOption?.label ?? value}
          </ViewportTooltip>
        )}
      </div>

      {isOpen && (
        <div
          className={`absolute z-50 w-full overflow-hidden overflow-y-auto rounded-xl border border-gray-200/60 bg-white/95 py-1 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] dark:ring-white/10 custom-scrollbar ${
            placement === 'top' ? 'bottom-full mb-1.5 animate-dropdown-up' : 'top-full mt-1.5 animate-dropdown-down'
          }`}
          style={{ maxHeight: menuMaxHeight }}
        >
          {options.map((option) => (
            <div
              key={option.value}
              data-option-value={String(option.value)}
              draggable={option.draggable}
              onDragStart={(e) => {
                if (!option.draggable) return
                setDraggedValue(option.value)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', String(option.value))
              }}
              onDragOver={(e) => {
                if (!option.draggable || !draggedValue) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'

                const targetElement = e.currentTarget as HTMLElement
                const rect = targetElement.getBoundingClientRect()
                const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'

                if (dragOverValue !== option.value || dragDropPosition !== position) {
                  setDragOverValue(option.value)
                  setDragDropPosition(position)
                }

                // Auto-scroll
                const scrollContainer = targetElement.parentElement
                if (scrollContainer) {
                  const containerRect = scrollContainer.getBoundingClientRect()
                  const scrollThreshold = 30

                  if (e.clientY < containerRect.top + scrollThreshold) {
                    scrollContainer.scrollTop -= 10
                  } else if (e.clientY > containerRect.bottom - scrollThreshold) {
                    scrollContainer.scrollTop += 10
                  }
                }
              }}
              onDragEnd={() => {
                setDraggedValue(null)
                setDragOverValue(null)
                setDragDropPosition(null)
              }}
              onDrop={(e) => {
                if (!option.draggable || !onReorder) return
                e.preventDefault()
                setDraggedValue(null)
                setDragOverValue(null)
                setDragDropPosition(null)

                const sourceValue = e.dataTransfer.getData('text/plain')
                const sourceOption = options.find(o => String(o.value) === sourceValue)
                if (sourceOption && sourceOption.value !== option.value) {
                  onReorder(sourceOption.value, option.value, dragDropPosition)
                }
              }}
              onTouchStart={(e) => {
                if (!option.draggable) {
                  if (!showValueTooltips) return
                  clearOptionTooltipTimer()
                  optionLongPressTriggeredRef.current = false
                  optionTooltipTimerRef.current = window.setTimeout(() => {
                    optionLongPressTriggeredRef.current = true
                    setHoveredOptionTooltip(option.value)
                  }, 500)
                  return
                }
                const target = e.target as HTMLElement
                if (!target.closest('[data-drag-handle]')) {
                  if (!showValueTooltips) return
                  clearOptionTooltipTimer()
                  optionLongPressTriggeredRef.current = false
                  optionTooltipTimerRef.current = window.setTimeout(() => {
                    optionLongPressTriggeredRef.current = true
                    setHoveredOptionTooltip(option.value)
                  }, 500)
                  return
                }

                const touch = e.touches[0]
                const rect = e.currentTarget.getBoundingClientRect()
                // Do not prevent default here, as it blocks scrolling
                // e.preventDefault()
                e.stopPropagation()
                touchDragRef.current = { value: option.value, startX: touch.clientX, startY: touch.clientY, moved: false }
                setDraggedValue(option.value)
                setTouchDragPreview({
                  label: option.label,
                  x: touch.clientX,
                  y: touch.clientY,
                  width: rect.width,
                  height: rect.height,
                  offsetX: touch.clientX - rect.left,
                  offsetY: touch.clientY - rect.top,
                })
              }}
              onTouchMove={(e) => {
                clearOptionTooltipTimer()
                const drag = touchDragRef.current
                if (!drag || !option.draggable) return
                const touch = e.touches[0]

                if (!drag.moved) {
                  if (Math.abs(touch.clientX - drag.startX) > 5 || Math.abs(touch.clientY - drag.startY) > 5) {
                    drag.moved = true
                  } else {
                    return
                  }
                }

                e.preventDefault() // prevent scrolling
                setTouchDragPreview((current) => current ? { ...current, x: touch.clientX, y: touch.clientY } : current)

                // Hide preview visually so elementFromPoint works correctly
                const previewEl = document.getElementById('touch-drag-preview')
                if (previewEl) previewEl.style.pointerEvents = 'none'

                const el = document.elementFromPoint(touch.clientX, touch.clientY)
                const targetDiv = el?.closest('[data-option-value]') as HTMLElement
                if (targetDiv) {
                  const targetValueStr = targetDiv.getAttribute('data-option-value')
                  if (targetValueStr) {
                    const targetOption = options.find(o => String(o.value) === targetValueStr)
                    if (targetOption && targetOption.draggable) {
                      const rect = targetDiv.getBoundingClientRect()
                      const position = touch.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                      if (dragOverValue !== targetOption.value || dragDropPosition !== position) {
                        setDragOverValue(targetOption.value)
                        setDragDropPosition(position)
                      }
                    }
                  }
                }

                const scrollContainer = targetDiv?.closest('.custom-scrollbar') as HTMLElement
                if (scrollContainer) {
                  const containerRect = scrollContainer.getBoundingClientRect()
                  const scrollThreshold = 30

                  if (dragScrollIntervalRef.current) {
                    clearInterval(dragScrollIntervalRef.current)
                    dragScrollIntervalRef.current = null
                  }

                  if (touch.clientY < containerRect.top + scrollThreshold) {
                    dragScrollIntervalRef.current = window.setInterval(() => {
                      scrollContainer.scrollTop -= 5
                    }, 16)
                  } else if (touch.clientY > containerRect.bottom - scrollThreshold) {
                    dragScrollIntervalRef.current = window.setInterval(() => {
                      scrollContainer.scrollTop += 5
                    }, 16)
                  }
                }
              }}
              onTouchEnd={(e) => {
                clearOptionTooltipTimer()
                if (optionLongPressTriggeredRef.current) {
                  if (e.cancelable) e.preventDefault()
                }
                optionLongPressTriggeredRef.current = false
                const drag = touchDragRef.current
                if (!drag || !drag.moved) {
                  clearTouchDrag()
                  return
                }

                e.preventDefault()

                if (onReorder && dragOverValue !== null && dragOverValue !== drag.value) {
                  onReorder(drag.value, dragOverValue, dragDropPosition)
                }

                clearTouchDrag()
              }}
              onTouchCancel={clearTouchDrag}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button, [data-drag-handle]')) return
                e.preventDefault()
                onChange(option.value)
                setIsOpen(false)
                clearOptionTooltipTimer()
                setHoveredOptionTooltip(null)
              }}
              onMouseEnter={() => showValueTooltips && setHoveredOptionTooltip(option.value)}
              onMouseLeave={() => {
                clearOptionTooltipTimer()
                setHoveredOptionTooltip(null)
              }}
              onFocus={() => showValueTooltips && setHoveredOptionTooltip(option.value)}
              onBlur={() => {
                clearOptionTooltipTimer()
                setHoveredOptionTooltip(null)
              }}
              className={`relative flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs transition-colors ${
                draggedValue === option.value
                  ? 'opacity-40 bg-gray-100 dark:bg-white/[0.04]'
                  : option.variant === 'action'
                  ? 'font-semibold text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10'
                  : option.variant === 'danger'
                  ? 'font-semibold text-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
                  : option.value === value
                  ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/[0.06]'
              }`}
            >
              {dragOverValue === option.value && dragDropPosition === 'before' && draggedValue !== option.value && (
                <div className="absolute -top-[1px] left-0 right-0 h-[2px] bg-blue-500 rounded-full z-40 shadow-sm pointer-events-none" />
              )}
              {dragOverValue === option.value && dragDropPosition === 'after' && draggedValue !== option.value && (
                <div className="absolute -bottom-[1px] left-0 right-0 h-[2px] bg-blue-500 rounded-full z-40 shadow-sm pointer-events-none" />
              )}
              {showValueTooltips && hoveredOptionTooltip === option.value && (
                <ViewportTooltip visible={true} className="max-w-[300px] break-words whitespace-pre-wrap">
                  {option.label}
                </ViewportTooltip>
              )}
              <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
                {option.draggable && (
                  <div
                    data-drag-handle
                    className="flex cursor-grab active:cursor-grabbing items-center justify-center text-gray-400 opacity-60 transition-opacity hover:opacity-100 dark:text-gray-500"
                    style={{ touchAction: 'none' }}
                    title="拖拽排序"
                  >
                    <DragHandleIcon className="h-3.5 w-3.5" />
                  </div>
                )}
                <span className="min-w-0 truncate">{option.label}</span>
              </div>
              {option.actions?.length ? (
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {option.actions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      title={action.label}
                      onPointerDown={(event) => {
                        event.stopPropagation()
                      }}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        action.onClick()
                        setIsOpen(false)
                      }}
                      className={`rounded-md p-1.5 transition flex items-center justify-center ${action.variant === 'danger'
                        ? 'text-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
                        : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.08] dark:hover:text-gray-200'}`}
                    >
                      {action.label === '编辑' ? (
                        <EditIcon className="w-3.5 h-3.5" />
                      ) : action.label === '删除' ? (
                        <TrashIcon className="w-3.5 h-3.5" />
                      ) : (
                        action.label
                      )}
                    </button>
                  ))}
                </span>
              ) : null}
              {option.variant === 'action' && (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <PlusIcon className="h-4 w-4" />
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {touchDragPreview && createPortal(
        <div
          id="touch-drag-preview"
          className="fixed pointer-events-none z-[110] flex items-center justify-between gap-2 rounded-xl bg-white/95 px-3 py-2 text-xs text-gray-700 shadow-xl ring-1 ring-black/5 backdrop-blur-xl dark:bg-gray-900/95 dark:text-gray-300 dark:ring-white/10"
          style={{
            left: touchDragPreview.x - touchDragPreview.offsetX,
            top: touchDragPreview.y - touchDragPreview.offsetY,
            width: touchDragPreview.width,
            minHeight: touchDragPreview.height,
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
            <DragHandleIcon className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
            <span className="min-w-0 truncate">{touchDragPreview.label}</span>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
