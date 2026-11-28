// @vitest-environment jsdom
import { act } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { getTopDialog } from '../lib/dialogLayers'
import { useDialogLayer } from './useDialogLayer'

function Dialog({ confirm, close }: { confirm?: boolean; close: () => void }) {
  const layer = useDialogLayer(close, confirm ? 'confirm-dialogs' : 'app-dialogs')
  return createPortal(<input defaultValue="草稿" />, layer)
}

it('后打开的子弹窗让位于全局确认，确认关闭后恢复未保存的输入', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.body.innerHTML = '<div id="app-layer"></div><div id="app-dialogs"></div><div id="confirm-dialogs"></div>'
  const app = document.getElementById('app-layer')!
  const root = createRoot(app)
  const closeChild = vi.fn()
  const closeConfirm = vi.fn()
  const render = (child: boolean, confirm: boolean) => act(() => root.render(<>
    {child && <Dialog close={closeChild} />}
    {confirm && <Dialog confirm close={closeConfirm} />}
  </>))
  const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  try {
    render(false, true)
    render(true, true)
    const input = document.querySelector<HTMLInputElement>('#app-dialogs input')!
    expect(input.closest('[inert]')).toBeTruthy()
    expect(app.hasAttribute('inert')).toBe(true)
    escape()
    expect(closeConfirm).toHaveBeenCalledTimes(1)
    expect(closeChild).not.toHaveBeenCalled()
    render(true, false)
    expect(getTopDialog()?.contains(input)).toBe(true)
    expect(input.closest('[inert]')).toBeNull()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }))
    input.addEventListener('keydown', (event) => event.preventDefault(), { once: true })
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(closeChild).not.toHaveBeenCalled()
    input.value = '修改后的草稿'
    render(true, true)
    render(true, false)
    expect(document.querySelector<HTMLInputElement>('#app-dialogs input')?.value).toBe('修改后的草稿')
    escape()
    expect(closeChild).toHaveBeenCalledTimes(1)
    render(false, false)
    expect(app.hasAttribute('inert')).toBe(false)
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  }
})
