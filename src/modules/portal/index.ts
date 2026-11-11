import { Elysia, t } from 'elysia'
import { config } from '../../config'

// the «Ивент» tab of the web client: an active portal opens its url, otherwise «Нет активного ивента»
export const portalModule = new Elysia({ tags: ['Platform'] }).get(
  '/v1/portal',
  () => ({ active: config.portal.active && !!config.portal.url, title: config.portal.title, url: config.portal.url }),
  { response: t.Object({ active: t.Boolean(), title: t.String(), url: t.String() }) }
)
