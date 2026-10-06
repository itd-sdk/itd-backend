import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { config } from '../../config'
import { db, type Transaction } from '../../db/client'
import { type EventAnchor, type EventItemKind, eventItems, eventNicknames, eventPlacements, eventProfiles, eventWallets, posts, postMarks } from '../../db/schema'
import { ApiError, badRequest, forbidden, notFound } from '../../lib/errors'
import { contentRevision } from '../../lib/crypto'
import { iso } from '../../lib/time'
import { redis, rk } from '../../redis'
import { loadBriefs } from '../../services/users'

export type ItemKind = 'sticker' | 'eraser' | 'window' | 'stain' | 'whoopee_cushion'
export const BACKPACK_KINDS: ItemKind[] = ['sticker', 'eraser', 'window', 'stain', 'whoopee_cushion']

/** Items of the stub shop: everything is granted for free from the event page (./free.ts) */
export const SHOP_INFO = [
  { id: 'post_notebook', title: 'Тетрадка', details: 'Оформление поста: тетрадь в клетку или в линейку', bullets: ['Выбирается при публикации поста', 'Одна тетрадка — один пост'] },
  { id: 'red_pen', title: 'Красная ручка', details: 'Исправить слово в чужом посте', bullets: ['Исправление видно всем сутки'] },
  { id: 'duty_corrector', title: 'Корректор', details: 'Замазать фрагмент текста в посте', bullets: ['Видно всем сутки'] },
  { id: 'aura_analyzer', title: 'Анализатор ауры', details: 'Показывает ауру профиля', bullets: ['Ставит случайное значение от 0 до 100'] }
]

export const SHOP = [
  { id: 'sticker', kind: 'sticker', title: 'Стикер', price: 10, asset: 'sticker_star' },
  { id: 'eraser', kind: 'eraser', title: 'Ластик', price: 5, asset: 'eraser' },
  { id: 'window', kind: 'window', title: 'Камень в окно', price: 25, asset: 'window_broken' },
  { id: 'stain', kind: 'stain', title: 'Водяная бомбочка', price: 5, asset: 'water_stain' },
  { id: 'whoopee_cushion', kind: 'whoopee_cushion', title: 'Подушка-пердушка', price: 15, asset: 'cushion' },
  { id: 'red_pen', kind: 'red_pen', title: 'Красная ручка', price: 10, asset: 'red_pen' },
  { id: 'corrector', kind: 'corrector', title: 'Корректор', price: 10, asset: 'corrector' },
  { id: 'nickname', kind: 'nickname', title: 'Кликуха на неделю', price: 30, asset: null }
] as const

export const NICKNAMES = ['Отличник', 'Двоечник', 'Староста', 'Хулиган', 'Ботаник', 'Прогульщик', 'Звезда класса', 'Тихоня']
const WINDOW_BROKEN_MS = 60 * 60_000
const BALLOON_TTL_MS = 10 * 60_000
const MARK_TTL_MS = 24 * 60 * 60_000
const RED_PEN_LIMIT = 3
const CORRECTOR_LIMIT = 3
const MAX_WEAR = 4

export const eventDisabled = () => new ApiError(403, 'EVENT_DISABLED', 'Ивент сейчас не проводится')

