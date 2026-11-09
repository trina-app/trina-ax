// The image viewer's 복사 (web/src/lib/copyImage.ts): where it is offered (never a button that does nothing), what goes
// on the clipboard (a PNG as it is, anything else drawn as a PNG; the thumbnail or a smaller drawing said so), why a copy
// failed, a copy given up writing nothing, and the ⌘C / Ctrl+C key. The real drawing and the clipboard read back as image/png are in
// test/e2e/image-viewer.spec.ts (Chromium).
import { afterEach, describe, expect, test } from 'bun:test'
import { canCopyImage, copyImage, isAndroidWebView, isCopyKey, SAFE_CANVAS_AREA, SAFE_CANVAS_SIDE, type CopyImageEnv, type Drawn, type EncodePng } from '../../src/lib/copyImage'

/** A ClipboardItem as the browser has it: the types and their (promised) values. */
class FakeItem {
  static supports?: (type: string) => boolean
  constructor(readonly items: Record<string, string | Blob | PromiseLike<string | Blob>>) {}
}

/** A clipboard that reads each item's PNG as the browser does (awaits it), or refuses. */
function fakeClipboard(o: { refuse?: string } = {}) {
  const written: Blob[] = []
  return {
    written,
    write: async (items: ClipboardItems) => {
      if (o.refuse) throw new DOMException('refused', o.refuse)
      for (const item of items as unknown as FakeItem[]) written.push((await item.items['image/png']) as Blob)
    },
  }
}

const env = (clipboard: ReturnType<typeof fakeClipboard>, extra: Partial<CopyImageEnv> = {}): CopyImageEnv => ({ clipboard, ClipboardItem: FakeItem as unknown as CopyImageEnv['ClipboardItem'], ...extra })
const drawn = (width: number, height: number): Drawn => ({ img: {} as CanvasImageSource, width, height })
const pngBlob = (s = 'png') => new Blob([s], { type: 'image/png' })

/** An encoder that records each size asked and makes a PNG, or none above `maxArea` (a canvas too big). */
function encoder(maxArea = Infinity) {
  const asked: [number, number][] = []
  const encode: EncodePng = async (_d, w, h) => {
    asked.push([w, h])
    return w * h > maxArea ? null : new Blob([`${w}x${h}`], { type: 'image/png' })
  }
  return { asked, encode }
}

afterEach(() => {
  FakeItem.supports = undefined
})

describe('where 복사 is offered', () => {
  const clip = fakeClipboard()
  test('a page with the async clipboard and ClipboardItem', () => {
    expect(canCopyImage(env(clip))).toBe(true)
  })
  test('ClipboardItem.supports asked where the browser has it', () => {
    FakeItem.supports = (t) => t === 'image/png'
    expect(canCopyImage(env(clip))).toBe(true)
    FakeItem.supports = () => false
    expect(canCopyImage(env(clip))).toBe(false)
  })
  test('not without ClipboardItem (older Firefox), without the async clipboard (a plain http page), or without write', () => {
    expect(canCopyImage(env(clip, { ClipboardItem: null }))).toBe(false)
    expect(canCopyImage(env(clip, { clipboard: null }))).toBe(false)
    expect(canCopyImage({ clipboard: {} as Pick<Clipboard, 'write'>, ClipboardItem: FakeItem as unknown as CopyImageEnv['ClipboardItem'] })).toBe(false)
  })
  test('not in an Android WebView (the phone app\'s, an in-app browser\'s): it writes no picture', () => {
    expect(canCopyImage(env(clip, { androidWebView: true }))).toBe(false)
  })
  test('an Android WebView by its user agent; Chrome on Android, iOS and computers are none', () => {
    expect(isAndroidWebView('Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36')).toBe(true)
    expect(isAndroidWebView('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 KAKAOTALK 10.8.0')).toBe(true)
    expect(isAndroidWebView('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36')).toBe(false)
    expect(isAndroidWebView('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148')).toBe(false)
    expect(isAndroidWebView('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')).toBe(false)
  })
})

