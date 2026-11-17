// An iPhone photo (HEIC / HEIF) attached in a message box: Chrome, Edge and Firefox cannot draw its bytes, so its
// square waits for the server's thumbnail (components/ChipThumb.tsx isLocalImage / isHeicName).
import { describe, expect, test } from 'bun:test'
import { isHeicName, isLocalImage } from '../../src/components/ChipThumb'

describe('pictures the browser draws itself', () => {
  test('a JPEG or PNG from this computer is drawn from its bytes', () => {
    expect(isLocalImage(new File([new Uint8Array(4)], 'shop.jpg', { type: 'image/jpeg' }))).toBe(true)
    expect(isLocalImage(new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' }))).toBe(true)
  })
  test('a HEIC or HEIF photo is not: it shows the server thumbnail once uploaded', () => {
    expect(isLocalImage(new File([new Uint8Array(4)], 'IMG_0001.HEIC', { type: 'image/heic' }))).toBe(false)
    expect(isLocalImage(new File([new Uint8Array(4)], 'IMG_0002.heif', { type: 'image/heif' }))).toBe(false)
    expect(isHeicName('IMG_0001.HEIC')).toBe(true)
    expect(isHeicName('photo.heic.pdf')).toBe(false)
  })
  test('a file that is not a picture is a chip', () => {
    expect(isLocalImage(new File(['x'], 'notes.txt', { type: 'text/plain' }))).toBe(false)
  })
})
