import { useEffect, useState } from 'react'
import { copyTextToClipboard } from '../../lib/clipboard'
import { getMcpStatus, setMcpStatus, type McpStatus } from '../../lib/mcpBridge'
import { useStore } from '../../store'
import Select from '../Select'

type McpClient = 'claude' | 'codex' | 'cursor'

function getSnippet(client: McpClient, status: McpStatus) {
  const url = `http://127.0.0.1:${status.port}/mcp`
  if (client === 'claude') {
    return `claude mcp add --transport http gpt-image ${url} --header "Authorization: Bearer ${status.token}"`
  }
  if (client === 'codex') {
    return `# 先设置环境变量 GPT_IMAGE_MCP_TOKEN=${status.token}\n[mcp_servers.gpt-image]\nurl = "${url}"\nbearer_token_env_var = "GPT_IMAGE_MCP_TOKEN"`
  }
  return JSON.stringify({ mcpServers: { 'gpt-image': { url, headers: { Authorization: `Bearer ${status.token}` } } } }, null, 2)
}

/** 仅客户端：可选的本地 MCP 服务，让 Agent 调用应用生图 */
export default function McpSettingsSection() {
  const showToast = useStore((s) => s.showToast)
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [port, setPort] = useState('')
  const [maxRetries, setMaxRetries] = useState('')
  const [retryInterval, setRetryInterval] = useState('')
  const [client, setClient] = useState<McpClient>('claude')
  const [showToken, setShowToken] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    getMcpStatus()
      .then((next) => {
        setStatus(next)
        setPort(String(next.port))
        setMaxRetries(String(next.maxRetries))
        setRetryInterval(String(next.retryInterval))
      })
      .catch((err) => setError(typeof err === 'string' ? err : '读取 MCP 设置失败'))
  }, [])

  const apply = async (enabled: boolean, regenerateToken = false) => {
    const nextPort = Number(port)
    if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) {
      setError('端口需在 1024–65535 之间')
      return
    }
    const nextRetries = Number(maxRetries)
    if (maxRetries === '' || !Number.isInteger(nextRetries) || nextRetries < 0 || nextRetries > 20) {
      setError('自动重试次数需在 0–20 之间')
      return
    }
    const nextInterval = Number(retryInterval)
    if (retryInterval === '' || !Number.isInteger(nextInterval) || nextInterval < 1 || nextInterval > 600) {
      setError('重试间隔需在 1–600 秒之间')
      return
    }
    try {
      const next = await setMcpStatus({ enabled, port: nextPort, regenerateToken, maxRetries: nextRetries, retryInterval: nextInterval })
      setStatus(next)
      setError(next.error ?? '')
      if (regenerateToken) showToast('已重新生成 token，旧 token 立即失效', 'success')
    } catch (err) {
      setError(typeof err === 'string' ? err : '保存 MCP 设置失败')
    }
  }

  const copy = (text: string, message: string) => {
    copyTextToClipboard(text).then(
      () => showToast(message, 'success'),
      () => showToast('复制失败', 'error'),
    )
  }

  const inputClass =
    'rounded-xl border border-transparent bg-black/[0.04] px-3 py-1.5 text-xs text-gray-700 outline-none transition focus:border-blue-300 dark:bg-white/[0.06] dark:text-gray-200 dark:focus:border-blue-500/50'

  return (
    <section className="space-y-4">
      <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">MCP 服务</h4>
      <div className="block">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">允许本机 Agent 调用生图</span>
          <button
            type="button"
            role="switch"
            aria-checked={!!status?.enabled}
            disabled={!status}
            onClick={() => void apply(!status?.enabled)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${status?.enabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-white/20'}`}
          >
            <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${status?.enabled ? 'translate-x-5' : ''}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，Claude Code、Codex、Cursor 等本机 Agent 可以用当前启用的 API 配置生成和编辑图片，结果会进入历史记录。调用会产生真实的 API 费用。仅监听 127.0.0.1，需要 token。
        </div>
        {error && <div data-selectable-text className="mt-1 text-xs text-red-500 dark:text-red-400">{error}</div>}
      </div>
      {status && (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">端口</span>
            <input
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
              onBlur={() => {
                if (port !== String(status.port)) void apply(status.enabled)
              }}
              inputMode="numeric"
              aria-label="MCP 端口"
              className={`w-24 text-right ${inputClass}`}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="block text-sm text-gray-600 dark:text-gray-300">失败自动重试次数</span>
              <span className="block text-xs text-gray-500">每个任务生成失败后自动重试的最多次数，0 为不重试；鉴权失败、额度不足、内容审核拒绝不会重试。Agent 调用时也可单独指定</span>
            </div>
            <input
              value={maxRetries}
              onChange={(e) => setMaxRetries(e.target.value.replace(/\D/g, ''))}
              onBlur={() => {
                if (maxRetries !== String(status.maxRetries)) void apply(status.enabled)
              }}
              inputMode="numeric"
              aria-label="MCP 自动重试次数"
              className={`w-24 shrink-0 text-right ${inputClass}`}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">重试间隔（秒）</span>
            <input
              value={retryInterval}
              onChange={(e) => setRetryInterval(e.target.value.replace(/\D/g, ''))}
              onBlur={() => {
                if (retryInterval !== String(status.retryInterval)) void apply(status.enabled)
              }}
              inputMode="numeric"
              aria-label="MCP 重试间隔"
              className={`w-24 shrink-0 text-right ${inputClass}`}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">状态</span>
            <span className="text-xs text-gray-500">{status.running ? `运行中 · 127.0.0.1:${status.port}/mcp` : status.enabled ? '启动失败' : '未开启'}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">Token</span>
            <div className="flex min-w-0 items-center gap-2">
              <input
                readOnly
                value={status.token}
                type={showToken ? 'text' : 'password'}
                aria-label="MCP token"
                className={`w-40 min-w-0 font-mono ${inputClass}`}
              />
              <button type="button" onClick={() => setShowToken((v) => !v)} className="shrink-0 text-xs text-blue-500 hover:underline">
                {showToken ? '隐藏' : '显示'}
              </button>
              <button type="button" onClick={() => void apply(status.enabled, true)} className="shrink-0 text-xs text-blue-500 hover:underline">
                重新生成
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="block text-sm text-gray-600 dark:text-gray-300">连接配置</span>
              <div className="w-28 shrink-0">
                <Select
                  value={client}
                  onChange={(val: McpClient) => setClient(val)}
                  options={[
                    { label: 'Claude Code', value: 'claude' },
                    { label: 'Codex', value: 'codex' },
                    { label: 'Cursor', value: 'cursor' },
                  ]}
                  className="w-full px-3 py-1.5 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] text-xs transition-all duration-200 text-gray-700 dark:text-gray-200 outline-none"
                />
              </div>
            </div>
            <pre data-selectable-text className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-black/[0.04] p-3 font-mono text-xs text-gray-700 dark:bg-white/[0.06] dark:text-gray-200">
              {getSnippet(client, { ...status, token: showToken ? status.token : '<token>' })}
            </pre>
            <button
              type="button"
              onClick={() => copy(getSnippet(client, status), '已复制连接配置（含 token）')}
              className="text-xs text-blue-500 hover:underline"
            >
              复制（含真实 token）
            </button>
          </div>
        </>
      )}
    </section>
  )
}
