import { useEffect, useRef } from 'react'
import { getTopDialog } from '../lib/dialogLayers'

const escStack: Array<{ layer?: HTMLElement; close: () => void }> = []

function globalKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
  const top = getTopDialog()
  const entry = top ? escStack.find((item) => item.layer === top) : escStack[escStack.length - 1]
  if (!entry) return
  event.preventDefault()
  entry.close()
}

export function useCloseOnEscape(enabled: boolean, onClose: () => void, layer?: HTMLElement) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!enabled) return
    const entry = { layer, close: () => closeRef.current() }
    if (!escStack.length) window.addEventListener('keydown', globalKeyDown)
    escStack.push(entry)
    return () => {
      escStack.splice(escStack.indexOf(entry), 1)
      if (!escStack.length) window.removeEventListener('keydown', globalKeyDown)
    }
  }, [enabled, layer])
}
