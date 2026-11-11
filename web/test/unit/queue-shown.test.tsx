// An answer's place in line (components/chat/Messages.tsx, queue-position) shows only once it has waited
// QUEUE_SHOWN_AFTER_MS (lib/queueShown.ts): the server holds answers of a burst back for up to 200 ms (chat/runtime.ts
// startSpread), and that moment must not flash "queued".
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { AssistantMessage } from '../../src/components/chat/Messages'
import { QUEUE_SHOWN_AFTER_MS } from '../../src/lib/queueShown'
import { useChats } from '../../src/store/chats'
import { useLocaleStore } from '../../src/i18n'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const before = { locale: useLocaleStore.getState().locale, queue: useChats.getState().queue }
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterAll(() => { useLocaleStore.setState({ locale: before.locale }); useChats.setState({ queue: before.queue }); removeDom() })

test('a place held a moment never shows; one that lasts shows after QUEUE_SHOWN_AFTER_MS', async () => {
  const m = msg({ role: 'assistant', content: '', status: 'streaming' })
  useChats.setState({ queue: { [m.id]: 2 } })
  const page = await mount(
    <MemoryRouter>
      <AssistantMessage m={m} chatId={CHAT} isLast busy switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} />
    </MemoryRouter>,
  )
  // held back by the start spread: started within 200 ms, nothing shown
  await page.settle(200)
  expect(page.find('queue-position')).toBeNull()
  await act(async () => { useChats.setState({ queue: { [m.id]: 0 } }) })
  await page.settle(QUEUE_SHOWN_AFTER_MS)
  expect(page.find('queue-position')).toBeNull()
  // a real wait: shown once it lasts
  await act(async () => { useChats.setState({ queue: { [m.id]: 3 } }) })
  expect(page.find('queue-position')).toBeNull()
  await page.until(() => page.find('queue-position'), 'the place in line', QUEUE_SHOWN_AFTER_MS + 1000)
  expect(page.get('queue-position').textContent).toContain('3')
  await page.unmount()
})
