// Room files open on click (components/rooms/RoomMessages.tsx FileChip, lib/imageViewer.ts roomFileItem): a chip's name
// opens the file viewer (the image viewer's document mode), and the chip has a small download icon of its own; a file
// with a preview is read through the room there, one without (no viewer, a server conversion, past its size limit)
// shows its card at once. A shared answer's link to a team file (lib/markdown.ts teamLinkTarget,
// components/Markdown.tsx): the team file when the viewer may open it now, else the copy that went with the message
// (RoomMessage.attachedLinks, in the side panel), else the lock; an older message without copies keeps the lock.
// A Hangul file has a preview only while the server's HWP preview is on (Me.server.hwpPreview) and within its 20 MB.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7, type RoomFile, type RoomMessage } from '@mycel/shared/api'
import { attachedCopies, RoomMessages } from '../../src/components/rooms/RoomMessages'
import { translate, useLocaleStore } from '../../src/i18n'
import { teamLinkTarget } from '../../src/lib/markdown'
import type { Me } from '@mycel/shared/api'
import { opensWithoutServer, roomFileOpens, roomHwpPreview, roomNoPreview } from '../../src/lib/preview'
import { useSession } from '../../src/store/session'
import { closeSidePanel, getSidePanel } from '../../src/lib/sidePanel'
import { closeImageViewer, getImageViewer } from '../../src/lib/imageViewer'
import { placeKey, roomFileGone, type RoomsData } from '../../src/store/rooms'
import { installDom, mount, removeDom } from './dom-host'
import { BEN, CY, ME, message, room } from './rooms-fixtures'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterEach(() => { closeSidePanel(); closeImageViewer(false) })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

const team = room({ name: 'Marketing' })
const file = (name: string, o: Partial<RoomFile> = {}): RoomFile => ({ id: uuidv7(), name, size: 2048, mime: 'application/octet-stream', kind: 'other', thumb: false, ...o })
const DECK = 'users/ben/acme-deck.html'
const BUDGET = 'finance/budget.xlsx'

/** Ben's shared answer linking the deck and the budget; the deck went with it as a copy. */
function shared(o: Partial<RoomMessage> = {}): { m: RoomMessage; deck: RoomFile } {
  const deck = file('acme-deck.html', { kind: 'text', mime: 'text/html' })
  const note = 'For Monday'
  const answer = `The deck: [deck](/files/view?path=${DECK}) and the [budget](/files/view?path=${BUDGET}).`
  const m = message({ roomId: team.id, seq: 3, author: BEN, body: `${note}\n\n${answer}`, sharedAnswer: { at: note.length + 2, cut: false }, files: [deck], openable: [], attachedLinks: [{ path: DECK, fileId: deck.id }], ...o })
  return { m, deck }
}
const list = (ms: RoomMessage[]) => <MemoryRouter><RoomMessages roomId={team.id} messages={ms} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} /></MemoryRouter>

test('the link resolution: the team file when it opens now, else the attached copy, else the lock; no copies keeps the lock', () => {
  const copies = new Map([['users/ben/acme-deck.html', 'copy-1']])
  // live access: the team file, also when a copy went with it (and as a person's own chat: every link opens)
  expect(teamLinkTarget(DECK, new Set([DECK]), copies)).toEqual({ kind: 'team' })
  expect(teamLinkTarget(DECK, null, null)).toEqual({ kind: 'team' })
  // no access, a copy: the copy (the path as the link writes it, slashes around it dropped like openable's)
  expect(teamLinkTarget(DECK, new Set(), copies)).toEqual({ kind: 'copy', copy: 'copy-1' })
  expect(teamLinkTarget(`/${DECK}/`, new Set(), copies)).toEqual({ kind: 'copy', copy: 'copy-1' })
  // neither: the lock
  expect(teamLinkTarget(BUDGET, new Set([DECK]), copies)).toEqual({ kind: 'locked' })
  // an older message (no attachedLinks): the lock, as before
  expect(teamLinkTarget(DECK, new Set(), null)).toEqual({ kind: 'locked' })
  expect(teamLinkTarget(DECK, new Set(), new Map())).toEqual({ kind: 'locked' })
  // another spelling of the path is another link: never matched to a copy by a guess
  expect(teamLinkTarget('users/ben/./acme-deck.html', new Set(), copies)).toEqual({ kind: 'locked' })
})

test("the copies: only files of the message, by the link's path; none at all is undefined", () => {
  const { m, deck } = shared()
  const map = attachedCopies(team.id, m)!
  expect([...map]).toEqual([[DECK, { source: 'room', roomId: team.id, fileId: deck.id, name: 'acme-deck.html' }]])
  // a link naming a file that is not on the message (deleted, another message's) is left out
  expect(attachedCopies(team.id, { ...m, attachedLinks: [{ path: BUDGET, fileId: uuidv7() }] })).toBeUndefined()
  expect(attachedCopies(team.id, { ...m, attachedLinks: undefined })).toBeUndefined()
})

