// The shared message actions (components/messages/MessageActions.tsx; docs/decisions/20261126-shared-message-actions.md):
// one icon per action, a sheet only where a message has something to act on, the copy words, and the one opener of a
// file an AI made (lib/messageFiles.ts): a room's chip under a shared answer opens the right panel as the chat does,
// a person's own file keeps the room's viewer.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7, type RoomFile } from '@mycel/shared/api'
import { AssistantMessage, UserMessage } from '../../src/components/chat/Messages'
import { ACTION_ICON } from '../../src/components/messages/MessageActions'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { translate, useLocaleStore } from '../../src/i18n'
import { closeImageViewer, getImageViewer } from '../../src/lib/imageViewer'
import { aiMadeFiles } from '../../src/lib/messageFiles'
import { closeSidePanel, getSidePanel } from '../../src/lib/sidePanel'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'
import { BEN, CY, ME, message, room } from './rooms-fixtures'

const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterEach(() => { closeSidePanel(); closeImageViewer() })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

const team = room({ name: 'Marketing' })
const file = (name: string, o: Partial<RoomFile> = {}): RoomFile => ({ id: uuidv7(), name, size: 2048, mime: 'application/pdf', kind: 'other', thumb: false, ...o })
const list = (ms: ReturnType<typeof message>[]) => <MemoryRouter><RoomMessages roomId={team.id} messages={ms} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} /></MemoryRouter>
const answer = (m: ReturnType<typeof msg>, isLast = true) => <AssistantMessage m={m} chatId={CHAT} isLast={isLast} busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} />
const html = async (ui: React.ReactElement) => {
  const page = await mount(<MemoryRouter>{ui}</MemoryRouter>)
  const out = page.html()
  await page.unmount()
  return out
}

test('one icon per action, and "reply in thread" looks the same in the chat and in a room', async () => {
  const icons = Object.values(ACTION_ICON)
  expect(new Set(icons).size).toBe(icons.length)
  // the chat's thread button and the room bar's thread button draw the same lucide icon
  const chat = await html(<AssistantMessage m={msg({ role: 'assistant', content: 'x', status: 'done' })} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} onThread={() => {}} />)
  const roomHtml = renderToStaticMarkup(list([message({ roomId: team.id, seq: 1, body: 'hello' })]))
  const iconClass = (h: string, testId: string) => h.slice(h.indexOf(`data-testid="${testId}"`)).match(/lucide-([a-z0-9-]+)/)?.[1]
  expect(iconClass(chat, 'reply-in-thread')).toBe('message-square-text')
  expect(iconClass(roomHtml, 'message-thread')).toBe('message-square-text')
})

test('a sheet only where there is something to act on', async () => {
  const sheet = (h: string) => h.includes('data-testid="side-message-menu"')
  // a finished answer and a sent question have one
  expect(sheet(await html(answer(msg({ role: 'assistant', content: 'done', status: 'done' }))))).toBe(true)
  expect(sheet(await html(<UserMessage m={msg({ role: 'user', content: 'q' })} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} />))).toBe(true)
  // an answer being written, one hidden from me, a question still on its way: none
  expect(sheet(await html(answer(msg({ role: 'assistant', content: 'so far', status: 'streaming' }))))).toBe(false)
  expect(sheet(await html(answer(msg({ role: 'assistant', content: '', status: 'done', withheld: true }))))).toBe(false)
  const local = { ...msg({ role: 'user', content: 'q' }), local: { state: 'sending' as const, clientId: 'c1' } }
  expect(sheet(await html(<UserMessage m={local as ReturnType<typeof msg>} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} />))).toBe(false)
  // a room: a deleted message and an event line have no menu
  const roomHtml = renderToStaticMarkup(list([message({ roomId: team.id, seq: 1, body: 'gone', deletedAt: new Date().toISOString() })]))
  expect(roomHtml).not.toContain('data-testid="message-menu"')
})

