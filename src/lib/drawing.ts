import { deflateSync } from 'node:zlib'

/*
 * A banner drawn in the web client. Since November the client sends the strokes, not a picture:
 *   { version: 1, width: 1100, height: 380, ops: [{ tool, color, width, points: [[x, y], ...] }, ...] }
 * and the server paints them itself, so a banner made this way is always a drawing. Tools, as the client
 * paints them on its canvas (round caps and joins, white background):
 *   brush, eraser (white)   a polyline through the points
 *   line, rectangle         two points: the start and the end (opposite corners)
 *   circle                  two points: the centre and a point on the circle
 *   clear                   the white background again
 */

export const BANNER_WIDTH = 1100
export const BANNER_HEIGHT = 380

// the client's own limits
const MAX_OPS = 2000
const MAX_POINTS_PER_OP = 4096
const MAX_POINTS = 60_000
const MAX_LINE_WIDTH = 200
// pixels a drawing may touch while it is painted (a full repaint of the banner is 418 000): bounds the time
const WORK_BUDGET = 100_000_000

const TOOLS = ['brush', 'eraser', 'line', 'rectangle', 'circle'] as const
type Tool = (typeof TOOLS)[number]
type Point = readonly [number, number]
export type DrawingOp = { tool: 'clear' } | { tool: Tool; color: readonly [number, number, number]; width: number; points: Point[] }
export type Drawing = { width: number; height: number; ops: DrawingOp[] }

export class DrawingError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function parseColor(value: unknown): [number, number, number] {
  const match = typeof value === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value) : null
  if (!match) throw new DrawingError('Invalid color')
  const hex = match[1]!.length === 3 ? [...match[1]!].map((c) => c + c).join('') : match[1]!
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

/** Checks what the client sent; throws DrawingError with the reason */
export function parseBannerDrawing(input: unknown): Drawing {
  if (!isObject(input) || input.version !== 1) throw new DrawingError('Unsupported drawing version')
  if (input.width !== BANNER_WIDTH || input.height !== BANNER_HEIGHT) throw new DrawingError('Invalid drawing size')
  if (!Array.isArray(input.ops)) throw new DrawingError('Invalid drawing')
  if (input.ops.length > MAX_OPS) throw new DrawingError('Drawing is too complex')

  let total = 0
  const ops = input.ops.map((raw): DrawingOp => {
    if (!isObject(raw)) throw new DrawingError('Invalid stroke')
    if (raw.tool === 'clear') return { tool: 'clear' }
    if (!TOOLS.includes(raw.tool as Tool)) throw new DrawingError('Unknown tool')
    const tool = raw.tool as Tool
    const width = raw.width
    if (typeof width !== 'number' || !(width > 0) || width > MAX_LINE_WIDTH) throw new DrawingError('Invalid line width')
    if (!Array.isArray(raw.points) || raw.points.length === 0) throw new DrawingError('Invalid stroke')
    if (raw.points.length > MAX_POINTS_PER_OP) throw new DrawingError('Stroke is too complex')
    if (tool !== 'brush' && tool !== 'eraser' && raw.points.length !== 2) throw new DrawingError('Invalid shape')
    total += raw.points.length
    if (total > MAX_POINTS) throw new DrawingError('Drawing is too complex')
    const points = raw.points.map((point): Point => {
      if (!Array.isArray(point) || point.length !== 2) throw new DrawingError('Invalid point')
      const [x, y] = point as [unknown, unknown]
      // the client lets a stroke leave the canvas by two canvas sizes on each side
      const inRange = (v: unknown, size: number): v is number => typeof v === 'number' && v >= -2 * size && v <= 3 * size
      if (!inRange(x, BANNER_WIDTH) || !inRange(y, BANNER_HEIGHT)) throw new DrawingError('Invalid point')
      return [x, y]
    })
    // the eraser paints white whatever colour was selected
    return { tool, color: tool === 'eraser' ? [255, 255, 255] : parseColor(raw.color), width, points }
  })
  return { width: BANNER_WIDTH, height: BANNER_HEIGHT, ops }
}

