import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import http from 'node:http'
import https from 'node:https'
import { normalizeDevProxyConfig } from './src/lib/devProxy'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
const AGENT_FETCH_HEADER = 'x-agent-fetch'
const MAX_AGENT_PAGE_BYTES = 4 * 1024 * 1024
const MAX_AGENT_IMAGE_BYTES = 25 * 1024 * 1024

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

function readAgentFetchTarget(reqUrl: string | undefined) {
  const url = new URL(reqUrl || '/', 'http://localhost')
  const target = url.searchParams.get('url') || ''
  if (!target) throw new Error('Missing url query parameter')

  const parsed = new URL(target)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported')
  }
  return parsed.toString()
}

async function readLimitedResponseBody(response: Response, maxBytes: number) {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.from(await response.arrayBuffer())

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`Response too large; limit is ${(maxBytes / 1024 / 1024).toFixed(1)} MiB`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

function getHeaderValue(headers: http.IncomingHttpHeaders, key: string) {
  const value = headers[key.toLowerCase()]
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

function getFetchErrorCode(err: unknown) {
  if (!err || typeof err !== 'object') return ''
  const record = err as { code?: unknown; cause?: unknown }
  if (typeof record.code === 'string') return record.code
  const cause = record.cause
  if (cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string') {
    return (cause as { code: string }).code
  }
  return ''
}

function shouldRetryWithoutTlsVerification(err: unknown) {
  return [
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
  ].includes(getFetchErrorCode(err))
}

function fetchWithNodeHttp(targetUrl: string, options: { accept: string; maxBytes: number; allowInsecureTls?: boolean }, redirectCount = 0): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl)
    const transport = parsedUrl.protocol === 'https:' ? https : http
    const req = transport.request(parsedUrl, {
      method: 'GET',
      headers: {
        accept: options.accept,
        'user-agent': 'Mozilla/5.0 (compatible; GPT-Image-Playground-Agent/1.0)',
      },
      ...(parsedUrl.protocol === 'https:' && options.allowInsecureTls ? { rejectUnauthorized: false } : {}),
    }, (upstream) => {
      const status = upstream.statusCode ?? 0
      const location = getHeaderValue(upstream.headers, 'location')
      if (status >= 300 && status < 400 && location && redirectCount < 5) {
        upstream.resume()
        const redirectUrl = new URL(location, targetUrl).toString()
        fetchWithNodeHttp(redirectUrl, options, redirectCount + 1).then(resolve, reject)
        return
      }

      const chunks: Buffer[] = []
      let total = 0
      upstream.on('data', (chunk: Buffer) => {
        total += chunk.byteLength
        if (total > options.maxBytes) {
          req.destroy(new Error(`Response too large; limit is ${(options.maxBytes / 1024 / 1024).toFixed(1)} MiB`))
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      upstream.on('end', () => {
        resolve({
          status,
          headers: upstream.headers,
          body: Buffer.concat(chunks),
        })
      })
    })
    req.on('error', reject)
    req.setTimeout(20_000, () => {
      req.destroy(new Error('Fetch timed out'))
    })
    req.end()
  })
}

async function fetchAgentTarget(targetUrl: string, options: { accept: string; maxBytes: number }) {
  try {
    const upstream = await fetch(targetUrl, {
      redirect: 'follow',
      headers: {
        accept: options.accept,
        'user-agent': 'Mozilla/5.0 (compatible; GPT-Image-Playground-Agent/1.0)',
      },
    })
    return {
      status: upstream.status,
      contentType: upstream.headers.get('content-type') || '',
      body: await readLimitedResponseBody(upstream, options.maxBytes),
    }
  } catch (err) {
    if (!shouldRetryWithoutTlsVerification(err)) throw err
    const upstream = await fetchWithNodeHttp(targetUrl, { ...options, allowInsecureTls: true })
    return {
      status: upstream.status,
      contentType: getHeaderValue(upstream.headers, 'content-type'),
      body: upstream.body,
    }
  }
}

function agentFetchPlugin() {
  return {
    name: 'agent-fetch-proxy',
    configureServer(server) {
      const handleFetch = async (
        req,
        res,
        options: { accept: string; maxBytes: number; validateContentType: (contentType: string) => boolean; fallbackContentType: string },
      ) => {
        try {
          const targetUrl = readAgentFetchTarget(req.url)
          const upstream = await fetchAgentTarget(targetUrl, {
            accept: options.accept,
            maxBytes: options.maxBytes,
          })
          const contentType = upstream.contentType || options.fallbackContentType
          if (upstream.status < 200 || upstream.status >= 300) {
            res.statusCode = upstream.status
            res.setHeader(AGENT_FETCH_HEADER, 'ok')
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.end(`Upstream HTTP ${upstream.status}`)
            return
          }
          if (!options.validateContentType(contentType)) {
            res.statusCode = 415
            res.setHeader(AGENT_FETCH_HEADER, 'ok')
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.end(`Unsupported content type: ${contentType}`)
            return
          }

          res.statusCode = 200
          res.setHeader(AGENT_FETCH_HEADER, 'ok')
          res.setHeader('access-control-allow-origin', '*')
          res.setHeader('cache-control', 'no-store')
          res.setHeader('content-type', contentType)
          res.end(upstream.body)
        } catch (err) {
          res.statusCode = 400
          res.setHeader(AGENT_FETCH_HEADER, 'ok')
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end(err instanceof Error ? err.message : String(err))
        }
      }

      server.middlewares.use('/agent-page-fetch', (req, res) => {
        void handleFetch(req, res, {
          accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.6,*/*;q=0.1',
          maxBytes: MAX_AGENT_PAGE_BYTES,
          fallbackContentType: 'text/html; charset=utf-8',
          validateContentType: (contentType) => /(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType),
        })
      })

      server.middlewares.use('/agent-image-fetch', (req, res) => {
        void handleFetch(req, res, {
          accept: 'image/png,image/jpeg,image/webp;q=0.9,*/*;q=0.1',
          maxBytes: MAX_AGENT_IMAGE_BYTES,
          fallbackContentType: 'application/octet-stream',
          validateContentType: (contentType) => /^image\/(?:png|jpe?g|webp)(?:[;\s]|$)/i.test(contentType),
        })
      })
    },
  }
}

export default defineConfig(({ command }) => {
  const devProxyConfig = command === 'serve' ? loadDevProxyConfig() : null

  return {
    plugins: [react(), agentFetchPlugin()],
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    server: {
      host: true,
      proxy:
        devProxyConfig?.enabled
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
          : undefined,
    },
  }
})
