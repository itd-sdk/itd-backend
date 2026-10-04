/** Keyset cursor `(createdAt, id)` encoded as an opaque url-safe string */
export type Keyset = { t: Date; id: string }

export function encodeKeyset(key: Keyset) {
  return Buffer.from(`${key.t.getTime()}_${key.id}`).toString('base64url')
}

export function decodeKeyset(cursor: string | undefined | null): Keyset | null {
  if (!cursor || cursor === '0') return null
  try {
    const [time, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('_')
    const t = new Date(Number(time))
    if (!id || Number.isNaN(t.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null
    return { t, id }
  } catch {
    return null
  }
}

/** Offset cursors: comments and popular feed pages */
export function parseOffset(cursor: string | number | undefined | null) {
  const value = Number.parseInt(String(cursor ?? '0'), 10)
  return Number.isFinite(value) && value > 0 ? value : 0
}
