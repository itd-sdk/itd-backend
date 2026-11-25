import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Elysia, t } from 'elysia'
import { config } from '../../config'
import { db } from '../../db/client'
import { chatFiles } from '../../db/schema'
import { ApiError, badRequest, notFound, payloadTooLarge } from '../../lib/errors'
import { errorMeta, logger } from '../../lib/logger'
import { sniff } from '../../lib/media'
import { storage } from '../../lib/storage'
import { authPlugin } from '../../plugins/auth'
import { redis, rk } from '../../redis'
import { enforceActionLimit } from '../../services/rate-limit'
import { v7 as uuidv7 } from 'uuid'

/*
 * Chat attachments are uploaded in parts like on the official site: init → PUT every 5 MB part → finalize.
 * Any file type may be sent. It is stored under the extension of what its bytes really are (images, video,
 * audio); anything else gets .bin and is served as a download, never as a page of this site.
 */

export const PART_SIZE = 5 * 1024 * 1024
const UPLOAD_TTL_SECONDS = 24 * 60 * 60
const MAX_THUMB_BYTES = 512 * 1024

type Pending = { ownerId: string; mime: string; size: number; totalParts: number }

const uploadKey = (id: string) => rk('chat-upload', id)
const partsDir = (id: string) => join(config.messenger.uploadTmpDir, id)
const expectedPartSize = (upload: Pending, part: number) => (part < upload.totalParts - 1 ? PART_SIZE : upload.size - PART_SIZE * (upload.totalParts - 1))

async function loadUpload(id: string, ownerId: string) {
  const raw = await redis.get(uploadKey(id))
  const upload = raw ? (JSON.parse(raw) as Pending) : null
  if (!upload || upload.ownerId !== ownerId) throw notFound('Загрузка не найдена или устарела', 'UPLOAD_NOT_FOUND')
  return upload
}

const clean = (value: string | null | undefined, max: number) => (value ? value.replace(/[\u0000-\u001f\\/]/g, '_').slice(0, max) : null)

function storageKey(id: string, ext: string, suffix = '') {
  const now = new Date()
  return `chat/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}${suffix}.${ext}`
}

const UPLOAD_ID = t.Object({ id: t.String({ format: 'uuid' }) })

