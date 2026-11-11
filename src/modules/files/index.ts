import { and, eq, isNull, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { v7 as uuidv7 } from 'uuid'
import { config } from '../../config'
import { db } from '../../db/client'
import { commentAttachments, comments, files, postAttachments, posts, users } from '../../db/schema'
import { bannerDrawingPng, DrawingError } from '../../lib/drawing'
import { ApiError, badRequest, conflict, forbidden, notFound, payloadTooLarge } from '../../lib/errors'
import { errorMeta, logger } from '../../lib/logger'
import { sniff, type SniffResult } from '../../lib/media'
import { storage } from '../../lib/storage'
import { authPlugin, type Me } from '../../plugins/auth'
import { FileModel, SuccessModel, Uuid } from '../../schemas'
import { enforceActionLimit } from '../../services/rate-limit'

type FileRow = typeof files.$inferSelect

const MAX_BY_KIND = { image: config.storage.maxImageSize, video: config.storage.maxVideoSize, audio: config.storage.maxAudioSize }

export function presentFile(file: FileRow) {
  return {
    id: file.id,
    url: file.url,
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.size,
    type: file.kind,
    width: file.width,
    height: file.height,
    createdAt: file.createdAt.toISOString()
  }
}

const invalidType = () => new ApiError(400, 'VALIDATION_ERROR', 'Недопустимый тип файла')

/** Stores an uploaded file after checking its real type (magic bytes) and size */
async function storeUpload(me: Me, upload: File, purpose: 'media' | 'avatar', only?: 'image') {
  if (upload.size === 0) throw badRequest('File is empty', 'VALIDATION_ERROR')
  if (upload.size > Math.max(...Object.values(MAX_BY_KIND))) throw payloadTooLarge()
  const bytes = new Uint8Array(await upload.arrayBuffer())
  const detected = sniff(bytes, upload.type)
  if (!detected) throw invalidType()
  if ((purpose === 'avatar' || only === 'image') && detected.kind !== 'image') throw invalidType()
  if (bytes.length > MAX_BY_KIND[detected.kind]) throw payloadTooLarge()
  return storeBytes(me, bytes, detected, upload.name, purpose)
}

async function storeBytes(me: Me, bytes: Uint8Array, detected: SniffResult, name: string, purpose: 'media' | 'avatar') {
  const id = uuidv7()
  const now = new Date()
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.${detected.ext}`
  let url: string
  try {
    url = await storage.put(key, bytes, detected.mime)
  } catch (error) {
    logger.error('upload failed', errorMeta(error))
    throw new ApiError(500, 'UPLOAD_ERROR', 'Не удалось загрузить файл')
  }

  const filename = (name || `file.${detected.ext}`).replace(/[/\\\u0000-\u001f]/g, '_').slice(0, 255)
  const [row] = await db
    .insert(files)
    .values({
      id,
      ownerId: me.id,
      storageKey: key,
      url,
      filename,
      mimeType: detected.mime,
      size: bytes.length,
      kind: detected.kind,
      width: detected.width ?? null,
      height: detected.height ?? null,
      purpose,
      createdAt: now
    })
    .returning()
  return row!
}

async function isFileInUse(fileId: string) {
  const [row] = await db.execute<{ used: boolean }>(sql`
    select exists (select 1 from ${postAttachments} pa join ${posts} p on p.id = pa.post_id where pa.file_id = ${fileId} and p.deleted_at is null)
        or exists (select 1 from ${commentAttachments} ca join ${comments} c on c.id = ca.comment_id where ca.file_id = ${fileId} and c.deleted_at is null)
        or exists (select 1 from ${users} u where u.banner_file_id = ${fileId} or u.avatar_file_id = ${fileId}) as used
  `)
  return !!row?.used
}

const UploadBody = t.Object({ file: t.File({ description: 'Image (jpeg, png, gif, webp, avif, heic), video (mp4, webm, mov) or audio' }) })

export const filesModule = new Elysia({ tags: ['Files'] })
  .use(authPlugin)

  .post(
    '/files/upload',
    async ({ body, me, set }) => {
      await enforceActionLimit('upload', me.id)
      set.status = 201
      return presentFile(await storeUpload(me, body.file, 'media'))
    },
    { user: true, body: UploadBody, response: { 201: FileModel }, detail: { summary: 'Upload media for posts, comments or a banner' } }
  )

  .post(
    '/files/avatar',
    async ({ body, me, set }) => {
      // a НУКСТА feature on the official server; openitd has no subscription, so everyone may
      await enforceActionLimit('upload', me.id)
      const file = await storeUpload(me, body.file, 'avatar')
      await db.update(users).set({ avatarFileId: file.id, updatedAt: new Date() }).where(eq(users.id, me.id))
      set.status = 201
      return { ...presentFile(file), avatar: file.url }
    },
    {
      user: true,
      body: UploadBody,
      response: { 201: t.Object({ ...FileModel.properties, avatar: t.String() }) },
      detail: { summary: 'Upload a picture avatar' }
    }
  )

  .post(
    '/files/banner-drawing',
    async ({ body, me, set }) => {
      await enforceActionLimit('upload', me.id)
      let png: ReturnType<typeof bannerDrawingPng>
      try {
        png = bannerDrawingPng(body)
      } catch (error) {
        if (error instanceof DrawingError) throw badRequest(error.message, 'VALIDATION_ERROR')
        throw error
      }
      const detected: SniffResult = { kind: 'image', mime: 'image/png', ext: 'png', width: png.width, height: png.height }
      set.status = 201
      return presentFile(await storeBytes(me, png.bytes, detected, 'banner.png', 'media'))
    },
    {
      user: true,
      body: t.Object({
        version: t.Integer(),
        width: t.Number(),
        height: t.Number(),
        // checked by parseBannerDrawing
        ops: t.Array(t.Unknown(), {
          description: '`{tool, color, width, points: [[x, y], ...]}` with tool brush, eraser, line, rectangle or circle; `{tool: "clear"}`'
        })
      }),
      response: { 201: FileModel },
      detail: { summary: 'A banner drawn in the web client: the strokes are painted on the server into a PNG (set it with bannerId)' }
    }
  )

  .post(
    '/files/banner-image',
    async ({ body, me, set }) => {
      await enforceActionLimit('upload', me.id)
      set.status = 201
      return presentFile(await storeUpload(me, body.file, 'media', 'image'))
    },
    {
      user: true,
      body: t.Object({ file: t.File({ description: 'Image (jpeg, png, gif, webp, avif, heic)' }) }),
      response: { 201: FileModel },
      detail: { summary: 'A banner from a picture (openitd; the official client only sends drawings). Set it with bannerId' }
    }
  )

  .delete(
    '/files/:id',
    async ({ params, me }) => {
      const [file] = await db
        .select()
        .from(files)
        .where(and(eq(files.id, params.id), isNull(files.deletedAt)))
        .limit(1)
      if (!file) throw notFound('File not found', 'FILE_NOT_FOUND')
      if (file.ownerId !== me.id) throw forbidden('You can delete only your own files')
      if (await isFileInUse(file.id)) throw conflict('File is attached to content', 'FILE_IN_USE')
      await db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, file.id))
      await storage.remove(file.storageKey).catch((error) => logger.warn('storage remove failed', errorMeta(error)))
      return { success: true }
    },
    { user: true, params: t.Object({ id: Uuid }), response: SuccessModel, detail: { summary: 'Delete an unused uploaded file' } }
  )

  .get(
    '/profile-avatar',
    async ({ me }) => {
      const [file] = me.avatarFileId ? await db.select({ url: files.url }).from(files).where(eq(files.id, me.avatarFileId)).limit(1) : []
      return { data: { active: file?.url ?? null, available: true } }
    },
    { user: true, response: t.Object({ data: t.Object({ active: t.Nullable(t.String()), available: t.Boolean() }) }) }
  )

  .delete(
    '/profile-avatar',
    async ({ me }) => {
      await db.update(users).set({ avatarFileId: null, updatedAt: new Date() }).where(eq(users.id, me.id))
      return { data: { active: null } }
    },
    { user: true, response: t.Object({ data: t.Object({ active: t.Null() }) }) }
  )
