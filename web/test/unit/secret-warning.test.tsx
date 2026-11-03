// A key typed into the message box (components/chat/SecretWarning.tsx, used by Composer): text that is almost surely a
// key or password (a known key prefix, a private key, a JWT, a labelled value) waits for "Send anyway" with a warning;
// ordinary text goes straight out, also a commit hash, a Google Docs link or a folder with a generated name.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Locale } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { hasSecret } from '@mycel/shared'
import { holdForSecret, SecretWarning } from '../../src/components/chat/SecretWarning'

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
