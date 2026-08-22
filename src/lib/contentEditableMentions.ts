import { getSelectedTextMentionLabel } from './promptImageMentions'

function getMentionTagTextLength(el: Element) {
  return el.textContent?.length ?? 0
}

function getNodeVisibleTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
  if (node instanceof HTMLElement && node.classList.contains('mention-tag')) {
    return getMentionTagTextLength(node)
  }
  return Array.from(node.childNodes).reduce((sum, child) => sum + getNodeVisibleTextLength(child), 0)
}

function getVisibleOffsetBeforeNode(root: HTMLElement, target: Node): number {
  let offset = 0
  let found = false

  const walk = (node: Node) => {
    if (found) return
    if (node === target) {
      found = true
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0
      return
    }
    if (node instanceof HTMLElement && node.classList.contains('mention-tag')) {
      offset += getMentionTagTextLength(node)
      return
    }
    node.childNodes.forEach(walk)
  }

  root.childNodes.forEach(walk)
  return offset
}

function getMentionTagForBoundary(root: HTMLElement, container: Node) {
  const el = container.nodeType === Node.ELEMENT_NODE
    ? container as Element
    : container.parentElement
  const tag = el?.closest('.mention-tag')
  return tag && root.contains(tag) ? tag : null
}

function getBoundaryOffsetInMention(tag: Element, container: Node, offset: number) {
  try {
    const range = document.createRange()
    range.selectNodeContents(tag)
    range.setEnd(container, offset)
    return range.toString().length
  } catch {
    // contenteditable=false 的内部 Range 边界存在浏览器兼容差异
    return getMentionTagTextLength(tag)
  }
}

function getContentEditableBoundaryOffset(
  root: HTMLElement,
  container: Node,
  offset: number,
  edge: 'start' | 'end',
  collapsed: boolean,
) {
  if (container === root) {
    let visibleOffset = 0
    for (const child of Array.from(root.childNodes).slice(0, offset)) {
      visibleOffset += getNodeVisibleTextLength(child)
    }
    return visibleOffset
  }

  if (!root.contains(container)) {
    // 处理输入框外的选区边界（如 Ctrl+A）
    const position = root.compareDocumentPosition(container)
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 0
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return root.textContent?.length ?? 0

    // 根据父容器偏移量判断在输入框前后
    if (container.contains(root)) {
      const children = Array.from(container.childNodes)
      const rootIndex = children.indexOf(root)
      return offset <= rootIndex ? 0 : root.textContent?.length ?? 0
    }
    return edge === 'start' ? 0 : root.textContent?.length ?? 0
  }

  const mentionTag = getMentionTagForBoundary(root, container)
  if (mentionTag) {
    const mentionStart = getVisibleOffsetBeforeNode(root, mentionTag)
    const mentionLength = getMentionTagTextLength(mentionTag)
    if (!collapsed) return edge === 'start' ? mentionStart : mentionStart + mentionLength
    const mentionOffset = getBoundaryOffsetInMention(mentionTag, container, offset)
    return mentionStart + (mentionOffset < mentionLength / 2 ? 0 : mentionLength)
  }

  if (container.nodeType === Node.TEXT_NODE) {
    return getVisibleOffsetBeforeNode(root, container) + offset
  }

  const element = container.nodeType === Node.ELEMENT_NODE ? container as Element : null
  if (element) {
    let visibleOffset = element === root ? 0 : getVisibleOffsetBeforeNode(root, element)
    for (const child of Array.from(element.childNodes).slice(0, offset)) {
      visibleOffset += getNodeVisibleTextLength(child)
    }
    return visibleOffset
  }

  return root.textContent?.length ?? 0
}

/** 获取 contentEditable 中光标的纯文本偏移量 */
export function getContentEditableCursor(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return el.textContent?.length ?? 0
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return el.textContent?.length ?? 0
  return getContentEditableBoundaryOffset(el, range.startContainer, range.startOffset, 'start', range.collapsed)
}

export function getContentEditableSelection(el: HTMLElement): { start: number; end: number } {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) {
    const end = el.textContent?.length ?? 0
    return { start: end, end }
  }
  const range = sel.getRangeAt(0)
  const start = getContentEditableBoundaryOffset(el, range.startContainer, range.startOffset, 'start', range.collapsed)
  const end = range.collapsed
    ? start
    : getContentEditableBoundaryOffset(el, range.endContainer, range.endOffset, 'end', false)
  return { start, end }
}

