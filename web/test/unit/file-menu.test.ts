// The right-click menu of a picture or file (web/src/lib/fileMenu.ts, components/FileMenu.tsx): the items per kind of
// file and place, the links it copies (the app's own address, never a key), the one kind of address 이미지 복사 reads,
// the keyboard's menu keys, and the desktop app's own clipboard for 이미지 복사 (lib/copyImage.ts env.desktop). The
// right-click itself and 링크 복사 on the clipboard are in test/e2e/file-menu.spec.ts.
import { describe, expect, test } from 'bun:test'
import type { Attachment, RoomFile } from '@mycel/shared/api'
import { canCopyImage, copyImage, pickFromAddress } from '../../src/lib/copyImage'
import { fileMenuActions, isMenuKey, itemImage, itemLink, messageLink, ownFileAddress, teamFileLink, type FileMenuTarget } from '../../src/lib/fileMenu'
import { attachmentItem, roomFileItem, roomItem, teamImageItem } from '../../src/lib/imageViewer'

const ORIGIN = 'https://acme.example'
const ROOM = '0190f0f0-0000-7000-8000-000000000001'
const MSG = '0190f0f0-0000-7000-8000-000000000002'
const ROOT = '0190f0f0-0000-7000-8000-000000000003'
const FILE = '0190f0f0-0000-7000-8000-000000000004'
const noop = () => {}

const roomFile = (o: Partial<RoomFile>): RoomFile => ({ id: FILE, name: 'acme.png', size: 1000, mime: 'image/png', kind: 'image', thumb: true, width: 40, height: 30, ...o })
const attachment = (o: Partial<Attachment>): Attachment => ({ id: FILE, name: 'acme.png', size: 1000, mime: 'image/png', kind: 'image', path: 'users/acme/uploads/acme.png', ...o }) as Attachment
/** a target as a room's list builds it (RoomMessages useRoomFileMenu) */
const roomTarget = (f: RoomFile, o: { ask?: boolean; reply?: boolean } = {}): FileMenuTarget => {
  const meta = { messageId: MSG, rootId: o.reply ? ROOT : MSG }
  const item = f.kind === 'image' && f.thumb ? roomItem(ROOM, f, meta) : roomFileItem(ROOM, f, null, meta)
  return { name: f.name, image: itemImage(item), link: itemLink(item, ORIGIN), download: item.download, ask: o.ask ? noop : null }
}
// the page's own address: relative file routes are read from it
const withOrigin = <T,>(fn: () => T): T => {
  const g = globalThis as { location?: unknown }
  const was = g.location
  g.location = { origin: ORIGIN }
  try {
    return fn()
  } finally {
    g.location = was
  }
}

describe('the items per file and place', () => {
  test('a room picture: copy image, copy link, download, ask Trina', () => {
    withOrigin(() => expect(fileMenuActions(roomTarget(roomFile({}), { ask: true }), true)).toEqual(['copyImage', 'copyLink', 'download', 'ask']))
  })
  test('a room document (PDF, ZIP, Hangul file): no copy image', () => {
    withOrigin(() => {
      for (const name of ['plan.pdf', 'acme.zip', 'form.hwp']) expect(fileMenuActions(roomTarget(roomFile({ name, kind: 'other', mime: 'application/octet-stream', thumb: false }), { ask: true }), true)).toEqual(['copyLink', 'download', 'ask'])
    })
  })
  test('where the clipboard takes no picture (an Android WebView): no copy image', () => {
    withOrigin(() => expect(fileMenuActions(roomTarget(roomFile({})), false)).toEqual(['copyLink', 'download']))
  })
  test('a HEIC photo the browser cannot draw: copied from its thumbnail', () => {
    const item = roomItem(ROOM, roomFile({ name: 'acme.heic', mime: 'image/heic' }), { messageId: MSG })
    expect(itemImage(item)).toEqual({ src: expect.stringContaining('thumb=1'), thumb: true })
  })
  test('an AI chat picture: copy image (the team file), copy link, download; a document: link and download', () => {
    withOrigin(() => {
      const pic = attachmentItem(attachment({}))
      expect(fileMenuActions({ name: 'acme.png', image: itemImage(pic), link: itemLink(pic, ORIGIN), download: pic.download }, true)).toEqual(['copyImage', 'copyLink', 'download'])
      expect(itemImage(pic)?.src).toContain('/api/')
      expect(fileMenuActions({ name: 'plan.pdf', image: null, link: teamFileLink('users/acme/plan.pdf', ORIGIN), download: noop }, true)).toEqual(['copyLink', 'download'])
    })
  })
  test('a picture in a message box (its own bytes, not sent yet): nothing but what it was given', () => {
    expect(itemImage({ original: null, blob: new Blob(['x']), thumb: null })).toBeNull()
    expect(itemLink({}, ORIGIN)).toBeNull()
    expect(fileMenuActions({ name: 'draft.png' }, true)).toEqual([])
  })
  test("the viewer's own copy is offered even without an address", () => {
    expect(fileMenuActions({ name: 'acme.png', copyImage: noop }, true)).toEqual(['copyImage'])
    expect(fileMenuActions({ name: 'acme.png', copyImage: noop }, false)).toEqual([])
  })
})

