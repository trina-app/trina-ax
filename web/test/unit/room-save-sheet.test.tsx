// "Save to team folder" on a room file (components/rooms/SaveToTeamSheet.tsx, lib/roomSave.ts, lib/fileMenu.ts;
// docs/decisions/20261117-room-file-save-btn.md): the sheet starts on the server's suggestion (labelled Suggested or
// Recent), never one for a file that looks personal (a note instead), says how many people outside the conversation see
// the folder, saves the message's files that are not there yet in one call and remembers where they went; a refusal
// for a skills folder says why. The file menu offers the save, or opening the file once it is in the team folder.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { ApiError } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { SaveToTeamSheet } from '../../src/components/rooms/SaveToTeamSheet'
import { DialogHost } from '../../src/components/ui'
import { fileMenuActions } from '../../src/lib/fileMenu'
import { filesToSave, folderOfPath, saveRefusalKey, saveSummary, startFolder, startTicks } from '../../src/lib/roomSave'
import { useUi } from '../../src/store/ui'
import { resetRoomSaves, useRoomSaves } from '../../src/store/roomSaves'
import { installDom, mount, removeDom } from './dom-host'

const ROOM = '0190f0f0-0000-7000-8000-00000000a001'
const F1 = '0190f0f0-0000-7000-8000-00000000f001'
const F2 = '0190f0f0-0000-7000-8000-00000000f002'
const F3 = '0190f0f0-0000-7000-8000-00000000f003'
const realFetch = globalThis.fetch
const before = useLocaleStore.getState().locale
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
let calls: { url: string; body: any }[] = []
let plan: unknown
let saveAnswer: () => Response
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body })
    if (url === `/api/rooms/${ROOM}/save-plan`) return body.folder ? json({ ...(plan as object), suggestion: null, folder: { path: body.folder, outside: 0 } }) : json(plan)
    if (url === `/api/rooms/${ROOM}/save-to-team`) return saveAnswer()
    if (url.startsWith('/api/files/tree')) return json({ path: '', access: 'write', entries: [], nextCursor: null })
    return json({ error: { code: 'internal', message: 'no route' } }, 500)
  }) as unknown as typeof fetch
})
beforeEach(() => {
  calls = []
  resetRoomSaves()
  plan = {
    files: [{ id: F1, name: 'acme-quote.pdf', size: 2048 }, { id: F2, name: 'acme-logo.png', size: 10, savedPath: 'shared/acme/acme-logo.png' }],
    suggestion: { path: 'shared/acme', why: 'suggested', outside: 12 },
    sensitive: false,
  }
  saveAnswer = () => json({ saved: [{ fileId: F1, path: 'shared/acme/acme-quote.pdf', existed: false }] })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before })
})

describe('the sheet', () => {
  test('starts on the suggestion with its audience; Save copies the files not there yet and remembers where', async () => {
    const m = await mount(<SaveToTeamSheet />)
    try {
      useRoomSaves.getState().open(ROOM, [F1, F2])
      await m.until(() => m.find('room-save-place'), 'the suggested folder')
      expect(document.body.textContent).toContain(translate('en', 'rooms.save.title'))
      expect(m.get('room-save-place').getAttribute('data-why')).toBe('suggested')
      expect(m.get('room-save-place').textContent).toContain(translate('en', 'rooms.save.suggested'))
      expect(m.get('room-save-audience').textContent).toBe(translate('en', 'rooms.save.outside', { n: 12 }))
      // the logo is there already: listed as such, not saved again
      expect(m.get('room-save-files').textContent).toContain(translate('en', 'rooms.save.already'))
      expect(m.find('room-save-sensitive')).toBeNull()
      await m.click('room-save-confirm')
      await m.until(() => !useRoomSaves.getState().sheet, 'the sheet closed')
      expect(calls.find((c) => c.url.endsWith('/save-to-team'))?.body).toEqual({ fileIds: [F1], folder: 'shared/acme', askWiden: true })
      expect(useRoomSaves.getState().byRoom[ROOM]?.[F1]).toBe('shared/acme/acme-quote.pdf')
    } finally { await m.unmount() }
  })

  test('a file that looks personal: nothing picked, a note, Save waits for a folder', async () => {
    plan = { files: [{ id: F1, name: 'passport.jpg', size: 10, sensitive: true }], suggestion: null, sensitive: true }
    const m = await mount(<SaveToTeamSheet />)
    try {
      useRoomSaves.getState().open(ROOM, [F1])
      await m.until(() => m.find('room-save-sensitive'), 'the note')
      expect(m.find('room-save-place')).toBeNull()
      expect(m.get('room-save-choose').textContent).toBe(translate('en', 'rooms.save.chooseFirst'))
      expect(m.get("room-save-confirm").hasAttribute("disabled")).toBe(true)
    } finally { await m.unmount() }
  })

  test('a refused save says why and keeps the sheet open', async () => {
    saveAnswer = () => json({ error: { code: 'validation', message: 'x', params: { reason: 'skills_folder' } } }, 400)
    const m = await mount(<SaveToTeamSheet />)
    try {
      useRoomSaves.getState().open(ROOM, [F1])
      await m.until(() => m.find('room-save-place'), 'the folder')
      await m.click('room-save-confirm')
      await m.until(() => document.body.textContent?.includes(translate('en', 'rooms.save.skillsFolder')), 'the reason')
      expect(useRoomSaves.getState().sheet).not.toBeNull()
    } finally { await m.unmount() }
  })
})

