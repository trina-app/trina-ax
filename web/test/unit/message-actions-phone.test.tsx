// A message's row of actions on a phone (components/chat/Messages.tsx): a touch screen has no hover, so under 768px the
// row (copy, edit, retry, the branch switch) is left out until the message is tapped, except under the newest answer.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { AssistantMessage, UserMessage } from '../../src/components/chat/Messages'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const UNTIL_TAP = 'max-md:pointer-coarse:hidden'
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

test('on a phone the actions of my message and of an older answer wait for a tap; the newest answer keeps its row', async () => {
  const q = msg({ role: 'user', content: 'first question' })
  const older = msg({ role: 'assistant', content: 'first answer' })
  const newest = msg({ role: 'assistant', content: 'second answer' })
  const answer = (m: typeof older, isLast: boolean) => <AssistantMessage m={m} chatId={CHAT} isLast={isLast} busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} />
  const page = await mount(
    <MemoryRouter>
      <UserMessage m={q} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} />
      <div data-testid="older">{answer(older, false)}</div>
      <div data-testid="newest">{answer(newest, true)}</div>
    </MemoryRouter>,
  )
  try {
    const row = (box: string, id: string) => page.get(box).querySelector(`[data-testid="${id}"]`)!.className
    const mine = () => page.get('message-actions').className
    expect(mine()).toContain(UNTIL_TAP)
    expect(row('older', 'answer-actions')).toContain(UNTIL_TAP)
    expect(row('newest', 'answer-actions')).not.toContain(UNTIL_TAP)
    // a computer still shows them on hover or focus
    expect(mine()).toContain('group-hover:opacity-100')
    expect(row('older', 'answer-actions')).toContain('group-hover:opacity-100')
    // a tap on the message brings its row
    await page.click('user-text')
    expect(mine()).not.toContain(UNTIL_TAP)
    expect(row('older', 'answer-actions')).toContain(UNTIL_TAP)
    await page.click(page.get('older').querySelector('[data-testid="assistant-message"]')!)
    expect(row('older', 'answer-actions')).not.toContain(UNTIL_TAP)
  } finally {
    await page.unmount()
  }
})
