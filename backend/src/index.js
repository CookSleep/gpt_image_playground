import { buildApp } from './app.js'
import { createOpenAIImageClient } from './imageClient.js'
import { createPgStore } from './pgStore.js'
import { createS3Storage } from './s3Storage.js'
import { createSub2apiClient } from './sub2apiClient.js'
import { createOpenAITextClient } from './textClient.js'

function boolEnv(name, fallback = false) {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  return value === '1' || value.toLowerCase() === 'true'
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`缺少环境变量：${name}`)
  return value
}

function intEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const port = Number(process.env.PORT || 3000)
const sub2apiBaseUrl = requireEnv('SUB2API_BASE_URL')
const store = await createPgStore(requireEnv('DATABASE_URL'))
const app = buildApp({
  store,
  storage: createS3Storage({
    endpoint: requireEnv('S3_ENDPOINT'),
    region: process.env.S3_REGION || 'auto',
    bucket: requireEnv('S3_BUCKET'),
    accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: boolEnv('S3_FORCE_PATH_STYLE', true),
  }),
  imageClient: createOpenAIImageClient({
    baseUrl: process.env.OPENAI_BASE_URL || `${sub2apiBaseUrl.replace(/\/+$/, '')}/v1`,
    apiKey: process.env.OPENAI_API_KEY,
    partialImages: intEnv('OPENAI_IMAGE_PARTIAL_IMAGES', 2),
    timeoutMs: intEnv('OPENAI_IMAGE_TIMEOUT_MS', 10 * 60 * 1000),
  }),
  textClient: createOpenAITextClient({
    baseUrl: process.env.OPENAI_BASE_URL || `${sub2apiBaseUrl.replace(/\/+$/, '')}/v1`,
    timeoutMs: intEnv('OPENAI_TEXT_TIMEOUT_MS', 120000),
  }),
  sub2apiClient: createSub2apiClient({
    baseUrl: sub2apiBaseUrl,
    timeoutMs: intEnv('SUB2API_TIMEOUT_MS', 30000),
  }),
  sessionSecret: requireEnv('SESSION_SECRET'),
  defaultModel: process.env.DEFAULT_IMAGE_MODEL || 'gpt-image-2',
  defaultTextModel: process.env.DEFAULT_TEXT_MODEL || 'gpt-5.5',
})

try {
  await app.listen({ host: '0.0.0.0', port })
  console.log(`backend listening on ${port}`)
} catch (err) {
  await store.close?.()
  console.error(err)
  process.exit(1)
}