export function getContentEditablePlainText(el: HTMLElement): string {
  let text = ''
  const appendNodeText = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      return
    }
    if (node instanceof HTMLElement && node.classList.contains('mention-tag')) {
      text += node.dataset.mentionText ?? node.textContent ?? ''
      return
    }
    node.childNodes.forEach(appendNodeText)
  }
  el.childNodes.forEach(appendNodeText)
  return text.replace(/\r\n?/g, '\n')
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function getMentionTagHtml(text: string) {
  return `<span contenteditable="false" class="mention-tag" data-mention-text="${escapeHtml(getSelectedTextMentionLabel(text))}">${escapeHtml(text)}</span>`
}

export function syncMentionTagSelection(el: HTMLElement) {
  const tags = el.querySelectorAll<HTMLElement>('.mention-tag')
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) {
    tags.forEach((tag) => tag.classList.remove('selected'))
    return
  }

  const range = sel.getRangeAt(0)
  if (range.collapsed) {
    tags.forEach((tag) => tag.classList.remove('selected'))
    return
  }

  tags.forEach((tag) => {
    let isSelected = false
    try {
      isSelected = range.intersectsNode(tag)
    } catch {
      // 分离节点等 Range 边界状态在不同浏览器中可能抛出异常
      isSelected = false
    }
    tag.classList.toggle('selected', isSelected)
  })
}

/** 在 contentEditable 中设置光标到指定纯文本偏移量 */
export function setContentEditableCursor(el: HTMLElement, offset: number) {
  const sel = window.getSelection()
  if (!sel) return
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let node: Text | null = null
  while (walker.nextNode()) {
    node = walker.currentNode as Text
    const mentionTag = node.parentElement?.closest('.mention-tag')
    if (mentionTag) {
      if (remaining <= node.length) {
        const range = document.createRange()
        if (remaining < node.length / 2) {
          range.setStartBefore(mentionTag)
        } else {
          range.setStartAfter(mentionTag)
        }
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
        return
      }
      remaining -= node.length
      continue
    }
    if (remaining <= node.length) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
      return
    }
    remaining -= node.length
  }
  // 偏移超出则放至末尾
  if (node) {
    const range = document.createRange()
    range.setStart(node, node.length)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
}

export function setContentEditableSelection(el: HTMLElement, start: number, end: number) {
  const sel = window.getSelection()
  if (!sel) return

  type Boundary =
    | { type: 'offset'; node: Node; offset: number }
    | { type: 'before'; element: Element }
    | { type: 'after'; element: Element }

  const findBoundary = (targetOffset: number, edge: 'start' | 'end'): Boundary => {
    let remaining = targetOffset
    let lastBoundary: Boundary = { type: 'offset', node: el, offset: 0 }

    const walk = (current: Node): Boundary | null => {
      if (current.nodeType === Node.TEXT_NODE) {
        const node = current as Text
        lastBoundary = { type: 'offset', node, offset: node.length }
        if (remaining <= node.length) return { type: 'offset', node, offset: remaining }
        remaining -= node.length
        return null
      }

      if (current instanceof HTMLElement && current.classList.contains('mention-tag')) {
        const length = getMentionTagTextLength(current)
        if (remaining <= 0) return { type: 'before', element: current }
        if (remaining < length) return edge === 'start' ? { type: 'before', element: current } : { type: 'after', element: current }
        if (remaining === length) return { type: 'after', element: current }
        remaining -= length
        return null
      }

      for (const child of Array.from(current.childNodes)) {
        const boundary = walk(child)
        if (boundary) return boundary
      }
      return null
    }

    return walk(el) ?? lastBoundary
  }

  const applyBoundary = (range: Range, boundary: Boundary, target: 'start' | 'end') => {
    if (boundary.type === 'before') {
      target === 'start' ? range.setStartBefore(boundary.element) : range.setEndBefore(boundary.element)
      return
    }
    if (boundary.type === 'after') {
      target === 'start' ? range.setStartAfter(boundary.element) : range.setEndAfter(boundary.element)
      return
    }
    target === 'start' ? range.setStart(boundary.node, boundary.offset) : range.setEnd(boundary.node, boundary.offset)
  }

  const startBoundary = findBoundary(start, 'start')
  const endBoundary = findBoundary(end, 'end')
  const range = document.createRange()
  applyBoundary(range, startBoundary, 'start')
  applyBoundary(range, endBoundary, 'end')
  sel.removeAllRanges()
  sel.addRange(range)
}
