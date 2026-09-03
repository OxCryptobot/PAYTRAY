import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const files = new Map([
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }]
])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const requestedPort = Number.parseInt(process.env.CLIENT_SMOKE_PORT || '0', 10)
  const server = createServer(async (request, response) => {
    const descriptor = files.get(request.url)
    if (!descriptor) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    const body = await readFile(path.join(root, descriptor.file))
    response.writeHead(200, { 'content-type': descriptor.type, 'cache-control': 'no-store' })
    response.end(body)
  })

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(Number.isInteger(requestedPort) ? requestedPort : 0, '127.0.0.1', resolve)
    })
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    const responses = {}
    for (const [route] of files) {
      const response = await fetch(`${baseUrl}${route}`)
      const body = await response.text()
      assert(response.status === 200, `${route} returned ${response.status}`)
      responses[route] = { bytes: Buffer.byteLength(body), contentType: response.headers.get('content-type') }
      if (route === '/index.html') {
        assert(body.includes('PayTray — Work in motion. Money in motion.'), 'index title contract is missing')
        assert(body.includes('aria-live="polite"'), 'index live-region accessibility contract is missing')
        assert(body.includes('type="module" src="./app.js"'), 'index module script contract is missing')
        assert(body.includes('Base Sepolia'), 'index testnet policy label is missing')
        assert(body.includes('id="collaboration-workspace"'), 'private collaboration workspace is missing')
        assert(body.includes('id="message-form"'), 'thread message form is missing')
        assert(body.includes('id="refresh-thread"'), 'thread refresh control is missing')
      }
      if (route === '/app.js') {
        assert(body.includes('MIGRATION_016') === false, 'client must not contain migration test-only markers')
        assert(body.includes('window.PAYTRAY_API_BASE'), 'client API-base contract is missing')
        assert(body.includes("personal_sign"), 'wallet challenge contract is missing')
        assert(body.includes('/api/threads/'), 'thread API integration is missing')
        assert(body.includes('/collaboration-state'), 'collaboration-state API integration is missing')
        assert(body.includes('Payment remains independently verified'), 'payment and collaboration separation copy is missing')
      }
      if (route === '/styles.css') {
        assert(body.includes('focus-visible'), 'keyboard focus contract is missing')
        assert(body.includes('prefers-reduced-motion'), 'reduced-motion contract is missing')
        assert(body.includes('content-visibility: auto'), 'deferred-rendering contract is missing')
        assert(body.includes('.collaboration-workspace'), 'collaboration workspace styles are missing')
        assert(body.includes('.thread-messages'), 'thread message styles are missing')
      }
    }

    console.log(JSON.stringify({
      status: 'verified',
      surface: 'paytray-client-static',
      port: address.port,
      routes: responses,
      portIsolation: requestedPort === 0,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }, null, 2))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

try {
  await main()
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    surface: 'paytray-client-static',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
