import { stat } from 'node:fs/promises'
import { Elysia } from 'elysia'
import { config } from '../../config'
import { localStorage } from '../../lib/storage'

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  weba: 'audio/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  aac: 'audio/aac'
}

/** Serves files of the local storage driver, with HTTP range support for media seeking */
export const uploadsModule = new Elysia({ name: 'uploads' }).get(
  `${config.storage.publicPath}/*`,
  async ({ params, request, set }) => {
    let path: string
    try {
      path = localStorage.pathFor(decodeURIComponent(params['*']))
    } catch {
      set.status = 404
      return 'Not found'
    }
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) {
      set.status = 404
      return 'Not found'
    }

    const file = Bun.file(path)
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const headers: Record<string, string> = {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff'
    }

    const range = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/)
    if (range && (range[1] || range[2])) {
      const size = info.size
      let start = range[1] ? Number(range[1]) : size - Number(range[2])
      let end = range[1] && range[2] ? Number(range[2]) : size - 1
      start = Math.max(0, start)
      end = Math.min(size - 1, end)
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
      }
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) }
      })
    }
    return new Response(file, { headers })
  },
  { detail: { hide: true } }
)
