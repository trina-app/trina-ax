// A room box's files and a page reload (QA TC-4327; docs/decisions/20261117-room-uploads-survive-reload.md).
// - The page does not reload by itself while a box holds a file that is up and not sent (lib/reload-guard.ts): the
//   update's reload used to come a moment after a large file was up, and its chip was gone.
// - A reload the person makes keeps them, in this tab (store/roomUploads.ts, sessionStorage): a file that was up comes
//   back ready to send; one that was on its way comes back saying "Upload stopped when the page reloaded. Choose the
//   file again to continue.", and the same file chosen again takes its place.
// - Nothing of one person stays for the next, and a file the server has removed by now (a day) is not brought back.
// - A send refused because its file is gone does not put the file back in the box.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { ROOM_FILES_MAX, type Me, type RoomFile } from '@mycel/shared/api'
import { RoomComposer } from '../../src/components/rooms/RoomComposer'
import { translate, useLocaleStore } from '../../src/i18n'
import { isBusy } from '../../src/lib/busy'
import { clearLocalData, ROOM_UPLOADS_KEY } from '../../src/lib/localData'
import { mayReloadNow, reloadWouldLose, unfinishedWork } from '../../src/lib/reload-guard'
import { _reloadRoomUploadsForTest, dropRoomUploads, forgetKept, forgetRoomUploads, holdsRoomUploads, KEPT_UPLOAD_MS, restoreRoomUploads, setPlaceUploads, teamCopies, useRoomUploads, type RoomUpload } from '../../src/store/roomUploads'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { FakeEvent, installDom, mount, removeDom, type FakeElement } from './dom-host'
import { BEN, ME, room } from './rooms-fixtures'

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const conn = useUi.getState().conn
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })
afterEach(() => {
  globalThis.fetch = realFetch
  forgetRoomUploads()
  _reloadRoomUploadsForTest()
  sessionStorage.clear()
  localStorage.clear()
  teamCopies.clear()
  useRooms.getState().reset()
  useSession.setState({ status })
  useUi.setState({ toasts: [], conn })
})

const MB = 1024 * 1024
const r = room({ name: 'launch', lastSeq: 1, lastReadSeq: 1 })
const signIn = (who: { id: string; name: string } = ME) => useSession.setState({ status: { kind: 'signed-in', me: { user: { id: who.id, name: who.name, role: 'member' }, team: { name: 'Acme' }, server: { allChatsConfidential: false } } as unknown as Me } })
/** a room file's id made at `at` (UUID v7: its first 48 bits are the time) */
const idAt = (at: number, n = 1) => { const h = at.toString(16).padStart(12, '0'); return `${h.slice(0, 8)}-${h.slice(8)}-7000-8000-${String(n).padStart(12, '0')}` }
const roomFile = (o: Partial<RoomFile> = {}): RoomFile => ({ id: idAt(Date.now()), name: 'film.mov', size: 2048 * MB, mime: 'video/quicktime', kind: 'video', thumb: false, ...o })
const picked = (name = 'film.mov', size = 600 * MB) => ({ name, size, type: 'video/quicktime', lastModified: 42 }) as File
const done = (f: RoomFile, o: Partial<RoomUpload> = {}): RoomUpload => ({ key: Math.random(), file: { name: f.name, size: f.size, lastModified: 42 } as File, status: 'done', roomFile: f, abort: new AbortController(), ...o })
const going = (file: File, o: Partial<RoomUpload> = {}): RoomUpload => ({ key: Math.random(), file, status: 'uploading', abort: new AbortController(), ...o })
/** the page loads again: nothing in memory, what the tab remembers stays, the same (or another) person is signed in */
function reload(who: { id: string; name: string } | null = ME, now?: number) {
  _reloadRoomUploadsForTest()
  if (who) { signIn(who); restoreRoomUploads(who.id, undefined, now) }
}
const here = (place = r.id) => useRoomUploads.getState().byPlace[place] ?? []
const kept = () => JSON.parse(sessionStorage.getItem(ROOM_UPLOADS_KEY) ?? 'null') as { userId: string; byPlace: Record<string, unknown[]> } | null

