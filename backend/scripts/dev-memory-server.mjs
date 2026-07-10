import { buildApp } from '../src/app.js'
import { createMemoryStore } from '../src/memoryStore.js'

const previewSvg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#edf8fb"/>
      <stop offset="1" stop-color="#b9d9ff"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="56" fill="url(#bg)"/>
  <circle cx="512" cy="430" r="128" fill="#fff" opacity=".96"/>
  <ellipse cx="512" cy="642" rx="260" ry="54" fill="#7f9bbe" opacity=".18"/>
  <text x="512" y="780" text-anchor="middle" font-size="48" font-family="Arial, sans-serif" fill="#2f5f93">Mock Image</text>
</svg>
`.trim())
const store = createMemoryStore()

const app = buildApp({
  store,
  sessionSecret: 'dev-memory-secret',
  defaultModel: 'gpt-image-2',
  runJobsInline: true,
  storage: {
    async putObject(key, body, contentType) {
      store.objects.set(key, { body, contentType })
    },
    async getObject(key) {
      return store.objects.get(key) ?? null
    },
  },
  sub2apiClient: {
    async login(email, password) {
      if (!email || !password) {
        const error = new Error('请输入 sub2api 邮箱和密码')
        error.statusCode = 400
        throw error
      }
      return {
        access_token: 'dev-access-token',
        refresh_token: 'dev-refresh-token',
        expires_in: 3600,
        user: { id: 1, email, username: 'local-user', role: 'user', status: 'active' },
      }
    },
    async refresh() {
      return {
        access_token: 'dev-access-token-refreshed',
        refresh_token: 'dev-refresh-token-refreshed',
        expires_in: 3600,
      }
    },
    async listKeys() {
      return {
        items: [{
          id: 101,
          name: 'codex仅生图-gpt-image-2',
          status: 'active',
          key: 'dev-hidden-key',
          quota: 100,
          quota_used: 0,
          group: { id: 1, name: '按次(图片)' },
        }],
      }
    },
    async getKey() {
      return {
        id: 101,
        name: 'codex仅生图-gpt-image-2',
        status: 'active',
        key: 'dev-hidden-key',
        group: { id: 1, name: '按次(图片)' },
      }
    },
  },
  imageClient: {
    async generate(input) {
      if (input.prompt.includes('失败')) throw new Error('mock upstream failed')
      await new Promise((resolve) => setTimeout(resolve, 500))
      return {
        images: [{ bytes: previewSvg, contentType: 'image/svg+xml', revisedPrompt: 'mock revised prompt' }],
        upstream: { id: 'dev-memory' },
      }
    },
  },
})

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 3000) })
console.log('dev memory backend listening on http://localhost:3000')