describe('the links: the app address of the place, never a key', () => {
  test('a message, a reply in a thread, a team file or folder', () => {
    expect(messageLink(ROOM, MSG, MSG, ORIGIN)).toBe(`${ORIGIN}/rooms/${ROOM}?m=${MSG}`)
    expect(messageLink(ROOM, MSG, null, ORIGIN)).toBe(`${ORIGIN}/rooms/${ROOM}?m=${MSG}`)
    expect(messageLink(ROOM, MSG, ROOT, ORIGIN)).toBe(`${ORIGIN}/rooms/${ROOM}/t/${ROOT}?m=${MSG}`)
    expect(teamFileLink('shared/acme plan/q3 #1.pdf', ORIGIN)).toBe(`${ORIGIN}/files/view?path=shared%2Facme%20plan%2Fq3%20%231.pdf`)
  })
  test('a room file links to its message; a team picture to its file', () => {
    const f = roomFile({})
    expect(itemLink(roomItem(ROOM, f, { messageId: MSG, rootId: ROOT }), ORIGIN)).toBe(`${ORIGIN}/rooms/${ROOM}/t/${ROOT}?m=${MSG}`)
    expect(itemLink(teamImageItem('shared/acme.png', 'acme.png'), ORIGIN)).toBe(`${ORIGIN}/files/view?path=shared%2Facme.png`)
  })
  test('no link carries a token, a key or a file route', () => {
    const links = [messageLink(ROOM, MSG, ROOT, ORIGIN), teamFileLink('users/acme/a.png', ORIGIN), itemLink(attachmentItem(attachment({})), ORIGIN)!]
    for (const l of links) {
      expect(l).not.toMatch(/token|key=|sig=|\/api\//i)
      expect(new URL(l).origin).toBe(ORIGIN)
    }
  })
})

describe('copy image reads only the app file routes on this address', () => {
  test('own routes yes; another site, data:, blob:, credentials in the address no', () => {
    expect(ownFileAddress(`/api/rooms/${ROOM}/files/${FILE}`, ORIGIN)).toBe(true)
    expect(ownFileAddress(`${ORIGIN}/api/files/download?path=a.png`, ORIGIN)).toBe(true)
    expect(ownFileAddress('https://evil.example/api/files/download?path=a.png', ORIGIN)).toBe(false)
    expect(ownFileAddress('//evil.example/api/x', ORIGIN)).toBe(false)
    expect(ownFileAddress('/rooms/x', ORIGIN)).toBe(false)
    expect(ownFileAddress('data:image/png;base64,AAAA', ORIGIN)).toBe(false)
    expect(ownFileAddress(`blob:${ORIGIN}/1234`, ORIGIN)).toBe(false)
    expect(ownFileAddress(`https://u:p@acme.example/api/x`, ORIGIN)).toBe(false)
    expect(ownFileAddress('/api/x', '')).toBe(false)
  })
  test('another address is never fetched', async () => {
    const g = globalThis as { fetch: typeof fetch }
    const was = g.fetch
    let asked = 0
    g.fetch = (async () => {
      asked++
      return new Response('')
    }) as unknown as typeof fetch
    try {
      expect(await pickFromAddress('https://evil.example/api/x.png', false, undefined, ORIGIN)()).toBeNull()
      expect(asked).toBe(0)
    } finally {
      g.fetch = was
    }
  })
  test('an answer that is no picture (a sign-in page) copies nothing', async () => {
    const g = globalThis as { fetch: typeof fetch }
    const was = g.fetch
    g.fetch = (async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    try {
      expect(await pickFromAddress('/api/files/download?path=a.png', false, undefined, ORIGIN)()).toBeNull()
    } finally {
      g.fetch = was
    }
  })
})

describe('the keyboard', () => {
  const key = (k: string, o: Partial<KeyboardEvent> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...o })
  test('the menu key and Shift+F10 open it; F10 alone or with Ctrl does not', () => {
    expect(isMenuKey(key('ContextMenu'))).toBe(true)
    expect(isMenuKey(key('F10', { shiftKey: true }))).toBe(true)
    expect(isMenuKey(key('F10'))).toBe(false)
    expect(isMenuKey(key('F10', { shiftKey: true, ctrlKey: true }))).toBe(false)
    expect(isMenuKey(key('Enter'))).toBe(false)
  })
})

describe("the desktop app's own clipboard", () => {
  const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: 'image/png' })
  test('offered wherever the app has it; the PNG bytes go to it, not to the async clipboard', async () => {
    const got: Uint8Array[] = []
    const env = { desktop: async (b: Uint8Array) => (got.push(b), true), clipboard: null, ClipboardItem: null }
    expect(canCopyImage(env)).toBe(true)
    expect(await copyImage({ blob: png, pick: async () => null }, env)).toEqual({ ok: true, smaller: null })
    expect([...got[0]!.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
  test('the app refusing the bytes is a failed copy; nothing drawn is notLoaded', async () => {
    expect(await copyImage({ blob: png, pick: async () => null }, { desktop: async () => false })).toEqual({ ok: false, reason: 'failed' })
    expect(await copyImage({ pick: async () => null }, { desktop: async () => true })).toEqual({ ok: false, reason: 'notLoaded' })
  })
  test('a copy given up writes nothing', async () => {
    const run = new AbortController()
    run.abort()
    let wrote = false
    expect(await copyImage({ pick: async () => null, signal: run.signal }, { desktop: async () => (wrote = true) })).toEqual({ ok: false, reason: 'cancelled' })
    expect(wrote).toBe(false)
  })
})
