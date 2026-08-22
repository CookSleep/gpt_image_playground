// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  getContentEditableCursor,
  getContentEditablePlainText,
  getContentEditableSelection,
  getMentionTagHtml,
  setContentEditableCursor,
  setContentEditableSelection,
  syncMentionTagSelection,
} from './contentEditableMentions'

describe('contentEditable mentions', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    window.getSelection()?.removeAllRanges()
  })

  it('escapes mention text in tag HTML', () => {
    expect(getMentionTagHtml('@image<&">')).toBe(
      '<span contenteditable="false" class="mention-tag" data-mention-text="\u2063@image&lt;&amp;&quot;&gt;\u2064">@image&lt;&amp;&quot;&gt;</span>',
    )
  })

  it('round-trips cursor offsets around a mention', () => {
    const el = document.createElement('div')
    el.contentEditable = 'true'
    el.innerHTML = '前<span contenteditable="false" class="mention-tag">@图1</span>后'
    document.body.append(el)

    for (const offset of [0, 1, 4, 5]) {
      setContentEditableCursor(el, offset)
      expect(getContentEditableCursor(el)).toBe(offset)
    }
  })

  it('expands a selection inside a mention to the whole mention', () => {
    const el = document.createElement('div')
    el.contentEditable = 'true'
    el.innerHTML = '前<span contenteditable="false" class="mention-tag">@图1</span>后'
    document.body.append(el)

    setContentEditableSelection(el, 2, 3)

    expect(getContentEditableSelection(el)).toEqual({ start: 1, end: 4 })
  })

  it('clamps Ctrl+A boundaries outside the editor', () => {
    document.body.innerHTML = '<p>前置</p><div contenteditable="true">正文</div><p>后置</p>'
    const el = document.querySelector<HTMLElement>('[contenteditable]')!
    const before = document.body.firstElementChild!.firstChild!
    const after = document.body.lastElementChild!.firstChild!
    const range = document.createRange()
    range.setStart(before, 0)
    range.setEnd(after, after.textContent!.length)
    const sel = window.getSelection()!
    sel.addRange(range)

    expect(getContentEditableSelection(el)).toEqual({ start: 0, end: 2 })
  })

  it('uses data-mention-text when reading plain text', () => {
    const el = document.createElement('div')
    el.innerHTML = '前<span class="mention-tag" data-mention-text="\u2063@图1\u2064">显示文本</span>后'

    expect(getContentEditablePlainText(el)).toBe('前\u2063@图1\u2064后')
  })

  it('marks only mentions intersecting the selection as selected', () => {
    const el = document.createElement('div')
    el.contentEditable = 'true'
    el.innerHTML = '<span contenteditable="false" class="mention-tag">@图1</span>中<span contenteditable="false" class="mention-tag selected">@图2</span>'
    document.body.append(el)

    setContentEditableSelection(el, 0, 2)
    syncMentionTagSelection(el)

    const tags = el.querySelectorAll('.mention-tag')
    expect(tags[0].classList.contains('selected')).toBe(true)
    expect(tags[1].classList.contains('selected')).toBe(false)
  })
})