export const messengerUploadsModule = new Elysia()
  .use(authPlugin)

  .post(
    '/media/upload/init',
    async ({ body, me }) => {
      await enforceActionLimit('upload', me.id)
      if (body.size > config.messenger.maxFileSize) throw payloadTooLarge()
      if (body.totalParts !== Math.max(1, Math.ceil(body.size / PART_SIZE))) throw badRequest('Invalid part count', 'VALIDATION_ERROR')
      const uploadId = uuidv7()
      const upload: Pending = { ownerId: me.id, mime: body.mime.slice(0, 127) || 'application/octet-stream', size: body.size, totalParts: body.totalParts }
      await mkdir(partsDir(uploadId), { recursive: true })
      await redis.set(uploadKey(uploadId), JSON.stringify(upload), 'EX', UPLOAD_TTL_SECONDS)
      return { uploadId, partSize: PART_SIZE }
    },
    {
      user: true,
      body: t.Object({ mime: t.String({ maxLength: 255 }), size: t.Integer({ minimum: 1 }), totalParts: t.Integer({ minimum: 1 }) }),
      detail: { summary: 'Start a chat file upload' }
    }
  )

  .put(
    '/media/upload/:id/part/:part',
    async ({ params, request, me }) => {
      const upload = await loadUpload(params.id, me.id)
      const part = params.part
      if (part >= upload.totalParts) throw badRequest('Invalid part number', 'VALIDATION_ERROR')
      const bytes = new Uint8Array(await request.arrayBuffer())
      if (bytes.length !== expectedPartSize(upload, part)) throw badRequest('Invalid part size', 'VALIDATION_ERROR')
      await writeFile(join(partsDir(params.id), String(part)), bytes)
      return { success: true }
    },
    {
      user: true,
      parse: 'none',
      params: t.Object({ id: t.String({ format: 'uuid' }), part: t.Numeric({ minimum: 0 }) }),
      detail: { summary: 'One part of a chat file (raw bytes, 5 MB except the last)' }
    }
  )

  .post(
    '/media/upload/:id/finalize',
    async ({ params, body, me }) => {
      const upload = await loadUpload(params.id, me.id)
      const dir = partsDir(params.id)
      const bytes = new Uint8Array(upload.size)
      for (let part = 0; part < upload.totalParts; part++) {
        const path = join(dir, String(part))
        const info = await stat(path).catch(() => null)
        if (info?.size !== expectedPartSize(upload, part)) throw badRequest(`Part ${part} is missing`, 'UPLOAD_INCOMPLETE')
        bytes.set(await readFile(path), part * PART_SIZE)
      }

      const detected = sniff(bytes, upload.mime)
      const key = storageKey(params.id, detected?.ext ?? 'bin')
      let url: string
      let thumb: { key: string; url: string; width: number | null; height: number | null } | null = null
      try {
        url = await storage.put(key, bytes, detected?.mime ?? 'application/octet-stream')
        // the client sends a small JPEG preview of images and videos: {bytes (base64), width, height}
        const preview = typeof body.thumb === 'string' ? { bytes: body.thumb } : body.thumb
        if (preview?.bytes) {
          const thumbBytes = Buffer.from(preview.bytes, 'base64')
          const kind = thumbBytes.length <= MAX_THUMB_BYTES ? sniff(new Uint8Array(thumbBytes)) : null
          if (kind?.kind === 'image') {
            const thumbKey = storageKey(params.id, kind.ext, '-thumb')
            thumb = {
              key: thumbKey,
              url: await storage.put(thumbKey, new Uint8Array(thumbBytes), kind.mime),
              width: preview.width ?? kind.width ?? null,
              height: preview.height ?? kind.height ?? null
            }
          }
        }
      } catch (error) {
        logger.error('chat upload failed', errorMeta(error))
        throw new ApiError(500, 'UPLOAD_ERROR', 'Не удалось загрузить файл')
      }

      const [file] = await db
        .insert(chatFiles)
        .values({
          id: params.id,
          ownerId: me.id,
          storageKey: key,
          url,
          mime: upload.mime,
          filename: clean(body.filename, 255),
          size: upload.size,
          width: body.width ?? detected?.width ?? null,
          height: body.height ?? detected?.height ?? null,
          durationMs: body.durationMs != null ? Math.round(body.durationMs) : null,
          waveform: clean(body.waveform, 4096),
          thumbhash: clean(body.thumbhash, 256),
          thumbKey: thumb?.key ?? null,
          thumbUrl: thumb?.url ?? null,
          thumbWidth: thumb?.width ?? null,
          thumbHeight: thumb?.height ?? null
        })
        .returning()
      await Promise.all([redis.del(uploadKey(params.id)), rm(dir, { recursive: true, force: true })])
      return { fileId: file!.id, url: file!.url, sizePlain: file!.size, mime: file!.mime }
    },
    {
      user: true,
      params: UPLOAD_ID,
      body: t.Object({
        filename: t.Optional(t.Nullable(t.String({ maxLength: 1024 }))),
        width: t.Optional(t.Integer({ minimum: 0, maximum: 100000 })),
        height: t.Optional(t.Integer({ minimum: 0, maximum: 100000 })),
        durationMs: t.Optional(t.Number({ minimum: 0 })),
        waveform: t.Optional(t.String({ maxLength: 8192 })),
        thumbhash: t.Optional(t.String({ maxLength: 512 })),
        thumb: t.Optional(
          t.Union([
            t.String({ maxLength: 1024 * 1024 }),
            t.Object({
              bytes: t.String({ maxLength: 1024 * 1024 }),
              width: t.Optional(t.Integer({ minimum: 0, maximum: 100000 })),
              height: t.Optional(t.Integer({ minimum: 0, maximum: 100000 }))
            })
          ])
        )
      }),
      detail: { summary: 'Finish a chat file upload: the file id goes into a message' }
    }
  )

/** Drops parts of uploads that were never finished (a job) */
export async function cleanStaleUploads() {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(config.messenger.uploadTmpDir).catch(() => [] as string[])
  const now = Date.now()
  for (const name of entries) {
    const info = await stat(join(config.messenger.uploadTmpDir, name)).catch(() => null)
    if (info && now - info.mtimeMs > UPLOAD_TTL_SECONDS * 1000) {
      await rm(join(config.messenger.uploadTmpDir, name), { recursive: true, force: true }).catch(() => {})
    }
  }
}
