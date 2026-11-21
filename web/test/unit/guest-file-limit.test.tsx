// A guest's file limit (docs/decisions/20261116-guest-room-file-limit.md): Admin > Members & invites has one choice
// for it (100 MB or 1 GB, never above a member's 1 GB; saved as it is picked), and a guest's room box refuses a larger file before it is sent,
// naming the guest's own limit (the server checks it again).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { UPLOAD_SESSION_MAX, type Me, type TeamSettings } from '@mycel/shared/api'
import { myUploadMax } from '../../src/lib/guests'
import { splitOversize } from '../../src/lib/upload'
import { RoomComposer } from '../../src/components/rooms/RoomComposer'
import { translate, useLocaleStore } from '../../src/i18n'
import { GuestFileLimit } from '../../src/pages/admin/Guests'
import { useRoomUploads } from '../../src/store/roomUploads'
import { myUploadMaxNow, useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { FakeEvent, installDom, mount, removeDom, type FakeElement } from './dom-host'
import { BEN, ME, room } from './rooms-fixtures'

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })
afterEach(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useRoomUploads.setState({ byPlace: {} })
  useUi.setState({ toasts: [] })
})
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
const MB = 1024 * 1024
/** the team settings as the server sends them (only the guest file limit matters here) */
const SETTINGS: TeamSettings = { teamName: 'Acme', defaultLocale: 'en', defaultEngine: 'claude-code', defaultModel: null, concurrency: 2, updateChannel: 'stable', updateWindow: null, auditRetentionDays: 365, fileHistoryRetentionDays: 90, trashRetentionDays: 30, chatTrashRetentionDays: 7, timeZone: 'Asia/Seoul', browserAllowAll: true, webAllowAll: true, personalIntegrations: true, aiVision: true, aiSubagents: true, roomAlwaysAllow: true, projectCreators: 'members', guestFileMax: '100mb', memberFileShares: true, oftenAsked: true, answerStepLimit: 150, speechProvider: 'local', speechModel: 'openai/whisper-large-v3-turbo', aiMediaTranscripts: null, introDeckTier: 'standard' }

describe('Admin > Members > Guests: the largest file a guest can send', () => {
  test('shows the team\'s choice between 100 MB and 1 GB (no 10 GB), and saves a new one as it is picked', async () => {
    const patches: unknown[] = []
    let saved = '100mb'
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://team.localhost').pathname
      if (path !== '/api/admin/settings') return json({ error: { code: 'not_found', message: 'no' } }, 404)
      if (init?.method === 'PATCH') { const b = JSON.parse(String(init.body)) as { guestFileMax: string }; patches.push(b); saved = b.guestFileMax }
      return json({ ...SETTINGS, guestFileMax: saved })
    }) as typeof fetch
    const m = await mount(<GuestFileLimit />)
    try {
      const select = await m.until(() => m.find('guest-file-max'), 'the choice')
      expect(m.get('guest-file-limit').textContent).toContain(translate('en', 'guest.admin.fileLimit'))
      expect([...select.querySelectorAll('option')].map((o) => [o.getAttribute('value'), o.textContent])).toEqual([['100mb', '100 MB'], ['1gb', '1 GB']])
      ;(select as unknown as { value: string }).value = '1gb'
      await act(async () => { select.dispatchEvent(new FakeEvent('change', { bubbles: true })) })
      await m.until(() => patches.length === 1, 'the save')
      expect(patches).toEqual([{ guestFileMax: '1gb' }])
      await m.until(() => useUi.getState().toasts.some((t) => t.level === 'success'), 'the saved line')
    } finally { await m.unmount() }
  })
})

