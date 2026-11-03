// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_DROPDOWN_MAX_HEIGHT, getDropdownMaxHeight, getDropdownSpace } from './dropdown'

function setRect(el: HTMLElement, top: number, bottom: number) {
  el.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) })
}

describe('dropdown', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    window.innerHeight = 800
  })

  it('没有裁切内容的祖先时按视口计算上下空间', () => {
    const wrap = document.createElement('div')
    const trigger = document.createElement('button')
    wrap.append(trigger)
    document.body.append(wrap)
    setRect(trigger, 300, 340)

    expect(getDropdownSpace(trigger)).toEqual({ above: 292, below: 452 })
  })

  it('会裁切内容的祖先同时限制上下空间', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const trigger = document.createElement('button')
    scroller.append(trigger)
    document.body.append(scroller)
    setRect(scroller, 200, 500)
    setRect(trigger, 300, 340)

    expect(getDropdownSpace(trigger)).toEqual({ above: 92, below: 152 })
  })

  it('最大高度取下方空间，并限制在上限与 0 之间', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)

    setRect(trigger, 100, 140)
    expect(getDropdownMaxHeight(trigger)).toBe(DEFAULT_DROPDOWN_MAX_HEIGHT)

    setRect(trigger, 600, 700.5)
    expect(getDropdownMaxHeight(trigger)).toBe(91)

    setRect(trigger, 760, 800)
    expect(getDropdownMaxHeight(trigger)).toBe(0)
  })
})
