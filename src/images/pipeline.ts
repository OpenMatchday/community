import { createHash, randomUUID } from 'node:crypto'
import {
  IMAGE_MIME_ALLOWLIST,
  MAX_IMAGE_BYTES,
  type ImageMime,
} from '../config.js'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const sniffMime = (buf: Buffer): ImageMime | null => {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) {
    return 'image/png'
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

const looksLikeSvg = (buf: Buffer, declaredName: string): boolean => {
  const lower = declaredName.toLowerCase()
  if (lower.endsWith('.svg') || lower.endsWith('.svgz')) return true
  const head = buf.subarray(0, Math.min(buf.length, 256)).toString('utf8').toLowerCase()
  return head.includes('<svg') || head.includes('image/svg+xml')
}

const extForMime = (mime: ImageMime): string => {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png') return 'png'
  return 'webp'
}

/** Re-encode JPEG by dropping APP/COM segments (strips EXIF/XMP/ICC). */
const reencodeJpeg = (input: Buffer): Buffer => {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) {
    throw new Error('not jpeg')
  }
  const out: number[] = [0xff, 0xd8]
  let i = 2
  while (i + 3 < input.length) {
    if (input[i] !== 0xff) {
      throw new Error('jpeg marker sync lost')
    }
    while (i < input.length && input[i] === 0xff) i += 1
    if (i >= input.length) break
    const marker = input[i]
    i += 1
    if (marker === 0xd9) {
      out.push(0xff, 0xd9)
      break
    }
    if (marker === 0xda) {
      out.push(0xff, 0xda)
      const len = (input[i] << 8) | input[i + 1]
      out.push(...input.subarray(i, i + len))
      i += len
      out.push(...input.subarray(i))
      break
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      out.push(0xff, marker)
      continue
    }
    const len = (input[i] << 8) | input[i + 1]
    if (len < 2 || i + len > input.length) {
      throw new Error('jpeg segment length invalid')
    }
    const drop =
      (marker >= 0xe1 && marker <= 0xef) || // APP1-APP15 (EXIF/XMP/…)
      marker === 0xe0 || // APP0 JFIF rebuilt implicitly by remaining stream
      marker === 0xfe // COM
    if (!drop) {
      out.push(0xff, marker, ...input.subarray(i, i + len))
    }
    i += len
  }
  return Buffer.from(out)
}

/** Re-encode PNG keeping critical chunks only (drops tEXt/iTXt/zTXt/eXIf). */
const reencodePng = (input: Buffer): Buffer => {
  if (!input.subarray(0, 8).equals(PNG_SIG)) throw new Error('not png')
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS'])
  const parts: Buffer[] = [PNG_SIG]
  let offset = 8
  while (offset + 8 <= input.length) {
    const length = input.readUInt32BE(offset)
    const type = input.toString('ascii', offset + 4, offset + 8)
    const end = offset + 12 + length
    if (end > input.length) throw new Error('png chunk truncated')
    if (keep.has(type)) {
      parts.push(input.subarray(offset, end))
    }
    offset = end
    if (type === 'IEND') break
  }
  return Buffer.concat(parts)
}

/** Re-encode WebP RIFF by dropping EXIF/XMP chunks. */
const reencodeWebp = (input: Buffer): Buffer => {
  if (
    input.length < 12 ||
    input.toString('ascii', 0, 4) !== 'RIFF' ||
    input.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error('not webp')
  }
  const chunks: Buffer[] = []
  let offset = 12
  while (offset + 8 <= input.length) {
    const fourcc = input.toString('ascii', offset, offset + 4)
    const size = input.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    const dataEnd = dataStart + size
    if (dataEnd > input.length) throw new Error('webp chunk truncated')
    const padded = size + (size % 2)
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      chunks.push(input.subarray(offset, dataStart + padded))
    }
    offset = dataStart + padded
  }
  const body = Buffer.concat(chunks)
  const out = Buffer.alloc(12 + body.length)
  out.write('RIFF', 0, 4, 'ascii')
  out.writeUInt32LE(4 + body.length, 4)
  out.write('WEBP', 8, 4, 'ascii')
  body.copy(out, 12)
  return out
}

export type ProcessedImage = {
  mime: ImageMime
  filename: string
  bytes: Uint8Array
  sha256: string
  byteLength: number
}

export const processImageUpload = async (input: {
  bytes: Buffer
  declaredFilename?: string
  declaredMime?: string
}): Promise<{ ok: true; image: ProcessedImage } | { ok: false; error: string }> => {
  if (input.bytes.byteLength === 0) {
    return { ok: false, error: 'empty image' }
  }
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `image exceeds ${MAX_IMAGE_BYTES} byte limit`,
    }
  }
  if (looksLikeSvg(input.bytes, input.declaredFilename ?? '')) {
    return { ok: false, error: 'SVG images are rejected' }
  }
  if (
    input.declaredMime &&
    (input.declaredMime === 'image/svg+xml' ||
      !IMAGE_MIME_ALLOWLIST.includes(input.declaredMime as ImageMime))
  ) {
    return { ok: false, error: `MIME ${input.declaredMime} not allowed` }
  }

  const sniffed = sniffMime(input.bytes)
  if (!sniffed) {
    return { ok: false, error: 'unrecognized image magic bytes' }
  }
  if (
    input.declaredMime &&
    IMAGE_MIME_ALLOWLIST.includes(input.declaredMime as ImageMime) &&
    input.declaredMime !== sniffed
  ) {
    return { ok: false, error: 'declared MIME does not match file bytes' }
  }

  let encoded: Buffer
  try {
    if (sniffed === 'image/jpeg') encoded = reencodeJpeg(input.bytes)
    else if (sniffed === 'image/png') encoded = reencodePng(input.bytes)
    else encoded = reencodeWebp(input.bytes)
  } catch (err) {
    return { ok: false, error: `re-encode failed: ${String(err)}` }
  }

  if (encoded.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, error: 're-encoded image exceeds size limit' }
  }

  const filename = `${randomUUID()}.${extForMime(sniffed)}`
  const sha256 = createHash('sha256').update(encoded).digest('hex')
  return {
    ok: true,
    image: {
      mime: sniffed,
      filename,
      bytes: new Uint8Array(encoded),
      sha256,
      byteLength: encoded.byteLength,
    },
  }
}

export const rejectRemoteImageUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('//')
  ) {
    return 'remote image URLs are rejected'
  }
  return null
}
