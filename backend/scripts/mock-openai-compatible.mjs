import http from 'node:http'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const port = Number(process.env.PORT || 4010)

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.includes('/images/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
    return
  }

  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    if (body.includes('fail')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock upstream failed' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: [{ b64_json: png, revised_prompt: 'mock revised prompt' }],
    }))
  })
})

server.listen(port, '0.0.0.0', () => {
  console.log(`mock OpenAI-compatible image API listening on ${port}`)
})
