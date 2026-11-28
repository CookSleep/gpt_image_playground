import { useLayoutEffect, useState } from 'react'
import { getTopDialog, syncDialogLayers } from '../lib/dialogLayers'
import { useCloseOnEscape } from './useCloseOnEscape'
import { usePreventBackgroundScroll } from './usePreventBackgroundScroll'

export function useDialogLayer(onClose: () => void, layerId: 'app-dialogs' | 'confirm-dialogs' = 'app-dialogs', active = true) {
  const [element] = useState(() => document.createElement('div'))
  useLayoutEffect(() => {
    if (!active) return
    const previous = document.activeElement
    const layer = document.getElementById(layerId)!
    element.className = 'relative isolate outline-none'
    element.tabIndex = -1
    layer.append(element)
    syncDialogLayers()
    if (element === getTopDialog()) element.focus({ preventScroll: true })

    return () => {
      const wasTop = element === getTopDialog()
      element.remove()
      syncDialogLayers()
      if (wasTop && previous instanceof HTMLElement && previous.isConnected && !previous.closest('[inert]')) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [active, element, layerId])
  useCloseOnEscape(active, onClose, element)
  usePreventBackgroundScroll(active)
  return element
}
