import { Elysia, t } from 'elysia'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { config } from '../../config'
import { db } from '../../db/client'
import { eventItems } from '../../db/schema'
import { authPlugin } from '../../plugins/auth'
import { Enum, Uuid } from '../../schemas'
import { requireTargetUser } from '../../services/users'
import {
  BACKPACK_KINDS,
  eventActive,
  applyTool,
  assertEventEnabled,
  breakWindow,
  buy,
  cancelTool,
  claimCurtains,
  claimDaily,
  donateCurtains,
  eraseSticker,
  eventEndsAt,
  getWallet,
  listNicknames,
  nicknamesFor,
  placeSticker,
  presentEventProfile,
  recyclePost,
  reportTool,
  setActiveNickname,
  setCurtains,
  SHOP,
  throwBalloon,
  toolInventory,
  toolState,
  placeCushion,
  claimCushion,
  notebookInventory,
  SHOP_INFO
} from './service'

const ProfileParams = t.Object({ id: t.String({ maxLength: 512 }) })
const Anchor = t.Object({ kind: Enum(['banner', 'profile_header', 'post']), id: t.Optional(t.Nullable(t.String({ maxLength: 64 }))) })
const SpotBody = t.Object({
  inventoryItemId: t.String({ maxLength: 64 }),
  x: t.Number(),
  y: t.Number(),
  angle: t.Optional(t.Number()),
  size: t.Optional(t.Number()),
  anchor: t.Optional(Anchor),
  // the web client sends the anchor flattened
  anchorKind: t.Optional(Enum(['banner', 'profile_header', 'post'])),
  anchorId: t.Optional(t.Nullable(t.String({ maxLength: 64 })))
})
const spotOf = (body: typeof SpotBody.static) => ({
  ...body,
  anchor: body.anchor ?? (body.anchorKind ? { kind: body.anchorKind, id: body.anchorId ?? null } : undefined)
})
const Ids = t.Object({ ids: t.String({ maxLength: 8000, description: 'Comma separated ids' }) })
const splitIds = (ids: string) => ids.split(',').map((id) => id.trim()).filter((id) => /^[0-9a-f-]{36}$/i.test(id))

const PlacementModel = t.Object({
  id: Uuid,
  kind: t.Literal('sticker'),
  asset: t.String(),
  x: t.Number(),
  y: t.Number(),
  z: t.Number(),
  size: t.Number(),
  angle: t.Number(),
  wear: t.Integer(),
  anchor: Anchor,
  createdAt: t.String(),
  createdBy: Uuid
})
const BalloonModel = t.Object({ id: Uuid, x: t.Number(), y: t.Number(), angle: t.Number(), thrownAt: t.String(), thrownBy: Uuid, expiresAt: t.String(), anchor: Anchor })
const EventProfileModel = t.Object({
  profileId: Uuid,
  rev: t.Integer(),
  window: t.Object({ broken: t.Boolean(), asset: t.Nullable(t.String()), brokenAt: t.Nullable(t.String()) }),
  curtains: t.Object({ fund: t.Integer(), goal: t.Integer(), hasCurtains: t.Boolean(), closed: t.Boolean() }),
  aura: t.Integer(),
  nickname: t.Nullable(t.String()),
  placements: t.Array(PlacementModel),
  balloons: t.Array(BalloonModel)
})

