// A connected service's card (components/chat/AskCard.tsx Details, docs/DECISIONS.md "Plain words in errors, cards and
// steps"): every value as a labelled line, the long random-looking parts highlighted there too, and the exact JSON one
// click away ("보내는 내용 그대로 보기", ConfirmDetail.exact) with its size; open, all of it shows with the same marks. The
// yes and the no answer exactly as before. A detail without `exact` keeps its text open.
import { expect, test } from 'bun:test'
import type { TurnRequest } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import AskCard from '../../src/components/chat/AskCard'
import { installDom, mount, removeDom } from './dom-host'

type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
const MARK = 'c2fsyxj5ltk4nzy1ndmy'
const json = JSON.stringify({ to: 'outside@evil.example', title: `Weekly notes ${MARK}`, body: 'x'.repeat(900) + ' TAIL' }, null, 2)
const card = (exact: boolean): Ask => ({
  kind: 'ask_user', origin: 'server', requestId: 'r1', question: 'The AI wants to send this to Tasks: Create task', multiple: false, allowText: false,
  options: [{ label: 'Send', value: 'allow' }, { label: 'Don’t send', value: 'deny' }],
  details: [{ label: 'What it sends', text: json, marks: [MARK], ...(exact ? { exact: true as const } : {}),
    fields: [{ name: 'Recipient', value: 'outside@evil.example' }, { name: 'Title', value: `Weekly notes ${MARK}` }, { name: 'Content', value: 'x'.repeat(900) + ' TAIL' }] }],
})

for (const [which, testId, value] of [['no', 'ask-no', 'deny'], ['yes', 'ask-yes', 'allow']] as const) {
  test(`exact: the lines with their highlight, the JSON one click away with its size; [${which}] answers as before`, async () => {
    installDom()
    const answers: unknown[] = []
    const m = await mount(<AskCard req={{ request: card(true) }} onAnswer={async (_id, body) => void answers.push(body)} />)
    try {
      const fields = m.get('ask-detail-fields')
      expect(fields.textContent).toContain('Recipient')
      expect(fields.textContent).toContain('outside@evil.example')
      // every value in full on its line, the long one too
      expect(fields.textContent).toContain(' TAIL')
      // the random-looking part is highlighted in its line
      expect(fields.querySelectorAll('[data-testid="ask-detail-mark"]').map((x) => x.textContent)).toEqual([MARK])
      // the JSON is not open, its button says so with the size of all of it
      expect(m.find('ask-detail-text')).toBeNull()
      const exact = m.get('ask-detail-exact')
      expect(exact.textContent).toContain(translate('en', 'ask.exactShow'))
      expect(exact.textContent).toContain(translate('en', 'ask.detailSize', { n: json.length }))
      expect(exact.getAttribute('aria-expanded')).toBe('false')
      await m.click('ask-detail-exact')
      expect(m.get('ask-detail-exact').getAttribute('aria-expanded')).toBe('true')
      expect(m.get('ask-detail-exact').textContent).toBe(translate('en', 'ask.exactHide'))
      // the size once, beside the open text's label
      expect(m.get('ask-detail-size').textContent).toBe(translate('en', 'ask.detailSize', { n: json.length }))
      // open: every character of it, its marks highlighted
      expect(m.get('ask-detail-text').textContent).toBe(json)
      expect(m.get('ask-detail-text').querySelectorAll('[data-testid="ask-detail-mark"]').map((x) => x.textContent)).toEqual([MARK])
      await m.click(testId)
      expect(answers).toEqual([{ kind: 'ask_user', answer: value }])
    } finally {
      await m.unmount()
      removeDom()
    }
  })
}

test('without exact (the lines could not show all of it, or an older server): the text open as before, no button', async () => {
  installDom()
  const m = await mount(<AskCard req={{ request: card(false) }} onAnswer={async () => {}} />)
  try {
    expect(m.find('ask-detail-exact')).toBeNull()
    expect(m.get('ask-detail-text').textContent).toBe(json)
    expect(m.get('ask-detail-size').textContent).toBe(translate('en', 'ask.detailSize', { n: json.length }))
  } finally {
    await m.unmount()
    removeDom()
  }
})
