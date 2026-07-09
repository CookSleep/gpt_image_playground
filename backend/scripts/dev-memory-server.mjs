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
  admin: { username: 'admin', password: 'admin123456' },
  runJobsInline: true,
  storage: {
    async putObject(key, body, contentType) {
      store.objects.set(key, { body, contentType })
    },
    async getObject(key) {
      return store.objects.get(key) ?? null
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
