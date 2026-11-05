import { useEffect, useRef, useState, type ReactNode } from 'react'
import { dismissAllTooltips } from '../../lib/tooltipDismiss'
import { ChevronDownIcon } from '../icons'

export const CHIP_BASE_CLASS = 'h-8 px-3.5 rounded-full text-xs transition-colors duration-200 focus:outline-none'
export const CHIP_IDLE_CLASS = 'bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] text-gray-700 dark:text-gray-200'
const PANEL_WIDTH = 240
const ACTIVE_CLASS = 'bg-blue-500/[0.1] dark:bg-blue-500/[0.16] hover:bg-blue-500/[0.14] dark:hover:bg-blue-500/[0.22] text-blue-600 dark:text-blue-400'

/** 参数栏中点击展开弹层的胶囊，summary 为折叠时显示的当前值 */
export default function ParamPopoverChip({
  label,
  summary,
  active = false,
  className = '',
  children,
}: {
  label: string
  summary?: string
  active?: boolean
  className?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [alignRight, setAlignRight] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    // 弹层内的提示随弹层一起关闭
    const close = () => {
      dismissAllTooltips()
      setOpen(false)
    }
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) close()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className={`relative min-w-0 max-sm:flex-auto ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          dismissAllTooltips()
          // 胶囊靠近窗口右侧时弹层改为右对齐，避免超出屏幕
          const rect = buttonRef.current?.getBoundingClientRect()
          if (rect) setAlignRight(rect.left + PANEL_WIDTH > window.innerWidth - 8)
          setOpen((value) => !value)
        }}
        aria-expanded={open}
        className={`flex w-full items-center gap-1 min-w-0 ${CHIP_BASE_CLASS} ${active ? ACTIVE_CLASS : CHIP_IDLE_CLASS} ${open && !active ? '!bg-black/[0.07] dark:!bg-white/[0.1]' : ''}`}
      >
        <span className="flex-shrink-0">{label}</span>
        {summary && <span className={`flex-1 truncate text-left ${active ? 'opacity-75' : 'text-gray-400 dark:text-gray-500'}`}>· {summary}</span>}
        <ChevronDownIcon className={`w-3.5 h-3.5 flex-shrink-0 transition-transform duration-200 ${active ? '' : 'text-gray-400 dark:text-gray-500'} ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          ref={panelRef}
          style={{ width: PANEL_WIDTH }}
          className={`absolute bottom-full ${alignRight ? 'right-0' : 'left-0'} z-40 mb-2 flex flex-col gap-2 rounded-xl bg-white/95 p-3 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl animate-dropdown-up dark:bg-gray-800/95 dark:shadow-[0_8px_30px_rgb(0,0,0,0.4)] dark:ring-white/[0.06]`}
        >
          {children}
        </div>
      )}
    </div>
  )
}