describe('the page does not reload by itself over a file not sent', () => {
  test('a file that is up and not sent holds the reload; sent or taken out, the reload is free again', () => {
    useUi.setState({ conn: 'open' })
    expect(mayReloadNow()).toBe(true)
    setPlaceUploads(r.id, [done(roomFile())])
    // not an upload on its way (the "upload" mark is for those), and still a reload would lose it
    expect(isBusy('upload')).toBe(false)
    expect(reloadWouldLose()).toBe(true)
    expect(mayReloadNow()).toBe(false)
    // a page part that could not load does not say "loads by itself" over it
    expect(unfinishedWork()).toBe(true)
    setPlaceUploads(r.id, [])
    expect(mayReloadNow()).toBe(true)
    expect(unfinishedWork()).toBe(false)
  })

  test('in a thread\'s box or a room that is not on screen too; a file that failed for its own reason holds nothing', () => {
    setPlaceUploads(`${r.id}/root-1`, [done(roomFile())])
    expect(reloadWouldLose()).toBe(true)
    setPlaceUploads(`${r.id}/root-1`, [])
    setPlaceUploads(r.id, [{ ...going(picked()), status: 'failed', error: 'The storage is full.' }])
    expect(reloadWouldLose()).toBe(false)
    // nor one a reload stopped: it comes back the same after the next reload, and must not hold updates for good
    setPlaceUploads(r.id, [{ ...going(picked()), status: 'failed', stopped: true }])
    expect(reloadWouldLose()).toBe(false)
  })

  test('a file the server has removed by now (not sent for a day) holds no reload', () => {
    const now = Date.now()
    setPlaceUploads(r.id, [done(roomFile({ id: idAt(now - KEPT_UPLOAD_MS - 1000) }))])
    expect(holdsRoomUploads(now)).toBe(false)
    setPlaceUploads(r.id, [done(roomFile({ id: idAt(now - KEPT_UPLOAD_MS + 60_000) }))])
    expect(holdsRoomUploads(now)).toBe(true)
  })
})

