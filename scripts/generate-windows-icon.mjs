import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = path.join(ROOT, 'build/icons/win')
const OUT_ICO = path.join(ROOT, 'build/icons/icon.ico')
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const VIEWBOX = 1024
const ART_SCALE = 1.06
const SUPERSAMPLE = 4

const COLORS = {
  background: [0xf7, 0xf7, 0xf4],
  border: [0xd8, 0xd8, 0xd2],
  mark: [0x11, 0x11, 0x11],
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function roundedRectContains(px, py, x, y, width, height, radius) {
  const cx = Math.max(x + radius, Math.min(px, x + width - radius))
  const cy = Math.max(y + radius, Math.min(py, y + height - radius))
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= radius * radius
}

function roundedRectStrokeContains(px, py, x, y, width, height, radius, strokeWidth) {
  const outer = strokeWidth / 2
  return (
    roundedRectContains(px, py, x - outer, y - outer, width + strokeWidth, height + strokeWidth, radius + outer) &&
    !roundedRectContains(px, py, x + outer, y + outer, width - strokeWidth, height - strokeWidth, radius - outer)
  )
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const lengthSq = vx * vx + vy * vy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSq))
  const dx = px - (ax + t * vx)
  const dy = py - (ay + t * vy)
  return Math.hypot(dx, dy)
}

function chevronContains(px, py) {
  const radius = 64
  return (
    distanceToSegment(px, py, 354, 296, 612, 512) <= radius ||
    distanceToSegment(px, py, 612, 512, 354, 728) <= radius
  )
}

function sampleIcon(x, y) {
  const ux = 512 + (x - 512) / ART_SCALE
  const uy = 512 + (y - 512) / ART_SCALE

  let color = null

  if (roundedRectContains(ux, uy, 64, 64, 896, 896, 220)) {
    color = COLORS.background
  }

  if (roundedRectStrokeContains(ux, uy, 64, 64, 896, 896, 220, 18)) {
    color = COLORS.border
  }

  if (chevronContains(ux, uy)) {
    color = COLORS.mark
  }

  const dx = ux - 724
  const dy = uy - 646
  if (dx * dx + dy * dy <= 72 * 72) {
    color = COLORS.mark
  }

  return color
}

function renderPng(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = SUPERSAMPLE * SUPERSAMPLE
  const viewScale = VIEWBOX / size

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let coverage = 0
      let red = 0
      let green = 0
      let blue = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const vx = (x + (sx + 0.5) / SUPERSAMPLE) * viewScale
          const vy = (y + (sy + 0.5) / SUPERSAMPLE) * viewScale
          const color = sampleIcon(vx, vy)

          if (color) {
            coverage += 1
            red += color[0]
            green += color[1]
            blue += color[2]
          }
        }
      }

      const offset = (y * size + x) * 4
      if (coverage === 0) {
        rgba[offset + 3] = 0
      } else {
        rgba[offset] = Math.round(red / coverage)
        rgba[offset + 1] = Math.round(green / coverage)
        rgba[offset + 2] = Math.round(blue / coverage)
        rgba[offset + 3] = Math.round((coverage / samples) * 255)
      }
    }
  }

  return encodePng(size, size, rgba)
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)

  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1)
    raw[row] = 0
    rgba.copy(raw, row + 1, y * stride, (y + 1) * stride)
  }

  const chunks = [
    chunk('IHDR', ihdr(width, height)),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]

  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks])
}

function ihdr(width, height) {
  const buffer = Buffer.alloc(13)
  buffer.writeUInt32BE(width, 0)
  buffer.writeUInt32BE(height, 4)
  buffer[8] = 8
  buffer[9] = 6
  buffer[10] = 0
  buffer[11] = 0
  buffer[12] = 0
  return buffer
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function encodeIco(entries) {
  const headerSize = 6 + entries.length * 16
  let offset = headerSize
  const header = Buffer.alloc(headerSize)

  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  entries.forEach((entry, index) => {
    const entryOffset = 6 + index * 16
    header[entryOffset] = entry.size === 256 ? 0 : entry.size
    header[entryOffset + 1] = entry.size === 256 ? 0 : entry.size
    header[entryOffset + 2] = 0
    header[entryOffset + 3] = 0
    header.writeUInt16LE(1, entryOffset + 4)
    header.writeUInt16LE(32, entryOffset + 6)
    header.writeUInt32LE(entry.png.length, entryOffset + 8)
    header.writeUInt32LE(offset, entryOffset + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, ...entries.map((entry) => entry.png)])
}

ensureDir(OUT_DIR)

const entries = SIZES.map((size) => {
  const png = renderPng(size)
  fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), png)
  return { size, png }
})

fs.writeFileSync(OUT_ICO, encodeIco(entries))

console.log(`Generated ${OUT_ICO}`)
console.log(`Generated PNG layers in ${OUT_DIR}`)
