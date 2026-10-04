import { db } from '../db/client'
import { bannedWords } from '../db/schema'
import { config } from '../config'
import { containsBannedWord } from '../lib/text'
import { badRequest } from '../lib/errors'

let cache: { words: string[]; loadedAt: number } | undefined
const TTL_MS = 60_000

export async function getBannedWords() {
  if (!cache || Date.now() - cache.loadedAt > TTL_MS) {
    const rows = await db.select({ word: bannedWords.word }).from(bannedWords)
    cache = { words: [...config.content.bannedWords, ...rows.map((r) => r.word)], loadedAt: Date.now() }
  }
  return cache.words
}

export function invalidateBannedWords() {
  cache = undefined
}

export async function assertNoBannedWords(content: string, kind: 'Post' | 'Comment' | 'Reply') {
  if (content && containsBannedWord(content, await getBannedWords())) {
    throw badRequest(`${kind} contains prohibited content`, 'BANNED_WORD')
  }
}
