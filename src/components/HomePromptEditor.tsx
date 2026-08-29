import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { InputImage } from '../types'
import { getAtImageQuery, getImageMentionLabel, imageMentionMatches, insertImageMentionAtVisibleRange, stripImageMentionMarkers } from '../lib/promptImageMentions'
import { CloseIcon } from './icons'

const MENTION_START = '\u2063'
const MENTION_END = '\u2064'
const SELECTED_IMAGE_MENTION_RE = /\u2063(@图(\d+))\u2064/g

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderPromptHtml(prompt: string) {
  let html = ''
  let lastIndex = 0
  for (const match of prompt.matchAll(SELECTED_IMAGE_MENTION_RE)) {
    if (match.index == null) continue
    html += escapeHtml(prompt.slice(lastIndex, match.index)).replace(/\n/g, '<br>')
    const label = match[1]
    html += `<span contenteditable="false" class="mention-tag" data-mention-text="${escapeHtml(label)}">${escapeHtml(label)}</span>`
    lastIndex = match.index + match[0].length
  }
  return `${html}${escapeHtml(prompt.slice(lastIndex)).replace(/\n/g, '<br>')}`
}

function getPromptText(root: HTMLElement) {
  let text = ''
  const append = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      return
    }
    if (node instanceof HTMLElement && node.classList.contains('mention-tag')) {
      text += `${MENTION_START}${node.dataset.mentionText ?? node.textContent ?? ''}${MENTION_END}`
      return
    }
    if (node instanceof HTMLElement && node.tagName === 'BR') {
      text += '\n'
      return
    }
    node.childNodes.forEach(append)
  }
  root.childNodes.forEach(append)
  return text.replace(/\r\n?/g, '\n')
}

function getCursorOffset(root: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return stripImageMentionMarkers(root.textContent ?? '').length
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return stripImageMentionMarkers(root.textContent ?? '').length
  const before = document.createRange()
  before.selectNodeContents(root)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().length
}

function setCursorOffset(root: HTMLElement, targetOffset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = targetOffset
  let node: Text | null = null
  while (walker.nextNode()) {
    node = walker.currentNode as Text
    const mention = node.parentElement?.closest('.mention-tag')
    if (mention) {
      if (remaining <= 0) {
        const range = document.createRange()
        range.setStartBefore(mention)
        range.collapse(true)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return
      }
      if (remaining <= node.length) {
        const range = document.createRange()
        range.setStartAfter(mention)
        range.collapse(true)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return
      }
      remaining -= node.length
      continue
    }
    if (remaining <= node.length) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }
    remaining -= node.length
  }
  if (!node) return
  const range = document.createRange()
  range.setStart(node, node.length)
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

interface HomePromptEditorProps {
  value: string
  images: InputImage[]
  placeholder: string
  onChange: (value: string) => void
  onSubmit: () => void
}

export default function HomePromptEditor({ value, images, placeholder, onChange, onSubmit }: HomePromptEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const pendingCursorRef = useRef<number | null>(null)
  const [cursorPos, setCursorPos] = useState(0)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  const visibleValue = stripImageMentionMarkers(value)
  const atQuery = getAtImageQuery(visibleValue, cursorPos, images)
  const options = atQuery
    ? images
        .map((image, index) => ({ image, index, label: getImageMentionLabel(index) }))
        .filter((option) => imageMentionMatches(atQuery.query, option.index))
    : []
  const showMenu = !menuDismissed && options.length > 0

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (getPromptText(editor) !== value) editor.innerHTML = renderPromptHtml(value)
    if (pendingCursorRef.current != null) {
      setCursorOffset(editor, pendingCursorRef.current)
      pendingCursorRef.current = null
    }
  }, [value])

  const syncInput = () => {
    const editor = editorRef.current
    if (!editor) return
    onChange(getPromptText(editor))
    setCursorPos(getCursorOffset(editor))
    setMenuIndex(0)
    setMenuDismissed(false)
  }

  const selectOption = (option: (typeof options)[number]) => {
    const editor = editorRef.current
    const cursor = editor ? getCursorOffset(editor) : visibleValue.length
    const query = getAtImageQuery(visibleValue, cursor, images)
    if (!query) return
    const next = insertImageMentionAtVisibleRange(value, query.start, cursor, option.index)
    pendingCursorRef.current = next.cursor
    onChange(next.prompt)
    setMenuDismissed(true)
    setMenuIndex(0)
    window.setTimeout(() => editorRef.current?.focus(), 0)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (showMenu) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMenuIndex((index) => (index + 1) % options.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMenuIndex((index) => (index - 1 + options.length) % options.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        selectOption(options[menuIndex] ?? options[0])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuDismissed(true)
        editorRef.current?.blur()
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSubmit()
    }
  }

  const clearPrompt = () => {
    onChange('')
    if (editorRef.current) {
      editorRef.current.innerHTML = ''
      editorRef.current.focus()
    }
  }

  return (
    <div className="relative grid grid-cols-[minmax(0,1fr)]">
      {showMenu && (
        <div className="absolute bottom-full z-50 mb-2 w-64 overflow-hidden rounded-2xl border border-gray-200/70 bg-white/95 p-1.5 shadow-xl ring-1 ring-black/5 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
          <div className="px-2 pb-1 pt-0.5 text-[11px] text-gray-400 dark:text-gray-500">选择图片引用</div>
          {options.map((option, index) => (
            <button
              key={`${option.image.id}:${option.index}`}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault()
                selectOption(option)
              }}
              className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs transition-colors ${index === menuIndex ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}
            >
              <span className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-gray-200/70 bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04]">
                <img src={option.image.dataUrl} className="h-full w-full object-cover" alt="" />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
            </button>
          ))}
        </div>
      )}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={syncInput}
        onClick={() => {
          setCursorPos(getCursorOffset(editorRef.current!))
          setMenuDismissed(false)
        }}
        onKeyUp={() => setCursorPos(getCursorOffset(editorRef.current!))}
        onKeyDown={handleKeyDown}
        aria-label={placeholder}
        className="col-start-1 row-start-1 min-h-20 w-full overflow-hidden whitespace-pre-wrap break-words rounded-2xl bg-transparent px-3 py-3 text-base leading-6 text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-600 sm:px-4"
      />
      {visibleValue.length === 0 && (
        <div className="pointer-events-none col-start-1 row-start-1 px-3 py-3 text-base leading-7 text-gray-400 dark:text-gray-600 sm:px-4 sm:text-lg">
          {placeholder}
        </div>
      )}
      {visibleValue.length > 0 && (
        <button
          type="button"
          onClick={clearPrompt}
          className="absolute right-3 top-3 z-10 flex items-center justify-center rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
          aria-label="清空文本"
          title="清空文本"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
