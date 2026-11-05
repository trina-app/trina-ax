// A profile photo (server/src/auth/avatar.ts): a JPEG is stored up to its end-of-image marker. Bytes appended after it
// are not part of the picture and could carry anything (a second file, text, the place a photo was taken).
import { expect, test } from 'bun:test'
import { prepareAvatar } from '../../server/src/auth/avatar'
import { makeJpeg } from '../lib/images'

/** makeJpeg's header (up to the frame), then one scan with stuffed bytes and a restart marker, the end, and a tail. */
function jpegWithTail(tail: string): Uint8Array {
  const head = makeJpeg(64, 64)
  const frameEnd = head.findIndex((_, i) => head[i] === 0xff && head[i + 1] === 0xd9)
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]
  const scan = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff]
  return new Uint8Array([...head.subarray(0, frameEnd), ...sos, ...scan, 0xff, 0xd9, ...new TextEncoder().encode(tail)])
}

test('a JPEG avatar is cut at its end-of-image marker; the picture data stays whole', () => {
  const r = prepareAvatar(jpegWithTail('TRAILING-SECRET-DATA'), 'image/jpeg')
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const out = Buffer.from(r.bytes)
  expect(out.includes(Buffer.from('TRAILING-SECRET'))).toBe(false)
  expect([...out.subarray(-2)]).toEqual([0xff, 0xd9])
  expect(out.includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]))).toBe(true)
  // the EXIF-like APP1 of the header is gone as before
  expect(out.includes(Buffer.from('Exif'))).toBe(false)
})

test('a JPEG whose scan never ends is refused', () => {
  const cut = jpegWithTail('')
  expect(prepareAvatar(cut.subarray(0, cut.length - 2), 'image/jpeg')).toEqual({ ok: false, problem: 'broken' })
})
