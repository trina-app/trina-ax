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

test('without exact (the lines could not show all of it, or an older server): raw JSON is behind Details, every character of it there', async () => {
  installDom()
  const m = await mount(<AskCard req={{ request: card(false) }} onAnswer={async () => {}} />)
  try {
    expect(m.find('ask-detail-exact')).toBeNull()
    expect(m.find('ask-detail-text')).toBeNull()
    await m.click('ask-detail-folded')
    expect(m.get('ask-detail-text').textContent).toBe(json)
    expect(m.get('ask-detail-size').textContent).toBe(translate('en', 'ask.detailSize', { n: json.length }))
  } finally {
    await m.unmount()
    removeDom()
  }
})

test('a script (a field with code: a declared CLI\'s stdin) shows in a code block, every space and line as sent', async () => {
  installDom()
  const script = 'const p = await page()\nif (p) {\n  await p.goto("https://en.wikipedia.org/wiki/Mycelium")  // the page\n\tconsole.log(await p.title())\n}\n'
  const req: Ask = {
    kind: 'ask_user', origin: 'server', requestId: 'r2', question: 'The AI wants to run this in ego lite: Run a browser script', multiple: false, allowText: false,
    options: [{ label: 'Run', value: 'allow' }, { label: 'Don’t run', value: 'deny' }],
    details: [{ label: 'What it sends', text: JSON.stringify({ script }, null, 2), exact: true, fields: [{ name: 'Script', value: script, code: true }, { name: 'Note', value: 'plain' }] }],
  }
  const m = await mount(<AskCard req={{ request: req }} onAnswer={async () => {}} />)
  try {
    const codes = m.container.querySelectorAll('[data-testid="ask-detail-code"]')
    expect(codes.length).toBe(1)
    // byte for byte: indentation, the run of spaces, the tab and the final line break, no escaping
    expect(codes[0]!.textContent).toBe(script)
    expect(codes[0]!.textContent).not.toContain('\\n')
    expect(codes[0]!.getAttribute('class')).toContain('whitespace-pre')
    expect(codes[0]!.getAttribute('aria-label')).toBe('Script')
    // the other value stays a plain line
    expect(m.get('ask-detail-fields').textContent).toContain('plain')
  } finally {
    await m.unmount()
    removeDom()
  }
})

// docs/decisions/20261122-connector-always-allow.md (the owner: "코드를 보여주면 뭐 어케 하라는거냐"): a card whose question
// says what happens in plain words keeps its code, parameters and ids behind one "Details"
test('hidden details: the plain question first, the code and ids only after Details', async () => {
  installDom()
  const code = "await openTab('https://example.com/')"
  const req: Ask = {
    kind: 'ask_user', origin: 'server', requestId: 'r3', question: 'In Aside: Open the mail page', multiple: false, allowText: false,
    options: [{ label: 'Allow', value: 'allow' }, { label: 'Always allow', value: 'always' }, { label: 'Don’t allow', value: 'deny' }], buttons: true,
    details: [{ label: 'What it sends', text: JSON.stringify({ code, profile_id: 'p1' }, null, 2), exact: true, hidden: true, fields: [{ name: 'Code', value: code }, { name: 'Profile id', value: 'p1' }] }],
  }
  const m = await mount(<AskCard req={{ request: req }} onAnswer={async () => {}} />)
  try {
    expect(m.container.textContent).toContain('In Aside: Open the mail page')
    expect(m.container.textContent).not.toContain('openTab')
    expect(m.container.textContent).not.toContain('Profile id')
    expect(m.get('ask-details-toggle').textContent).toBe(translate('en', 'ask.foldedShow'))
    await m.click('ask-details-toggle')
    expect(m.container.textContent).toContain('openTab')
    expect(m.container.textContent).toContain('Profile id')
  } finally {
    await m.unmount()
    removeDom()
  }
})
