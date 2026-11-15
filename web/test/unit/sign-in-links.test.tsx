// The first step of a sign-in in another tab (owner 2026-11-14: "Open Claude to approve" was an underlined text link
// and "Copy link" grey text). Open is a real button (components/ui.tsx LinkButton, SignInLinks): a link to a new tab
// with a Button's look; Copy link is a bordered button. In the Claude dialog (pages/admin/Credentials.tsx
// ClaudeProgress) Open is the primary action until it is used or a code is typed, then it steps back so Connect is the
// only primary one, and the code field gets the focus.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { translate, useLocaleStore } from '../../src/i18n'
import { SignInLinks } from '../../src/components/ui'
import { ClaudeProgress } from '../../src/pages/admin/Credentials'
import type { CredentialLogin } from '@mycel/shared/api'
import { installDom, mount, removeDom } from './dom-host'

const URL_ = 'https://claude.com/cai/oauth/authorize?code=true&state=s'
const PRIMARY = 'bg-accent'
const SECONDARY = 'border-field-border'

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })
beforeEach(() => { useLocaleStore.setState({ locale: 'en' }) })

test('Open is a link to a new tab that looks like a primary button; Copy link is a bordered button', async () => {
  const m = await mount(<SignInLinks url={URL_} label="Open it" copyLabel="Copy link" testId="open" />)
  const open = m.get('open')
  expect(open.tagName.toLowerCase()).toBe('a')
  expect(open.getAttribute('href')).toBe(URL_)
  expect(open.getAttribute('target')).toBe('_blank')
  expect(open.getAttribute('rel')).toContain('noopener')
  expect(open.getAttribute('class')).toContain(PRIMARY)
  expect(open.getAttribute('class')).not.toContain('underline')
  expect(open.textContent).toBe('Open it')
  const copy = m.container.querySelectorAll('button')[0]!
  expect(copy.textContent).toBe('Copy link')
  expect(copy.getAttribute('class')).toContain(SECONDARY)
  await m.unmount()
})

test('not primary: Open is a bordered button', async () => {
  const m = await mount(<SignInLinks url={URL_} label="Open it" copyLabel="Copy link" primary={false} testId="open" />)
  expect(m.get('open').getAttribute('class')).toContain(SECONDARY)
  expect(m.get('open').getAttribute('class')).not.toContain(PRIMARY)
  await m.unmount()
})

const login: CredentialLogin = { loginId: 'l1', kind: 'anthropic-oauth', state: 'code', url: URL_, code: null, expiresAt: '2099-01-01T00:00:00.000Z', credential: null, reason: null } as CredentialLogin

test('Claude: Open is the primary action until it is used; then it steps back and the code field has the focus', async () => {
  const m = await mount(<ClaudeProgress l={login} code="" onCode={() => {}} onSubmit={() => {}} error={null} />)
  const open = () => m.get('claude-open')
  expect(open().textContent).toBe(translate('en', 'credentials.claude.open'))
  expect(open().getAttribute('class')).toContain(PRIMARY)
  expect(m.html()).toContain(translate('en', 'credentials.claude.copyLink'))
  await m.click('claude-open')
  await m.settle()
  expect(open().getAttribute('class')).not.toContain(PRIMARY)
  expect(open().getAttribute('class')).toContain(SECONDARY)
  expect(document.activeElement).toBe(m.get('claude-code-input') as unknown as Element)
  await m.unmount()
})

test('Claude: a code already typed (from another device) also hands the primary role to Connect', async () => {
  const m = await mount(<ClaudeProgress l={login} code="abc#def" onCode={() => {}} onSubmit={() => {}} error={null} />)
  expect(m.get('claude-open').getAttribute('class')).not.toContain(PRIMARY)
  await m.unmount()
})
