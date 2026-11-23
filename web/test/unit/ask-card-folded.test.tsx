// A room card for a command or a file change (components/chat/AskCard.tsx Folded, ConfirmDetail.folded): the question
// and the rows say what happens in words; the command or the file's new content (code, SVG) is behind "Details" with its
// size, and opens in full. A folded text with highlighted parts stays open.
import { expect, test } from 'bun:test'
import type { TurnRequest } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import AskCard from '../../src/components/chat/AskCard'
import { installDom, mount, removeDom } from './dom-host'

type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
const command = "mkdir -p p && cd p && cat > p.html <<'E'"
const card = (marks?: string[]): Ask => ({
  kind: 'ask_user', origin: 'server', requestId: 'r1', question: 'Trina wants to do this: Make the web page file. Allow it?', multiple: false, allowText: false, buttons: true,
  options: [{ label: 'Allow once', value: 'once' }, { label: 'Always allow', value: 'always' }, { label: 'Don’t allow', value: 'deny' }],
  details: [{ label: 'What changes', text: command, folded: true, fields: [{ name: 'Action', value: 'Make the web page file' }], ...(marks ? { marks } : {}) }],
})

test('the command behind "Details" with its size; open, all of it', async () => {
  installDom()
  const m = await mount(<AskCard req={{ request: card() }} onAnswer={async () => {}} />)
  try {
    expect(m.get('ask-detail-fields').textContent).toContain('Make the web page file')
    expect(m.find('ask-detail-text')).toBeNull()
    const btn = m.get('ask-detail-folded')
    expect(btn.textContent).toContain(translate('en', 'ask.foldedShow'))
    expect(btn.textContent).toContain(translate('en', 'ask.detailSize', { n: command.length }))
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    await m.click('ask-detail-folded')
    expect(m.get('ask-detail-folded').textContent).toBe(translate('en', 'ask.foldedHide'))
    expect(m.get('ask-detail-text').textContent).toBe(command)
  } finally {
    await m.unmount()
    removeDom()
  }
})

test('a folded text with highlighted parts: the parts stay in view, the text is behind Details', async () => {
  installDom()
  const m = await mount(<AskCard req={{ request: card(['p.html']) }} onAnswer={async () => {}} />)
  try {
    expect(m.find('ask-detail-text')).toBeNull()
    expect(m.get('ask-payload-marks').textContent).toContain('p.html')
    await m.click('ask-detail-folded')
    expect(m.get('ask-detail-text').textContent).toBe(command)
  } finally {
    await m.unmount()
    removeDom()
  }
})
