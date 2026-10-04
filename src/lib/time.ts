export type LastSeen = { unit: 'just_now' | 'recently' | 'minutes' | 'hours' | 'this_week' | 'this_month' | 'long_ago'; value?: number | null }

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const ONLINE_WINDOW_MS = 5 * MINUTE

export function lastSeenFrom(date: Date | null, now = Date.now()): LastSeen | null {
  if (!date) return null
  const diff = Math.max(0, now - date.getTime())
  if (diff < MINUTE) return { unit: 'just_now', value: null }
  if (diff < HOUR) return { unit: 'minutes', value: Math.floor(diff / MINUTE) }
  if (diff < DAY) return { unit: 'hours', value: Math.floor(diff / HOUR) }
  if (diff < 7 * DAY) return { unit: 'this_week', value: null }
  if (diff < 30 * DAY) return { unit: 'this_month', value: null }
  return { unit: 'long_ago', value: null }
}

export const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null)

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY)
export const addSeconds = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000)

const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']

/** "13 мая" — the date format used by the official changelog */
export const ruDate = (date: Date) => `${date.getUTCDate()} ${MONTHS_RU[date.getUTCMonth()]}`
