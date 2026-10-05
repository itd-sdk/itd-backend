import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { Elysia, t } from 'elysia'
import { config } from '../../config'
import { db, type Transaction } from '../../db/client'
import { type EventItemKind, eventItems, eventNicknames, eventProfiles, eventWallets, pins, userPins, users } from '../../db/schema'
import { badRequest, notFound } from '../../lib/errors'
import { authPlugin } from '../../plugins/auth'
import { broadcastChannel, publish } from '../../services/realtime'
import { assertEventEnabled, eventActive, getWallet, NICKNAMES } from './service'

/*
 * Stub of the event shop: every item is granted for free from the event page (deploy/frontend/event-app),
 * and can be taken back. Counted items take an amount, one-off items are owned or not.
 */

// resetOnly: a counter that can only be taken down (to zero), not granted
type FreeItem = { key: string; title: string; description: string; once: boolean; resetOnly?: boolean }

export const FREE_ITEMS: FreeItem[] = [
  { key: 'notebook_grid', title: 'Тетрадь в клетку', description: 'Оформление поста, выбирается при публикации', once: false },
  { key: 'notebook_ruled', title: 'Тетрадь в линейку', description: 'Оформление поста, выбирается при публикации', once: false },
  { key: 'pin_aliceai', title: 'Пин «Алиса AI»', description: 'Значок возле имени, включается в настройках профиля', once: true },
  { key: 'red_pen', title: 'Красная ручка', description: 'Исправить слово в чужом посте (меню поста)', once: false },
  { key: 'corrector', title: 'Корректор', description: 'Замазать фрагмент текста в посте (меню поста)', once: false },
  { key: 'sticker', title: 'Наклейка для баннера', description: 'Наклеить на баннер профиля', once: false },
  { key: 'balloon', title: 'Шарик с водой', description: 'Бросить в баннер или пост на чужом профиле', once: false },
  { key: 'bell', title: 'Звонок', description: 'При получении звенит у всех, кто сейчас онлайн', once: true },
  { key: 'aura_analyzer', title: 'Анализатор ауры', description: 'Ставит профилю случайную ауру от 0 до 100', once: true },
  { key: 'nickname', title: 'Случайная кликуха', description: 'Подпись возле имени, выдаётся случайная', once: true },
  { key: 'whoopee_cushion', title: 'Подушка-пердушка', description: 'Подложить на чужой профиль', once: false },
  { key: 'window', title: 'Портфель', description: 'Разбить окно на баннере чужого профиля', once: false },
  { key: 'chalk', title: 'Мелки', description: 'Скидываются на шторы любого профиля, и своего тоже', once: false },
  { key: 'curtains_fund', title: 'Собрано на шторы', description: 'Мелки, которые скинули на шторы вашего профиля', once: false, resetOnly: true },
  { key: 'clan_image', title: 'Своя картинка вместо эмодзи клана', description: 'Загрузить картинку на этой странице', once: true }
]

// sticker art the web client knows (deploy/frontend: assets/sticker_*)
const STICKERS = [
  'sticker_5plus', 'sticker_apple', 'sticker_bow', 'sticker_star', 'sticker_toad',
  ...Array.from({ length: 31 }, (_, i) => `sticker_school_${String(i + 3).padStart(2, '0')}`).filter((s) => s !== 'sticker_school_11'),
  'sticker_school_46', 'sticker_school_47', 'sticker_school_alice_mark', 'sticker_school_alice_text', 'sticker_school_photo', 'sticker_school_skull'
]
const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]!

const WALLET_COLUMNS = {
  notebook_grid: 'notebookGrid',
  notebook_ruled: 'notebookRuled',
  red_pen: 'redPens',
  corrector: 'correctors',
  chalk: 'balance'
} as const
const ITEM_KINDS: Record<string, EventItemKind> = { sticker: 'sticker', balloon: 'stain', whoopee_cushion: 'whoopee_cushion', window: 'window' }
const ONE_OFF_KINDS: Record<string, EventItemKind> = { bell: 'bell', aura_analyzer: 'aura_analyzer', clan_image: 'clan_image' }
const ALICE_PIN = { slug: 'aliceai', name: 'Алиса AI', description: 'Участник ивента «Алиса AI»', url: `/public/events/${config.event.id}/pin-aliceai.svg` }