describe('what goes on the clipboard', () => {
  test('a PNG whose bytes the page has goes as it is: nothing is drawn', async () => {
    const clip = fakeClipboard()
    const enc = encoder()
    let picked = 0
    const own = pngBlob('the-file')
    const r = await copyImage({ blob: own, pick: async () => (picked++, { drawn: drawn(10, 10), thumb: false }) }, env(clip), enc.encode)
    expect(r).toEqual({ ok: true, smaller: null })
    expect(clip.written).toEqual([own])
    expect(picked).toBe(0)
    expect(enc.asked).toEqual([])
  })
  test('a JPEG, WebP or GIF (its bytes, or only its address) is drawn at its own size as a PNG', async () => {
    for (const blob of [new Blob(['j'], { type: 'image/jpeg' }), new Blob(['w'], { type: 'image/webp' }), new Blob(['g'], { type: 'image/gif' }), undefined]) {
      const clip = fakeClipboard()
      const enc = encoder()
      const r = await copyImage({ blob, pick: async () => ({ drawn: drawn(2880, 1800), thumb: false }) }, env(clip), enc.encode)
      expect(r).toEqual({ ok: true, smaller: null })
      expect(enc.asked).toEqual([[2880, 1800]])
      expect(clip.written).toHaveLength(1)
      expect(clip.written[0]!.type).toBe('image/png')
      expect(await clip.written[0]!.text()).toBe('2880x1800')
    }
  })
  test('the thumbnail shown in place of the original is copied, and the result says so', async () => {
    const clip = fakeClipboard()
    const r = await copyImage({ pick: async () => ({ drawn: drawn(640, 400), thumb: true }) }, env(clip), encoder().encode)
    expect(r).toEqual({ ok: true, smaller: 'thumb' })
    expect(await clip.written[0]!.text()).toBe('640x400')
  })
  test('a picture too big for a canvas is drawn once more at the safe size, keeping its shape', async () => {
    const clip = fakeClipboard()
    const enc = encoder(SAFE_CANVAS_AREA)
    const r = await copyImage({ pick: async () => ({ drawn: drawn(8000, 6000), thumb: false }) }, env(clip), enc.encode)
    expect(r).toEqual({ ok: true, smaller: 'scaled' })
    expect(enc.asked).toHaveLength(2)
    const [w, h] = enc.asked[1]!
    expect(w * h).toBeLessThanOrEqual(SAFE_CANVAS_AREA)
    expect(w / h).toBeCloseTo(8000 / 6000, 2)
  })
  test('a long strip too long for a canvas is drawn again within the longest side', async () => {
    const clip = fakeClipboard()
    const asked: [number, number][] = []
    const enc: EncodePng = async (_d, w, h) => (asked.push([w, h]), Math.max(w, h) > SAFE_CANVAS_SIDE ? null : new Blob(['x'], { type: 'image/png' }))
    const r = await copyImage({ pick: async () => ({ drawn: drawn(40000, 300), thumb: false }) }, env(clip), enc)
    expect(r).toEqual({ ok: true, smaller: 'scaled' })
    expect(asked[1]![0]).toBeLessThanOrEqual(SAFE_CANVAS_SIDE)
  })
  test('the item is made and written at once, inside the click: the PNG may come later', async () => {
    const clip = fakeClipboard()
    let release: (v: { drawn: Drawn; thumb: boolean }) => void = () => {}
    let writes = 0
    const watched = { ...clip, write: (items: ClipboardItems) => (writes++, clip.write(items)) }
    const done = copyImage({ pick: () => new Promise((r) => (release = r)) }, { ...env(clip), clipboard: watched }, encoder().encode)
    // the original is still loading, and the write has already been asked for
    expect(writes).toBe(1)
    release({ drawn: drawn(4, 4), thumb: false })
    expect(await done).toEqual({ ok: true, smaller: null })
  })
})

describe('a copy given up', () => {
  test('while its picture loads: nothing is written, and it is no failure to tell', async () => {
    const clip = fakeClipboard()
    const run = new AbortController()
    let release: (v: { drawn: Drawn; thumb: boolean }) => void = () => {}
    const done = copyImage({ pick: () => new Promise((r) => (release = r)), signal: run.signal }, env(clip), encoder().encode)
    run.abort()
    expect(await done).toEqual({ ok: false, reason: 'cancelled' })
    // the picture that comes later goes nowhere
    release({ drawn: drawn(4, 4), thumb: false })
    await new Promise((r) => setTimeout(r, 10))
    expect(clip.written).toEqual([])
  })
  test('one already on the clipboard stays copied', async () => {
    const clip = fakeClipboard()
    const run = new AbortController()
    expect(await copyImage({ pick: async () => ({ drawn: drawn(4, 4), thumb: false }), signal: run.signal }, env(clip), encoder().encode)).toEqual({ ok: true, smaller: null })
    run.abort()
    expect(clip.written).toHaveLength(1)
  })
})

