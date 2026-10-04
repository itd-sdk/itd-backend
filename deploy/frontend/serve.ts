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

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  idleTimeout: 255,
  async fetch(request, srv) {
    const url = new URL(request.url)
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
  }
})
console.log(`frontend preview on http://localhost:${server.port} -> ${BACKEND}`)