test('in the room: no access but a copy is a link to the copy (no lock); the other file keeps its lock; live access is the team file', async () => {
  const { m } = shared()
  const html = renderToStaticMarkup(list([m]))
  expect(html).toMatch(/data-testid="team-file-chip" data-copy="">[^]*?deck<\/button>/)
  expect(html).toContain(`title="${en('rooms.fileAttachedCopy')}"`)
  expect(html).toMatch(/data-testid="team-file-text">[^]*?budget/)
  expect(html.split('data-testid="team-file-lock"').length - 1).toBe(1)
  // an older message without the copies: both locked, as today
  const old = renderToStaticMarkup(list([{ ...m, attachedLinks: undefined }]))
  expect(old.split('data-testid="team-file-lock"').length - 1).toBe(2)
  expect(old).not.toContain('data-copy')
  // someone who may open the deck now gets the team file itself
  const live = renderToStaticMarkup(list([{ ...m, openable: [DECK] }]))
  expect(live).toMatch(/title="Preview" data-testid="team-file-chip">/)
  expect(live).not.toContain('data-copy')
  // a click on the copy's link opens the copy in the panel, through the room
  const page = await mount(list([m]))
  try {
    await page.click('team-file-chip')
    expect(getSidePanel()).toMatchObject({ kind: 'file', file: { source: 'room', roomId: team.id, fileId: m.files[0]!.id, name: 'acme-deck.html' } })
  } finally {
    await page.unmount()
  }
})

test('a chip\'s name opens the file viewer, its icon downloads; a file with no preview here opens its card', async () => {
  const pdf = file('acme-q4.pdf', { mime: 'application/pdf' })
  const zip = file('acme-assets.zip')
  const hwp = file('acme-form.hwp')
  const huge = file('acme-scan.png', { kind: 'image', mime: 'image/png', size: 30 * 1024 * 1024 })
  const m = message({ roomId: team.id, seq: 1, author: BEN, body: '', files: [pdf, zip, hwp, huge] })
  expect([pdf, zip, hwp, huge].map(opensWithoutServer)).toEqual([true, false, false, false])
  expect([pdf, zip, hwp, huge].map((f) => roomNoPreview(f, null))).toEqual([null, 'unsupported', 'unsupported', 'large'])
  // (text is shown cut, so any size opens)
  expect(opensWithoutServer({ name: 'log.txt', size: 40 * 1024 * 1024 })).toBe(true)
  const page = await mount(list([m]))
  try {
    const chips = page.container.querySelectorAll('[data-testid="room-file"]')
    // `data-opens`: a preview; every chip has its name to open and its own download icon
    expect(chips.map((c) => c.hasAttribute('data-opens'))).toEqual([true, false, false, false])
    expect(chips.map((c) => !!c.querySelector('[data-testid="room-file-open"]') && !!c.querySelector('[data-testid="room-file-download"]'))).toEqual([true, true, true, true])
    // the PDF: its name and size open it (named by those words, then "Preview"); the icon downloads, named with the file
    const open = page.get('room-file-open')
    expect(open.textContent).toContain('acme-q4.pdf')
    expect(open.textContent).toContain(en('common.preview'))
    expect(page.get('room-file-download').getAttribute('aria-label')).toBe(en('rooms.downloadFile', { name: 'acme-q4.pdf' }))
    await page.click(open)
    // the viewer, not the side panel: the document read through the room, with who sent it, where and its message
    expect(getSidePanel()).toBeNull()
    expect(getImageViewer()?.entry.item).toMatchObject({ kind: 'file', name: 'acme-q4.pdf', file: { source: 'room', roomId: team.id, fileId: pdf.id }, sender: { kind: 'user', user: { id: BEN.id } }, room: { roomId: team.id, fileId: pdf.id, messageId: m.id } })
    // (no room in the store here: no place line)
    expect(getImageViewer()?.entry.item).not.toHaveProperty('messageId')
    expect(getImageViewer()?.entry.item.card).toBeUndefined()
    // the ZIP: its card at once (nothing to read), with the download
    await page.click(chips[1]!.querySelector('[data-testid="room-file-open"]')!)
    expect(getImageViewer()?.entry.item).toMatchObject({ kind: 'file', name: 'acme-assets.zip', card: 'unsupported' })
    expect(getImageViewer()?.entry.item.download).toBeFunction()
    expect(getSidePanel()).toBeNull()
  } finally {
    await page.unmount()
  }
})

