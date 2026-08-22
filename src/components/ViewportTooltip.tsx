import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { onDismissTooltips } from '../lib/tooltipDismiss'

interface ViewportTooltipProps {
  visible: boolean
  children: ReactNode
  className?: string
}

export default function ViewportTooltip({ visible, children, className = '' }: ViewportTooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{
    left: number
    top: number
    arrowLeft: number
    placement: 'top' | 'bottom'
  } | null>(null)

  // Global dismiss: when any modal opens, suppress the tooltip even if
  // the parent still passes visible=true.  Reset when visible goes back
  // to false (so the next hover cycle works normally).
  const [suppressed, setSuppressed] = useState(false)

  useEffect(() => {
    if (!visible) {
      setSuppressed(false)
      return
    }
    return onDismissTooltips(() => setSuppressed(true))
  }, [visible])

  const effectiveVisible = visible && !suppressed

  // 检查锚点中心是否仍在最上层可命中（未被弹窗等遮挡）
  const isAnchorExposed = (anchor: HTMLElement, rect: DOMRect) => {
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    if (x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight) return false
    const el = document.elementFromPoint(x, y)
    return !!el && anchor.contains(el)
  }

  useEffect(() => {
    if (!effectiveVisible) return

    const hideIfOutside = (event: PointerEvent | TouchEvent) => {
      const target = event.target
      const anchorParent = anchorRef.current?.parentElement
      if (!(target instanceof Node)) return
      if (anchorParent?.contains(target) || tooltipRef.current?.contains(target)) return
      setSuppressed(true)
    }

    document.addEventListener('pointerdown', hideIfOutside, true)
    document.addEventListener('touchstart', hideIfOutside, true)
    return () => {
      document.removeEventListener('pointerdown', hideIfOutside, true)
      document.removeEventListener('touchstart', hideIfOutside, true)
    }
  }, [effectiveVisible])

  useEffect(() => {
    if (!effectiveVisible) {
      setPosition(null)
      return
    }

    const updatePosition = () => {
      const anchor = anchorRef.current?.parentElement
      const el = tooltipRef.current
      if (!anchor || !el) return

      const margin = 8
      const gap = 8
      const anchorRect = anchor.getBoundingClientRect()
      if (!anchor.getClientRects().length || (anchorRect.width === 0 && anchorRect.height === 0)) {
        setPosition(null)
        return
      }
      if (!isAnchorExposed(anchor, anchorRect)) {
        setPosition(null)
        return
      }

      const tooltipRect = el.getBoundingClientRect()
      const anchorCenter = anchorRect.left + anchorRect.width / 2
      const maxLeft = Math.max(margin, window.innerWidth - tooltipRect.width - margin)
      const left = Math.min(Math.max(anchorCenter - tooltipRect.width / 2, margin), maxLeft)
      const aboveTop = anchorRect.top - tooltipRect.height - gap
      const placement = aboveTop >= margin ? 'top' : 'bottom'
      const top = placement === 'top' ? aboveTop : anchorRect.bottom + gap

      setPosition({
        left,
        top,
        arrowLeft: anchorCenter - left,
        placement,
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [effectiveVisible, children])

  return (
    <>
      <span ref={anchorRef} className="hidden" aria-hidden />
      {effectiveVisible && createPortal(
        <div
          ref={tooltipRef}
          className={`fixed pointer-events-none rounded-lg bg-gray-800 px-3 py-2 text-xs font-normal text-white shadow-lg ${className}`}
          style={{
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            visibility: position ? 'visible' : 'hidden',
            zIndex: 120,
          }}
        >
          {children}
          <div
            className={`absolute left-0 border-4 border-transparent ${position?.placement === 'bottom' ? 'bottom-full border-b-gray-800' : 'top-full border-t-gray-800'}`}
            style={{
              left: position?.arrowLeft ?? 0,
              transform: 'translateX(-50%)',
            }}
          />
        </div>,
        document.body,
      )}
    </>
  )
}
