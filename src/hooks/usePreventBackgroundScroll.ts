import { useEffect, type RefObject } from 'react'

import { getTopDialog } from '../lib/dialogLayers'

type ScrollBoundaryRef = RefObject<HTMLElement | null>
type ScrollDelta = { x: number; y: number }

let lockCount = 0
let previousBodyOverflow = ''
let previousBodyOverscrollBehavior = ''
let previousDocumentOverscrollBehavior = ''

function getAllowedRoot(target: EventTarget | null, allowRefs?: ScrollBoundaryRef | ScrollBoundaryRef[]) {
  if (!(target instanceof Node)) return null
  const top = getTopDialog()
  if (top instanceof HTMLElement) return top.contains(target) ? top : null
  if (!allowRefs) return null

  const refs = Array.isArray(allowRefs) ? allowRefs : [allowRefs]
  for (const ref of refs) {
    const element = ref.current
    if (element?.contains(target)) return element
  }

  return null
}

function canScrollAxis(element: HTMLElement, axis: 'x' | 'y', delta: number) {
  if (delta === 0) return false

  const style = window.getComputedStyle(element)
  const overflow = axis === 'y' ? style.overflowY : style.overflowX
  if (!/(auto|scroll|overlay)/.test(overflow)) return false

  if (axis === 'y') {
    if (element.scrollHeight <= element.clientHeight) return false
    if (delta < 0) return element.scrollTop > 0
    return element.scrollTop + element.clientHeight < element.scrollHeight - 1
  }

  if (element.scrollWidth <= element.clientWidth) return false
  if (delta < 0) return element.scrollLeft > 0
  return element.scrollLeft + element.clientWidth < element.scrollWidth - 1
}

function canScrollElement(element: HTMLElement, delta: ScrollDelta) {
  return canScrollAxis(element, 'y', delta.y) || canScrollAxis(element, 'x', delta.x)
}

function getElementFromTarget(target: EventTarget | null) {
  if (target instanceof HTMLElement) return target
  if (target instanceof Node) return target.parentElement
  return null
}

function canScrollWithin(root: HTMLElement, target: EventTarget | null, delta: ScrollDelta) {
  let element = getElementFromTarget(target)

  while (element && root.contains(element)) {
    if (canScrollElement(element, delta)) return true
    if (element === root) break
    element = element.parentElement
  }

  return false
}

export function usePreventBackgroundScroll(active: boolean, allowRefs?: ScrollBoundaryRef | ScrollBoundaryRef[]) {
  useEffect(() => {
    if (!active) return

    if (lockCount === 0) {
      previousBodyOverflow = document.body.style.overflow
      previousBodyOverscrollBehavior = document.body.style.overscrollBehavior
      previousDocumentOverscrollBehavior = document.documentElement.style.overscrollBehavior
      document.body.style.overflow = 'hidden'
      document.body.style.overscrollBehavior = 'none'
      document.documentElement.style.overscrollBehavior = 'none'
    }
    lockCount += 1

    let lastTouchX = 0
    let lastTouchY = 0

    const preventOutsideWheel = (event: WheelEvent) => {
      const root = getAllowedRoot(event.target, allowRefs)
      if (!root || !canScrollWithin(root, event.target, { x: event.deltaX, y: event.deltaY })) {
        event.preventDefault()
      }
    }

    const trackTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) return
      lastTouchX = touch.clientX
      lastTouchY = touch.clientY
    }

    const preventOutsideTouch = (event: TouchEvent) => {
      const touch = event.touches[0]
      const root = getAllowedRoot(event.target, allowRefs)
      if (!touch || !root) {
        event.preventDefault()
        return
      }

      const delta = { x: lastTouchX - touch.clientX, y: lastTouchY - touch.clientY }
      lastTouchX = touch.clientX
      lastTouchY = touch.clientY

      if (!canScrollWithin(root, event.target, delta)) event.preventDefault()
    }

    document.addEventListener('wheel', preventOutsideWheel, { capture: true, passive: false })
    document.addEventListener('touchstart', trackTouchStart, { capture: true, passive: true })
    document.addEventListener('touchmove', preventOutsideTouch, { capture: true, passive: false })

    return () => {
      document.removeEventListener('wheel', preventOutsideWheel, { capture: true })
      document.removeEventListener('touchstart', trackTouchStart, { capture: true })
      document.removeEventListener('touchmove', preventOutsideTouch, { capture: true })

      lockCount = Math.max(0, lockCount - 1)
      if (lockCount === 0) {
        document.body.style.overflow = previousBodyOverflow
        document.body.style.overscrollBehavior = previousBodyOverscrollBehavior
        document.documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior
      }
    }
  }, [active, allowRefs])
}