export const eventModule = new Elysia({ tags: ['Event'] })
  .use(authPlugin)

  .get('/v1/portal', () => ({ active: config.event.portalActive, title: config.event.portalTitle, url: config.event.portalUrl }), {
    response: t.Object({ active: t.Boolean(), title: t.String(), url: t.String() })
  })

  // the web client shows the event while `enabled` is true, so an event past EVENT_ENDS_AT reports false
  .get('/v1/event/status', () => ({ enabled: eventActive(), eventId: config.event.id, endsAt: eventEndsAt().toISOString() }), {
    response: t.Object({ enabled: t.Boolean(), eventId: t.String(), endsAt: t.String() })
  })

  // nicknames decorate posts, which guests see as well
  .get('/event-nicknames', ({ query }) => nicknamesFor(splitIds(query.ids)), { optionalUser: true, query: Ids })

  // ------------------------------------------------------------ wallet, shop, inventory

  .get('/v1/aliceai/balance', async ({ me }) => ({ balance: (await getWallet(me.id)).balance }), {
    user: true,
    response: t.Object({ balance: t.Integer() })
  })

  .get(
    '/v1/aliceai/inventory',
    async ({ me }) => {
      const items = await db
        .select({ id: eventItems.id, kind: eventItems.kind, asset: eventItems.asset })
        .from(eventItems)
        // only things that go into the backpack: one-off purchases (bell, aura analyzer…) are stored as items too
        .where(and(eq(eventItems.userId, me.id), isNull(eventItems.usedAt), inArray(eventItems.kind, BACKPACK_KINDS)))
        .orderBy(asc(eventItems.createdAt))
      return { items }
    },
    { user: true, response: t.Object({ items: t.Array(t.Object({ id: t.String(), kind: t.String(), asset: t.Nullable(t.String()) })) }) }
  )

  // shop cards shown by the web client (product info); old-style priced offers stay for itd-sdk
  .get('/v1/aliceai/shop', () => ({
    items: [
      ...SHOP_INFO.map((item) => ({ ...item, price: 0, isAvailable: eventActive() })),
      ...SHOP.map((item) => ({ ...item, details: '', bullets: [], isAvailable: eventActive() }))
    ]
  }), { user: true })

  .post(
    '/v1/aliceai/shop/:itemId/buy',
    ({ me, params }) => {
      assertEventEnabled()
      return buy(me.id, params.itemId)
    },
    { user: true, params: t.Object({ itemId: t.String({ maxLength: 32 }) }), detail: { summary: 'Buy an event item for coins' } }
  )

  .get('/v1/aliceai/nicknames', ({ me }) => listNicknames(me.id), { user: true })

  .put('/v1/aliceai/nicknames/active', ({ me, body }) => setActiveNickname(me.id, body.form ?? null), {
    user: true,
    body: t.Object({ form: t.Optional(t.Nullable(t.String({ maxLength: 64 }))) })
  })

  // ------------------------------------------------------------ profiles

  .get('/v1/aliceai/profiles/:id', async ({ params, me }) => presentEventProfile((await requireTargetUser(params.id, me)).id), {
    user: true,
    params: ProfileParams,
    response: EventProfileModel
  })

  .post(
    '/v1/aliceai/profiles/:id/claim',
    async ({ params, me }) => {
      assertEventEnabled()
      await requireTargetUser(params.id, me)
      return claimDaily(me.id)
    },
    { user: true, params: ProfileParams, detail: { summary: 'Daily coins reward' } }
  )

  .post(
    '/v1/aliceai/profiles/:id/placements',
    async ({ params, body, me }) => {
      assertEventEnabled()
      const target = await requireTargetUser(params.id, me)
      return placeSticker(me.id, target.id, body.inventoryItemId, spotOf(body))
    },
    { user: true, params: ProfileParams, body: SpotBody }
  )

  .post(
    '/v1/aliceai/profiles/:id/placements/:placementId/erase',
    async ({ params, body, me }) => {
      assertEventEnabled()
      const target = await requireTargetUser(params.id, me)
      return eraseSticker(me.id, target.id, params.placementId, body?.inventoryItemId)
    },
    {
      user: true,
      params: t.Object({ id: t.String({ maxLength: 512 }), placementId: Uuid }),
      body: t.Optional(t.Object({ inventoryItemId: t.Optional(t.String({ maxLength: 64 })) }))
    }
  )

  .post(
    '/v1/aliceai/profiles/:id/balloons',
    async ({ params, body, me }) => {
      assertEventEnabled()
      const target = await requireTargetUser(params.id, me)
      return throwBalloon(me.id, target.id, body.inventoryItemId, spotOf(body))
    },
    { user: true, params: ProfileParams, body: SpotBody, response: t.Object({ success: t.Boolean(), balloon: BalloonModel }) }
  )

  .post(
    '/v1/aliceai/profiles/:id/window/break',
    async ({ params, body, me }) => {
      assertEventEnabled()
      const target = await requireTargetUser(params.id, me)
      return breakWindow(me.id, target.id, body.inventoryItemId)
    },
    { user: true, params: ProfileParams, body: t.Object({ inventoryItemId: t.String({ maxLength: 64 }) }) }
  )

  .post(
    '/v1/aliceai/profiles/:id/cushion',
    async ({ params, body, me }) => {
      assertEventEnabled()
      const target = await requireTargetUser(params.id, me)
      return placeCushion(me.id, target.id, body.inventoryItemId, body)
    },
    {
      user: true,
      params: ProfileParams,
      body: t.Object({
        inventoryItemId: t.String({ maxLength: 64 }),
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
        anchorKind: t.Optional(t.String({ maxLength: 32 })),
        anchorId: t.Optional(t.Nullable(t.String({ maxLength: 64 })))
      })
    }
  )

  // called by every visitor of a profile: plays the cushion for the first one after it was hidden
  .post('/v1/aliceai/profiles/:id/cushion/claim', async ({ params, me }) => claimCushion(me.id, (await requireTargetUser(params.id, me)).id), {
    user: true,
    params: ProfileParams
  })

  .post(
    '/v1/aliceai/profiles/:id/curtains/donations',
    async ({ params, body, me }) => {
      assertEventEnabled()
      const target = await requireTargetUser(params.id, me)
      return donateCurtains(me.id, target.id, body.amount)
    },
    { user: true, params: ProfileParams, body: t.Object({ amount: t.Integer({ minimum: 1, maximum: 10000 }) }) }
  )

  .post(
    '/v1/aliceai/profiles/:id/curtains/claim',
    async ({ params, me }) => {
      assertEventEnabled()
      const target = await requireTargetUser(params.id, me)
      return claimCurtains(me.id, target.id)
    },
    { user: true, params: ProfileParams }
  )

  .put(
    '/v1/aliceai/profiles/:id/curtains',
    async ({ params, body, me }) => {
      const target = await requireTargetUser(params.id, me)
      return setCurtains(me.id, target.id, body.closed)
    },
    { user: true, params: ProfileParams, body: t.Object({ closed: t.Boolean() }) }
  )

  .post(
    '/v1/aliceai/waste-paper/posts/:id',
    async ({ params, me }) => {
      assertEventEnabled()
      return recyclePost(me.id, params.id)
    },
    { user: true, params: t.Object({ id: Uuid }), detail: { summary: 'Hand a post over to the waste-paper collection (coins once per post)' } }
  )

  .get('/post-notebooks/inventory', ({ me }) => notebookInventory(me.id), { user: true })

  // ------------------------------------------------------------ red pens & correctors

  .get('/red-pens/state', ({ me, query }) => toolState(me.id, 'red_pen', splitIds(query.ids)), { user: true, query: Ids })
  .get('/correctors/state', ({ me, query }) => toolState(me.id, 'corrector', splitIds(query.ids)), { user: true, query: Ids })
  .get('/red-pens/inventory', ({ me }) => toolInventory(me.id, 'red_pen'), { user: true })
  .get('/correctors/inventory', ({ me }) => toolInventory(me.id, 'corrector'), { user: true })

  .post(
    '/red-pens/apply',
    ({ me, body }) => {
      assertEventEnabled()
      return applyTool(me.id, 'red_pen', body)
    },
    {
      user: true,
      body: t.Object(
        {
          postId: Uuid,
          eventId: t.Optional(t.String()),
          revision: t.String({ maxLength: 64 }),
          start: t.Integer({ minimum: 0 }),
          end: t.Integer({ minimum: 1 }),
          replacement: t.String({ maxLength: 200 })
        },
        { additionalProperties: true }
      )
    }
  )
  .post(
    '/correctors/apply',
    ({ me, body }) => {
      assertEventEnabled()
      return applyTool(me.id, 'corrector', body)
    },
    {
      user: true,
      body: t.Object(
        { postId: Uuid, eventId: t.Optional(t.String()), revision: t.String({ maxLength: 64 }), start: t.Integer({ minimum: 0 }), end: t.Integer({ minimum: 1 }) },
        { additionalProperties: true }
      )
    }
  )
  .post('/red-pens/cancel', ({ me, body }) => cancelTool(me.id, 'red_pen', body.postId, body.claimId), {
    user: true,
    body: t.Object({ postId: Uuid, claimId: t.Optional(Uuid) })
  })
  .post('/correctors/cancel', ({ me, body }) => cancelTool(me.id, 'corrector', body.postId, body.markId), {
    user: true,
    body: t.Object({ postId: Uuid, markId: t.Optional(Uuid) })
  })
  .post('/red-pens/report', ({ body }) => reportTool('red_pen', body.postId, body.claimId), {
    user: true,
    body: t.Object({ postId: Uuid, claimId: Uuid, reason: t.Optional(t.String({ maxLength: 200 })) })
  })
  .post('/correctors/report', ({ body }) => reportTool('corrector', body.postId, body.markId), {
    user: true,
    body: t.Object({ postId: Uuid, markId: Uuid, reason: t.Optional(t.String({ maxLength: 200 })) })
  })