describe('why a copy failed', () => {
  test('the browser refused the clipboard (no focus, no permission)', async () => {
    expect(await copyImage({ pick: async () => ({ drawn: drawn(4, 4), thumb: false }) }, env(fakeClipboard({ refuse: 'NotAllowedError' })), encoder().encode)).toEqual({ ok: false, reason: 'denied' })
    expect(await copyImage({ pick: async () => ({ drawn: drawn(4, 4), thumb: false }) }, env(fakeClipboard({ refuse: 'DataError' })), encoder().encode)).toEqual({ ok: false, reason: 'failed' })
  })
  test('nothing has loaded to draw', async () => {
    const clip = fakeClipboard()
    expect(await copyImage({ pick: async () => null }, env(clip), encoder().encode)).toEqual({ ok: false, reason: 'notLoaded' })
    expect(await copyImage({ pick: async () => ({ drawn: drawn(0, 0), thumb: false }) }, env(clip), encoder().encode)).toEqual({ ok: false, reason: 'notLoaded' })
    expect(clip.written).toEqual([])
  })
  test('too big even at the safe size, or no canvas for a small one', async () => {
    const never: EncodePng = async () => null
    expect(await copyImage({ pick: async () => ({ drawn: drawn(9000, 9000), thumb: false }) }, env(fakeClipboard()), never)).toEqual({ ok: false, reason: 'tooBig' })
    expect(await copyImage({ pick: async () => ({ drawn: drawn(100, 100), thumb: false }) }, env(fakeClipboard()), never)).toEqual({ ok: false, reason: 'failed' })
  })
  test('a drawing that throws, or a clipboard that refuses as the drawing fails, says the drawing\'s reason', async () => {
    const boom: EncodePng = async () => {
      throw new Error('tainted')
    }
    expect(await copyImage({ pick: async () => ({ drawn: drawn(4, 4), thumb: false }) }, env(fakeClipboard()), boom)).toEqual({ ok: false, reason: 'failed' })
    // a browser whose write rejects as NotAllowedError when the item's promise rejects: the reason is the picture's
    const strict = { write: async (items: ClipboardItems) => {
      try { await (items[0] as unknown as FakeItem).items['image/png'] } catch { throw new DOMException('read failed', 'NotAllowedError') }
    } }
    expect(await copyImage({ pick: async () => null }, { ...env(fakeClipboard()), clipboard: strict }, encoder().encode)).toEqual({ ok: false, reason: 'notLoaded' })
  })
  test('no clipboard at all', async () => {
    expect(await copyImage({ pick: async () => null }, { clipboard: null, ClipboardItem: null })).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('⌘C / Ctrl+C', () => {
  const key = (o: Partial<KeyboardEvent>) => ({ key: 'c', code: 'KeyC', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...o })
  test('⌘C and Ctrl+C, either case', () => {
    expect(isCopyKey(key({ metaKey: true }))).toBe(true)
    expect(isCopyKey(key({ ctrlKey: true }))).toBe(true)
    expect(isCopyKey(key({ ctrlKey: true, key: 'C' }))).toBe(true)
  })
  test('with a Korean input source the key is ㅊ: its place says C', () => {
    expect(isCopyKey(key({ metaKey: true, key: 'ㅊ' }))).toBe(true)
  })
  test('another layout\'s C is its letter, not the place (Dvorak\'s J sits there)', () => {
    expect(isCopyKey(key({ metaKey: true, key: 'j' }))).toBe(false)
    expect(isCopyKey(key({ metaKey: true, key: 'c', code: 'KeyI' }))).toBe(true)
  })
  test('not C alone, not with ⇧ or ⌥, not a held key', () => {
    expect(isCopyKey(key({}))).toBe(false)
    expect(isCopyKey(key({ metaKey: true, shiftKey: true }))).toBe(false)
    expect(isCopyKey(key({ metaKey: true, altKey: true }))).toBe(false)
    expect(isCopyKey(key({ metaKey: true, repeat: true }))).toBe(false)
  })
})
