// A message that only answers the AI's cards (Message.cardAnswer, server chat/open-questions.ts cardAnswerOf) is one
// quiet line under the answer that asked, never a bubble of the person's words: no card text, no edit, no picture; a
// shared chat names who chose. A typed answer stays the person's bubble.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { UserMessage } from '../../src/components/chat/Messages'
import { useLocaleStore } from '../../src/i18n'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'ko' }) })
afterAll(() => { useLocaleStore.setState({ locale }); removeDom() })

const DION = { id: 'dion', name: 'dion' }
const answer = (content: string, choices: (string | null)[] | null) => ({ ...msg({ role: 'user', content, author: DION }), ...(choices ? { cardAnswer: { choices } } : {}), local: undefined }) as never

test('two website cards answered 열기: one quiet line "열기 · 열기 선택함", no bubble, no card text, no edit', async () => {
  const page = await mount(
    <MemoryRouter>
      <div data-testid="solo"><UserMessage m={answer('AI가 이 대화에 없던 주소를 열려고 해요\n열기\n\nAI가 이 대화에 없던 주소를 열려고 해요\n열기', ['열기', '열기'])} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} /></div>
      <div data-testid="shared"><UserMessage m={answer('열기', ['열기', null])} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} showAuthor canEdit={false} /></div>
      <div data-testid="typed"><UserMessage m={answer('이 프로젝트에서만', null)} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} /></div>
    </MemoryRouter>,
  )
  try {
    const solo = page.get('solo')
    const line = solo.querySelector('[data-testid="card-answer"]')!
    expect(line.textContent).toBe('열기 · 열기 선택함')
    expect(solo.textContent).not.toContain('AI가')
    expect(solo.querySelector('[data-testid="user-text"]')).toBeNull()
    expect(solo.querySelector('[data-testid="edit-message"]')).toBeNull()
    expect(solo.querySelector('[data-testid="message-author-row"]')).toBeNull()
    // a shared chat: who chose, in the line; a skipped card says so
    const shared = page.get('shared').querySelector('[data-testid="card-answer"]')!
    expect(shared.textContent).toBe('dion · 열기 선택함 · 건너뜀')
    // typed text: the person's own words, a bubble as before
    expect(page.get('typed').querySelector('[data-testid="card-answer"]')).toBeNull()
    expect(page.get('typed').querySelector('[data-testid="user-text"]')!.textContent).toContain('이 프로젝트에서만')
  } finally { page.unmount() }
})
