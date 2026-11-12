// Phone polish 2 (QA TC-265: TRINA-24, CHATS-17).
// TRINA-24: an AI question the message box answers (lib/askAnswer.ts BoxAnswers) has no second text box or secrets line
// on its card, only a line saying to type below; elsewhere (a room's AI status, Settings: no provider) and on the
// server's own checks the card keeps its box.
// CHATS-17: in a room's side chat panel (pressMenu) a phone's long press on a message opens its actions as a sheet,
// as a room message does; the icons are out of sight under every answer (the newest too), the send-here button stays.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { TurnRequest } from '@mycel/shared/api'
import AskCard from '../../src/components/chat/AskCard'
import { AssistantMessage, UNTIL_TAP, UserMessage } from '../../src/components/chat/Messages'
import { BoxAnswers } from '../../src/lib/askAnswer'
import { CHAT, msg } from './fixtures'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
beforeAll(() => {
  installDom()
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
})

type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
const aiAsk = (o: Partial<Ask> = {}): Ask => ({ kind: 'ask_user', requestId: 'r1', question: '어느 분기를 볼까요?', multiple: false, allowText: true, options: [{ label: '3분기', value: 'q3' }, { label: '4분기', value: 'q4' }], ...o })

test('TRINA-24: the card the message box answers has no text box of its own and one line saying to type below', async () => {
  const m = await mount(
    <BoxAnswers.Provider value="r1">
      <AskCard req={{ request: aiAsk() }} />
    </BoxAnswers.Provider>,
  )
  try {
    expect(m.find('ask-text')).toBeNull()
    expect(m.find('ask-no-secrets')).toBeNull()
    expect(m.get('ask-in-box').textContent).toBe('Or type your own answer in the message box below.')
    // the options and [답하기] stay
    expect(m.html().split('type="radio"').length - 1).toBe(2)
    expect(m.find('ask-send')).not.toBeNull()
  } finally {
    await m.unmount()
  }
})

test('TRINA-24: a question without options has only the line and Skip (nothing for its own Answer button to send)', async () => {
  const m = await mount(
    <BoxAnswers.Provider value="r1">
      <AskCard req={{ request: aiAsk({ options: [], allowText: undefined }) }} />
    </BoxAnswers.Provider>,
  )
  try {
    expect(m.find('ask-text')).toBeNull()
    expect(m.get('ask-in-box').textContent).toBe('Type your answer in the message box below.')
    expect(m.find('ask-send')).toBeNull()
  } finally {
    await m.unmount()
  }
})

test('TRINA-24: the card keeps its box where no message box answers it', async () => {
  for (const [what, ui] of [
    ['no box on screen (a room AI status)', <AskCard key="a" req={{ request: aiAsk() }} />],
    ['another question is the box\'s', <BoxAnswers.Provider key="b" value="r0"><AskCard req={{ request: aiAsk() }} /></BoxAnswers.Provider>],
    ['a server check', <BoxAnswers.Provider key="c" value="r1"><AskCard req={{ request: aiAsk({ origin: 'server' }) }} /></BoxAnswers.Provider>],
    ['its own answer route (Settings)', <BoxAnswers.Provider key="d" value="r1"><AskCard req={{ request: aiAsk() }} onAnswer={async () => {}} /></BoxAnswers.Provider>],
  ] as const) {
    const m = await mount(ui)
    try {
      expect(m.find('ask-text'), what).not.toBeNull()
      expect(m.find('ask-no-secrets'), what).not.toBeNull()
      expect(m.find('ask-in-box'), what).toBeNull()
    } finally {
      await m.unmount()
    }
  }
})

const sideAnswer = (m: ReturnType<typeof msg>, isLast: boolean, pressMenu: boolean, onRegenerate: (m: { id: string }) => void = () => {}) => (
  <AssistantMessage m={m} chatId={CHAT} isLast={isLast} busy={false} switchedFrom={null} onRegenerate={onRegenerate} onSelectBranch={() => {}} onAskOwnFolder={() => {}} shareable sendHere={{ roomId: 'room-1', target: null, onView: () => {} }} canSuggest={false} pressMenu={pressMenu} />
)

