// A message's actions on a phone (components/chat/Messages.tsx): a touch screen has no hover, so under 768px copy, edit
// and retry wait for a tap on the message, except under the newest answer. Until then they are out of sight only
// (sr-only): a screen reader still reads them and a keyboard still reaches them. The branch switch ("‹ 1 / 2 ›") always
// shows.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { AssistantMessage, UNTIL_TAP, UserMessage } from '../../src/components/chat/Messages'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
beforeAll(() => {
  installDom()
  // nothing here needs the server; a call answers "not found"
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
})

const answer = (m: ReturnType<typeof msg>, isLast: boolean) => <AssistantMessage m={m} chatId={CHAT} isLast={isLast} busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} />

test('hidden from sight only: out of view on a touch phone, kept for screen readers and the keyboard', () => {
  expect(UNTIL_TAP).toContain('max-md:pointer-coarse:')
  expect(UNTIL_TAP).toContain('sr-only')
  expect(UNTIL_TAP).toContain('not-focus-within:')
  expect(UNTIL_TAP).not.toMatch(/(^|:)hidden\b/)
})

test('on a phone the actions of my message and of an older answer wait for a tap; the newest answer keeps its row', async () => {
  const q = msg({ role: 'user', content: 'first question' })
  const older = msg({ role: 'assistant', content: 'first answer', model: 'claude-x' })
  const newest = msg({ role: 'assistant', content: 'second answer' })
  const page = await mount(
    <MemoryRouter>
      <UserMessage m={q} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} />
      <div data-testid="older">{answer(older, false)}</div>
      <div data-testid="newest">{answer(newest, true)}</div>
    </MemoryRouter>,
  )
  try {
    const cls = (box: string, id: string) => page.get(box).querySelector(`[data-testid="${id}"]`)!.className
    const mine = (id: string) => page.get('user-message').querySelector(`[data-testid="${id}"]`)!.className
    // without a branch switch the whole row waits (it takes no room), its buttons inside it
    expect(mine('message-actions')).toContain(UNTIL_TAP)
    expect(mine('message-actions-tap')).toContain(UNTIL_TAP)
    expect(cls('older', 'answer-actions')).toContain(UNTIL_TAP)
    expect(cls('older', 'answer-actions-tap')).toContain(UNTIL_TAP)
    expect(cls('newest', 'answer-actions')).not.toContain(UNTIL_TAP)
    expect(cls('newest', 'answer-actions-tap')).not.toContain(UNTIL_TAP)
    // still there, with their names, for a screen reader and the keyboard
    expect(page.get('edit-message').getAttribute('aria-label')).toBeTruthy()
    expect(page.get('older').querySelector('[data-testid="regenerate"]')!.getAttribute('aria-label')).toBeTruthy()
    // a computer still shows them on hover or focus
    expect(mine('message-actions')).toContain('group-hover:opacity-100')
    expect(cls('older', 'answer-actions')).toContain('group-hover:opacity-100')
    // a tap on the message brings its row
    await page.click('user-text')
    expect(mine('message-actions')).not.toContain(UNTIL_TAP)
    expect(mine('message-actions-tap')).not.toContain(UNTIL_TAP)
    expect(cls('older', 'answer-actions')).toContain(UNTIL_TAP)
    await page.click(page.get('older').querySelector('[data-testid="assistant-message"]')!)
    expect(cls('older', 'answer-actions')).not.toContain(UNTIL_TAP)
    expect(cls('older', 'answer-actions-tap')).not.toContain(UNTIL_TAP)
  } finally {
    await page.unmount()
  }
})

test('the branch switch always shows: only the other actions wait for the tap', async () => {
  const a = msg({ role: 'user', content: 'asked once' })
  const q0 = msg({ role: 'user', content: 'asked again' })
  const q = { ...q0, branch: { index: 1, count: 2, siblingIds: [a.id, q0.id] } }
  const other = msg({ role: 'assistant', content: 'another answer' })
  const older = msg({ role: 'assistant', content: 'an answer' })
  const olderBranched = { ...older, branch: { index: 0, count: 2, siblingIds: [older.id, other.id] } }
  const page = await mount(
    <MemoryRouter>
      <UserMessage m={q} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} />
      <div data-testid="older">{answer(olderBranched, false)}</div>
    </MemoryRouter>,
  )
  try {
    for (const [row, tap] of [
      [page.get('user-message').querySelector('[data-testid="message-actions"]')!, page.get('user-message').querySelector('[data-testid="message-actions-tap"]')!],
      [page.get('older').querySelector('[data-testid="answer-actions"]')!, page.get('older').querySelector('[data-testid="answer-actions-tap"]')!],
    ] as const) {
      const nav = row.querySelector('[data-testid="branch-nav"]')!
      expect(row.className).not.toContain(UNTIL_TAP)
      expect(tap.className).toContain(UNTIL_TAP)
      // the switch is not inside the part that waits
      expect(tap.contains(nav)).toBe(false)
      expect(nav.querySelector('[data-testid="branch-label"]')!.textContent).toMatch(/\d \/ 2/)
      expect(nav.querySelectorAll('button')).toHaveLength(2)
    }
  } finally {
    await page.unmount()
  }
})
