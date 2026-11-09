// Draws the app icon (a page with a highlighted line) and writes build/icon.ico and build/icon.png.
// Run with: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const SAMPLES = 4
const inRect = (x, y, x1, y1, x2, y2) => x >= x1 && x <= x2 && y >= y1 && y <= y2

function inRounded(x, y, x1, y1, x2, y2, r) {
  if (!inRect(x, y, x1, y1, x2, y2)) return false
  const dx = Math.max(x1 + r - x, x - (x2 - r), 0)
  const dy = Math.max(y1 + r - y, y - (y2 - r), 0)
  return dx * dx + dy * dy <= r * r
}

const BACKGROUND = [47, 93, 80, 255]
const PAPER = [250, 248, 243, 255]
const FOLD = [196, 214, 206, 255]
const TEXT = [96, 108, 103, 255]
const MARKER = [245, 215, 66, 255]
const CLEAR = [0, 0, 0, 0]

/** Color at a point, with x and y from 0 to 1. Later checks are the layers on top. */
function colorAt(x, y) {
  if (!inRounded(x, y, 0.04, 0.04, 0.96, 0.96, 0.2)) return CLEAR
  if (!inRounded(x, y, 0.24, 0.13, 0.76, 0.87, 0.03)) return BACKGROUND
  const diagonal = x - y
  if (diagonal > 0.43) return BACKGROUND // the folded-away corner
  if (x > 0.6 && y < 0.3) return FOLD
  if (inRect(x, y, 0.3, 0.45, 0.7, 0.57)) {
    return inRect(x, y, 0.34, 0.49, 0.66, 0.53) ? TEXT : MARKER
  }
  if (inRect(x, y, 0.34, 0.35, 0.56, 0.39)) return TEXT
  if (inRect(x, y, 0.34, 0.63, 0.66, 0.67)) return TEXT
  if (inRect(x, y, 0.34, 0.73, 0.52, 0.77)) return TEXT
  return PAPER
}

function render(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size) // each row starts with a PNG filter byte
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let [r, g, b, a] = [0, 0, 0, 0]
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = colorAt((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size)
          r += c[0] * c[3]
          g += c[1] * c[3]
          b += c[2] * c[3]
          a += c[3]
        }
      }
      const at = py * (size * 4 + 1) + 1 + px * 4
      if (a > 0) {
        raw[at] = Math.round(r / a)
        raw[at + 1] = Math.round(g / a)
        raw[at + 2] = Math.round(b / a)
      }
      raw[at + 3] = Math.round(a / (SAMPLES * SAMPLES))
    }
  }
  return encodePng(size, raw)
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(size, raw) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bits per channel
  header[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = 6 + 16 * images.length
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16)
    entry[0] = size === 256 ? 0 : size
    entry[1] = size === 256 ? 0 : size
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    return entry
  })
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

const images = [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: render(size) }))
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'icon.ico'), encodeIco(images))
writeFileSync(join(out, 'icon.png'), images.at(-1).png)
console.log('icon written to', out)
