import { eq, sql } from 'drizzle-orm'
import { config } from '../config'
import { hashPassword } from '../lib/password'
import { normalizeTelegram } from '../lib/telegram'
import { closeRedis } from '../redis'
import { closeDb, db } from './client'
import { accounts, announcements, appVersions, changelog, notificationSettings, pins, userPins, users } from './schema'

const PINS = [
  // the client draws a pin only from `url`; this GIF is mirrored with the web client (deploy/frontend)
  { slug: 'nuksta', name: 'НУКСТА', description: 'Подписчик НУКСТА', url: '/cdn/public/pins/nuksta.gif' },
  { slug: 'early', name: 'Первопроходец', description: 'Один из первых пользователей ИТД' },
  { slug: 'verified', name: 'Проверенный', description: 'Прошёл верификацию' },
  { slug: 'moderator', name: 'Модератор', description: 'Следит за порядком' },
  { slug: 'sdk', name: 'SDK', description: 'Разработчик клиента или SDK для ИТД' }
]

const APPS = [
  { name: 'android', minVersion: '1.0.0', latestVersion: '1.4.2', updateUrl: 'https://xn--d1ah4a.com/app/android' },
  { name: 'ios', minVersion: '1.0.0', latestVersion: '1.4.0', updateUrl: 'https://xn--d1ah4a.com/app/ios' }
]

const CHANGELOG = [
  { version: '1.2.0', date: '13 мая', changes: ['Опросы в постах', 'Закреплённые посты', 'Новые настройки приватности'] },
  { version: '1.1.0', date: '2 апреля', changes: ['Репосты с комментарием', 'Поиск по хэштегам'] },
  { version: '1.0.0', date: '1 марта', changes: ['Первый релиз'] }
]

export async function seedReferenceData() {
  for (const pin of PINS) {
    // a picture set by an admin is kept
    await db
      .insert(pins)
      .values(pin)
      .onConflictDoUpdate({ target: pins.slug, set: { url: sql`coalesce(${pins.url}, excluded.url)` } })
  }
  for (const app of APPS) await db.insert(appVersions).values(app).onConflictDoNothing()
  for (const [index, entry] of CHANGELOG.entries()) {
    await db
      .insert(changelog)
      .values({ ...entry, createdAt: new Date(Date.now() - index * 86400_000) })
      .onConflictDoNothing()
  }
  await db
    .insert(announcements)
    .values({
      id: 'welcome',
      title: 'Добро пожаловать в ИТД',
      description: 'Делитесь мыслями, находите свой клан и общайтесь.',
      buttons: [{ title: 'Понятно', style: 'primary', action: { type: 'dismiss' } }]
    })
    .onConflictDoNothing()
}

export async function seedAdmin() {
  const { telegram, password, username } = config.admin
  if (!telegram || !password) return null
  const normalized = normalizeTelegram(telegram)
  let [account] = await db.select().from(accounts).where(eq(accounts.telegram, normalized)).limit(1)
  if (!account) {
    ;[account] = await db
      .insert(accounts)
      .values({ telegram: normalized, passwordHash: await hashPassword(password), verifiedAt: new Date(), roles: ['user', 'admin'] })
      .returning()
  } else {
    await db.update(accounts).set({ roles: ['user', 'admin'] }).where(eq(accounts.id, account.id))
  }
  const [profile] = await db.select({ id: users.id }).from(users).where(eq(users.id, account!.id)).limit(1)
  if (!profile) {
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
    await db.insert(users).values({ id: account!.id, username: taken ? `${username}_${Date.now() % 10000}` : username, displayName: 'Администрация', avatar: '🛡️', verified: true })
    await db.insert(notificationSettings).values({ userId: account!.id }).onConflictDoNothing()
  }
  await db.insert(userPins).values({ userId: account!.id, pinSlug: 'moderator' }).onConflictDoNothing()
  return account!.id
}

if (import.meta.main) {
  await seedReferenceData()
  const adminId = await seedAdmin()
  console.log('reference data seeded', adminId ? `(admin ${adminId})` : '(set ADMIN_TELEGRAM / ADMIN_PASSWORD to create an admin)')
  await Promise.allSettled([closeDb(), closeRedis()])
}
