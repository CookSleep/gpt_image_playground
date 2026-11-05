import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { onDismissTooltips } from '../lib/tooltipDismiss'

interface UseHintTooltipOptions {
  enabled?: () => boolean
  autoHideMs?: number
  touchDelayMs?: number
}

export function useHintTooltip(options: UseHintTooltipOptions = {}) {
  const { autoHideMs, touchDelayMs = 450 } = options
  const [visible, setVisible] = useState(false)
  const touchTimerRef = useRef<number | null>(null)
  const autoHideTimerRef = useRef<number | null>(null)
  const enabledRef = useRef(options.enabled)
  enabledRef.current = options.enabled

  const clearTimer = useCallback(() => {
    if (touchTimerRef.current != null) {
      window.clearTimeout(touchTimerRef.current)
      touchTimerRef.current = null
    }
  }, [])

  const clearAutoHideTimer = useCallback(() => {
    if (autoHideTimerRef.current != null) {
      window.clearTimeout(autoHideTimerRef.current)
      autoHideTimerRef.current = null
    }
  }, [])

  const hide = useCallback(() => {
    setVisible(false)
    clearTimer()
    clearAutoHideTimer()
  }, [clearAutoHideTimer, clearTimer])

  const show = useCallback(() => {
    if (enabledRef.current && !enabledRef.current()) return
    clearTimer()
    clearAutoHideTimer()
    setVisible(true)
    if (autoHideMs != null) {
      autoHideTimerRef.current = window.setTimeout(() => {
        setVisible(false)
        autoHideTimerRef.current = null
      }, autoHideMs)
    }
  }, [autoHideMs, clearAutoHideTimer, clearTimer])

  const startTouch = useCallback(() => {
    if (enabledRef.current && !enabledRef.current()) return
    clearTimer()
    touchTimerRef.current = window.setTimeout(() => {
      touchTimerRef.current = null
      show()
    }, touchDelayMs)
  }, [clearTimer, show, touchDelayMs])

  // 显示状态由调用方保存，提示所在的弹层关闭后仍会保留，需随全局关闭一起清除
  useEffect(() => onDismissTooltips(hide), [hide])

  useEffect(() => () => {
    clearTimer()
    clearAutoHideTimer()
  }, [clearAutoHideTimer, clearTimer])

  return useMemo(
    () => ({ visible, show, hide, clearTimer, startTouch }),
    [clearTimer, hide, show, startTouch, visible],
  )
}
