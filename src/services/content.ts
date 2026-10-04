import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { files, users } from '../db/schema'
import { forbidden, validationError } from '../lib/errors'
import { buildSpans, extractHashtags, extractMentions, sanitizeSpans, type SpanInput } from '../lib/text'
import { assertNoBannedWords } from './moderation'
import type { FileRow } from './posts'

/** Validates text + spans and computes generated hashtag / mention spans */
export async function prepareContent(content: string, spansInput: SpanInput[] | undefined, options: { maxLength: number; kind: 'Post' | 'Comment' | 'Reply' }) {
  if (content.length > options.maxLength) throw validationError(`text must be at most ${options.maxLength} characters`, 'content')
  await assertNoBannedWords(content, options.kind)

  const { spans: userSpans, error } = sanitizeSpans(content, spansInput)
  if (error) throw validationError(error, 'spans')

  const hashtags = extractHashtags(content)
  const mentionEntities = extractMentions(content).slice(0, 20)
  const usernames = [...new Set(mentionEntities.map((m) => m.value))]
  const found = usernames.length
    ? await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(and(sql`lower(${users.username}) in ${usernames}`, isNull(users.deletedAt), eq(users.isBanned, false)))
    : []
  const byName = new Map(found.map((u) => [u.username.toLowerCase(), u.id]))
  const mentions = mentionEntities.filter((m) => byName.has(m.value))

  return {
    spans: buildSpans(userSpans, hashtags, mentions),
    hashtags: [...new Set(hashtags.map((h) => h.value))],
    mentionedUserIds: [...new Set(mentions.map((m) => byName.get(m.value)!))]
  }
}

/** Resolves attachment ids: files must exist and belong to the author */
export async function resolveAttachments(ownerId: string, ids: string[], max: number): Promise<FileRow[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  if (unique.length > max) throw validationError(`Maximum ${max} attachments allowed per post`, 'attachmentIds')
  const rows = await db
    .select()
    .from(files)
    .where(and(inArray(files.id, unique), isNull(files.deletedAt)))
  if (rows.length !== unique.length || rows.some((f) => f.ownerId !== ownerId)) throw forbidden('Некоторые файлы не принадлежат вам')
  const byId = new Map(rows.map((f) => [f.id, f]))
  return unique.map((id) => byId.get(id)!)
}
