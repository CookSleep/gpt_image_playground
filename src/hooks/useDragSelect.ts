import { useEffect, useRef, useState, useCallback } from 'react'

interface UseDragSelectOptions {
  containerSelector: string
  itemSelector: string
  getItemId: (element: Element) => string | null
  onSelectionChange: (selectedIds: string[]) => void
  initialSelectedIds?: string[]
  onSuppressClick?: () => void
}

export function useDragSelect({
  containerSelector,
  itemSelector,
  getItemId,
  onSelectionChange,
  initialSelectedIds = [],
  onSuppressClick,
}: UseDragSelectOptions) {
  const [selectionBox, setSelectionBox] = useState<{ startPageX: number; startPageY: number; currentPageX: number; currentPageY: number } | null>(null)
  const isDragging = useRef(false)
  const dragStart = useRef<{ pageX: number; pageY: number } | null>(null)
  const lastClientPoint = useRef<{ x: number; y: number } | null>(null)
  const hasDragged = useRef(false)
  const dragScrollIntervalRef = useRef<number | null>(null)
  const dragScrollDirectionRef = useRef<-1 | 1 | null>(null)
  const startedOnItem = useRef(false)
  const startedWithCtrl = useRef(false)
  const initialSelection = useRef<string[]>([])
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  const getPagePoint = useCallback((clientX: number, clientY: number) => ({
    pageX: clientX + window.scrollX,
    pageY: clientY + window.scrollY,
  }), [])

  const beginSelection = useCallback((target: HTMLElement, clientX: number, clientY: number, isCtrl: boolean) => {
    const point = getPagePoint(clientX, clientY)

    startedOnItem.current = Boolean(target.closest(itemSelector))
    startedWithCtrl.current = isCtrl
    initialSelection.current = [...initialSelectedIds]

    isDragging.current = true
    hasDragged.current = false
    dragStart.current = point
    lastClientPoint.current = { x: clientX, y: clientY }
    document.body.classList.add('select-none')
    document.body.classList.add('drag-selecting')
    setSelectionBox({
      startPageX: point.pageX,
      startPageY: point.pageY,
      currentPageX: point.pageX,
      currentPageY: point.pageY,
    })
  }, [getPagePoint, initialSelectedIds, itemSelector])

  const updateSelectionFromPoint = useCallback((pageX: number, pageY: number) => {
    const start = dragStart.current
    if (!start) return

    const minX = Math.min(start.pageX, pageX)
    const maxX = Math.max(start.pageX, pageX)
    const minY = Math.min(start.pageY, pageY)
    const maxY = Math.max(start.pageY, pageY)

    const containers = document.querySelectorAll(containerSelector)
    const newSelected = new Set(initialSelection.current)
    const initialSelected = new Set(initialSelection.current)

    containers.forEach((container) => {
      const items = container.querySelectorAll(itemSelector)
      items.forEach((item) => {
        const rect = item.getBoundingClientRect()
        const id = getItemId(item)
        if (!id) return

        const itemLeft = rect.left + window.scrollX
        const itemRight = rect.right + window.scrollX
        const itemTop = rect.top + window.scrollY
        const itemBottom = rect.bottom + window.scrollY

        const isIntersecting =
          minX < itemRight && maxX > itemLeft && minY < itemBottom && maxY > itemTop

        if (isIntersecting) {
          if (initialSelected.has(id)) {
            newSelected.delete(id)
          } else {
            newSelected.add(id)
          }
        } else if (!initialSelected.has(id)) {
          newSelected.delete(id)
        }
      })
    })

    onSelectionChange(Array.from(newSelected))
  }, [containerSelector, getItemId, itemSelector, onSelectionChange])

  useEffect(() => {
    const stopDragScroll = () => {
      if (dragScrollIntervalRef.current) {
        clearInterval(dragScrollIntervalRef.current)
        dragScrollIntervalRef.current = null
      }
      dragScrollDirectionRef.current = null
    }

    const startDragScroll = (direction: -1 | 1) => {
      if (dragScrollIntervalRef.current && dragScrollDirectionRef.current === direction) return
      stopDragScroll()
      dragScrollDirectionRef.current = direction
      dragScrollIntervalRef.current = window.setInterval(() => {
        window.scrollBy({ top: direction * 15, behavior: 'instant' })
      }, 16)
    }

    const endSelection = (clearEmptySurfaceClick = false, suppressClick = false) => {
      if (isDragging.current) {
        document.body.classList.remove('select-none')
        document.body.classList.remove('drag-selecting')
      }
      if (isDragging.current && clearEmptySurfaceClick && !hasDragged.current && !startedOnItem.current && !startedWithCtrl.current) {
        onSelectionChange([])
      }
      if (suppressClick && hasDragged.current) onSuppressClick?.()
      stopDragScroll()
      isDragging.current = false
      dragStart.current = null
      lastClientPoint.current = null
      setSelectionBox(null)
    }

    const getEventElement = (e: MouseEvent) => {
      if (e.target instanceof Element) return e.target
      return document.elementFromPoint(e.clientX, e.clientY)
    }

    const handleDocumentMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = getEventElement(e)
      if (!target) return
      if (!target.closest(containerSelector)) return
      if (target.closest('[data-input-bar]')) return
      if (target.closest('[data-no-drag-select], [data-lightbox-root]')) return
      
      const closestInteractive = target.closest('button, a, input, textarea, select, [draggable="true"]')
      
      // If we clicked on an interactive element (like a button or draggable thumb)
      if (closestInteractive) {
        // If it's the ReferenceThumb button itself, don't start box selection, allow native drag and drop
        if (closestInteractive.closest('.reference-thumb-wrapper')) return
        
        // If it's a button/link inside TaskCard (like delete/reuse), don't start selection
        // Wait, if it's the TaskCard wrapper itself (which is not a button), closestInteractive would be null.
        // If the user clicked a real button inside TaskCard, closestInteractive is the button.
        // We MUST return here so the button click works!
        return
      }

      const isCtrl = isMac ? e.metaKey : e.ctrlKey
      beginSelection(target as HTMLElement, e.clientX, e.clientY, isCtrl)
      e.preventDefault()
    }

    const handleDocumentMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragStart.current) return

      const start = dragStart.current
      const point = getPagePoint(e.clientX, e.clientY)
      lastClientPoint.current = { x: e.clientX, y: e.clientY }
      const distance = Math.hypot(point.pageX - start.pageX, point.pageY - start.pageY)
      if (distance < 6 && !hasDragged.current) return

      hasDragged.current = true
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
      e.preventDefault()

      const scrollThreshold = 40
      if (e.clientY < scrollThreshold) {
        startDragScroll(-1)
      } else if (e.clientY > window.innerHeight - scrollThreshold) {
        startDragScroll(1)
      } else {
        stopDragScroll()
      }
    }

    const handleDocumentScroll = () => {
      if (!isDragging.current || !dragStart.current || !lastClientPoint.current || !hasDragged.current) return

      const point = getPagePoint(lastClientPoint.current.x, lastClientPoint.current.y)
      const start = dragStart.current
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
    }

    const handleDocumentWheel = (e: WheelEvent) => {
      if (!isDragging.current) return
      if ((e.buttons & 1) === 0) {
        endSelection()
        return
      }
      if (!hasDragged.current) return
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
    }

    const handleDocumentMouseUp = () => {
      endSelection(true, true)
    }

    document.addEventListener('mousedown', handleDocumentMouseDown, true)
    document.addEventListener('mousemove', handleDocumentMouseMove, true)
    document.addEventListener('mouseup', handleDocumentMouseUp, true)
    document.addEventListener('wheel', handleDocumentWheel, { capture: true, passive: false })
    window.addEventListener('scroll', handleDocumentScroll, true)
    return () => {
      stopDragScroll()
      document.removeEventListener('mousedown', handleDocumentMouseDown, true)
      document.removeEventListener('mousemove', handleDocumentMouseMove, true)
      document.removeEventListener('mouseup', handleDocumentMouseUp, true)
      document.removeEventListener('wheel', handleDocumentWheel, true)
      window.removeEventListener('scroll', handleDocumentScroll, true)
    }
  }, [beginSelection, containerSelector, isMac, itemSelector, onSelectionChange, onSuppressClick, updateSelectionFromPoint])

  return { selectionBox, isDragging: isDragging.current }
}
