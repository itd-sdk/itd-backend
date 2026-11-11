import { describe, expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'
import { decodeKeyset, encodeKeyset, parseOffset } from '../src/lib/cursor'
import { bannerDrawingPng, DrawingError, parseBannerDrawing, renderDrawing } from '../src/lib/drawing'
import { normalizeIp } from '../src/lib/ip'
import { signAccessToken, TokenVerificationError, verifyAccessToken } from '../src/lib/jwt'
import { sniff } from '../src/lib/media'
import { isValidPassword } from '../src/lib/password'
import {
  buildSpans,
  containsBannedWord,
  extractHashtags,
  extractMentions,
  isSingleEmoji,
  sanitizeSpans,
  validateDisplayName,
  validateUsername
} from '../src/lib/text'
import { lastSeenFrom } from '../src/lib/time'
import { parseUserAgent } from '../src/lib/useragent'
import { issueViewToken, readViewToken } from '../src/lib/view-token'
import { PNG_1x1 } from './helpers'

describe('text', () => {
  test('hashtags: unicode, case-insensitive, offsets in UTF-16 units', () => {
    const tags = extractHashtags('Привет #ИТД и #sdk_2026! #123 a#b')
    expect(tags.map((t) => t.value)).toEqual(['итд', 'sdk_2026'])
    expect(tags[0]).toMatchObject({ offset: 7, length: 4 })
  })

  test('mentions follow username rules', () => {
    expect(extractMentions('hi @alice, @bo, mail@x.com @Bob_1').map((m) => m.value)).toEqual(['alice', 'bob_1'])
  })

  test('spans: aliases, bounds, link urls', () => {
    const ok = sanitizeSpans('hello world', [
      { offset: 0, length: 5, type: 'bold' },
      { offset: 6, length: 5, type: 'text_link', url: 'https://итд.com' },
      { offset: 0, length: 1, type: 'hashtag' }
    ])
    expect(ok.error).toBeUndefined()
    expect(ok.spans).toEqual([
      { offset: 0, length: 5, type: 'bold' },
      { offset: 6, length: 5, type: 'link', url: 'https://итд.com' }
    ])
    expect(sanitizeSpans('hi', [{ offset: 1, length: 5, type: 'bold' }]).error).toBeDefined()
    expect(sanitizeSpans('hi', [{ offset: 0, length: 2, type: 'link', url: 'javascript:alert(1)' }]).error).toBeDefined()
    expect(sanitizeSpans('hi', [{ offset: 0, length: 2, type: 'blink' }]).error).toBeDefined()
  })

  test('generated spans are merged and sorted', () => {
    const spans = buildSpans([{ offset: 10, length: 2, type: 'bold' }], [{ offset: 0, length: 4, value: 'abc' }], [{ offset: 5, length: 4, value: 'bob' }])
    expect(spans.map((s) => s.type)).toEqual(['hashtag', 'mention', 'bold'])
  })

  test('usernames, display names, emoji avatars', () => {
    expect(validateUsername('alice_01')).toBeNull()
    expect(validateUsername('1alice')).not.toBeNull()
    expect(validateUsername('al')).not.toBeNull()
    expect(validateUsername('alice_')).not.toBeNull()
    expect(validateUsername('ali__ce')).not.toBeNull()
    expect(validateUsername('алиса')).not.toBeNull()
    expect(validateDisplayName('  Алиса 🦊 ')).toBeNull()
    expect(validateDisplayName('a​b')).toBe('Name contains invalid invisible characters')
    expect(validateDisplayName('...')).not.toBeNull()
    expect(isSingleEmoji('🐱')).toBe(true)
    expect(isSingleEmoji('👨‍👩‍👧')).toBe(true)
    expect(isSingleEmoji('🇷🇺')).toBe(true)
    expect(isSingleEmoji('🐱🐶')).toBe(false)
    expect(isSingleEmoji('a')).toBe(false)
  })

  test('banned words match whole words, ignoring case and ё', () => {
    expect(containsBannedWord('Это ЁЛКА!', ['елка'])).toBe(true)
    expect(containsBannedWord('ёлкапалка', ['елка'])).toBe(false)
  })

  test('password policy', () => {
    expect(isValidPassword('correct-horse')).toBe(true)
    expect(isValidPassword('short')).toBe(false)
    expect(isValidPassword('пароль-кириллицей')).toBe(false)
  })
})

describe('tokens', () => {
  test('access token round trip and failures', () => {
    const { token, claims } = signAccessToken({ userId: '01a106bf-5009-7739-b8bf-d2040f54bb8b', sessionId: '01a106bf-5009-7739-b8bf-d2040f54bb8c', roles: ['user'] })
    expect(verifyAccessToken(token)).toMatchObject({ sub: claims.sub, sid: claims.sid, iss: 'auth-service', isActive: true })
    const reason = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return (error as TokenVerificationError).reason
      }
    }
    expect(reason(() => verifyAccessToken(token, Date.now() + 3600_000))).toBe('expired')
    expect(reason(() => verifyAccessToken(token.slice(0, -2) + 'xx'))).toBe('invalid_signature')
    expect(reason(() => verifyAccessToken('nope'))).toBe('malformed')
    const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    expect(reason(() => verifyAccessToken(`${none}.${token.split('.')[1]}.`))).toBe('unsupported_alg')
  })

  test('view tokens are bound to post and viewer', () => {
    const post = '01a106bf-5009-7739-b8bf-d2040f54bb8b'
    const viewer = '01a106bf-5009-7739-b8bf-d2040f54bb8c'
    const token = issueViewToken(post, viewer)
    expect(readViewToken(token)).toMatchObject({ postId: post, viewerId: viewer })
    expect(readViewToken(issueViewToken(post, null))?.viewerId).toBeNull()
    expect(readViewToken(token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBeNull()
  })

  test('keyset cursors', () => {
    const key = { t: new Date('2026-01-30T12:58:14.228Z'), id: '01a106bf-5009-7739-b8bf-d2040f54bb8b' }
    expect(decodeKeyset(encodeKeyset(key))).toEqual(key)
    expect(decodeKeyset('0')).toBeNull()
    expect(decodeKeyset('garbage!')).toBeNull()
    expect(parseOffset('20')).toBe(20)
    expect(parseOffset('-3')).toBe(0)
  })
})

describe('environment helpers', () => {
  test('user agents', () => {
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0')).toMatchObject({
      deviceType: 'desktop',
      osName: 'Windows',
      osVersion: 10,
      clientName: 'Firefox',
      clientVersion: '140.0'
    })
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36')).toMatchObject({
      deviceType: 'mobile',
      osName: 'Android',
      osVersion: 14
    })
    expect(parseUserAgent('itd-sdk/2.10.0 (Python/3.11)').clientName).toBe('itd-sdk')
  })

  test('ip normalization keeps IPv4 for clients that expect it', () => {
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3')
    expect(normalizeIp('::1')).toBe('127.0.0.1')
    expect(normalizeIp(undefined)).toBe('127.0.0.1')
  })

  test('last seen buckets', () => {
    const now = Date.now()
    expect(lastSeenFrom(new Date(now - 10_000), now)?.unit).toBe('just_now')
    expect(lastSeenFrom(new Date(now - 5 * 60_000), now)).toEqual({ unit: 'minutes', value: 5 })
    expect(lastSeenFrom(new Date(now - 3 * 3600_000), now)).toEqual({ unit: 'hours', value: 3 })
    expect(lastSeenFrom(new Date(now - 3 * 86400_000), now)?.unit).toBe('this_week')
    expect(lastSeenFrom(new Date(now - 90 * 86400_000), now)?.unit).toBe('long_ago')
    expect(lastSeenFrom(null)).toBeNull()
  })

  test('media sniffing ignores the declared type', () => {
    expect(sniff(PNG_1x1, 'video/mp4')).toMatchObject({ kind: 'image', mime: 'image/png', width: 1, height: 1 })
    expect(sniff(Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000hello'))).toMatchObject({ kind: 'audio', mime: 'audio/mpeg' })
    expect(sniff(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull()
  })
})

describe('banner drawings', () => {
  const drawing = (ops: unknown[]) => ({ version: 1, width: 1100, height: 380, ops })
  const pixel = (pixels: Uint8Array, x: number, y: number) => [...pixels.subarray((y * 1100 + x) * 3, (y * 1100 + x) * 3 + 3)]

  test('strokes are painted as the client paints them', () => {
    const pixels = renderDrawing(
      parseBannerDrawing(
        drawing([
          { tool: 'brush', color: '#FF0000', width: 10, points: [[100, 100], [200, 100]] },
          { tool: 'rectangle', color: '#00FF00', width: 4, points: [[300, 50], [400, 150]] },
          { tool: 'circle', color: '#0000ff', width: 4, points: [[600, 200], [650, 200]] },
          { tool: 'brush', color: '#000', width: 20, points: [[900, 300]] },
          { tool: 'eraser', color: '#FF0000', width: 6, points: [[150, 90], [150, 110]] }
        ])
      )
    )
    expect(pixel(pixels, 120, 100)).toEqual([255, 0, 0])
    expect(pixel(pixels, 120, 110)).toEqual([255, 255, 255])
    // the round end reaches past the last point
    expect(pixel(pixels, 203, 100)).toEqual([255, 0, 0])
    // the eraser is white whatever its colour
    expect(pixel(pixels, 150, 100)).toEqual([255, 255, 255])
    // a rectangle is an outline, a circle goes around its first point
    expect(pixel(pixels, 350, 50)).toEqual([0, 255, 0])
    expect(pixel(pixels, 350, 100)).toEqual([255, 255, 255])
    expect(pixel(pixels, 600, 250)).toEqual([0, 0, 255])
    expect(pixel(pixels, 600, 200)).toEqual([255, 255, 255])
    // a single point is a dot
    expect(pixel(pixels, 905, 300)).toEqual([0, 0, 0])
  })

  test('clear starts over; strokes may leave the canvas', () => {
    const pixels = renderDrawing(
      parseBannerDrawing(
        drawing([
          { tool: 'brush', color: '#FF0000', width: 10, points: [[100, 100], [200, 100]] },
          { tool: 'clear' },
          { tool: 'line', color: '#000000', width: 6, points: [[-2000, 190], [3000, 190]] }
        ])
      )
    )
    expect(pixel(pixels, 120, 100)).toEqual([255, 255, 255])
    expect(pixel(pixels, 0, 190)).toEqual([0, 0, 0])
    expect(pixel(pixels, 1099, 190)).toEqual([0, 0, 0])
  })

  test('the result is a PNG of the banner size', () => {
    const { bytes, width, height } = bannerDrawingPng(drawing([{ tool: 'brush', color: '#007AFF', width: 8, points: [[10, 10], [500, 300]] }]))
    expect(sniff(bytes)).toEqual({ kind: 'image', mime: 'image/png', ext: 'png', width: 1100, height: 380 })
    expect([width, height]).toEqual([1100, 380])
    // IDAT follows the signature (8 bytes) and IHDR (25): length, type, data
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(Buffer.from(bytes.subarray(37, 41)).toString('latin1')).toBe('IDAT')
    expect(inflateSync(bytes.subarray(41, 41 + view.getUint32(33))).length).toBe(380 * (1 + 1100 * 3))
  })

  test('anything else is refused', () => {
    const stroke = { tool: 'brush', color: '#000000', width: 4, points: [[1, 1]] }
    const bad: unknown[] = [
      'data:image/png;base64,AAAA',
      { ...drawing([]), version: 2 },
      { ...drawing([]), width: 4000 },
      drawing([{ ...stroke, tool: 'image' }]),
      drawing([{ ...stroke, color: 'url(x)' }]),
      drawing([{ ...stroke, width: 0 }]),
      drawing([{ ...stroke, width: 5000 }]),
      drawing([{ ...stroke, points: [] }]),
      drawing([{ ...stroke, points: [[1, 'a']] }]),
      drawing([{ ...stroke, points: [[1e9, 1]] }]),
      drawing([{ ...stroke, points: [[Number.NaN, 1]] }]),
      drawing([{ ...stroke, tool: 'line' }]),
      drawing([{ ...stroke, points: Array.from({ length: 4097 }, () => [1, 1]) }]),
      drawing(Array.from({ length: 2001 }, () => stroke))
    ]
    for (const input of bad) expect(() => parseBannerDrawing(input)).toThrow(DrawingError)
    // far more painting than a drawing needs
    const heavy = drawing(Array.from({ length: 2000 }, () => ({ tool: 'line', color: '#000000', width: 200, points: [[0, 0], [1100, 380]] })))
    expect(() => bannerDrawingPng(heavy)).toThrow(DrawingError)
  })
})
