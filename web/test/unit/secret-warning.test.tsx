// A key typed into a box whose text reaches the AI (components/chat/SecretWarning.tsx): text that is almost surely a
// key or password (a known key prefix, a private key, a JWT, a labelled value) waits for "Send anyway" with a warning;
// ordinary text goes straight out, also a commit hash, a Google Docs link, a folder with a generated name and code
// that only names a key. The boxes rendered and clicked (dom-host.ts): the message box, an ask_user card's own answer,
// editing a sent message and editing a waiting one each hold such text until "Send anyway", send nothing on "Edit",
// and send ordinary text at once.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Attachment, Locale } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { hasSecret } from '@mycel/shared'
import { holdForSecret, SecretWarning } from '../../src/components/chat/SecretWarning'
import Composer from '../../src/components/chat/Composer'
import AskCard from '../../src/components/chat/AskCard'
import { UserMessage } from '../../src/components/chat/Messages'
import QueuedMessages from '../../src/components/chat/QueuedMessages'
import { useSendQueue } from '../../src/store/sendQueue'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const noop = () => {}
// provider prefixes joined at run time, so secret scanners do not take this file for a leak
const k = (...parts: string[]) => parts.join('')
const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(before))

describe('which messages wait for "Send anyway"', () => {
  test('key-looking text waits', () => {
    for (const text of [
      'here is my key sk-proj-Ab12Cd34Ef56Gh78Ij90KlMnOp',
      'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
      'password: hunter2222',
      'API_KEY=9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456',
      '비밀번호: correct-horse-9',
      `my anthropic key ${k('sk-', 'ant-api03-', 'Ab12Cd34Ef56Gh78Ij90KlMn')}`,
      k('gl', 'pat-', 'Ab12Cd34Ef56Gh78Ij90'),
      k('xo', 'xb-', '123456789012-1234567890123-AbCdEfGhIjKlMnOp'),
      k('AK', 'IA', 'IOSFODNN7EXAMPLE'),
      k('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'),
      k('h', 'f_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'),
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
      k('eyJ', 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456'),
      'my api key: 9f8e7d6c5b4a',
      'pwd=Tr0ub4dor',
      'postgres://app:S3cretPass@db.example.com/prod',
    ])
      expect({ text, held: holdForSecret(text) }).toEqual({ text, held: true })
  })

  test('a commit hash, a Google Docs link or a generated folder name goes straight out (titles still hide them)', () => {
    for (const text of [
      'Merged in 5c6de5a19f3b4e7d8a9b0c1d2e3f4a5b6c7d8e9f, see the log',
      'Please review https://docs.google.com/document/d/1Xy7Kq2vR9bT4mZ8nL3pW6sA0dF5gH1jE/edit before Friday',
      'The export is in /Users/sam/Downloads/a8F3k29dK3xQ7mZ1pL0v/report.pdf',
    ]) {
      expect({ text, held: holdForSecret(text) }).toEqual({ text, held: false })
      // the broader check of chat titles is unchanged
      expect({ text, title: hasSecret(text) }).toEqual({ text, title: true })
    }
  })

  test('ordinary text goes straight out', () => {
    for (const text of [
      'Connect Higgsfield for me',
      'Summarize https://docs.example.com/guides/getting-started for the team',
      'The meeting is on 2026-11-03 at 10:00, room 4B',
      'Use the OPENAI_API_KEY environment variable from the docs',
      'Ticket 0192f0a0-0000-7000-8000-00000000c001 is done',
      '',
      // code and settings that name a key without holding one
      'const apiKey = process.env.API_KEY',
      'token = response.json()',
      'Password: required',
      'token: 4096 max',
    ])
      expect({ text, held: holdForSecret(text) }).toEqual({ text, held: false })
  })
})

describe('the warning above the message box', () => {
  for (const locale of ['en', 'ko'] as const) {
    test(`${locale}: says where a message goes and offers Send anyway / Edit`, () => {
      setLocale(locale)
      const html = renderToStaticMarkup(<SecretWarning onSendAnyway={noop} onEdit={noop} />)
      expect(html).toContain('role="alert"')
      expect(html).toContain(translate(locale, 'composer.secretWarning'))
      expect(/<button[^>]*data-testid="secret-send-anyway"[^>]*>/.test(html)).toBe(true)
      expect(html).toContain(translate(locale, 'composer.sendAnyway'))
      expect(html).toContain(translate(locale, 'composer.secretEdit'))
    })
  }
  test('the English text is the one in the design', () => {
    expect(translate('en', 'composer.secretWarning')).toBe(
      'This looks like a key or password. Anything in a message goes to the AI provider and stays in the chat. To connect a service, ask the AI to connect it and paste the key into the card it shows.',
    )
  })
})

// the boxes, rendered and clicked
const KEY_TEXT = 'my password: hunter22'
describe('each box holds a key until "Send anyway"', () => {
  const localeBefore = useLocaleStore.getState().locale
  const realFetch = globalThis.fetch
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'en' })
    // nothing these boxes do needs the server here; a call would fail loudly in the test
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    removeDom()
    useLocaleStore.setState({ locale: localeBefore })
  })

  /** the hold as each box shows it: the warning, nothing sent on Edit, sent once on Send anyway */
  async function heldThenSent(m: Mounted, send: () => Promise<void>, sent: () => unknown[], input: string) {
    await m.type(input, KEY_TEXT)
    await send()
    expect(m.find('secret-warning'), 'the warning').not.toBeNull()
    expect(m.get('secret-warning').textContent).toContain(translate('en', 'composer.secretWarning'))
    expect(sent()).toEqual([])
    // Edit: back to the text, nothing sent; sending again asks again
    await m.click('secret-edit')
    expect(m.find('secret-warning')).toBeNull()
    expect(sent()).toEqual([])
    await send()
    expect(m.find('secret-warning')).not.toBeNull()
    // a changed text takes the warning away
    await m.type(input, KEY_TEXT + '!')
    expect(m.find('secret-warning')).toBeNull()
    await send()
    expect(sent()).toEqual([])
    await m.click('secret-send-anyway')
    await m.settle()
    expect(sent()).toHaveLength(1)
    expect(m.find('secret-warning')).toBeNull()
  }

  test('the message box', async () => {
    const sent: { text: string; atts: Attachment[] }[] = []
    const m = await mount(<Composer draftId="new" ensureChat={async () => CHAT} running={false} onSend={async (text, atts) => void sent.push({ text, atts })} onStop={async () => {}} engine={{ engine: undefined, model: undefined }} />)
    await heldThenSent(m, () => m.click('send'), () => sent, 'composer-input')
    expect(sent[0]!.text).toBe(KEY_TEXT + '!')
    // ordinary text goes at once
    await m.type('composer-input', 'Connect Higgsfield for me')
    await m.click('send')
    await m.settle()
    expect(sent.map((s) => s.text)).toEqual([KEY_TEXT + '!', 'Connect Higgsfield for me'])
    expect(m.find('secret-warning')).toBeNull()
    await m.unmount()
  })

  test('an ask_user card\'s own answer', async () => {
    const answers: unknown[] = []
    const req = { request: { kind: 'ask_user' as const, requestId: 'q1', question: 'Which account?', allowText: true } }
    const m = await mount(<AskCard req={req} onAnswer={async (_id, body) => void answers.push(body)} />)
    await heldThenSent(m, () => m.click('ask-send'), () => answers, 'ask-text')
    expect(answers).toEqual([{ kind: 'ask_user', answer: KEY_TEXT + '!' }])
    await m.unmount()
  })

  test('editing a sent message', async () => {
    const edits: string[] = []
    const m = await mount(<UserMessage m={msg({ role: 'user', content: 'hello' })} chatId={CHAT} busy={false} onEdit={(_m, text) => void edits.push(text)} onSelectBranch={() => {}} />)
    await m.click('edit-message')
    await heldThenSent(m, () => m.click('edit-send'), () => edits, 'edit-input')
    expect(edits).toEqual([KEY_TEXT + '!'])
    // sent: the box is closed
    expect(m.find('edit-input')).toBeNull()
    await m.unmount()
  })

  test('editing a waiting message', async () => {
    const item = { id: 'w1', content: 'later', attachments: [], author: { id: 'u1', name: 'U' }, createdAt: new Date().toISOString() }
    useSendQueue.setState({ userId: null, queues: { [CHAT]: { items: [item], paused: 'stopped', after: null } }, editing: {} })
    const content = () => useSendQueue.getState().queues[CHAT]!.items[0]!.content
    const m = await mount(<QueuedMessages chatId={CHAT} onFocusComposer={() => {}} />)
    await m.click('outbox-edit')
    // saved: the waiting message has the new text (it goes when the answer ends)
    await heldThenSent(m, () => m.click('outbox-save'), () => (content() === 'later' ? [] : [content()]), 'outbox-edit-input')
    expect(content()).toBe(KEY_TEXT + '!')
    await m.unmount()
    useSendQueue.getState().reset()
  })
})
