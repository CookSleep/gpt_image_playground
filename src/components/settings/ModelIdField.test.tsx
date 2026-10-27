// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile } from '../../lib/apiProfiles'
import { fetchProviderModelIds } from '../../lib/modelList'
import ModelIdField from './ModelIdField'

vi.mock('../../lib/modelList', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/modelList')>()),
  fetchProviderModelIds: vi.fn(),
}))

const PROFILE = createDefaultOpenAIProfile({ id: 'a', baseUrl: 'https://api.example.com', apiKey: 'test-key' })
const fetchMock = vi.mocked(fetchProviderModelIds)
let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

async function render(overrides: Partial<ComponentProps<typeof ModelIdField>> = {}) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => root!.render(
    <ModelIdField
      label="模型 ID"
      value="custom-model"
      placeholder="模型 ID"
      profile={PROFILE}
      disabled={false}
      canFetch={true}
      imageModelsOnly={true}
      onChange={vi.fn()}
      onCommit={vi.fn()}
      {...overrides}
    >
      <div>支持手动填写模型。</div>
    </ModelIdField>,
  ))
}

describe('ModelIdField', () => {
  it('只在点击后拉取模型，选择候选项时才提交', async () => {
    fetchMock.mockResolvedValue(['gpt-5', 'gpt-image-2'])
    const onCommit = vi.fn()
    await render({ onCommit })
    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('input')!.value).toBe('custom-model')
    expect(onCommit).not.toHaveBeenCalled()
    expect(container.querySelectorAll('input')).toHaveLength(1)
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(container.querySelector('[role="option"]')!.textContent).toBe('gpt-image-2')
    await act(async () => container.querySelector<HTMLElement>('[role="option"]')!.click())
    expect(onCommit).toHaveBeenCalledWith('gpt-image-2')
    expect(container.querySelector('[role="listbox"]')).toBeNull()
  })

  it('Responses 文本模型保留完整列表，图像工具模型允许留空', async () => {
    fetchMock.mockResolvedValue(['gpt-5', 'gpt-image-2'])
    await render({ imageModelsOnly: false })
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2)

    const onCommit = vi.fn()
    await render({ imageModelsOnly: true, emptyLabel: '留空使用 API 默认值', onCommit })
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2)
    await act(async () => container.querySelector<HTMLElement>('[role="option"]')!.click())
    expect(onCommit).toHaveBeenCalledWith('')
  })

  it('切换配置或修改接口地址时取消请求并忽略旧结果', async () => {
    let resolveRequest: (ids: string[]) => void = () => {}
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve }))
    await render()
    await act(async () => container.querySelector('button')!.click())
    const signal = fetchMock.mock.calls[0][0].signal!
    expect(container.querySelector('button')!.disabled).toBe(true)

    await render({ profile: { ...PROFILE, baseUrl: 'https://another.example.com' } })
    expect(signal.aborted).toBe(true)
    await act(async () => resolveRequest(['old-image-model']))
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    expect(container.querySelector('button')!.disabled).toBe(false)
  })

  it('关闭字段时取消请求', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    await render()
    await act(async () => container.querySelector('button')!.click())
    const signal = fetchMock.mock.calls[0][0].signal!
    act(() => root!.unmount())
    root = null
    expect(signal.aborted).toBe(true)
  })

  it('空列表和请求失败都有提示，并保留手动输入', async () => {
    fetchMock.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('无效 API Key'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await render()
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('没有返回任何模型')
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('无效 API Key')
    expect(container.querySelector('input')!.disabled).toBe(false)
    expect(container.querySelector('input')!.value).toBe('custom-model')
  })

  it('受锁定的配置或不支持拉取的服务商不显示按钮', async () => {
    await render({ disabled: true })
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('input')!.disabled).toBe(true)
    await render({ canFetch: false })
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('input')!.disabled).toBe(false)
  })

  it.each([
    { baseUrl: '', apiKey: '', missing: 'API URL 和 API Key' },
    { baseUrl: ' ', apiKey: 'test-key', missing: 'API URL' },
    { baseUrl: 'https://api.example.com', apiKey: ' ', missing: 'API Key' },
  ])('缺少 $missing 时直接提示且不发送请求', async ({ baseUrl, apiKey, missing }) => {
    await render({ profile: { ...PROFILE, baseUrl, apiKey } })
    await act(async () => container.querySelector('button')!.click())

    expect(fetchMock).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(`请先填写 ${missing}，再拉取模型`)
    expect(container.querySelector('button')!.disabled).toBe(false)
  })

  it('代理提供 API 地址时只要求填写 API Key', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    fetchMock.mockResolvedValue(['gpt-image-2'])
    await render({ profile: { ...PROFILE, baseUrl: '', apiProxy: true } })
    await act(async () => container.querySelector('button')!.click())

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('地址和密钥保存时的格式整理不会清掉已拉取的候选项', async () => {
    fetchMock.mockResolvedValue(['gpt-image-2'])
    await render({ profile: { ...PROFILE, baseUrl: 'api.example.com', apiKey: ' test-key ' } })
    await act(async () => container.querySelector('button')!.click())
    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: PROFILE.baseUrl, apiKey: PROFILE.apiKey }))

    await render({ profile: PROFILE })
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)
  })

  it('输入框右侧按钮可展开候选列表，并支持键盘选择和 Escape 关闭', async () => {
    fetchMock.mockResolvedValue(['gpt-image-2', 'gpt-image-2.5-sunburst'])
    const onCommit = vi.fn()
    await render({ onCommit })
    await act(async () => container.querySelector('button')!.click())
    const input = container.querySelector('input')!
    const keydown = vi.fn()
    window.addEventListener('keydown', keydown)
    try {
      act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      expect(keydown).not.toHaveBeenCalled()
      expect(container.querySelector('[role="listbox"]')).toBeNull()
      expect(input.getAttribute('aria-expanded')).toBe('false')

      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择模型 ID"]')!.click())
      expect(input.getAttribute('aria-expanded')).toBe('true')
      act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
      act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
      expect(onCommit).toHaveBeenCalledWith('gpt-image-2.5-sunburst')
      expect(container.querySelector('[role="listbox"]')).toBeNull()
    } finally {
      window.removeEventListener('keydown', keydown)
    }
  })

  it('拉取后仍可手动输入并在失焦时保存', async () => {
    fetchMock.mockResolvedValue(['gpt-image-2'])
    const onChange = vi.fn()
    const onCommit = vi.fn()
    await render({ onChange, onCommit })
    await act(async () => container.querySelector('button')!.click())
    const input = container.querySelector('input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'my-custom-model')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('my-custom-model')
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    await render({ value: 'my-custom-model', onChange, onCommit })
    act(() => input.blur())
    expect(onCommit).toHaveBeenCalledWith('my-custom-model')
  })
})
