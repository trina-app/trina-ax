// HEIC / HEIF photos (QA R2-FMT-10): the file panel shows them through the server's JPEG (GET /api/files/preview),
// because browsers other than Safari cannot draw them.
import { describe, expect, test } from 'bun:test'
import { iconKind, previewKind, serverPreview } from '../../src/lib/preview'

describe('which files use the server preview', () => {
  test('HEIC / HEIF are images shown through the server JPEG', () => {
    for (const n of ['IMG_0001.HEIC', 'photo.heic', 'x.heif']) {
      expect(previewKind(n)).toBe('image')
      expect(serverPreview(n)).toBe(true)
      expect(iconKind(n)).toBe('image')
    }
  })
  test('other images use the file bytes', () => {
    for (const n of ['a.jpg', 'a.png', 'a.webp', 'a.gif', 'notes.txt']) expect(serverPreview(n)).toBe(false)
  })
})
