/**
 * Local preview of the built frontend: serves deploy/frontend/dist (SPA fallback) and proxies
 * the backend paths, like the Caddy config does in production.
 *
 *   BACKEND_URL=http://localhost:3000 PORT=8080 bun deploy/frontend/serve.ts
 */
import { join, normalize } from 'node:path'

const ROOT = process.env.DIST_DIR ?? join(import.meta.dir, 'dist')
const BACKEND = (process.env.BACKEND_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const PROXIED = /^\/(api|uploads|swagger|health)(\/|$)/

type SocketData = { target: string; protocols: string[]; upstream?: WebSocket; queue: (string | Buffer)[] }

const server = Bun.serve<SocketData>({
  port: Number(process.env.PORT ?? 8080),
  idleTimeout: 255,
  async fetch(request, srv) {
    const url = new URL(request.url)
    // WebSockets (the chats): bridged to the backend, subprotocols (and the token in them) passed on
    if (url.pathname.startsWith('/api/') && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim()).filter(Boolean)
      const target = BACKEND.replace(/^http/, 'ws') + url.pathname + url.search
      const accepted = protocols.find((p) => !p.startsWith('bearer.'))
      if (srv.upgrade(request, { data: { target, protocols, queue: [] }, headers: accepted ? { 'Sec-WebSocket-Protocol': accepted } : {} })) return
      return new Response('Upgrade failed', { status: 400 })
    }
    if (PROXIED.test(url.pathname)) {
      const headers = new Headers(request.headers)
      headers.set('x-forwarded-for', srv.requestIP(request)?.address ?? '127.0.0.1')
      headers.delete('host')
      if (url.pathname.startsWith('/api/notifications/stream')) srv.timeout(request, 0)
      return fetch(BACKEND + url.pathname + url.search, {
        method: request.method,
        headers,
        // buffered: streaming request bodies through fetch stall in this simple proxy
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
        redirect: 'manual'
      })
    }
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    const file = Bun.file(join(ROOT, path))
    if (path !== '/' && (await file.exists())) {
      const immutable = path.startsWith('/assets/')
      return new Response(file, { headers: immutable ? { 'cache-control': 'public, max-age=31536000, immutable' } : {} })
    }
    // static folders must 404 instead of falling back to the app shell
    if (/^\/(assets|cdn)\//.test(path)) return new Response('Not found', { status: 404 })
    return new Response(Bun.file(join(ROOT, 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
  },
  websocket: {
    idleTimeout: 120,
    open(ws) {
      const upstream = new WebSocket(ws.data.target, ws.data.protocols)
      ws.data.upstream = upstream
      upstream.binaryType = 'arraybuffer'
      upstream.addEventListener('open', () => {
        for (const message of ws.data.queue.splice(0)) upstream.send(message)
      })
      upstream.addEventListener('message', (event) => ws.send(typeof event.data === 'string' ? event.data : new Uint8Array(event.data)))
      // keep the backend's close code: 4001 makes the client refresh its token
      upstream.addEventListener('close', (event) => ws.close(event.code >= 3000 || event.code === 1000 ? event.code : 1011, event.reason))
    },
    message(ws, message) {
      const upstream = ws.data.upstream
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(message)
      else ws.data.queue.push(message)
    },
    close(ws) {
      ws.data.upstream?.close()
    }
  }
})
console.log(`frontend preview on http://localhost:${server.port} -> ${BACKEND}`)
