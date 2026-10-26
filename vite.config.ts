import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { normalizeDevProxyConfig } from './src/lib/devProxy'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

function loadDevProxyConfig() {
  try {
    return normalizeDevProxyConfig(
      JSON.parse(readFileSync('./dev-proxy.config.json', 'utf-8')) as unknown,
    )
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw error
  }
}

async function embedDefaultConfig(value: string) {
  const source = value.trim()
  if (!source) return source

  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source)
    if (!url.pathname.toLowerCase().endsWith('.json')) return source

    const response = await fetch(source)
    if (!response.ok) throw new Error(`预置配置请求失败：HTTP ${response.status}`)
    return `embedded-config:${Buffer.from(await response.text()).toString('base64')}`
  }

  const fileUrl = source.startsWith('file://')
  const path = fileUrl ? fileURLToPath(source) : resolve(source)
  if (!existsSync(path)) {
    if (fileUrl || source.toLowerCase().endsWith('.json')) throw new Error(`预置配置文件不存在：${path}`)
    return source
  }
  return `embedded-config:${Buffer.from(readFileSync(path)).toString('base64')}`
}

export default defineConfig(async ({ command, mode }) => {
  // 客户端构建只读取 src-tauri/ 下的 env 文件，与网页版部署配置隔离
  const envDir = process.env.TAURI_ENV_PLATFORM ? resolve('src-tauri') : process.cwd()
  const env = loadEnv(mode, envDir, '')
  const defaultApiUrl = await embedDefaultConfig(process.env.VITE_DEFAULT_API_URL ?? env.VITE_DEFAULT_API_URL ?? '')
  if (defaultApiUrl.startsWith('embedded-config:')) process.env.VITE_DEFAULT_API_URL = defaultApiUrl
  const devProxyConfig = command === 'serve' ? loadDevProxyConfig() : null

  return {
    plugins: [react()],
    base: './',
    envDir,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
      'import.meta.env.VITE_GROK_PROXY_AVAILABLE': JSON.stringify(process.env.VERCEL === '1' ? 'true' : 'false'),
    },
    server: {
      host: true,
      // Tauri 开发模式的 devUrl 固定为 5173，端口被占用时直接报错而不是换端口
      strictPort: Boolean(process.env.TAURI_ENV_PLATFORM),
      watch: { ignored: ['**/src-tauri/**'] },
      proxy: {
        '/grok-api': {
          target: 'https://grok.aisenno.com',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/grok-api/, '/v1'),
        },
        ...(devProxyConfig?.enabled
          ? {
              [devProxyConfig.prefix]: {
                target: devProxyConfig.target,
                changeOrigin: devProxyConfig.changeOrigin,
                secure: devProxyConfig.secure,
                rewrite: (path) =>
                  path.replace(
                    new RegExp(`^${devProxyConfig.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
                    '',
                  ),
              },
            }
          : {}),
      },
    },
  }
})
