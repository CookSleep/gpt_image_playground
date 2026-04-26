const VIEWPORT_CONTENT = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'

function isInsideLightbox(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('[data-lightbox-root]'))
}

export function installMobileViewportGuards() {
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (viewport) viewport.content = VIEWPORT_CONTENT

  const preventPageGesture = (event: Event) => {
    if (!isInsideLightbox(event.target)) event.preventDefault()
  }

  const preventMultiTouchPageZoom = (event: TouchEvent) => {
    if (event.touches.length > 1 && !isInsideLightbox(event.target)) event.preventDefault()
  }

  document.addEventListener('gesturestart', preventPageGesture, { passive: false })
  document.addEventListener('gesturechange', preventPageGesture, { passive: false })
  document.addEventListener('touchmove', preventMultiTouchPageZoom, { passive: false })
}
