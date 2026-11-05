// The server's yes/no cards (components/chat/AskCard.tsx): two buttons, the "no" neutral and the "yes" primary, with no
// radios, no [답하기] and no [건너뛰기]; each sends its own option's value. A server question with more choices (an
// address with "allow this site", a schedule with "and let it write") keeps its radios and [답하기].
import { expect, test } from 'bun:test'
import type { TurnRequest } from '@mycel/shared/api'
import AskCard from '../../src/components/chat/AskCard'
import { installDom, mount, removeDom } from './dom-host'

type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
const serverCard = (options: Ask['options']): Ask => ({
  kind: 'ask_user', origin: 'server', requestId: 'r1', question: 'Allow it?', multiple: false, allowText: false, options,
  details: [{ label: 'What it would change', fields: [{ name: 'File', value: 'shared/a.txt' }], text: 'hello' }],
})

for (const [which, testId, value] of [['no', 'ask-no', 'skip'], ['yes', 'ask-yes', 'allow']] as const) {
  test(`two options: [${which}] answers with its own value, no radios or skip`, async () => {
    installDom()
    const answers: unknown[] = []
    const m = await mount(<AskCard req={{ request: serverCard([{ label: 'Allow', value: 'allow' }, { label: "Don't", value: 'skip' }]) }} onAnswer={async (_id, body) => void answers.push(body)} />)
    try {
      const html = m.html()
      expect(html).not.toContain('type="radio"')
      expect(html).not.toContain('data-testid="ask-send"')
      expect(m.get('ask-card').getAttribute('data-kind')).toBe('confirm')
      expect(m.get('ask-no').textContent).toBe("Don't")
      expect(m.get('ask-yes').textContent).toBe('Allow')
      // the fields and the text as plain lines
      expect(m.get('ask-detail-fields').textContent).toContain('shared/a.txt')
      expect(m.get('ask-detail-text').textContent).toBe('hello')
      await m.click(testId)
      expect(answers).toEqual([{ kind: 'ask_user', answer: value }])
    } finally {
      await m.unmount()
      removeDom()
    }
  })
}

test('three options keep the radios and [답하기]', async () => {
  installDom()
  const m = await mount(<AskCard req={{ request: serverCard([{ label: 'Open', value: 'allow' }, { label: 'Allow this site', value: 'site' }, { label: "Don't open", value: 'deny' }]) }} onAnswer={async () => {}} />)
  try {
    const html = m.html()
    expect(html.split('type="radio"').length - 1).toBe(3)
    expect(html).toContain('data-testid="ask-send"')
    expect(m.find('ask-yes')).toBeNull()
  } finally {
    await m.unmount()
    removeDom()
  }
})
