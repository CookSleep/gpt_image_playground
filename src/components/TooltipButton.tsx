import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useTooltip } from '../hooks/useTooltip'
import ViewportTooltip from './ViewportTooltip'

export function TooltipButton({
  tooltip,
  className,
  wrapperClassName = 'relative inline-flex',
  disabled = false,
  showOnClick = false,
  stopPropagation = false,
  onClick,
  onMouseDown,
  children,
}: {
  tooltip: string
  className: string
  wrapperClassName?: string
  disabled?: boolean
  showOnClick?: boolean
  stopPropagation?: boolean
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  onMouseDown?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}) {
  const tooltipState = useTooltip()

  return (
    <span className={wrapperClassName} {...tooltipState.handlers}>
      <button
        type="button"
        className={className}
        aria-label={tooltip}
        aria-disabled={disabled}
        disabled={disabled && !showOnClick}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation()
          if (showOnClick) tooltipState.show()
          else tooltipState.dismiss()
          if (disabled) return
          onClick?.(e)
        }}
        onMouseDown={(e) => {
          tooltipState.dismiss()
          if (disabled) return
          onMouseDown?.(e)
        }}
      >
        {children}
      </button>
      <ViewportTooltip visible={tooltipState.visible} className="whitespace-nowrap">
        {tooltip}
      </ViewportTooltip>
    </span>
  )
}