/** Paints the drawing; returns RGB pixels, 3 bytes each, row by row */
export function renderDrawing(drawing: Drawing): Uint8Array {
  const { width, height } = drawing
  const pixels = new Uint8Array(width * height * 3).fill(255)
  // how much of each pixel the current stroke covers (0..255): overlapping pieces of one stroke do not add up
  const mask = new Uint8Array(width * height)
  let budget = WORK_BUDGET
  let dirty: { x0: number; y0: number; x1: number; y1: number } | null = null

  /** Rows and columns whose pixel centres can be within `reach` of the box; null when it misses the canvas */
  const clip = (minX: number, minY: number, maxX: number, maxY: number, reach: number) => {
    const x0 = Math.max(0, Math.floor(minX - reach))
    const y0 = Math.max(0, Math.floor(minY - reach))
    const x1 = Math.min(width - 1, Math.ceil(maxX + reach))
    const y1 = Math.min(height - 1, Math.ceil(maxY + reach))
    if (x0 > x1 || y0 > y1) return null
    budget -= (x1 - x0 + 1) * (y1 - y0 + 1)
    if (budget < 0) throw new DrawingError('Drawing is too complex')
    if (!dirty) dirty = { x0, y0, x1, y1 }
    else dirty = { x0: Math.min(dirty.x0, x0), y0: Math.min(dirty.y0, y0), x1: Math.max(dirty.x1, x1), y1: Math.max(dirty.y1, y1) }
    return { x0, y0, x1, y1 }
  }

  /** A line with round ends: every pixel closer than half the width to the segment */
  const segment = (a: Point, b: Point, radius: number) => {
    const box = clip(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), radius + 1)
    if (!box) return
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const lengthSquared = dx * dx + dy * dy
    // fully covered up to `inner` from the segment, not at all from `outer`, a soft edge between
    const inner = Math.max(0, radius - 0.5)
    const innerSquared = inner * inner
    const outerSquared = (radius + 0.5) * (radius + 0.5)
    for (let y = box.y0; y <= box.y1; y++) {
      const py = y + 0.5 - a[1]
      let index = y * width + box.x0
      for (let x = box.x0; x <= box.x1; x++, index++) {
        if (mask[index] === 255) continue
        const px = x + 0.5 - a[0]
        let along = lengthSquared ? (px * dx + py * dy) / lengthSquared : 0
        if (along < 0) along = 0
        else if (along > 1) along = 1
        const ox = px - along * dx
        const oy = py - along * dy
        const distanceSquared = ox * ox + oy * oy
        if (distanceSquared >= outerSquared) continue
        if (distanceSquared <= innerSquared) {
          mask[index] = 255
          continue
        }
        const value = Math.round(Math.min(1, radius + 0.5 - Math.sqrt(distanceSquared)) * 255)
        if (value > mask[index]!) mask[index] = value
      }
    }
  }

  const ring = (centre: Point, ringRadius: number, radius: number) => {
    const box = clip(centre[0] - ringRadius, centre[1] - ringRadius, centre[0] + ringRadius, centre[1] + ringRadius, radius + 1)
    if (!box) return
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        const index = y * width + x
        const cx = x + 0.5 - centre[0]
        const cy = y + 0.5 - centre[1]
        const coverage = radius + 0.5 - Math.abs(Math.sqrt(cx * cx + cy * cy) - ringRadius)
        if (coverage <= 0) continue
        const value = coverage >= 1 ? 255 : Math.round(coverage * 255)
        if (value > mask[index]!) mask[index] = value
      }
    }
  }

  for (const op of drawing.ops) {
    if (op.tool === 'clear') {
      pixels.fill(255)
      continue
    }
    const radius = op.width / 2
    const [first, second] = op.points as [Point, Point | undefined]
    if (op.tool === 'circle') {
      ring(first, Math.hypot(second![0] - first[0], second![1] - first[1]), radius)
    } else if (op.tool === 'rectangle') {
      const corners: Point[] = [first, [second![0], first[1]], second!, [first[0], second![1]]]
      corners.forEach((corner, i) => segment(corner, corners[(i + 1) % 4]!, radius))
    } else if (op.points.length === 1) {
      segment(first, first, radius)
    } else {
      for (let i = 1; i < op.points.length; i++) segment(op.points[i - 1]!, op.points[i]!, radius)
    }

    // the stroke goes onto the picture, and the mask is clean for the next one
    const area = dirty as { x0: number; y0: number; x1: number; y1: number } | null
    if (!area) continue
    for (let y = area.y0; y <= area.y1; y++) {
      for (let x = area.x0; x <= area.x1; x++) {
        const index = y * width + x
        const alpha = mask[index]!
        if (!alpha) continue
        mask[index] = 0
        for (let c = 0; c < 3; c++) {
          const at = index * 3 + c
          pixels[at] = alpha === 255 ? op.color[c]! : Math.round((op.color[c]! * alpha + pixels[at]! * (255 - alpha)) / 255)
        }
      }
    }
    dirty = null
  }
  return pixels
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(Buffer.from(type, 'latin1'), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** An 8-bit RGB PNG from pixels as renderDrawing returns them */
export function encodePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 2, 0, 0, 0], 8) // 8 bits per channel, RGB, no interlace
  // every row starts with its filter type: 0, the bytes as they are
  const rows = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array(0))
  ])
}

/** The PNG of a banner drawing sent by the client */
export function bannerDrawingPng(input: unknown) {
  const drawing = parseBannerDrawing(input)
  return { bytes: encodePng(renderDrawing(drawing), drawing.width, drawing.height), width: drawing.width, height: drawing.height }
}
