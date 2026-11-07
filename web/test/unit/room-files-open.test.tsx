// Room files open on click (components/rooms/RoomMessages.tsx FileChip, lib/sidePanel.ts roomPreview): a file the panel
// can show opens there from its chip, with a small download icon of its own; one it cannot show (no viewer, a server
// conversion, past its size limit) stays one download button. A shared answer's link to a team file
// (lib/markdown.ts teamLinkTarget, components/Markdown.tsx): the team file when the viewer may open it now, else the copy
// that went with the message (RoomMessage.attachedLinks), else the lock; an older message without copies keeps the lock.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7, type RoomFile, type RoomMessage } from '@mycel/shared/api'
import { attachedCopies, RoomMessages } from '../../src/components/rooms/RoomMessages'
import { translate, useLocaleStore } from '../../src/i18n'
import { teamLinkTarget } from '../../src/lib/markdown'
import { opensWithoutServer } from '../../src/lib/preview'
import { closeSidePanel, getSidePanel } from '../../src/lib/sidePanel'
import { installDom, mount, removeDom } from './dom-host'
import { BEN, CY, ME, message, room } from './rooms-fixtures'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterEach(() => closeSidePanel())
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

test('a chip opens the file in the panel and has its own download icon; a file the panel cannot show stays a download', async () => {
  const pdf = file('acme-q4.pdf', { mime: 'application/pdf' })
  const zip = file('acme-assets.zip')
  const hwp = file('acme-form.hwp')
  const huge = file('acme-scan.png', { kind: 'image', mime: 'image/png', size: 30 * 1024 * 1024 })
  const m = message({ roomId: team.id, seq: 1, author: BEN, body: '', files: [pdf, zip, hwp, huge] })
  expect([pdf, zip, hwp, huge].map(opensWithoutServer)).toEqual([true, false, false, false])
  // (text is shown cut, so any size opens)
  expect(opensWithoutServer({ name: 'log.txt', size: 40 * 1024 * 1024 })).toBe(true)
  const page = await mount(list([m]))
  try {
    const chips = page.container.querySelectorAll('[data-testid="room-file"]')
    expect(chips.map((c) => c.hasAttribute('data-opens'))).toEqual([true, false, false, false])
    // the PDF: its name and size open it (named by those words, then "Preview"); the icon downloads, named with the file
    const open = page.get('room-file-open')
    expect(open.textContent).toContain('acme-q4.pdf')
    expect(open.textContent).toContain(en('common.preview'))
    expect(page.get('room-file-download').getAttribute('aria-label')).toBe(en('rooms.downloadFile', { name: 'acme-q4.pdf' }))
    await page.click(open)
    expect(getSidePanel()).toMatchObject({ kind: 'file', file: { source: 'room', roomId: team.id, fileId: pdf.id, name: 'acme-q4.pdf' } })
    // the others: one button that downloads, as before (no panel)
    closeSidePanel()
    expect(chips[1]!.tagName.toLowerCase()).toBe('button')
    expect(chips[1]!.textContent).toContain(en('common.download'))
  } finally {
    await page.unmount()
  }
})