async function freeState(userId: string) {
  const wallet = await getWallet(userId)
  const [items, pinRows, nicknames, profile] = await Promise.all([
    db
      .select({ kind: eventItems.kind, count: sql<number>`count(*)::int` })
      .from(eventItems)
      .where(and(eq(eventItems.userId, userId), isNull(eventItems.usedAt)))
      .groupBy(eventItems.kind),
    db.select({ slug: userPins.pinSlug }).from(userPins).where(and(eq(userPins.userId, userId), eq(userPins.pinSlug, ALICE_PIN.slug))),
    db.select().from(eventNicknames).where(and(eq(eventNicknames.userId, userId), sql`${eventNicknames.expiresAt} > now()`)).orderBy(desc(eventNicknames.createdAt)),
    db.select({ aura: eventProfiles.aura, fund: eventProfiles.curtainsFund, goal: eventProfiles.curtainsGoal }).from(eventProfiles).where(eq(eventProfiles.userId, userId))
  ])
  const countOf = (kind: EventItemKind) => items.find((i) => i.kind === kind)?.count ?? 0
  const active = nicknames.find((n) => n.id === wallet.activeNicknameId)
  return {
    enabled: eventActive(),
    items: FREE_ITEMS.map((item) => {
      let count: number
      let note: string | null = null
      if (item.key in WALLET_COLUMNS) count = wallet[WALLET_COLUMNS[item.key as keyof typeof WALLET_COLUMNS]]
      else if (item.key in ITEM_KINDS) count = countOf(ITEM_KINDS[item.key]!)
      else if (item.key in ONE_OFF_KINDS) count = Math.min(1, countOf(ONE_OFF_KINDS[item.key]!))
      else if (item.key === 'pin_aliceai') count = pinRows.length ? 1 : 0
      else if (item.key === 'curtains_fund') count = profile[0]?.fund ?? 0
      else count = active ? 1 : 0
      if (item.key === 'nickname' && active) note = active.label
      if (item.key === 'aura_analyzer' && count) note = `аура ${profile[0]?.aura ?? 0}`
      if (item.key === 'curtains_fund' && profile[0]) note = `цель ${profile[0].goal}`
      return { ...item, count, owned: count > 0, note }
    })
  }
}

async function addItems(tx: Transaction, userId: string, kind: EventItemKind, amount: number, asset: () => string | null) {
  if (amount > 0) {
    await tx.insert(eventItems).values(Array.from({ length: amount }, () => ({ userId, kind, asset: asset() })))
    return
  }
  // taking back removes the newest unused ones
  const rows = await tx
    .select({ id: eventItems.id })
    .from(eventItems)
    .where(and(eq(eventItems.userId, userId), eq(eventItems.kind, kind), isNull(eventItems.usedAt)))
    .orderBy(desc(eventItems.createdAt))
    .limit(-amount)
  if (rows.length) await tx.delete(eventItems).where(inArray(eventItems.id, rows.map((r) => r.id)))
}

const bumpProfile = async (tx: Transaction, userId: string, set: PgUpdateSetSource<typeof eventProfiles>) => {
  await tx.insert(eventProfiles).values({ userId }).onConflictDoNothing()
  await tx
    .update(eventProfiles)
    .set({ ...set, rev: sql`${eventProfiles.rev} + 1`, updatedAt: new Date() })
    .where(eq(eventProfiles.userId, userId))
}