describe('QA TC-ask2-6: a save where more people see it asks once', () => {
  const widened = () => json({ error: { code: 'conflict', message: 'x', params: { reason: 'audience_widened', viewersAdded: 16 } } }, 409)
  const saves = () => calls.filter((c) => c.url.endsWith('/save-to-team')).map((c) => c.body)
  test('the 409 asks with how many more; yes sends it again confirmed and saves', async () => {
    saveAnswer = () => (saves().length === 1 ? widened() : json({ saved: [{ fileId: F1, path: 'shared/acme/acme-quote.pdf', existed: false }] }))
    const m = await mount(<><SaveToTeamSheet /><DialogHost /></>)
    try {
      useRoomSaves.getState().open(ROOM, [F1])
      await m.until(() => m.find('room-save-place'), 'the folder')
      await m.click('room-save-confirm')
      await m.until(() => m.find('dialog-confirm'), 'the question', 2000)
      expect(document.body.textContent).toContain(translate('en', 'rooms.save.widenBody', { n: 16 }))
      await m.click('dialog-confirm')
      await m.until(() => !useRoomSaves.getState().sheet, 'the sheet closed')
      expect(saves()).toEqual([{ fileIds: [F1], folder: 'shared/acme', askWiden: true }, { fileIds: [F1], folder: 'shared/acme', askWiden: true, confirm: true }])
    } finally { await m.unmount() }
  })

  test('no: nothing saved, no error, the sheet stays', async () => {
    saveAnswer = widened
    const m = await mount(<><SaveToTeamSheet /><DialogHost /></>)
    try {
      useRoomSaves.getState().open(ROOM, [F1])
      await m.until(() => m.find('room-save-place'), 'the folder')
      await m.click('room-save-confirm')
      await m.until(() => m.find('dialog-confirm'), 'the question', 2000)
      await m.click(m.get('dialog-confirm').parentElement!.querySelector('button')!)
      await m.until(() => !m.find('dialog-confirm') && !m.get('room-save-confirm').hasAttribute('disabled'), 'back on the sheet', 2000)
      expect(saves()).toHaveLength(1)
      expect(useRoomSaves.getState().sheet).not.toBeNull()
      expect(document.body.textContent).not.toContain(translate('en', 'rooms.save.failed'))
    } finally { await m.unmount() }
  })
})

