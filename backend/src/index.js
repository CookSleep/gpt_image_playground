import { buildApp } from './app.js'
import { createOpenAIImageClient } from './imageClient.js'
import { createPgStore } from './pgStore.js'
import { createS3Storage } from './s3Storage.js'

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

const port = Number(process.env.PORT || 3000)
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
    baseUrl: requireEnv('OPENAI_BASE_URL'),
    apiKey: requireEnv('OPENAI_API_KEY'),
  }),
  sessionSecret: requireEnv('SESSION_SECRET'),
  defaultModel: process.env.DEFAULT_IMAGE_MODEL || 'gpt-image-2',
  admin: {
    username: requireEnv('ADMIN_USERNAME'),
    password: requireEnv('ADMIN_PASSWORD'),
  },
})

try {
  await app.listen({ host: '0.0.0.0', port })
  console.log(`backend listening on ${port}`)
} catch (err) {
  await store.close?.()
  console.error(err)
  process.exit(1)
}
