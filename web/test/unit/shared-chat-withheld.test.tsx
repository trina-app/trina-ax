// An answer of a shared project chat hidden from me (Message.withheld, docs/DECISIONS.md "People who see a shared chat
// later"; components/chat/Messages.tsx): one faint line in its place, the rooms' words, and nothing else: no copy,
// regenerate, share or suggest, no steps, sources or model. Its branch switch stays when it has siblings.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7 } from '@mycel/shared/api'
import { AssistantMessage } from '../../src/components/chat/Messages'
import { useLocaleStore } from '../../src/i18n'
import { msg } from './fixtures'
import { CHAT } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'ko' }) })
afterAll(() => { useLocaleStore.setState({ locale }); removeDom() })

async function render(m: ReturnType<typeof msg>) {
  const page = await mount(
    <MemoryRouter>
      <AssistantMessage m={m} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} shareable canSuggest />
    </MemoryRouter>,
  )
  const html = page.html()
  await page.unmount()
  return html
}

test('one faint line with the rooms\' words, no actions', async () => {
  const html = await render(msg({ role: 'assistant', content: '', withheld: true }))
  expect(html).toContain('data-testid="answer-withheld"')
  expect(html).toContain('볼 수 없는 자료를 참고한 답이라 가려졌어요')
  expect(html).toContain('text-faint')
  for (const id of ['answer-actions', 'regenerate', 'share-to-room', 'suggest-skill', 'answer-error']) expect(html).not.toContain(`data-testid="${id}"`)
})

test('with siblings: the branch switch stays', async () => {
  const id = uuidv7()
  const html = await render(msg({ id, role: 'assistant', content: '', withheld: true, branch: { index: 0, count: 2, siblingIds: [id, uuidv7()] } }))
  expect(html).toContain('data-testid="answer-withheld"')
  expect(html).toContain('1 / 2')
})

test('an answer I may see is unchanged', async () => {
  const html = await render(msg({ role: 'assistant', content: '견적은 1,200원이에요' }))
  expect(html).not.toContain('answer-withheld')
  expect(html).toContain('견적은 1,200원이에요')
})
