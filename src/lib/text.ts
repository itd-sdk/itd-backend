import type { Span, SpanType } from '../db/schema'

// ---------------------------------------------------------------- usernames / names / emoji

export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'api',
  'app',
  'auth',
  'help',
  'itd',
  'login',
  'logout',
  'me',
  'moderator',
  'notifications',
  'post',
  'posts',
  'profile',
  'register',
  'root',
  'search',
  'settings',
  'support',
  'system',
  'users'
])

/** Returns an error message (same wording as the official API) or null */
export function validateUsername(username: string): string | null {
  if (!username) return 'Username is required'
  if (username.length < 3) return 'Username must be at least 3 characters'
  if (username.length > 50) return 'Username must be at most 50 characters'
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return 'Username can contain only latin letters, digits and _'
  if (!/^[a-zA-Z]/.test(username)) return 'Username must start with a letter'
  if (username.endsWith('_')) return 'Username cannot end with _'
  if (username.includes('__')) return 'Username cannot contain __'
  return null
}

export const isReservedUsername = (username: string) => RESERVED_USERNAMES.has(username.toLowerCase())

const INVISIBLE = new RegExp('[' + ['\\u0000-\\u001F', '\\u007F-\\u009F', '\\u00AD', '\\u034F', '\\u061C', '\\u115F', '\\u1160', '\\u17B4', '\\u17B5', '\\u180E', '\\u2000-\\u200C', '\\u200E-\\u200F', '\\u2028-\\u202F', '\\u205F-\\u206F', '\\u3164', '\\uFEFF', '\\uFFA0'].join('') + ']', 'u')

export function validateDisplayName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return 'Display name cannot be empty'
  if (INVISIBLE.test(name)) return 'Name contains invalid invisible characters'
  const length = [...graphemes(name)].length
  if (length < 1 || length > 50) return 'Display name must be between 1 and 50 characters'
  if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(name)) return 'Display name must contain letters, numbers, or emoji'
  return null
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

export function* graphemes(value: string) {
  for (const { segment } of segmenter.segment(value)) yield segment
}

const EMOJI_GRAPHEME = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)/u

export function isSingleEmoji(value: string) {
  if (!value) return false
  const parts = [...graphemes(value)]
  return parts.length === 1 && EMOJI_GRAPHEME.test(parts[0]!)
}

// ---------------------------------------------------------------- hashtags & mentions

const HASHTAG_RE = /(?<![\p{L}\p{N}_#&/])#((?=[\p{N}_]*\p{L})[\p{L}\p{N}_]{1,64})/gu
const MENTION_RE = /(?<![\p{L}\p{N}_@./])@([a-zA-Z][a-zA-Z0-9_]{2,49})/gu

export type TextEntity = { offset: number; length: number; value: string }

export function extractHashtags(content: string): TextEntity[] {
  return [...content.matchAll(HASHTAG_RE)].map((match) => ({
    offset: match.index!,
    length: match[0].length,
    value: match[1]!.toLowerCase()
  }))
}

export function extractMentions(content: string): TextEntity[] {
  return [...content.matchAll(MENTION_RE)].map((match) => ({
    offset: match.index!,
    length: match[0].length,
    value: match[1]!.toLowerCase()
  }))
}

export const normalizeHashtag = (name: string) => name.replace(/^#/, '').trim().toLowerCase()

// ---------------------------------------------------------------- spans

const USER_SPAN_TYPES = new Set<SpanType>(['monospace', 'strike', 'bold', 'italic', 'spoiler', 'underline', 'link', 'quote'])
const SPAN_ALIASES: Record<string, SpanType> = { text_link: 'link', url: 'link', strikethrough: 'strike', code: 'monospace', pre: 'monospace', blockquote: 'quote' }

export type SpanInput = { offset: number; length: number; type: string; url?: string | null }

/** Validates client spans; generated types (hashtag, mention) are dropped and recomputed by the server */
export function sanitizeSpans(content: string, input: SpanInput[] = []): { spans: Span[]; error?: string } {
  const spans: Span[] = []
  for (const raw of input) {
    const type = (SPAN_ALIASES[raw.type] ?? raw.type) as SpanType
    if (type === 'hashtag' || type === 'mention') continue
    if (!USER_SPAN_TYPES.has(type)) return { spans: [], error: `Unknown span type: ${raw.type}` }
    if (!Number.isInteger(raw.offset) || !Number.isInteger(raw.length) || raw.offset < 0 || raw.length <= 0) {
      return { spans: [], error: 'Invalid span range' }
    }
    if (raw.offset + raw.length > content.length) return { spans: [], error: 'Span is out of content bounds' }
    const span: Span = { offset: raw.offset, length: raw.length, type }
    if (type === 'link') {
      const url = raw.url ?? content.slice(raw.offset, raw.offset + raw.length)
      if (!isHttpUrl(url)) return { spans: [], error: 'Link span requires a valid http(s) url' }
      span.url = url
    }
    spans.push(span)
  }
  return { spans }
}

export function isHttpUrl(value: string | null | undefined) {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Merges user spans with generated hashtag / mention spans */
export function buildSpans(userSpans: Span[], hashtags: TextEntity[], mentions: TextEntity[]): Span[] {
  const generated: Span[] = [
    ...hashtags.map((h) => ({ offset: h.offset, length: h.length, type: 'hashtag' as const, tag: h.value })),
    ...mentions.map((m) => ({ offset: m.offset, length: m.length, type: 'mention' as const, tag: m.value }))
  ]
  return [...userSpans, ...generated].sort((a, b) => a.offset - b.offset || b.length - a.length)
}

// ---------------------------------------------------------------- banned words

const normalizeForFilter = (value: string) =>
  value
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')

export function containsBannedWord(content: string, words: Iterable<string>) {
  const text = normalizeForFilter(content)
  if (!text) return false
  for (const raw of words) {
    const word = normalizeForFilter(raw).trim()
    if (!word) continue
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text)) return true
  }
  return false
}

export function truncate(value: string | null | undefined, max = 120) {
  if (!value) return value ?? null
  const chars = [...value]
  return chars.length > max ? chars.slice(0, max).join('') + '…' : value
}
