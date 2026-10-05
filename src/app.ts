import { cors } from '@elysiajs/cors'
import { swagger } from '@elysiajs/swagger'
import { Elysia } from 'elysia'
import { config } from './config'
import { sqlClient } from './db/client'
import { authModule } from './modules/auth'
import { adminModule } from './modules/admin'
import { commentsModule } from './modules/comments'
import { dwellModule } from './modules/dwell'
import { eventModule } from './modules/event'
import { freeItemsModule } from './modules/event/free'
import { filesModule } from './modules/files'
import { hashtagsModule } from './modules/hashtags'
import { notificationsModule } from './modules/notifications'
import { platformModule } from './modules/platform'
import { postsModule } from './modules/posts'
import { reportsModule } from './modules/reports'
import { searchModule } from './modules/search'
import { usersModule } from './modules/users'
import { verificationModule } from './modules/verification'
import { uploadsModule } from './modules/uploads'
import { errorHandler } from './plugins/error-handler'
import { rateLimitPlugin } from './plugins/rate-limit'
import { redis } from './redis'

const TAGS = [
  { name: 'Auth', description: 'Sign-up, sign-in, tokens, sessions, QR login' },
  { name: 'Users', description: 'Profiles, privacy, follows, blocks, pins' },
  { name: 'Posts', description: 'Feeds, walls, posts, likes, reposts, polls' },
  { name: 'Comments', description: 'Comments and replies' },
  { name: 'Hashtags', description: 'Trending hashtags and hashtag feeds' },
  { name: 'Search', description: 'Users and hashtags search' },
  { name: 'Notifications', description: 'Notifications list, settings and SSE stream' },
  { name: 'Files', description: 'Media uploads' },
  { name: 'Reports', description: 'Content reports' },
  { name: 'Platform', description: 'App versions, changelog, announcements' },
  { name: 'Verification', description: 'Account verification requests' },
  { name: 'Dwell', description: 'View and interaction analytics' },
  { name: 'Event', description: 'Seasonal event (portal, aliceai)' },
  { name: 'Admin', description: 'Moderation tools' }
]

export function createApp() {
  const api = new Elysia({ prefix: '/api' })
    .use(authModule)
    .use(usersModule)
    .use(postsModule)
    .use(commentsModule)
    .use(hashtagsModule)
    .use(searchModule)
    .use(filesModule)
    .use(notificationsModule)
    .use(reportsModule)
    .use(platformModule)
    .use(verificationModule)
    .use(dwellModule)
    .use(eventModule)
    .use(freeItemsModule)
    .use(adminModule)

  return new Elysia({ serve: { idleTimeout: 120, maxRequestBodySize: config.storage.maxVideoSize + 1024 * 1024 } })
    .use(errorHandler)
    .use(
      cors({
        // without CORS_ORIGINS any origin is reflected in development only
        origin: config.corsOrigins.length ? config.corsOrigins : !config.isProduction,
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'X-Requested-With', 'Content-Encoding'],
        exposeHeaders: ['x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after']
      })
    )
    .use(
      swagger({
        path: '/swagger',
        exclude: ['/health', '/'],
        documentation: {
          info: {
            title: 'ITD API',
            version: '1.0.0',
            description: 'Backend clone of the ITD (итд.com) social network. Endpoints and models follow the itd-sdk contract. All API routes live under `/api`.'
          },
          tags: TAGS,
          components: {
            securitySchemes: {
              bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
              refreshCookie: { type: 'apiKey', in: 'cookie', name: config.auth.refreshCookieName }
            }
          }
        }
      })
    )
    .use(rateLimitPlugin)
    .use(uploadsModule)
    .get('/', () => ({ name: 'itd-backend', docs: '/swagger', api: '/api' }), { detail: { hide: true } })
    .get(
      '/health',
      async ({ set }) => {
        const [pg, rd] = await Promise.allSettled([sqlClient`select 1`, redis.ping()])
        const ok = pg.status === 'fulfilled' && rd.status === 'fulfilled'
        if (!ok) set.status = 503
        return { status: ok ? 'ok' : 'degraded', postgres: pg.status === 'fulfilled', redis: rd.status === 'fulfilled' }
      },
      { detail: { hide: true } }
    )
    .use(api)
}

export type App = ReturnType<typeof createApp>
