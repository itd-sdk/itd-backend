import { Elysia, t } from 'elysia'
import { config } from '../../config'
import { ApiError } from '../../lib/errors'
import { authPlugin } from '../../plugins/auth'
import { SuccessModel, Uuid } from '../../schemas'
import {
  completePayment,
  createPayment,
  deleteMethod,
  findPayment,
  getSubscription,
  listMethods,
  setAutoRenewal,
  setDefaultMethod,
  verifyCheckoutSignature
} from './service'

const PaymentLink = t.Object({ confirmationUrl: t.String(), paymentId: Uuid, amount: t.Number(), currency: t.String() })

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#111}button{font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#111;color:#fff;cursor:pointer}.muted{color:#666}</style>
</head><body>${body}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  )

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export const subscriptionModule = new Elysia({ prefix: '/v1/subscription', tags: ['Subscription'] })
  .use(authPlugin)

  .get('/', ({ me }) => getSubscription(me.id), {
    user: true,
    response: t.Object({
      isActive: t.Boolean(),
      expiresAt: t.Nullable(t.String()),
      autoRenewal: t.Boolean(),
      startedAt: t.Nullable(t.String()),
      price: t.Number(),
      currency: t.String(),
      periodDays: t.Integer(),
      hasPaymentMethod: t.Boolean()
    }),
    detail: { summary: 'НУКСТА subscription state' }
  })

  .post('/pay', ({ me }) => createPayment(me.id, 'subscription'), {
    user: true,
    response: PaymentLink,
    detail: { summary: 'Start a subscription payment; open confirmationUrl to pay' }
  })

  .post(
    '/auto-renewal',
    async ({ me, body }) => {
      const result = await setAutoRenewal(me.id, body.enabled)
      if (result === null) {
        // object form: the SDK cannot match string `error` bodies other than token / rate-limit ones
        throw new ApiError(404, 'NOT_FOUND', 'Активная подписка не найдена')
      }
      return { autoRenewal: result }
    },
    { user: true, body: t.Object({ enabled: t.Boolean() }), response: t.Object({ autoRenewal: t.Boolean() }) }
  )

  .post('/bind-card', ({ me }) => createPayment(me.id, 'bind_card'), {
    user: true,
    response: PaymentLink,
    detail: { summary: 'Bind a card (1 ₽ verification payment)' }
  })

  .get('/methods', async ({ me }) => ({ data: await listMethods(me.id) }), {
    user: true,
    response: t.Object({
      data: t.Array(
        t.Object({ id: Uuid, type: t.String(), brand: t.String(), last4: t.String(), title: t.String(), isDefault: t.Boolean(), createdAt: t.String() })
      )
    })
  })

  .post(
    '/methods/:method/default',
    async ({ me, params }) => {
      await setDefaultMethod(me.id, params.method)
      return { success: true }
    },
    { user: true, params: t.Object({ method: Uuid }), response: SuccessModel }
  )

  .delete(
    '/methods/:method',
    async ({ me, params }) => {
      await deleteMethod(me.id, params.method)
      return { success: true }
    },
    { user: true, params: t.Object({ method: Uuid }), response: SuccessModel }
  )

  // ------------------------------------------------------------ mock acquiring (replace with a real provider webhook)

  .get(
    '/checkout/:paymentId',
    async ({ params, query }) => {
      verifyCheckoutSignature(params.paymentId, query.sig)
      const payment = await findPayment(params.paymentId)
      if (payment.status !== 'pending') return page('Оплата', '<h2>Платёж уже обработан</h2>')
      const title = payment.kind === 'bind_card' ? 'Привязка карты' : `НУКСТА на ${config.subscription.periodDays} дней`
      const action = `/api/v1/subscription/checkout/${payment.id}/confirm?sig=${encodeURIComponent(query.sig!)}`
      return page(
        'Оплата',
        `<h2>${escapeHtml(title)}</h2><p class="muted">Тестовая оплата: деньги не списываются.</p><p>Сумма: <b>${payment.amount / 100} ₽</b></p>
<form method="post" action="${escapeHtml(action)}"><button type="submit">Оплатить</button></form>`
      )
    },
    { params: t.Object({ paymentId: Uuid }), query: t.Object({ sig: t.Optional(t.String({ maxLength: 64 })) }), detail: { hide: true } }
  )

  .post(
    '/checkout/:paymentId/confirm',
    async ({ params, query, request }) => {
      verifyCheckoutSignature(params.paymentId, query.sig)
      await findPayment(params.paymentId)
      const payment = await completePayment(params.paymentId)
      if (request.headers.get('accept')?.includes('application/json')) return Response.json({ success: !!payment })
      return page('Оплата', payment ? '<h2>Оплата прошла успешно</h2><p>Можно вернуться в ИТД.</p>' : '<h2>Платёж уже обработан</h2>')
    },
    { params: t.Object({ paymentId: Uuid }), query: t.Object({ sig: t.Optional(t.String({ maxLength: 64 })) }), detail: { hide: true } }
  )
