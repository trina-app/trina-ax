// A key typed into the message box (components/chat/SecretWarning.tsx, used by Composer): text that looks like a key
// or password waits for "Send anyway" with a warning; ordinary text goes straight out.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Locale } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { holdForSecret, SecretWarning } from '../../src/components/chat/SecretWarning'

const noop = () => {}
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
    ])
      expect({ text, held: holdForSecret(text) }).toEqual({ text, held: true })
  })

  test('ordinary text goes straight out', () => {
    for (const text of [
      'Connect Higgsfield for me',
      'Summarize https://docs.example.com/guides/getting-started for the team',
      'The meeting is on 2026-11-03 at 10:00, room 4B',
      'Use the OPENAI_API_KEY environment variable from the docs',
      'Ticket 0192f0a0-0000-7000-8000-00000000c001 is done',
      '',
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