test('the copy words are one key in every language', () => {
  for (const l of ['en', 'ko', 'ja', 'zh', 'es', 'id'] as const) expect(translate(l, 'messages.copied')).toBeTruthy()
  expect(translate('ko', 'messages.copied')).toBe('복사했어요')
})

test('a file an AI made opens in the right panel, a person\'s own file in the room viewer', async () => {
  const doc = file('q4-report.pdf')
  const own = file('my-notes.pdf')
  const sharedAnswer = message({ roomId: team.id, seq: 1, author: BEN, body: 'For Monday\n\nThe report.', sharedAnswer: { at: 12, cut: false }, files: [doc] })
  const upload = message({ roomId: team.id, seq: 2, author: CY, body: 'mine', files: [own] })
  expect(aiMadeFiles(sharedAnswer)).toBe(true)
  expect(aiMadeFiles(upload)).toBe(false)
  const page = await mount(list([sharedAnswer, upload]))
  try {
    const chips = page.container.querySelectorAll('[data-testid="room-file-open"]')
    expect(chips.map((c) => c.getAttribute('data-opens-in'))).toEqual(['panel', 'viewer'])
    await page.click(chips[0]!)
    expect(getSidePanel()).toMatchObject({ kind: 'file', file: { source: 'room', roomId: team.id, fileId: doc.id, name: 'q4-report.pdf' } })
    expect(getImageViewer()).toBeNull()
    closeSidePanel()
    await page.click(chips[1]!)
    expect(getImageViewer()?.entry.item).toMatchObject({ kind: 'file', name: 'my-notes.pdf' })
    expect(getSidePanel()).toBeNull()
  } finally {
    await page.unmount()
  }
})

test('a long press that starts on a picture or a link goes to the phone\'s own menu, never the sheet', async () => {
  const { useMessagePress: usePress, MessageActionSheet: Sheet, PRESS_BOX: box, NATIVE_CALLOUT: native } = await import('../../src/components/messages/MessageActions')
  const { FakeEvent } = await import('./dom-host')
  function Box({ skip }: { skip?: string }) {
    const press = usePress(true, skip)
    return (
      <div data-testid="box" className={press.box} {...press.bind}>
        <p data-testid="words">words</p>
        <img data-testid="pic" alt="chart" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
        <a data-testid="link" href="https://example.com/brief">brief</a>
        <Sheet signal={press.signal} actions={[{ id: 'copy', label: 'Copy', copy: { text: () => 'x' }, menuTestId: 'sheet-copy' }]} />
      </div>
    )
  }
  const { ROOM_PRESS_SKIP } = await import('../../src/components/messages/MessageActions')
  for (const skip of [undefined, ROOM_PRESS_SKIP]) {
    const page = await mount(<Box skip={skip} />)
    const hold = async (id: string) => {
      const ev = (type: string) => Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', clientX: 5, clientY: 5 })
      page.get(id).dispatchEvent(ev('pointerdown'))
      await page.settle(600)
      const menu = ev('contextmenu')
      page.get(id).dispatchEvent(menu)
      page.get(id).dispatchEvent(ev('pointerup'))
      await page.settle()
      return menu
    }
    try {
      // a picture and a link: no sheet, and the phone's own menu is not held back
      for (const id of ['pic', 'link']) {
        const menu = await hold(id)
        expect(page.find('sheet-copy'), `${id} (${skip ?? 'chat'})`).toBeNull()
        expect((menu as unknown as { defaultPrevented: boolean }).defaultPrevented, id).toBe(false)
      }
      // the words still open the sheet
      await hold('words')
      expect(page.find('sheet-copy')).not.toBeNull()
      // the box turns the phone's menu off for the message, back on for its pictures and links
      expect(page.get('box').className).toContain(box.split(' ').find((c) => c.includes('touch-callout:none'))!)
      for (const c of native.split(' ')) expect(page.get('box').className).toContain(c)
    } finally {
      await page.unmount()
    }
  }
})
