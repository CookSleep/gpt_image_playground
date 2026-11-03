const DROPDOWN_GAP_PX = 8
const OVERFLOW_BOUNDARY_RE = /(auto|scroll|hidden|clip)/

export const DEFAULT_DROPDOWN_MAX_HEIGHT = 240

// 圆角外壳只负责裁切，滚动交给内层 DROPDOWN_SCROLL_CLASS，滚动条才不会伸出圆角；
// maxHeight 设在外壳上，含边框在内
export const DROPDOWN_PANEL_CLASS = 'flex flex-col overflow-hidden rounded-xl border border-transparent bg-white/95 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl dark:bg-gray-800/95 dark:shadow-[0_8px_30px_rgb(0,0,0,0.4)] dark:ring-white/[0.06]'
// 拖拽排序靠 custom-scrollbar 找到滚动容器；iOS 上外壳的圆角裁不住滚动中的内层，
// 内层自己按外壳内圆角（12px 减 1px 边框）裁切
export const DROPDOWN_SCROLL_CLASS = 'custom-scrollbar ios-rounded-scroll-fix min-h-0 overflow-y-auto rounded-[11px]'

// 触发器上下方可用于展开菜单的高度，受视口和所有会裁切内容的祖先容器限制
export function getDropdownSpace(trigger: HTMLElement) {
  const rect = trigger.getBoundingClientRect()
  let below = window.innerHeight - rect.bottom - DROPDOWN_GAP_PX
  let above = rect.top - DROPDOWN_GAP_PX
  let parent = trigger.parentElement

  while (parent && parent !== document.body) {
    const style = window.getComputedStyle(parent)
    if (OVERFLOW_BOUNDARY_RE.test(`${style.overflow} ${style.overflowY}`)) {
      const parentRect = parent.getBoundingClientRect()
      below = Math.min(below, parentRect.bottom - rect.bottom - DROPDOWN_GAP_PX)
      above = Math.min(above, rect.top - parentRect.top - DROPDOWN_GAP_PX)
    }
    parent = parent.parentElement
  }

  return { above, below }
}

export function getDropdownMaxHeight(trigger: HTMLElement, maxHeight = DEFAULT_DROPDOWN_MAX_HEIGHT) {
  return Math.max(0, Math.min(maxHeight, Math.floor(getDropdownSpace(trigger).below)))
}
