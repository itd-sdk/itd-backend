import type { FileKind } from '../db/schema'

export type SniffResult = { kind: FileKind; mime: string; ext: string; width?: number; height?: number }

const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length))
const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0

function jpegSize(b: Uint8Array) {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]!
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const length = u16be(b, i + 2)
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) }
    }
    i += 2 + length
  }
  return {}
}

function webpSize(b: Uint8Array) {
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8 ' && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X' && b.length >= 30) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  return {}
}

function ispeSize(b: Uint8Array) {
  const limit = Math.min(b.length - 16, 64 * 1024)
  for (let i = 4; i < limit; i++) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
      return { width: u32be(b, i + 8), height: u32be(b, i + 12) }
    }
  }
  return {}
}

/** Detects the real file type by magic bytes (the declared mime type is not trusted) */
export function sniff(bytes: Uint8Array, declaredMime = ''): SniffResult | null {
  const b = bytes
  if (b.length < 12) return null

  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg', ...jpegSize(b) }
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return { kind: 'image', mime: 'image/png', ext: 'png', width: u32be(b, 16), height: u32be(b, 20) }
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { kind: 'image', mime: 'image/gif', ext: 'gif', width: u16le(b, 6), height: u16le(b, 8) }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: 'webp', ...webpSize(b) }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', ext: 'wav' }

  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4)
    if (brand === 'avif' || brand === 'avis') return { kind: 'image', mime: 'image/avif', ext: 'avif', ...ispeSize(b) }
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return { kind: 'image', mime: 'image/heic', ext: 'heic', ...ispeSize(b) }
    if (brand === 'M4A ' || brand === 'M4B ' || declaredMime.startsWith('audio/')) return { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' }
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime', ext: 'mov' }
    return { kind: 'video', mime: 'video/mp4', ext: 'mp4' }
  }

  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return declaredMime.startsWith('audio/') ? { kind: 'audio', mime: 'audio/webm', ext: 'weba' } : { kind: 'video', mime: 'video/webm', ext: 'webm' }
  }
  if (ascii(b, 0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg', ext: 'ogg' }
  if (ascii(b, 0, 3) === 'ID3') return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' }
  if (b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return { kind: 'audio', mime: 'audio/aac', ext: 'aac' }
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' }
  return null
}
