import { Elysia, t } from 'elysia'
import { config } from '../../config'

export const portalModule = new Elysia({ tags: ['Platform'] })
  // the «Ивент» tab of the web client: an active portal opens its url, otherwise «Нет активного ивента»
  .get(
    '/v1/portal',
    () => ({ active: config.portal.active && !!config.portal.url, title: config.portal.title, url: config.portal.url }),
    { response: t.Object({ active: t.Boolean(), title: t.String(), url: t.String() }) }
  )
  // seasonal events of the official site (Alice AI, Halloween): the client asks whether one runs; openitd has none
  .get('/v1/event/status', () => ({ enabled: false }), { response: t.Object({ enabled: t.Boolean() }) })
  // the client checks the НУКСТА subscription after sign-in; openitd has no subscription (its features are open to all)
  .get('/v1/subscription/', () => ({ active: false }), { response: t.Object({ active: t.Boolean() }) })
