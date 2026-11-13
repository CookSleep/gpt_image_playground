import { useEffect, useRef, type RefObject } from 'react'
import { dismissAllTooltips } from '../lib/tooltipDismiss'

/**
 * 弹层的关闭逻辑：点击弹层和触发按钮以外的位置或按 ESC 时关闭。
 * 打开弹层的那一次点击早于弹层挂载，不会命中这里的监听。
 */
export function usePopoverDismiss(
  open: boolean,
  refs: Array<RefObject<HTMLElement | null>>,
  onClose: () => void,
) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return

    const close = () => {
      // 弹层里的提示随弹层一起关闭
      dismissAllTooltips()
      closeRef.current()
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (refs.some((ref) => ref.current?.contains(target))) return
      close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])
}
