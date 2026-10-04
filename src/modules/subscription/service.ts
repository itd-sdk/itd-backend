import { and, asc, desc, eq, lte, sql } from 'drizzle-orm'
import { config } from '../../config'
import { db } from '../../db/client'
import { paymentMethods, payments, pins, subscriptions, userPins } from '../../db/schema'
import { hmac, safeEqual } from '../../lib/crypto'
import { badRequest, notFound } from '../../lib/errors'
import { errorMeta, logger } from '../../lib/logger'
import { addDays, iso } from '../../lib/time'
import { isSubscriptionActive } from '../../services/users'

export const NUKSTA_PIN = 'nuksta'
const signature = (paymentId: string) => hmac(config.auth.jwtSecret, `payment:${paymentId}`).toString('base64url').slice(0, 32)

export function checkoutUrl(paymentId: string) {
  return `${config.publicUrl}/api/v1/subscription/checkout/${paymentId}?sig=${signature(paymentId)}`
}

export function verifyCheckoutSignature(paymentId: string, sig: string | undefined) {
  if (!sig || !safeEqual(signature(paymentId), sig)) throw badRequest('Invalid payment link', 'INVALID_SIGNATURE')
}

export async function getSubscription(userId: string) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1)
  const methods = await db.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.userId, userId))
  return {
    isActive: isSubscriptionActive(row?.expiresAt),
    expiresAt: iso(row?.expiresAt ?? null),
    autoRenewal: row?.autoRenewal ?? true,
    startedAt: iso(row?.startedAt ?? null),
    price: config.subscription.priceRub,
    currency: 'RUB',
    periodDays: config.subscription.periodDays,
    hasPaymentMethod: methods.length > 0
  }
}

export async function createPayment(userId: string, kind: 'subscription' | 'bind_card') {
  const amount = kind === 'subscription' ? config.subscription.priceRub * 100 : 100
  const [payment] = await db.insert(payments).values({ userId, kind, amount }).returning()
  return { paymentId: payment!.id, confirmationUrl: checkoutUrl(payment!.id), amount: amount / 100, currency: 'RUB' }
}

export async function findPayment(paymentId: string) {
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1)
  if (!payment) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND')
  return payment
}

async function ensureCard(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], userId: string) {
  const existing = await tx.select().from(paymentMethods).where(eq(paymentMethods.userId, userId)).orderBy(desc(paymentMethods.isDefault))
  if (existing.length) return existing[0]!
  const [card] = await tx
    .insert(paymentMethods)
    .values({ userId, brand: 'MIR', last4: String(1000 + Math.floor(Math.random() * 9000)), isDefault: true })
    .returning()
  return card!
}

/** Marks a payment as paid and applies its effect (mock acquiring: the checkout page confirms it) */
export async function completePayment(paymentId: string) {
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .update(payments)
      .set({ status: 'succeeded', paidAt: new Date() })
      .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')))
      .returning()
    if (!payment) return null
    const card = await ensureCard(tx, payment.userId)
    await tx.update(payments).set({ paymentMethodId: card.id }).where(eq(payments.id, payment.id))

    if (payment.kind === 'subscription' || payment.kind === 'renewal') {
      await extendSubscription(tx, payment.userId)
    }
    return payment
  })
}

async function extendSubscription(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], userId: string) {
  const [current] = await tx.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1)
  const base = current && current.expiresAt.getTime() > Date.now() ? current.expiresAt : new Date()
  const expiresAt = addDays(base, config.subscription.periodDays)
  await tx
    .insert(subscriptions)
    .values({ userId, expiresAt, autoRenewal: current?.autoRenewal ?? true })
    .onConflictDoUpdate({ target: subscriptions.userId, set: { expiresAt, updatedAt: new Date(), ...(current && !isSubscriptionActive(current.expiresAt) ? { startedAt: new Date() } : {}) } })
  const [pin] = await tx.select({ slug: pins.slug }).from(pins).where(eq(pins.slug, NUKSTA_PIN)).limit(1)
  if (pin) await tx.insert(userPins).values({ userId, pinSlug: NUKSTA_PIN }).onConflictDoNothing()
}

export async function setAutoRenewal(userId: string, enabled: boolean) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1)
  if (!row || !isSubscriptionActive(row.expiresAt)) return null
  await db.update(subscriptions).set({ autoRenewal: enabled, updatedAt: new Date() }).where(eq(subscriptions.userId, userId))
  return enabled
}

export async function listMethods(userId: string) {
  const rows = await db.select().from(paymentMethods).where(eq(paymentMethods.userId, userId)).orderBy(desc(paymentMethods.isDefault), asc(paymentMethods.createdAt))
  return rows.map((m) => ({
    id: m.id,
    type: 'card',
    brand: m.brand,
    last4: m.last4,
    title: `${m.brand} •••• ${m.last4}`,
    isDefault: m.isDefault,
    createdAt: m.createdAt.toISOString()
  }))
}

export async function setDefaultMethod(userId: string, methodId: string) {
  await db.transaction(async (tx) => {
    const [method] = await tx
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.id, methodId), eq(paymentMethods.userId, userId)))
    if (!method) throw notFound('Payment method not found', 'PAYMENT_METHOD_NOT_FOUND')
    await tx.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.userId, userId))
    await tx.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.id, methodId))
  })
}

export async function deleteMethod(userId: string, methodId: string) {
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(paymentMethods)
      .where(and(eq(paymentMethods.id, methodId), eq(paymentMethods.userId, userId)))
      .returning()
    if (!removed) throw notFound('Payment method not found', 'PAYMENT_METHOD_NOT_FOUND')
    if (removed.isDefault) {
      const [next] = await tx.select().from(paymentMethods).where(eq(paymentMethods.userId, userId)).orderBy(asc(paymentMethods.createdAt)).limit(1)
      if (next) await tx.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.id, next.id))
    }
  })
}

/** Job: charge the default card of expired subscriptions with auto-renewal (mock charge always succeeds) */
export async function renewDueSubscriptions() {
  const due = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.autoRenewal, true), lte(subscriptions.expiresAt, sql`now()`), sql`${subscriptions.expiresAt} > now() - interval '3 days'`))
    .limit(100)
  for (const sub of due) {
    try {
      const [card] = await db.select().from(paymentMethods).where(and(eq(paymentMethods.userId, sub.userId), eq(paymentMethods.isDefault, true))).limit(1)
      if (!card) {
        await db.update(subscriptions).set({ autoRenewal: false, updatedAt: new Date() }).where(eq(subscriptions.userId, sub.userId))
        continue
      }
      const [payment] = await db
        .insert(payments)
        .values({ userId: sub.userId, kind: 'renewal', amount: config.subscription.priceRub * 100, paymentMethodId: card.id })
        .returning()
      await completePayment(payment!.id)
    } catch (error) {
      logger.error('subscription renewal failed', { ...errorMeta(error), userId: sub.userId })
    }
  }
  return due.length
}
