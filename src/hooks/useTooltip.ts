import { useCallback, useEffect, useRef, useState } from 'react'
import { onDismissTooltips } from '../lib/tooltipDismiss'

/**
 * Unified tooltip hook that manages visibility, hover/focus/touch handlers,
 * and a `dismiss()` helper to hide the tooltip before opening modals, etc.
 *
 * Automatically subscribes to the global `dismissAllTooltips()` signal so
 * that every tooltip using this hook is hidden when any modal opens.
 *
 * Usage:
 *   const tooltip = useTooltip()
 *   <button {...tooltip.handlers} onClick={() => { tooltip.dismiss(); openModal() }}>
 *   <ViewportTooltip visible={tooltip.visible}>...</ViewportTooltip>
 */
export function useTooltip(delay = 500) {
  const [visible, setVisible] = useState(false)
  const timerRef = useRef<number | null>(null)
  // When dismissed (e.g. a modal opens), suppress any pending onClick timer
  // from re-showing the tooltip.  Reset on the next mouse/focus cycle.
  const suppressedRef = useRef(false)
  const longPressTriggeredRef = useRef(false)

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /** Immediately hide the tooltip and cancel any pending timer.
   *  Call this before opening a modal / performing an action that takes focus away. */
  const dismiss = useCallback(() => {
    clearTimer()
    suppressedRef.current = true
    longPressTriggeredRef.current = false
    setVisible(false)
  }, [clearTimer])

  useEffect(() => {
    return () => { clearTimer() }
  }, [clearTimer])

  // Auto-dismiss when any modal opens via the global bus
  useEffect(() => {
    return onDismissTooltips(dismiss)
  }, [dismiss])

  const show = useCallback(() => {
    suppressedRef.current = false
    setVisible(true)
  }, [])

  const hide = useCallback(() => {
    setVisible(false)
  }, [])

  const handlers = {
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    onTouchStart: () => {
      clearTimer()
      longPressTriggeredRef.current = false
      timerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true
        if (!suppressedRef.current) setVisible(true)
        timerRef.current = null
      }, delay)
    },
    onTouchMove: clearTimer,
    onClick: () => {
      clearTimer()
    },
    onTouchEnd: (e: React.TouchEvent | TouchEvent) => {
      clearTimer()
      if (longPressTriggeredRef.current) {
        if (e.cancelable) e.preventDefault()
      }
      longPressTriggeredRef.current = false
    },
    onTouchCancel: () => {
      clearTimer()
      longPressTriggeredRef.current = false
    },
  }

  return { visible, handlers, show, dismiss }
}