test('CHATS-17: in the side chat panel the icons wait for a long press under every answer; the send button stays in sight', async () => {
  const newest = msg({ role: 'assistant', content: 'the answer', status: 'done' })
  const q = msg({ role: 'user', content: 'a question' })
  const page = await mount(
    <MemoryRouter>
      <UserMessage m={q} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} sideChat pressMenu />
      <div data-testid="newest">{sideAnswer(newest, true, true)}</div>
    </MemoryRouter>,
  )
  try {
    const cls = (box: string, id: string) => page.get(box).querySelector(`[data-testid="${id}"]`)!.className
    expect(cls('newest', 'answer-actions-tap')).toContain(UNTIL_TAP)
    expect(cls('newest', 'answer-actions-tap-more')).toContain(UNTIL_TAP)
    expect(cls('newest', 'answer-actions')).not.toContain(UNTIL_TAP)
    expect(cls('newest', 'answer-actions-send')).not.toContain(UNTIL_TAP)
    expect(page.get('newest').querySelector('[data-testid="send-here-room"]')).not.toBeNull()
    // a tap no longer brings the icons (the long press does)
    await page.click(page.get('newest').querySelector('[data-testid="assistant-message"]')!)
    expect(cls('newest', 'answer-actions-tap')).toContain(UNTIL_TAP)
    await page.click('user-text')
    expect(page.get('user-message').querySelector('[data-testid="message-actions-tap"]')!.className).toContain(UNTIL_TAP)
    // still there, named, for a screen reader and the keyboard
    expect(page.get('newest').querySelector('[data-testid="regenerate"]')!.getAttribute('aria-label')).toBeTruthy()
  } finally {
    await page.unmount()
  }
})

test('CHATS-17: a long press on a side chat answer opens copy and retry as a sheet; on my question copy and edit', async () => {
  const a = msg({ role: 'assistant', content: 'the answer', status: 'done' })
  const q = msg({ role: 'user', content: 'a question' })
  const retried: string[] = []
  const page = await mount(
    <MemoryRouter>
      <UserMessage m={q} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} sideChat pressMenu />
      <div data-testid="answer">{sideAnswer(a, true, true, (x) => void retried.push(x.id))}</div>
    </MemoryRouter>,
  )
  const press = async (el: { dispatchEvent(e: FakeEvent): unknown }) => {
    const ev = (type: string) => Object.assign(new FakeEvent(type, { bubbles: true }), { pointerType: 'touch', clientX: 10, clientY: 10 })
    el.dispatchEvent(ev('pointerdown'))
    await page.settle(600)
    el.dispatchEvent(ev('pointerup'))
    await page.settle()
  }
  try {
    expect(page.find('side-answer-copy')).toBeNull()
    await press(page.get('answer').querySelector('[data-testid="assistant-message"]')!)
    await page.until(() => page.find('side-answer-copy'), 'the answer sheet')
    expect(page.find('side-answer-regenerate')).not.toBeNull()
    // the send button is not in the sheet: it is under the answer
    const sheet = page.get('answer').querySelector('[role="menu"]')!
    expect(sheet.querySelectorAll('button').map((b) => b.getAttribute('data-testid'))).toEqual(['side-answer-copy', 'side-answer-regenerate'])
    // (the finger lifting right after the long press is no pick: MenuButton)
    await page.settle(450)
    await page.click('side-answer-regenerate')
    expect(retried).toEqual([a.id])
    expect(page.find('side-answer-copy')).toBeNull()
    await press(page.get('user-text'))
    await page.until(() => page.find('side-message-edit'), 'the question sheet')
    expect(page.find('side-message-copy')).not.toBeNull()
  } finally {
    await page.unmount()
  }
})

test('CHATS-17: the full AI chat keeps its tap pattern (the newest answer shows its icons)', async () => {
  const a = msg({ role: 'assistant', content: 'the answer', status: 'done' })
  const page = await mount(<MemoryRouter><div data-testid="answer">{sideAnswer(a, true, false)}</div></MemoryRouter>)
  try {
    expect(page.get('answer').querySelector('[data-testid="answer-actions-tap"]')!.className).not.toContain(UNTIL_TAP)
    expect(page.find('side-message-menu')).toBeNull()
  } finally {
    await page.unmount()
  }
})