export function eventEndsAt() {
  if (config.event.endsAt) return new Date(config.event.endsAt)
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

export const eventActive = () => config.event.enabled && eventEndsAt().getTime() > Date.now()

export function assertEventEnabled() {
  if (!config.event.enabled || eventEndsAt().getTime() <= Date.now()) throw eventDisabled()
}

export const eventsList = () => [{ id: config.event.id, endsAt: eventEndsAt().toISOString(), applicationsEnabled: config.event.enabled }]

// ---------------------------------------------------------------- wallet

export async function getWallet(userId: string, executor: Transaction | typeof db = db) {
  await executor.insert(eventWallets).values({ userId }).onConflictDoNothing()
  const [wallet] = await executor.select().from(eventWallets).where(eq(eventWallets.userId, userId))
  return wallet!
}

async function spendBalance(tx: Transaction, userId: string, amount: number) {
  await tx.insert(eventWallets).values({ userId }).onConflictDoNothing()
  const [row] = await tx
    .update(eventWallets)
    .set({ balance: sql`${eventWallets.balance} - ${amount}`, updatedAt: new Date() })
    .where(and(eq(eventWallets.userId, userId), sql`${eventWallets.balance} >= ${amount}`))
    .returning()
  if (!row) throw badRequest('Недостаточно монет', 'INSUFFICIENT_BALANCE')
  return row
}

async function consumeItem(tx: Transaction, userId: string, itemId: string, kind: ItemKind) {
  const [item] = await tx
    .update(eventItems)
    .set({ usedAt: new Date() })
    .where(and(eq(eventItems.id, itemId), eq(eventItems.userId, userId), eq(eventItems.kind, kind), isNull(eventItems.usedAt)))
    .returning()
  if (!item) throw badRequest('Предмет не найден в инвентаре', 'ITEM_NOT_FOUND')
  return item
}

export async function buy(userId: string, itemId: string) {
  const offer = SHOP.find((o) => o.id === itemId)
  if (!offer) throw notFound('Товар не найден', 'ITEM_NOT_FOUND')
  return db.transaction(async (tx) => {
    const wallet = await spendBalance(tx, userId, offer.price)
    if (offer.kind === 'red_pen' || offer.kind === 'corrector') {
      const column = offer.kind === 'red_pen' ? eventWallets.redPens : eventWallets.correctors
      await tx
        .update(eventWallets)
        .set({ [offer.kind === 'red_pen' ? 'redPens' : 'correctors']: sql`${column} + 1` })
        .where(eq(eventWallets.userId, userId))
      return { balance: wallet.balance, item: null }
    }
    if (offer.kind === 'nickname') {
      const label = NICKNAMES[Math.floor(Math.random() * NICKNAMES.length)]!
      const [nickname] = await tx
        .insert(eventNicknames)
        .values({ id: crypto.randomUUID(), userId, label, styleKey: 'school_gold', eventId: config.event.id, expiresAt: new Date(Date.now() + 7 * 86400_000) })
        .returning()
      return { balance: wallet.balance, item: { id: nickname!.id, kind: 'nickname', asset: null, label } }
    }
    const [item] = await tx.insert(eventItems).values({ userId, kind: offer.kind, asset: offer.asset }).returning()
    return { balance: wallet.balance, item: { id: item!.id, kind: item!.kind, asset: item!.asset } }
  })
}

export async function claimDaily(userId: string) {
  return db.transaction(async (tx) => {
    await tx.insert(eventProfiles).values({ userId }).onConflictDoNothing()
    const [profile] = await tx
      .update(eventProfiles)
      .set({ claimedAt: new Date(), aura: sql`${eventProfiles.aura} + 1` })
      .where(and(eq(eventProfiles.userId, userId), or(isNull(eventProfiles.claimedAt), sql`${eventProfiles.claimedAt} < now() - interval '1 day'`)))
      .returning()
    if (!profile) throw new ApiError(409, 'ALREADY_CLAIMED', 'Награда уже получена сегодня')
    await tx.insert(eventWallets).values({ userId }).onConflictDoNothing()
    const [wallet] = await tx
      .update(eventWallets)
      .set({ balance: sql`${eventWallets.balance} + ${config.event.dailyReward}` })
      .where(eq(eventWallets.userId, userId))
      .returning()
    return { success: true, reward: config.event.dailyReward, balance: wallet!.balance }
  })
}

// ---------------------------------------------------------------- profiles

async function ensureProfile(tx: Transaction | typeof db, userId: string) {
  await tx.insert(eventProfiles).values({ userId }).onConflictDoNothing()
  const [profile] = await tx.select().from(eventProfiles).where(eq(eventProfiles.userId, userId))
  return profile!
}

const bumpRev = (tx: Transaction, userId: string) =>
  tx
    .update(eventProfiles)
    .set({ rev: sql`${eventProfiles.rev} + 1`, updatedAt: new Date() })
    .where(eq(eventProfiles.userId, userId))

export async function presentEventProfile(userId: string) {
  const profile = await ensureProfile(db, userId)
  const now = Date.now()
  const [placements, wallet] = await Promise.all([
    db
      .select()
      .from(eventPlacements)
      .where(and(eq(eventPlacements.profileId, userId), isNull(eventPlacements.erasedAt), or(isNull(eventPlacements.expiresAt), gt(eventPlacements.expiresAt, sql`now()`))))
      .orderBy(asc(eventPlacements.createdAt)),
    getWallet(userId)
  ])
  const [nickname] = wallet.activeNicknameId
    ? await db
        .select()
        .from(eventNicknames)
        .where(and(eq(eventNicknames.id, wallet.activeNicknameId), gt(eventNicknames.expiresAt, sql`now()`)))
    : []
  const broken = !!profile.windowBrokenAt && now - profile.windowBrokenAt.getTime() < WINDOW_BROKEN_MS

  return {
    profileId: userId,
    rev: profile.rev,
    window: { broken, asset: broken ? (profile.windowAsset ?? 'window_broken') : null, brokenAt: broken ? iso(profile.windowBrokenAt) : null },
    curtains: { fund: profile.curtainsFund, goal: profile.curtainsGoal, hasCurtains: profile.curtainsAvailable, closed: profile.curtainsClosed },
    aura: profile.aura,
    nickname: nickname?.label ?? null,
    placements: placements
      .filter((p) => p.kind === 'sticker')
      .map((p, index) => ({
        id: p.id,
        kind: 'sticker' as const,
        asset: p.asset ?? 'sticker_star',
        x: p.x,
        y: p.y,
        z: p.z || index + 1,
        size: p.size,
        angle: p.angle,
        wear: p.wear,
        anchor: p.anchor,
        createdAt: p.createdAt.toISOString(),
        createdBy: p.createdBy
      })),
    balloons: placements
      .filter((p) => p.kind === 'stain')
      .map((p) => ({ id: p.id, x: p.x, y: p.y, angle: p.angle, thrownAt: p.createdAt.toISOString(), thrownBy: p.createdBy, expiresAt: iso(p.expiresAt)!, anchor: p.anchor }))
  }
}

type Spot = { x: number; y: number; anchor?: EventAnchor | null; angle?: number; size?: number }

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

export async function placeSticker(actorId: string, profileId: string, itemId: string, spot: Spot) {
  return db.transaction(async (tx) => {
    await ensureProfile(tx, profileId)
    const item = await consumeItem(tx, actorId, itemId, 'sticker')
    const [placement] = await tx
      .insert(eventPlacements)
      .values({
        profileId,
        kind: 'sticker',
        asset: item.asset,
        x: clamp01(spot.x),
        y: clamp01(spot.y),
        angle: spot.angle ?? Math.round(Math.random() * 40 - 20),
        size: spot.size ?? 0.18,
        anchor: spot.anchor ?? { kind: 'profile_header', id: profileId },
        createdBy: actorId
      })
      .returning()
    const [profile] = await bumpRev(tx, profileId).returning({ rev: eventProfiles.rev })
    const p = placement!
    return {
      success: true,
      placementId: p.id,
      rev: profile!.rev,
      placement: { id: p.id, kind: 'sticker' as const, asset: p.asset ?? 'sticker_star', x: p.x, y: p.y, z: p.z || 1, size: p.size, angle: p.angle, wear: p.wear },
      evicted: [] as string[]
    }
  })
}

export async function throwBalloon(actorId: string, profileId: string, itemId: string, spot: Spot) {
  return db.transaction(async (tx) => {
    await ensureProfile(tx, profileId)
    await consumeItem(tx, actorId, itemId, 'stain')
    const [balloon] = await tx
      .insert(eventPlacements)
      .values({
        profileId,
        kind: 'stain',
        asset: 'water_stain',
        x: clamp01(spot.x),
        y: clamp01(spot.y),
        angle: spot.angle ?? Math.round(Math.random() * 360),
        anchor: spot.anchor ?? { kind: 'profile_header', id: profileId },
        createdBy: actorId,
        expiresAt: new Date(Date.now() + BALLOON_TTL_MS)
      })
      .returning()
    await bumpRev(tx, profileId)
    const shape = {
      id: balloon!.id,
      x: balloon!.x,
      y: balloon!.y,
      angle: balloon!.angle,
      thrownAt: balloon!.createdAt.toISOString(),
      thrownBy: actorId,
      expiresAt: balloon!.expiresAt!.toISOString(),
      anchor: balloon!.anchor
    }
    return { success: true, balloon: shape }
  })
}

export async function eraseSticker(actorId: string, profileId: string, placementId: string, itemId: string | undefined) {
  return db.transaction(async (tx) => {
    const [placement] = await tx
      .select()
      .from(eventPlacements)
      .where(and(eq(eventPlacements.id, placementId), eq(eventPlacements.profileId, profileId), isNull(eventPlacements.erasedAt)))
    if (!placement) throw notFound('Стикер не найден', 'PLACEMENT_NOT_FOUND')
    // the profile owner erases for free, others spend an eraser
    if (actorId !== profileId) {
      const [eraser] = itemId
        ? [{ id: itemId }]
        : await tx
            .select({ id: eventItems.id })
            .from(eventItems)
            .where(and(eq(eventItems.userId, actorId), eq(eventItems.kind, 'eraser'), isNull(eventItems.usedAt)))
            .limit(1)
      if (!eraser) throw badRequest('Нужен ластик', 'ITEM_NOT_FOUND')
      await consumeItem(tx, actorId, eraser.id, 'eraser')
    }
    const wear = placement.wear + 1
    await tx
      .update(eventPlacements)
      .set({ wear, ...(wear >= MAX_WEAR ? { erasedAt: new Date() } : {}) })
      .where(eq(eventPlacements.id, placementId))
    await bumpRev(tx, profileId)
    return { success: true, wear, removed: wear >= MAX_WEAR }
  })
}

export async function breakWindow(actorId: string, profileId: string, itemId: string) {
  if (actorId === profileId) throw badRequest('Нельзя разбить своё окно')
  return db.transaction(async (tx) => {
    await ensureProfile(tx, profileId)
    await consumeItem(tx, actorId, itemId, 'window')
    const brokenAt = new Date()
    await tx.update(eventProfiles).set({ windowBrokenAt: brokenAt, windowAsset: 'window_broken' }).where(eq(eventProfiles.userId, profileId))
    await bumpRev(tx, profileId)
    return { success: true, window: { broken: true, asset: 'window_broken', brokenAt: brokenAt.toISOString() } }
  })
}

const CUSHION_TTL_SECONDS = 24 * 60 * 60
const cushionKey = (profileId: string) => rk('event', 'cushion', profileId)
type Cushion = { id: string; placedBy: string; x: number; y: number; anchorKind: string; anchorId: string | null; expiresAt: string }

/** Hides a whoopee cushion on a profile: the next visitor other than the prankster sits on it */
export async function placeCushion(actorId: string, profileId: string, itemId: string, spot: { x?: number; y?: number; anchorKind?: string; anchorId?: string | null }) {
  if (await redis.exists(cushionKey(profileId))) throw new ApiError(409, 'CUSHION_ACTIVE', 'На этом профиле уже лежит подушка')
  await db.transaction(async (tx) => {
    await consumeItem(tx, actorId, itemId, 'whoopee_cushion')
  })
  const cushion: Cushion = {
    id: crypto.randomUUID(),
    placedBy: actorId,
    x: clamp01(spot.x ?? 0.5),
    y: clamp01(spot.y ?? 0.5),
    anchorKind: spot.anchorKind ?? 'profile_header',
    anchorId: spot.anchorId ?? null,
    expiresAt: new Date(Date.now() + CUSHION_TTL_SECONDS * 1000).toISOString()
  }
  await redis.set(cushionKey(profileId), JSON.stringify(cushion), 'EX', CUSHION_TTL_SECONDS)
  return { success: true, id: cushion.id }
}

export async function claimCushion(viewerId: string, profileId: string) {
  const raw = await redis.get(cushionKey(profileId))
  if (!raw) return { show: false }
  const cushion = JSON.parse(raw) as Cushion
  if (cushion.placedBy === viewerId) return { show: false }
  // only one visitor gets it
  if ((await redis.del(cushionKey(profileId))) === 0) return { show: false }
  const { placedBy: _, ...rest } = cushion
  return { ...rest, show: true }
}

export async function donateCurtains(actorId: string, profileId: string, amount: number) {
  return db.transaction(async (tx) => {
    await ensureProfile(tx, profileId)
    const wallet = await spendBalance(tx, actorId, amount)
    const [profile] = await tx
      .update(eventProfiles)
      .set({ curtainsFund: sql`${eventProfiles.curtainsFund} + ${amount}` })
      .where(eq(eventProfiles.userId, profileId))
      .returning()
    await bumpRev(tx, profileId)
    const curtains = { fund: profile!.curtainsFund, goal: profile!.curtainsGoal, hasCurtains: profile!.curtainsAvailable, closed: profile!.curtainsClosed }
    return { success: true, ...curtains, curtains, donated: amount, balance: wallet.balance }
  })
}

export async function claimCurtains(userId: string, profileId: string) {
  if (userId !== profileId) throw forbidden('Шторы можно забрать только себе')
  return db.transaction(async (tx) => {
    const profile = await ensureProfile(tx, profileId)
    if (profile.curtainsFund < profile.curtainsGoal) throw badRequest('Сбор на шторы ещё не завершён', 'GOAL_NOT_REACHED')
    await tx.update(eventProfiles).set({ curtainsAvailable: true }).where(eq(eventProfiles.userId, profileId))
    await bumpRev(tx, profileId)
    return { success: true, hasCurtains: true }
  })
}

export async function setCurtains(userId: string, profileId: string, closed: boolean) {
  if (userId !== profileId) throw forbidden('Можно управлять только своими шторами')
  const profile = await ensureProfile(db, profileId)
  if (!profile.curtainsAvailable) throw badRequest('У вас ещё нет штор', 'NO_CURTAINS')
  const [updated] = await db
    .update(eventProfiles)
    .set({ curtainsClosed: closed, rev: sql`${eventProfiles.rev} + 1` })
    .where(eq(eventProfiles.userId, profileId))
    .returning()
  const curtains = { fund: updated!.curtainsFund, goal: updated!.curtainsGoal, hasCurtains: updated!.curtainsAvailable, closed: updated!.curtainsClosed }
  return { success: true, closed, rev: updated!.rev, curtains }
}

// ---------------------------------------------------------------- nicknames

export async function listNicknames(userId: string) {
  const wallet = await getWallet(userId)
  const rows = await db
    .select()
    .from(eventNicknames)
    .where(and(eq(eventNicknames.userId, userId), gt(eventNicknames.expiresAt, sql`now()`)))
    .orderBy(asc(eventNicknames.createdAt))
  const active = rows.find((n) => n.id === wallet.activeNicknameId) ?? null
  return {
    nicknames: rows.map((n) => ({ id: n.id, label: n.label, styleKey: n.styleKey, eventId: n.eventId, expiresAt: n.expiresAt.toISOString(), stateVersion: 0 })),
    // the web client lists and activates nicknames by their label
    owned: rows.map((n) => n.label),
    active: active?.label ?? null,
    activeId: active?.id ?? null
  }
}

export async function setActiveNickname(userId: string, nicknameId: string | null) {
  if (nicknameId) {
    const [nickname] = await db
      .select()
      .from(eventNicknames)
      .where(
        and(
          or(eq(eventNicknames.id, nicknameId), eq(eventNicknames.label, nicknameId)),
          eq(eventNicknames.userId, userId),
          gt(eventNicknames.expiresAt, sql`now()`)
        )
      )
      .orderBy(desc(eventNicknames.expiresAt))
      .limit(1)
    if (!nickname) throw notFound('Кликуха не найдена', 'NICKNAME_NOT_FOUND')
    await getWallet(userId)
    await db.update(eventWallets).set({ activeNicknameId: nickname.id }).where(eq(eventWallets.userId, userId))
    return { nickname: nickname.label }
  }
  await getWallet(userId)
  await db.update(eventWallets).set({ activeNicknameId: null }).where(eq(eventWallets.userId, userId))
  return { nickname: null }
}

export async function nicknamesFor(userIds: string[]) {
  const unique = [...new Set(userIds)].slice(0, 200)
  const rows = unique.length
    ? await db
        .select({ userId: eventWallets.userId, id: eventNicknames.id, eventId: eventNicknames.eventId, label: eventNicknames.label, styleKey: eventNicknames.styleKey, expiresAt: eventNicknames.expiresAt })
        .from(eventWallets)
        .innerJoin(eventNicknames, eq(eventNicknames.id, eventWallets.activeNicknameId))
        .where(and(inArray(eventWallets.userId, unique), gt(eventNicknames.expiresAt, sql`now()`)))
    : []
  const byUser = new Map(
    rows.map((r) => [r.userId, { id: r.id, label: r.label, styleKey: r.styleKey, eventId: r.eventId, expiresAt: r.expiresAt.toISOString(), stateVersion: 0 }])
  )
  const serverTime = new Date()
  return {
    data: Object.fromEntries(unique.map((id) => [id, byUser.get(id) ?? null])),
    serverTime: serverTime.toISOString(),
    displayValidUntil: new Date(serverTime.getTime() + 60_000).toISOString()
  }
}

// ---------------------------------------------------------------- red pens & correctors

type Tool = 'red_pen' | 'corrector'
const revisionOf = contentRevision

export async function toolInventory(userId: string, tool: Tool) {
  const wallet = await getWallet(userId)
  return { data: { events: [{ id: config.event.id, balance: tool === 'red_pen' ? wallet.redPens : wallet.correctors, endsAt: eventEndsAt().toISOString() }] } }
}

export async function toolState(viewerId: string | null, tool: Tool, postIds: string[]) {
  const unique = [...new Set(postIds)].slice(0, 100)
  if (unique.length === 0) return { data: {}, serverTime: new Date().toISOString() }
  const [postRows, marks] = await Promise.all([
    db
      .select({ id: posts.id, content: posts.content })
      .from(posts)
      .where(and(inArray(posts.id, unique), isNull(posts.deletedAt))),
    db
      .select()
      .from(postMarks)
      // corrector marks fade after a day, red pen claims last until the event ends
      .where(
        and(
          inArray(postMarks.postId, unique),
          eq(postMarks.kind, tool),
          isNull(postMarks.canceledAt),
          tool === 'corrector' ? gt(postMarks.createdAt, sql`now() - interval '1 day'`) : undefined
        )
      )
      .orderBy(asc(postMarks.createdAt))
  ])
  const { briefs } = await loadBriefs(marks.map((m) => m.authorId))
  const data: Record<string, unknown> = {}
  for (const id of unique) {
    const post = postRows.find((p) => p.id === id)
    if (!post) {
      data[id] = null
      continue
    }
    const own = marks.filter((m) => m.postId === id && m.revision === revisionOf(post.content))
    const render = (m: (typeof marks)[number]) => ({
      id: m.id,
      eventId: m.eventId,
      start: m.start,
      end: m.end,
      createdAt: m.createdAt.toISOString(),
      endsAt: new Date(m.createdAt.getTime() + MARK_TTL_MS).toISOString(),
      isOwner: m.authorId === viewerId,
      actor: briefs.get(m.authorId) ?? null
    })
    const serverTime = new Date().toISOString()
    if (tool === 'corrector') {
      // how many the viewer already used on this post (the client allows 3)
      const used = own.filter((m) => m.authorId === viewerId).length
      data[id] = { revision: revisionOf(post.content), serverTime, events: eventsList().map((e) => ({ ...e, used })), marks: own.map(render) }
      continue
    }
    // one claim per user and post, holding up to RED_PEN_LIMIT corrections; its id is the id of its first correction
    const byAuthor = new Map<string, (typeof own)[number][]>()
    for (const m of own) byAuthor.set(m.authorId, [...(byAuthor.get(m.authorId) ?? []), m])
    const endsAt = eventEndsAt().toISOString()
    const claims = [...byAuthor.entries()].map(([authorId, list]) => {
      const actor = briefs.get(authorId)
      return {
        id: list[0]!.id,
        eventId: list[0]!.eventId,
        endsAt,
        used: list.length,
        limit: RED_PEN_LIMIT,
        isOwner: authorId === viewerId,
        actor: actor ? { id: actor.id, username: actor.username, displayName: actor.displayName } : null
      }
    })
    data[id] = {
      revision: revisionOf(post.content),
      serverTime,
      events: eventsList(),
      claim: claims.find((c) => c.isOwner) ?? claims[0] ?? null,
      claims,
      corrections: own.map((m) => ({
        id: m.id,
        start: m.start,
        end: m.end,
        replacement: m.replacement ?? '',
        createdAt: m.createdAt.toISOString(),
        createdAtMicros: m.createdAt.getTime() * 1000
      }))
    }
  }
  return { data, serverTime: new Date().toISOString() }
}

export async function applyTool(userId: string, tool: Tool, input: { postId: string; eventId?: string; revision: string; start: number; end: number; replacement?: string }) {
  const [post] = await db.select().from(posts).where(eq(posts.id, input.postId))
  if (!post || post.deletedAt) throw notFound('Post not found')
  if (revisionOf(post.content) !== input.revision) throw new ApiError(409, 'STALE_REVISION', 'Пост изменился. Обновите страницу')
  if (post.authorId === userId) throw forbidden(tool === 'red_pen' ? 'Свой пост исправлять нельзя' : 'Свой пост закрашивать нельзя')
  const length = post.content.length
  if (input.start < 0 || input.end <= input.start || input.end > length) throw badRequest('Некорректный фрагмент текста', 'INVALID_RANGE')

  const active = await db
    .select()
    .from(postMarks)
    .where(and(eq(postMarks.postId, post.id), eq(postMarks.revision, input.revision), isNull(postMarks.canceledAt)))
  const marks = active.filter((m) => m.kind === 'corrector' && m.createdAt.getTime() > Date.now() - MARK_TTL_MS)
  const corrections = active.filter((m) => m.kind === 'red_pen')
  const partly = (m: { start: number; end: number }) => m.start < input.end && m.end > input.start && (m.start !== input.start || m.end !== input.end)
  checkToolRange(tool, post, input, { marks, corrections, partly, userId })

  return db.transaction(async (tx) => {
    const column = tool === 'red_pen' ? eventWallets.redPens : eventWallets.correctors
    await tx.insert(eventWallets).values({ userId }).onConflictDoNothing()
    // the wallet row lock also serializes the claim check below
    await tx.select({ userId: eventWallets.userId }).from(eventWallets).where(eq(eventWallets.userId, userId)).for('update')

    // a red pen opens a claim on the post: up to RED_PEN_LIMIT corrections for one pen
    const claim =
      tool === 'red_pen'
        ? await tx
            .select({ id: postMarks.id })
            .from(postMarks)
            .where(
              and(
                eq(postMarks.postId, post.id),
                eq(postMarks.kind, 'red_pen'),
                eq(postMarks.authorId, userId),
                eq(postMarks.revision, input.revision),
                isNull(postMarks.canceledAt)
              )
            )
            .orderBy(asc(postMarks.createdAt))
        : []
    if (claim.length >= RED_PEN_LIMIT) throw badRequest(`Вы уже исправили ${RED_PEN_LIMIT} слов`, 'RED_PEN_LIMIT')
    if (tool === 'corrector') {
      const [{ used }] = await tx
        .select({ used: sql<number>`count(*)::int` })
        .from(postMarks)
        .where(
          and(
            eq(postMarks.postId, post.id),
            eq(postMarks.kind, 'corrector'),
            eq(postMarks.authorId, userId),
            eq(postMarks.revision, input.revision),
            isNull(postMarks.canceledAt),
            gt(postMarks.createdAt, sql`now() - interval '1 day'`)
          )
        )
      if (used >= CORRECTOR_LIMIT) throw badRequest(`На этом посте вы уже использовали ${CORRECTOR_LIMIT} корректора`, 'CORRECTOR_LIMIT')
    }
    if (claim.length === 0) {
      const [wallet] = await tx
        .update(eventWallets)
        .set({ [tool === 'red_pen' ? 'redPens' : 'correctors']: sql`${column} - 1` })
        .where(and(eq(eventWallets.userId, userId), sql`${column} > 0`))
        .returning()
      if (!wallet) throw badRequest(tool === 'red_pen' ? 'Нет красных ручек' : 'Нет корректоров', 'INSUFFICIENT_BALANCE')
    }
    const [mark] = await tx
      .insert(postMarks)
      .values({
        postId: post.id,
        kind: tool,
        authorId: userId,
        eventId: input.eventId ?? config.event.id,
        revision: input.revision,
        start: input.start,
        end: input.end,
        replacement: tool === 'red_pen' ? input.replacement!.slice(0, 200) : null
      })
      .returning()
    return { success: true, id: mark!.id, claimId: claim[0]?.id ?? mark!.id }
  })
}

/*
 * The same rules as the web client applies before sending (its messages too): a red pen replaces one whole word
 * with another word of up to 10 letters, a corrector paints 1-10 non-space characters.
 */
const WORD = /^[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*$/u
const WORD_CHAR = /[\p{L}\p{M}\p{N}_'’-]/u
const MAX_WORD = 10
const graphemes = new Intl.Segmenter('ru', { granularity: 'grapheme' })
const graphemeCount = (text: string) => [...graphemes.segment(text)].length

type MarkRow = typeof postMarks.$inferSelect
function checkToolRange(
  tool: Tool,
  post: { content: string; spans: { type: string; offset: number; length: number }[] },
  input: { start: number; end: number; replacement?: string },
  state: { marks: MarkRow[]; corrections: MarkRow[]; partly: (m: MarkRow) => boolean; userId: string }
) {
  const selected = post.content.slice(input.start, input.end)
  const invalid = (message: string) => badRequest(message, 'INVALID_RANGE')
  if (tool === 'corrector') {
    const count = [...graphemes.segment(selected)].filter((g) => !/^\s+$/u.test(g.segment)).length
    if (count < 1 || count > 10) throw invalid('Выберите от 1 до 10 символов без учёта пробелов')
    if (state.marks.some((m) => m.authorId === state.userId && m.start === input.start && m.end === input.end)) throw invalid('Вы уже закрасили этот фрагмент')
    if (state.marks.some(state.partly)) throw invalid('Выделите весь закрашенный фрагмент')
    if (state.corrections.some(state.partly)) throw invalid('Выделите всё исправленное слово')
    return
  }
  if (!WORD.test(selected)) throw invalid('Выделите одно слово без пробелов')
  const before = Array.from(post.content.slice(0, input.start)).at(-1) ?? ''
  const after = Array.from(post.content.slice(input.end))[0] ?? ''
  if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) throw invalid('Выделите слово целиком')
  const hidden = ['link', 'mention', 'hashtag', 'spoiler']
  if (post.spans.some((s) => hidden.includes(s.type) && s.offset < input.end && s.offset + s.length > input.start)) {
    throw invalid('Ссылки, упоминания и скрытый текст исправлять нельзя')
  }
  if (state.marks.some(state.partly)) throw invalid('Выделите весь закрашенный фрагмент')
  if (state.corrections.some(state.partly)) throw invalid('Выделите всё исправленное слово')

  const replacement = input.replacement ?? ''
  const sameRange = state.corrections.filter((m) => m.start === input.start && m.end === input.end)
  if (sameRange.some((m) => m.replacement === replacement)) throw invalid('Это слово уже так исправлено')
  if (!WORD.test(replacement)) throw badRequest('Введите одно слово без пробелов', 'INVALID_REPLACEMENT')
  if (graphemeCount(replacement) > MAX_WORD) throw badRequest(`Не больше ${MAX_WORD} символов`, 'INVALID_REPLACEMENT')
  if (!sameRange.length && replacement.normalize('NFC') === selected.normalize('NFC')) throw badRequest('Введите другое слово', 'INVALID_REPLACEMENT')
}

export async function cancelTool(userId: string, tool: Tool, postId: string, markId?: string) {
  // a red pen claim is all corrections of its author on the post
  let claimAuthor: string | undefined
  if (tool === 'red_pen' && markId) {
    const [mark] = await db.select({ authorId: postMarks.authorId }).from(postMarks).where(and(eq(postMarks.id, markId), eq(postMarks.postId, postId)))
    if (!mark) throw notFound('Правка не найдена', 'MARK_NOT_FOUND')
    claimAuthor = mark.authorId
  }
  const rows = await db
    .update(postMarks)
    .set({ canceledAt: new Date() })
    .where(
      and(
        eq(postMarks.postId, postId),
        eq(postMarks.kind, tool),
        isNull(postMarks.canceledAt),
        claimAuthor ? eq(postMarks.authorId, claimAuthor) : markId ? eq(postMarks.id, markId) : undefined,
        // the post author may clean up marks of others, everyone else only their own
        sql`(${postMarks.authorId} = ${userId} or exists (select 1 from posts p where p.id = ${postMarks.postId} and p.author_id = ${userId}))`
      )
    )
    .returning({ id: postMarks.id })
  if (rows.length === 0) throw notFound('Правка не найдена', 'MARK_NOT_FOUND')
  return { success: true, canceled: rows.length }
}

export async function reportTool(tool: Tool, postId: string, markId: string) {
  const [mark] = await db
    .update(postMarks)
    .set({ reportsCount: sql`${postMarks.reportsCount} + 1` })
    .where(and(eq(postMarks.id, markId), eq(postMarks.postId, postId), eq(postMarks.kind, tool)))
    .returning()
  if (!mark) throw notFound('Правка не найдена', 'MARK_NOT_FOUND')
  if (mark.reportsCount >= 3 && !mark.canceledAt) await db.update(postMarks).set({ canceledAt: new Date() }).where(eq(postMarks.id, markId))
  return { success: true }
}

// ---------------------------------------------------------------- waste paper

/** A post can be handed to the waste-paper collection once per user, for one coin */
export async function recyclePost(userId: string, postId: string) {
  const [post] = await db.select({ id: posts.id }).from(posts).where(and(eq(posts.id, postId), isNull(posts.deletedAt)))
  if (!post) throw notFound('Post not found')
  const first = await redis.set(rk('event', 'recycled', userId, postId), 1, 'EX', 60 * 60 * 24 * 60, 'NX')
  if (first !== 'OK') throw new ApiError(409, 'ALREADY_RECYCLED', 'Этот пост уже сдан в макулатуру')
  await getWallet(userId)
  const [wallet] = await db
    .update(eventWallets)
    .set({ balance: sql`${eventWallets.balance} + 1` })
    .where(eq(eventWallets.userId, userId))
    .returning()
  return { success: true, reward: 1, balance: wallet!.balance }
}

// ---------------------------------------------------------------- post notebooks

export async function notebookInventory(userId: string) {
  const wallet = await getWallet(userId)
  return { data: { eventId: config.event.id, applicationsEnabled: eventActive(), balance: { grid: wallet.notebookGrid, ruled: wallet.notebookRuled } } }
}

export async function ownsEventItem(userId: string, kind: EventItemKind) {
  const [row] = await db
    .select({ id: eventItems.id })
    .from(eventItems)
    .where(and(eq(eventItems.userId, userId), eq(eventItems.kind, kind), isNull(eventItems.usedAt)))
    .limit(1)
  return !!row
}