describe('a guest\'s room box', () => {
  const r = room({ name: 'client-call', lastSeq: 1, lastReadSeq: 1 })
  const signIn = (uploadMaxBytes?: number) => useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name, role: uploadMaxBytes ? 'guest' : 'member' }, team: { name: 'Acme', ...(uploadMaxBytes ? { uploadMaxBytes } : {}) }, server: { allChatsConfidential: false } } as unknown as Me } })
  const drop = async (box: FakeElement, file: File) => {
    const dt = { types: ['Files'], files: [file], dropEffect: 'none', getData: () => '' }
    for (const type of ['dragenter', 'dragover', 'drop']) await act(async () => { box.dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { dataTransfer: dt, relatedTarget: null })) })
  }
  const chips = (box: FakeElement) => [...box.querySelectorAll('[data-testid="room-file-chip"]')]
  const warned = () => useUi.getState().toasts.filter((t) => t.level === 'warn').map((t) => t.text)

  test('a file over the guest\'s limit is refused at once, with that limit; a member is held to the room\'s 1 GB only', async () => {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch
    const big = { name: 'walkthrough.mov', size: 100 * MB + 1, type: 'video/quicktime', lastModified: 1 } as File
    signIn(100 * MB)
    let m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN]} meId={ME.id} onSent={() => {}} />)
    try {
      await drop(m.get('room-composer'), big)
      expect(chips(m.get('room-composer'))).toHaveLength(0)
      expect(warned()).toEqual([translate('en', 'rooms.tooBig', { name: 'walkthrough.mov', max: '100 MB' })])
    } finally { await m.unmount() }
    useUi.setState({ toasts: [] })
    // raised to 1 GB by an admin: the same file is taken
    signIn(1024 * MB)
    m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN]} meId={ME.id} onSent={() => {}} />)
    try {
      await drop(m.get('room-composer'), big)
      expect(warned()).toEqual([])
      expect(useRoomUploads.getState().byPlace[r.id]?.map((f) => f.file.name)).toEqual(['walkthrough.mov'])
      await drop(m.get('room-composer'), { name: 'film.mov', size: 1024 * MB + 1, type: 'video/quicktime', lastModified: 1 } as File)
      expect(warned()).toEqual([translate('en', 'rooms.tooBig', { name: 'film.mov', max: '1 GB' })])
    } finally { await m.unmount() }
    useUi.setState({ toasts: [] })
    useRoomUploads.setState({ byPlace: {} })
    signIn()
    m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN]} meId={ME.id} onSent={() => {}} />)
    try {
      // a member: 1 GB is taken, one byte more is refused at once, naming 1 GB
      await drop(m.get('room-composer'), { name: 'film.mov', size: 1024 * MB, type: 'video/quicktime', lastModified: 1 } as File)
      expect(warned()).toEqual([])
      expect(useRoomUploads.getState().byPlace[r.id]).toHaveLength(1)
      await drop(m.get('room-composer'), { name: 'longer.mov', size: 1024 * MB + 1, type: 'video/quicktime', lastModified: 1 } as File)
      expect(warned()).toEqual([translate('en', 'rooms.tooBig', { name: 'longer.mov', max: '1 GB' })])
      expect(useRoomUploads.getState().byPlace[r.id]).toHaveLength(1)
    } finally { await m.unmount() }
  })
})

describe('a guest\'s other uploads', () => {
  test('the same limit for a file attached to an AI chat or dropped as a folder: taken from Me, 20 GB for anyone else', () => {
    const me = (uploadMaxBytes?: number) => ({ user: { id: 'gus', role: uploadMaxBytes ? 'guest' : 'member' }, team: { name: 'Acme', ...(uploadMaxBytes ? { uploadMaxBytes } : {}) } }) as unknown as Me
    expect(myUploadMax(me(100 * MB), UPLOAD_SESSION_MAX)).toBe(100 * MB)
    expect(myUploadMax(me(), UPLOAD_SESSION_MAX)).toBe(UPLOAD_SESSION_MAX)
    expect(myUploadMax(null, UPLOAD_SESSION_MAX)).toBe(UPLOAD_SESSION_MAX)
    // never above what the place itself takes
    expect(myUploadMax(me(10 * 1024 * MB), 50 * MB)).toBe(50 * MB)
    const files = [{ name: 'a.pdf', size: 5 * MB }, { name: 'b.mov', size: 100 * MB + 1 }, { name: 'c.mov', size: 100 * MB }]
    expect(splitOversize(files, 100 * MB)).toEqual({ fit: [files[0]!, files[2]!], tooBig: files[1] })
    expect(splitOversize(files).tooBig).toBeUndefined()
    useSession.setState({ status: { kind: 'signed-in', me: me(1024 * MB) } })
    expect(myUploadMaxNow(UPLOAD_SESSION_MAX)).toBe(1024 * MB)
  })
})