describe('a reload the person makes keeps the box\'s files, in this tab', () => {
  test('a file that was up comes back ready to send, in its own box', () => {
    reload()
    const film = roomFile(), photo = roomFile({ id: idAt(Date.now(), 2), name: 'plan.png', size: 4 * MB, mime: 'image/png', kind: 'image', thumb: true, width: 800, height: 600 })
    setPlaceUploads(r.id, [done(film)])
    setPlaceUploads(`${r.id}/root-1`, [done(photo)])
    expect(kept()?.userId).toBe(ME.id)
    reload()
    expect(here().map((f) => [f.status, f.file.name, f.file.size, f.roomFile?.id])).toEqual([['done', 'film.mov', film.size, film.id]])
    expect(here(`${r.id}/root-1`).map((f) => [f.status, f.roomFile])).toEqual([['done', photo]])
    // and again after one more reload
    reload()
    expect(here()).toHaveLength(1)
  })

  test('a file that was on its way comes back stopped, with the words that say so; one that had failed does not', async () => {
    reload()
    setPlaceUploads(r.id, [going(picked()), { ...going(picked('old.zip')), status: 'failed', error: 'The storage is full.' }])
    reload()
    expect(here().map((f) => [f.status, f.stopped, f.file.name, f.file.size, f.file.lastModified])).toEqual([['failed', true, 'film.mov', 600 * MB, 42]])
    // nothing is on its way now: the row's "uploading" mark and the browser's "leave this page?" are off
    expect(isBusy('upload')).toBe(false)
    const m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN]} meId={ME.id} onSent={() => {}} />)
    try {
      const chip = m.get('room-file-chip')
      expect(chip.getAttribute('data-status')).toBe('failed')
      expect(chip.textContent).toContain('film.mov')
      expect(chip.textContent).toContain(translate('en', 'rooms.uploadStopped'))
      expect(translate('en', 'rooms.uploadStopped')).toBe('Upload stopped when the page reloaded. Choose the file again to continue.')
      // it cannot be sent as it is
      expect(m.get('room-send').hasAttribute('disabled')).toBe(true)
    } finally { await m.unmount() }
    // a second reload still says so
    reload()
    expect(here().map((f) => f.stopped)).toEqual([true])
  })

  test('the same file chosen again takes the stopped chip\'s place and goes up; another file is added beside it', async () => {
    reload()
    setPlaceUploads(r.id, [going(picked())])
    reload()
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch
    const m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN]} meId={ME.id} onSent={() => {}} />)
    const drop = async (box: FakeElement, file: File) => {
      const dt = { types: ['Files'], files: [file], dropEffect: 'none', getData: () => '' }
      for (const type of ['dragenter', 'dragover', 'drop']) await act(async () => { box.dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { dataTransfer: dt, relatedTarget: null })) })
    }
    try {
      await drop(m.get('room-composer'), picked('notes.pdf', 3 * MB))
      // (these stand-in files have no bytes, so what becomes of the new chips is not looked at: only which chips there are)
      expect(here().map((f) => [f.file.name, !!f.stopped])).toEqual([['film.mov', true], ['notes.pdf', false]])
      await drop(m.get('room-composer'), picked())
      expect(here().map((f) => [f.file.name, !!f.stopped])).toEqual([['notes.pdf', false], ['film.mov', false]])
      // the chip that takes the place is the picked file itself (its bytes), not the stand-in the reload left
      expect(here()[1]!.file.type).toBe('video/quicktime')
    } finally {
      for (const f of here()) f.abort.abort()
      await m.unmount()
    }
  })

  test('taking the stopped chip out asks the server to drop the pieces it holds', async () => {
    reload()
    const file = picked()
    // the upload session this browser remembers for the file (lib/upload.ts)
    const { fingerprint } = await import('../../src/lib/upload')
    localStorage.setItem('mycel.uploads', JSON.stringify({ [fingerprint(file, { kind: 'room', roomId: r.id, name: file.name })]: 'session-1' }))
    setPlaceUploads(r.id, [going(file)])
    reload()
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(input), 'http://team.localhost').pathname}`)
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN]} meId={ME.id} onSent={() => {}} />)
    try {
      const remove = m.get('room-file-chip').querySelector('button')!
      await m.click(remove)
      expect(here()).toEqual([])
      await m.until(() => calls.includes('DELETE /api/upload-sessions/session-1'), 'the drop of the pieces')
      expect(kept()).toBeNull()
    } finally { await m.unmount() }
  })

  test('a team file comes back with its line about who it reaches; one still being copied is not kept', () => {
    reload()
    const copy = roomFile({ name: 'prices.xlsx', size: MB })
    setPlaceUploads(r.id, [done(copy, { teamPath: 'shared/prices.xlsx', unable: 2 }), going({ name: 'deck.pptx', size: MB } as File, { teamPath: 'shared/deck.pptx' })])
    reload()
    expect(here().map((f) => [f.status, f.teamPath, f.unable])).toEqual([['done', 'shared/prices.xlsx', 2]])
    // a send the server refuses brings it back as a team file too (RoomComposer.tsx)
    expect(teamCopies.get(copy.id)).toEqual({ path: 'shared/prices.xlsx', unable: 2 })
  })

  test('a file the server has removed by now is not brought back', () => {
    reload()
    const now = Date.now()
    setPlaceUploads(r.id, [done(roomFile({ id: idAt(now, 1) })), done(roomFile({ id: idAt(now, 2), name: 'b.mov' }))])
    reload(ME, now + KEPT_UPLOAD_MS + 60_000)
    expect(here()).toEqual([])
    expect(kept()).toBeNull()
  })

  test('nothing is written before the person is known: a page that could not reach the server leaves the tab\'s memory alone', () => {
    reload()
    setPlaceUploads(r.id, [done(roomFile())])
    const before = sessionStorage.getItem(ROOM_UPLOADS_KEY)
    // the page loads again while the server restarts: no person yet, the stores are emptied (App.tsx dropPersonStores)
    reload(null)
    forgetRoomUploads()
    expect(sessionStorage.getItem(ROOM_UPLOADS_KEY)).toBe(before)
    // the server answers: the person's files are back
    signIn()
    restoreRoomUploads(ME.id)
    expect(here()).toHaveLength(1)
  })
})

describe('nothing of one person stays for the next', () => {
  test('another person signing in on this tab gets none of them, and they are removed', () => {
    reload()
    setPlaceUploads(r.id, [done(roomFile())])
    reload(BEN)
    expect(here()).toEqual([])
    expect(kept()).toBeNull()
  })

  test('signing out, a sign-in that ends, and clearing this browser\'s data forget them', async () => {
    reload()
    setPlaceUploads(r.id, [done(roomFile())])
    expect(kept()).not.toBeNull()
    await dropRoomUploads(0)
    expect(kept()).toBeNull()
    reload()
    expect(here()).toEqual([])

    setPlaceUploads(r.id, [done(roomFile())])
    forgetRoomUploads()
    expect(kept()).toBeNull()

    reload()
    setPlaceUploads(r.id, [done(roomFile())])
    clearLocalData()
    expect(kept()).toBeNull()
  })

  test('a box that is full: the stopped file chosen again still takes its chip\'s place, another file is refused', async () => {
    reload()
    setPlaceUploads(r.id, [going(picked()), ...Array.from({ length: ROOM_FILES_MAX - 1 }, (_, i) => done(roomFile({ id: idAt(Date.now(), i + 1), name: `clip-${i}.mov` })))])
    reload()
    expect(here()).toHaveLength(ROOM_FILES_MAX)
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch
    const m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN]} meId={ME.id} onSent={() => {}} />)
    try {
      const dt = { types: ['Files'], files: [picked('extra.mov'), picked()], dropEffect: 'none', getData: () => '' }
      for (const type of ['dragenter', 'dragover', 'drop']) await act(async () => { m.get('room-composer').dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { dataTransfer: dt, relatedTarget: null })) })
      expect(here()).toHaveLength(ROOM_FILES_MAX)
      expect(here().some((f) => f.stopped)).toBe(false)
      expect(here().map((f) => f.file.name)).not.toContain('extra.mov')
      expect(here().at(-1)!.file.name).toBe('film.mov')
      expect(useUi.getState().toasts.map((t) => t.text)).toEqual([translate('en', 'rooms.tooMany', { n: ROOM_FILES_MAX })])
    } finally {
      for (const f of here()) f.abort.abort()
      await m.unmount()
    }
  })

  test('the page loads and nobody is signed in: the tab\'s memory goes (App.tsx)', async () => {
    reload()
    setPlaceUploads(r.id, [done(roomFile())])
    _reloadRoomUploadsForTest()
    // App.tsx's watch of the session, as the page loads it
    await import('../../src/App')
    useSession.setState({ status: { kind: 'error', error: 'unreachable' } as never })
    expect(kept()).not.toBeNull()
    useSession.setState({ status: { kind: 'signed-out' } as never })
    expect(kept()).toBeNull()
    forgetKept()
  })

  test('a broken or foreign value in the tab\'s memory is ignored', () => {
    sessionStorage.setItem(ROOM_UPLOADS_KEY, '{"userId":"ada","byPlace":{"x":[{"name":7},null,{"name":"a","size":-1}],"y":"no"}}')
    reload()
    expect(useRoomUploads.getState().byPlace).toEqual({})
    sessionStorage.setItem(ROOM_UPLOADS_KEY, 'not json')
    reload()
    expect(useRoomUploads.getState().byPlace).toEqual({})
  })
})

describe('a send refused because its file is gone', () => {
  test('the words come back to the box without the file, and a line says to attach it again', async () => {
    signIn()
    const film = roomFile()
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://team.localhost').pathname
      const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
      if (path === `/api/rooms/${r.id}/messages` && init?.method === 'POST') return json({ error: { code: 'validation', message: 'Check what you entered.', fields: { 'body.fileIds': 'unknown file' } } }, 400)
      return json({ items: [], nextCursor: null })
    }) as typeof fetch
    useRooms.getState().send(r.id, { body: 'the cut', mentions: [], files: [film] })
    const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((res) => setTimeout(res, 5)) }
    await until(() => !!useRooms.getState().returned[r.id])
    const back = useRooms.getState().returned[r.id]!
    expect(back.body).toBe('the cut')
    expect(back.files).toEqual([])
    expect(useUi.getState().toasts.map((t) => t.text)).toEqual([translate('en', 'rooms.filesGone')])
  })
})
