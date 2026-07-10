import http from 'node:http'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const port = Number(process.env.PORT || 4010)

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve({ text, json: text ? JSON.parse(text) : {} })
      } catch {
        resolve({ text, json: {} })
      }
    })
  })
}

const demoKey = {
  id: 101,
  name: 'codex仅生图-gpt-image-2',
  status: 'active',
  key: 'local-mock-key',
  quota: 100,
  quota_used: 0,
  group: { id: 1, name: '按次(图片)' },
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${port}`}`)
  const body = req.method === 'GET' ? { text: '', json: {} } : await readBody(req)

  if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
    if (!body.json.email || !body.json.password) {
      sendJson(res, 400, { code: 400, message: '请输入邮箱和密码' })
      return
    }
    sendJson(res, 200, {
      code: 0,
      message: 'ok',
      data: {
        access_token: 'local-access-token',
        refresh_token: 'local-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        user: { id: 1, email: body.json.email, username: 'local-user', role: 'user', status: 'active' },
      },
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/auth/refresh') {
    sendJson(res, 200, {
      code: 0,
      message: 'ok',
      data: {
        access_token: 'local-access-token-refreshed',
        refresh_token: 'local-refresh-token-refreshed',
        expires_in: 3600,
        token_type: 'Bearer',
      },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/auth/me') {
    sendJson(res, 200, {
      code: 0,
      message: 'ok',
      data: { id: 1, email: 'dev@example.com', username: 'local-user', role: 'user', status: 'active' },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/keys') {
    sendJson(res, 200, { code: 0, message: 'ok', data: { items: [demoKey], total: 1, page: 1, page_size: 100 } })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/keys/101') {
    sendJson(res, 200, { code: 0, message: 'ok', data: demoKey })
    return
  }

  if (req.method !== 'POST' || !url.pathname.includes('/images/')) {
    sendJson(res, 404, { error: { message: 'not found' } })
    return
  }

  if (body.text.includes('fail')) {
    sendJson(res, 500, { error: { message: 'mock upstream failed' } })
    return
  }
  sendJson(res, 200, {
    data: [{ b64_json: png, revised_prompt: 'mock revised prompt' }],
  })
})

server.listen(port, '0.0.0.0', () => {
  console.log(`mock OpenAI-compatible image API listening on ${port}`)
})