describe('QA 11-17', () => {
  test('TC-4803: two identical files: the second says it is the same file, both are sent, and the toast says it was saved once', async () => {
    plan = { files: [{ id: F1, name: '계약서_QA.txt', size: 32 }, { id: F2, name: '계약서_QA.txt', size: 32, sameAs: F1 }], suggestion: { path: 'shared', why: 'recent', outside: 0 }, sensitive: false }
    saveAnswer = () => json({ saved: [{ fileId: F1, path: 'shared/계약서_QA.txt', existed: false }, { fileId: F2, path: 'shared/계약서_QA.txt', existed: true }] })
    useUi.setState({ toasts: [] })
    const m = await mount(<SaveToTeamSheet />)
    try {
      useRoomSaves.getState().open(ROOM, [F1, F2])
      await m.until(() => m.find('room-save-place'), 'the folder')
      expect(m.get('room-save-files').textContent).toContain(translate('en', 'rooms.save.sameFile'))
      await m.click('room-save-confirm')
      await m.until(() => !useRoomSaves.getState().sheet, 'the sheet closed')
      expect(calls.find((c) => c.url.endsWith('/save-to-team'))?.body).toEqual({ fileIds: [F1, F2], folder: 'shared', askWiden: true })
      const t = useUi.getState().toasts.at(-1)!
      expect(t.detail).toBe(translate('en', 'rooms.save.savedSame', { n: 1 }))
    } finally { await m.unmount() }
  })

  test('one personal file among others: the folder is still suggested, the personal one starts unticked and is not sent', async () => {
    plan = { files: [{ id: F1, name: '통장사본.pdf', size: 42, sensitive: true }, { id: F2, name: 'brief.md', size: 10 }, { id: F3, name: 'logo.png', size: 10 }], suggestion: { path: 'shared/acme', why: 'suggested', outside: 3 }, sensitive: true }
    saveAnswer = () => json({ saved: [{ fileId: F2, path: 'shared/acme/brief.md', existed: false }, { fileId: F3, path: 'shared/acme/logo.png', existed: false }] })
    const m = await mount(<SaveToTeamSheet />)
    try {
      useRoomSaves.getState().open(ROOM, [F1, F2, F3])
      await m.until(() => m.find('room-save-place'), 'the suggested folder')
      expect(m.get('room-save-place').getAttribute('data-why')).toBe('suggested')
      expect(m.get('room-save-sensitive').textContent).toBe(translate('en', 'rooms.save.sensitiveSome'))
      const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-testid="room-save-file-check"]')]
      expect(boxes.map((b) => b.checked)).toEqual([false, true, true])
      expect(m.get('room-save-files').textContent).toContain(translate('en', 'rooms.save.personal'))
      await m.click('room-save-confirm')
      await m.until(() => !useRoomSaves.getState().sheet, 'the sheet closed')
      expect(calls.find((c) => c.url.endsWith('/save-to-team'))?.body).toEqual({ fileIds: [F2, F3], folder: 'shared/acme', askWiden: true })
    } finally { await m.unmount() }
  })

  test('startTicks and saveSummary', () => {
    const p = { files: [{ id: F1, name: 'a', size: 1, sensitive: true }, { id: F2, name: 'b', size: 1 }, { id: F3, name: 'b', size: 1, sameAs: F2 }], sensitive: true }
    expect([...startTicks(p)]).toEqual([F2])
    // every file personal: all ticked (no folder is picked for them; the person picks it)
    expect([...startTicks({ files: [{ id: F1, name: 'a', size: 1, sensitive: true }], sensitive: true })]).toEqual([F1])
    expect(saveSummary([{ fileId: F1, path: 'x/a', existed: false }, { fileId: F2, path: 'x/a', existed: true }, { fileId: F3, path: 'x/b', existed: false }])).toEqual({ same: 1 })
    expect(startFolder({ files: [{ id: F1, name: 'a', size: 1, sensitive: true }, { id: F2, name: 'b', size: 1 }], suggestion: { path: 's', why: 'suggested', outside: 0 }, sensitive: true })).toEqual({ path: 's', why: 'suggested', outside: 0 })
  })
})

describe('the parts', () => {
  test('startFolder, filesToSave, folderOfPath, saveRefusalKey', () => {
    expect(startFolder({ files: [], suggestion: { path: 'a', why: 'recent', outside: 0 }, sensitive: false })).toEqual({ path: 'a', why: 'recent', outside: 0 })
    expect(startFolder({ files: [{ id: F1, name: 'p', size: 1, sensitive: true }], suggestion: { path: 'a', why: 'suggested', outside: 0 }, sensitive: true })).toBeNull()
    expect(filesToSave({ files: [{ id: F1, name: 'a', size: 1 }, { id: F2, name: 'b', size: 1, savedPath: 'x/b' }] }).map((f) => f.id)).toEqual([F1])
    const words = { path: (p: string, sep = '/') => p.split('/').join(sep) }
    expect(folderOfPath('shared/acme/quotes/q.pdf', words)).toEqual({ short: 'quotes', full: 'shared › acme › quotes' })
    expect(saveRefusalKey(new ApiError(400, { code: 'validation', message: 'x', params: { reason: 'instruction_file' } } as never))).toBe('rooms.save.badName')
    expect(saveRefusalKey(new ApiError(413, { code: 'payload_too_large', message: 'x' } as never))).toBe('rooms.save.tooLarge')
    expect(saveRefusalKey(new Error('x'))).toBeNull()
  })

  test('the file menu: the save after the download; once saved, open', () => {
    const noop = () => {}
    expect(fileMenuActions({ name: 'a.pdf', download: noop, team: { saved: false, run: noop }, ask: noop }, false)).toEqual(['download', 'saveToTeam', 'ask'])
    expect(fileMenuActions({ name: 'a.pdf', download: noop, team: null }, false)).toEqual(['download'])
  })
})