async function grant(user: { id: string; username: string | null }, key: string, amount: number) {
  const item = FREE_ITEMS.find((i) => i.key === key)
  if (!item) throw notFound('Нет такого предмета', 'ITEM_NOT_FOUND')
  if (item.once) amount = Math.sign(amount)
  if (amount === 0) return
  if (item.resetOnly && amount > 0) throw badRequest('Это можно только обнулить', 'VALIDATION_ERROR')

  let ringBell = false
  await db.transaction(async (tx) => {
    await tx.insert(eventWallets).values({ userId: user.id }).onConflictDoNothing()
    if (key in WALLET_COLUMNS) {
      const field = WALLET_COLUMNS[key as keyof typeof WALLET_COLUMNS]
      const column = eventWallets[field]
      await tx
        .update(eventWallets)
        .set({ [field]: sql`greatest(0, ${column} + ${amount})`, updatedAt: new Date() })
        .where(eq(eventWallets.userId, user.id))
      return
    }
    if (key in ITEM_KINDS) {
      const kind = ITEM_KINDS[key]!
      await addItems(tx, user.id, kind, amount, () => (kind === 'sticker' ? pick(STICKERS) : kind === 'stain' ? 'water_stain' : kind === 'window' ? 'window_broken' : 'cushion'))
      return
    }
    if (key in ONE_OFF_KINDS) {
      const kind = ONE_OFF_KINDS[key]!
      const [owned] = await tx
        .select({ id: eventItems.id })
        .from(eventItems)
        .where(and(eq(eventItems.userId, user.id), eq(eventItems.kind, kind), isNull(eventItems.usedAt)))
        .limit(1)
      if (amount > 0 && owned) return
      if (amount < 0 && !owned) return
      await addItems(tx, user.id, kind, amount > 0 ? 1 : -1000, () => null)
      if (kind === 'bell' && amount > 0) ringBell = true
      if (kind === 'aura_analyzer') await bumpProfile(tx, user.id, { aura: amount > 0 ? Math.floor(Math.random() * 101) : 0 })
      if (kind === 'clan_image' && amount < 0) await tx.update(users).set({ avatarFileId: null, updatedAt: new Date() }).where(eq(users.id, user.id))
      return
    }
    if (key === 'curtains_fund') {
      await bumpProfile(tx, user.id, { curtainsFund: sql`greatest(0, ${eventProfiles.curtainsFund} + ${amount})` })
      return
    }
    if (key === 'pin_aliceai') {
      if (amount > 0) {
        await tx.insert(pins).values(ALICE_PIN).onConflictDoUpdate({ target: pins.slug, set: { url: ALICE_PIN.url } })
        await tx.insert(userPins).values({ userId: user.id, pinSlug: ALICE_PIN.slug }).onConflictDoNothing()
      } else {
        await tx.delete(userPins).where(and(eq(userPins.userId, user.id), eq(userPins.pinSlug, ALICE_PIN.slug)))
        await tx.update(users).set({ activePinSlug: null }).where(and(eq(users.id, user.id), eq(users.activePinSlug, ALICE_PIN.slug)))
      }
      return
    }
    if (key === 'nickname') {
      if (amount > 0) {
        const [nickname] = await tx
          .insert(eventNicknames)
          .values({ id: crypto.randomUUID(), userId: user.id, label: pick(NICKNAMES), styleKey: 'school_gold', eventId: config.event.id, expiresAt: new Date(Date.now() + 30 * 86400_000) })
          .returning()
        await tx.update(eventWallets).set({ activeNicknameId: nickname!.id }).where(eq(eventWallets.userId, user.id))
      } else {
        await tx.update(eventWallets).set({ activeNicknameId: null }).where(eq(eventWallets.userId, user.id))
        await tx.delete(eventNicknames).where(eq(eventNicknames.userId, user.id))
      }
    }
  })

  if (ringBell) {
    await publish(broadcastChannel(), 'alice.bell', {
      id: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      buyerUsername: user.username ?? ''
    })
  }
}

export const freeItemsModule = new Elysia({ tags: ['Event'] })
  .use(authPlugin)
  .get('/v1/aliceai/free', ({ me }) => freeState(me.id), { user: true, detail: { summary: 'Free event items of the current user (stub shop)' } })
  .post(
    '/v1/aliceai/free/:key',
    async ({ me, params, body }) => {
      assertEventEnabled()
      if (!Number.isInteger(body.amount) || Math.abs(body.amount) > 1000) throw badRequest('Количество от -1000 до 1000', 'VALIDATION_ERROR')
      await grant(me, params.key, body.amount)
      return freeState(me.id)
    },
    {
      user: true,
      params: t.Object({ key: t.String({ maxLength: 32 }) }),
      body: t.Object({ amount: t.Integer({ description: 'Positive grants, negative takes back; one-off items use 1 / -1' }) }),
      detail: { summary: 'Grant (or take back) an event item for free' }
    }
  )
