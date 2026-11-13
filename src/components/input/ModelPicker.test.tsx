// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ModelPicker from './ModelPicker'

vi.mock('../ViewportTooltip', () => ({
  default: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? <span data-tooltip>{children}</span> : null,
}))

describe('模型列表触摸交互', () => {
  let container: HTMLDivElement
  let root: Root
  let trigger: HTMLButtonElement
  let option: HTMLButtonElement
  const onChange = vi.fn()

  const dispatch = (el: HTMLElement, type: string) => {
    act(() => { el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })) })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    onChange.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(<ModelPicker
        value="m1"
        activeProfileId="a"
        canSwitchProfile
        groups={[
          { profileId: 'a', name: 'A', providerLabel: 'OpenAI', models: ['m1'] },
          { profileId: 'b', name: 'B', providerLabel: 'OpenAI', models: ['m2'] },
        ]}
        onChange={onChange}
        onOpenSettings={vi.fn()}
      />)
    })
    trigger = container.querySelector('button')!
    dispatch(trigger, 'click')
    option = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'm2')!
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('长按后即使收到兼容点击也不切换配置，下一次轻触仍可选择', () => {
    dispatch(option, 'touchstart')
    act(() => { vi.advanceTimersByTime(500) })
    expect(container.querySelector('[data-tooltip]')?.textContent).toBe('m2')
    dispatch(option, 'touchend')
    dispatch(option, 'click')
    expect(onChange).not.toHaveBeenCalled()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    dispatch(option, 'touchstart')
    dispatch(option, 'touchend')
    dispatch(option, 'click')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('b', 'm2')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('长按后没有兼容点击时，下一次鼠标点击仍可选择', () => {
    dispatch(option, 'touchstart')
    act(() => { vi.advanceTimersByTime(500) })
    dispatch(option, 'touchend')
    dispatch(option, 'pointerdown')
    dispatch(option, 'click')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('b', 'm2')
  })

  it.each(['touchcancel', 'touchmove'])('%s 取消尚未显示的长按提示', (type) => {
    dispatch(option, 'touchstart')
    act(() => { vi.advanceTimersByTime(200) })
    dispatch(option, type)
    act(() => { vi.advanceTimersByTime(500) })
    expect(container.querySelector('[data-tooltip]')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('关闭后重新打开菜单不会显示上一次触摸的提示', () => {
    dispatch(option, 'touchstart')
    dispatch(trigger, 'click')
    act(() => { vi.advanceTimersByTime(500) })
    dispatch(trigger, 'click')
    expect(container.querySelector('[data-tooltip]')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})
