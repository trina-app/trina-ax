// A server card's details (components/chat/AskCard.tsx Details): a room change card shows the start of what a call
// would write and the rest one click away (ConfirmDetail.collapsedAt), with the size of all of it; a detail without
// collapsedAt (an instruction file, the other safety cards) shows all of it at once; a detail without text shows no
// empty box.
import { expect, test } from 'bun:test'
import type { TurnRequest } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import AskCard from '../../src/components/chat/AskCard'
import { installDom, mount, removeDom } from './dom-host'

const card = (details: NonNullable<Extract<TurnRequest, { kind: 'ask_user' }>['details']>): Extract<TurnRequest, { kind: 'ask_user' }> => ({
  kind: 'ask_user', origin: 'server', requestId: 'r1', question: 'Allow it?', multiple: false, allowText: false,
  options: [{ label: 'Allow', value: 'allow' }, { label: "Don't", value: 'skip' }], details,
})

test('a long preview shows its start and the size of all of it; "Show all" opens the rest, "Show less" closes it', async () => {
  const text = 'a'.repeat(450) + ' PLANTED-TAIL'
  installDom()
  const m = await mount(<AskCard req={{ request: card([{ label: 'What it would change', fields: [{ name: 'Action', value: 'Save' }], text, collapsedAt: 400 }]) }} onAnswer={async () => {}} />)
  try {
    expect(m.get('ask-detail-text').textContent).not.toContain('PLANTED-TAIL')
    expect(m.get('ask-detail-text').textContent).toHaveLength(401)
    expect(m.get('ask-detail-size').textContent).toBe(translate('en', 'ask.detailSize', { n: text.length }))
    expect(m.get('ask-detail-more').textContent).toBe(translate('en', 'ask.detailAll'))
    await m.click('ask-detail-more')
    expect(m.get('ask-detail-text').textContent).toBe(text)
    expect(m.get('ask-detail-more').textContent).toBe(translate('en', 'ask.detailLess'))
    await m.click('ask-detail-more')
    expect(m.get('ask-detail-text').textContent).not.toContain('PLANTED-TAIL')
  } finally {
    await m.unmount()
    removeDom()
  }
})

test('without collapsedAt (an instruction file) all of it shows at once; a short text has no button; no text, no box', async () => {
  const text = 'b'.repeat(450) + ' RULE-TAIL'
  installDom()
  const m = await mount(<AskCard req={{ request: card([
    { label: 'rule', text },
    { label: 'short', text: 'tiny', collapsedAt: 400 },
    { label: 'rename', text: '', fields: [{ name: 'New name', value: 'b.md' }] },
  ]) }} onAnswer={async () => {}} />)
  try {
    const html = m.html()
    expect(html).toContain('RULE-TAIL')
    expect(html).toContain('>tiny<')
    expect(html).not.toContain('data-testid="ask-detail-more"')
    expect(html.split('data-testid="ask-detail-text"').length - 1).toBe(2)
    expect(html.split('data-testid="ask-detail-size"').length - 1).toBe(2)
  } finally {
    await m.unmount()
    removeDom()
  }
})
