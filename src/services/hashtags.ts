import { eq, inArray, sql } from 'drizzle-orm'
import type { Transaction } from '../db/client'
import { hashtags, postHashtags } from '../db/schema'

/** Links hashtags to a post, creating them on first use */
export async function attachHashtags(tx: Transaction, postId: string, names: string[], createdAt: Date) {
  const unique = [...new Set(names)].slice(0, 30)
  if (unique.length === 0) return
  const rows = await tx
    .insert(hashtags)
    .values(unique.map((name) => ({ name, postsCount: 1, lastUsedAt: createdAt })))
    .onConflictDoUpdate({
      target: hashtags.name,
      set: { postsCount: sql`${hashtags.postsCount} + 1`, lastUsedAt: createdAt }
    })
    .returning({ id: hashtags.id })
  await tx
    .insert(postHashtags)
    .values(rows.map((row) => ({ postId, hashtagId: row.id, createdAt })))
    .onConflictDoNothing()
}

/** Removes hashtag links of a post (edit) */
export async function detachHashtags(tx: Transaction, postId: string) {
  const links = await tx.delete(postHashtags).where(eq(postHashtags.postId, postId)).returning({ hashtagId: postHashtags.hashtagId })
  if (links.length === 0) return
  await tx
    .update(hashtags)
    .set({ postsCount: sql`greatest(${hashtags.postsCount} - 1, 0)` })
    .where(
      inArray(
        hashtags.id,
        links.map((l) => l.hashtagId)
      )
    )
}

/** Keeps hashtag counters in sync when a post is deleted (-1) or restored (+1) */
export async function adjustHashtagCounts(tx: Transaction, postId: string, delta: 1 | -1) {
  await tx.execute(sql`
    update ${hashtags} set posts_count = greatest(posts_count + ${delta}, 0)
    where id in (select hashtag_id from ${postHashtags} where post_id = ${postId})
  `)
}