test("a room file's Markdown preview never loads the viewer's team pictures: each is a link to open", async () => {
  const { Markdown } = await import('../../src/components/Markdown')
  const md = 'Look: ![our logo](/api/files/download?path=users/ada/private-photo.png) and [the plan](/files/view?path=acme/plan.md) ![upload](/api/uploads/019a5f00-0000-7000-8000-000000000001/thumbnail)'
  const inTeam = renderToStaticMarkup(<MemoryRouter><Markdown text={md} /></MemoryRouter>)
  expect(inTeam).toContain('<img')
  const fromRoom = renderToStaticMarkup(<MemoryRouter><Markdown text={md} teamImagesAsLinks /></MemoryRouter>)
  expect(fromRoom).not.toContain('<img')
  expect(fromRoom).not.toContain('/api/files/download')
  expect(fromRoom).not.toContain('/api/uploads/')
  expect(fromRoom).toContain('[upload]')
  expect(fromRoom.split('data-testid="team-file-chip"').length - 1).toBe(2)
  expect(fromRoom).toContain('our logo</button>')
})

test('a Hangul file has a preview only while the HWP preview is on, within what it reads; otherwise its card', async () => {
  const on = { server: { version: '0', dev: false, hwpPreview: true } } as unknown as Me
  const off = { server: { version: '0', dev: false } } as unknown as Me
  const hwp = file('acme-form.hwp', { size: 300 * 1024 })
  const hwpx = file('acme-notice.HWPX', { size: 20 * 1024 * 1024 })
  const big = file('acme-scan.hwp', { size: 20 * 1024 * 1024 + 1 })
  const zip = file('acme-assets.zip')
  expect([hwp, hwpx, big, zip].map((f) => roomFileOpens(f, on))).toEqual([true, true, false, false])
  expect([hwp, hwpx, big, zip].map((f) => roomFileOpens(f, off))).toEqual([false, false, false, false])
  expect([hwp, hwpx].map((f) => roomFileOpens(f, null))).toEqual([false, false])
  // the panel's own question (a copy from a shared answer opens there by its link): Hangul and the flag only
  expect([roomHwpPreview('acme-form.hwp', on), roomHwpPreview('acme-form.hwp', off), roomHwpPreview('acme.docx', on)]).toEqual([true, false, false])
  expect([hwp, hwpx, big, zip].map((f) => roomNoPreview(f, on))).toEqual([null, null, 'large', 'unsupported'])
  const status = useSession.getState().status
  const m = message({ roomId: team.id, seq: 1, author: BEN, body: '', files: [hwp, big] })
  for (const [me, opens] of [[on, [true, false]], [off, [false, false]]] as const) {
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    const page = await mount(list([m]))
    try {
      const chips = page.container.querySelectorAll('[data-testid="room-file"]')
      expect(chips.map((c) => c.hasAttribute('data-opens'))).toEqual([...opens])
      // the name opens the viewer either way: the pages while the preview is on, else the card
      await page.click(page.get('room-file-open'))
      expect(getImageViewer()?.entry.item).toMatchObject({ kind: 'file', file: { source: 'room', roomId: team.id, fileId: hwp.id, name: 'acme-form.hwp' } })
      expect(getImageViewer()?.entry.item.card).toBe(opens[0] ? undefined : 'unsupported')
      expect(getSidePanel()).toBeNull()
    } finally {
      await page.unmount()
      closeImageViewer(false)
      useSession.setState({ status })
    }
  }
})

test('a room file is gone once its message, as this window has it, is deleted or no longer has it; one not held is not known to be gone', () => {
  const pdf = file('acme-q4.pdf')
  const m = message({ roomId: team.id, seq: 1, author: BEN, body: 'see', files: [pdf] })
  const reply = message({ roomId: team.id, seq: 2, author: BEN, body: 'and', files: [file('acme.md')], threadRootId: m.id })
  const data = (messages: RoomMessage[], replies: RoomMessage[] = []): RoomsData => ({
    rooms: [team], openRoomId: team.id,
    timeline: { roomId: team.id, messages, nextCursor: null } as RoomsData['timeline'],
    threadViews: { [placeKey(team.id, m.id)]: { roomId: team.id, rootId: m.id, root: m, replies } as unknown as RoomsData['threadViews'][string] },
  })
  expect(roomFileGone(data([m]), team.id, m.id, pdf.id)).toBe(false)
  // deleted: the server empties its files and marks it
  const deleted = { ...m, body: '', files: [], deletedAt: '2026-11-09T05:00:00.000Z' }
  expect(roomFileGone({ ...data([deleted]), threadViews: {} }, team.id, m.id, pdf.id)).toBe(true)
  // the file taken off it
  expect(roomFileGone({ ...data([{ ...m, files: [] }]), threadViews: {} }, team.id, m.id, pdf.id)).toBe(true)
  // a reply only the open thread holds
  expect(roomFileGone(data([m], [reply]), team.id, reply.id, reply.files[0]!.id)).toBe(false)
  expect(roomFileGone(data([m], [{ ...reply, files: [], deletedAt: '2026-11-09T05:00:00.000Z' }]), team.id, reply.id, reply.files[0]!.id)).toBe(true)
  // an older page the timeline left behind (it went back to the newest), another room: not known, so not gone
  expect(roomFileGone({ ...data([]), threadViews: {} }, team.id, m.id, pdf.id)).toBe(false)
  expect(roomFileGone(data([m]), uuidv7(), m.id, pdf.id)).toBe(false)
})
