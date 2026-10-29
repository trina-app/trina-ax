// Team settings > Transfer ownership (QA R2-PERM-10): only active admins and members can become the owner, the picker
// names each person with the localized role, and the button stays off until a person is chosen.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { User } from '@mycel/shared/api'
import { DICTS, translate, type MessageKey } from '../../src/i18n'
import { transferCandidates, TransferOwnerForm } from '../../src/pages/admin/TransferOwner'

const user = (id: string, role: User['role'], status: User['status'] = 'active') => ({ id, name: id.toUpperCase(), username: id, email: null, role, status, mustChangePassword: false, locale: 'en' }) as User
const USERS = [user('olga', 'owner'), user('ana', 'admin'), user('bob', 'member'), user('dan', 'member', 'disabled')]
const noop = () => {}
const form = (candidates: User[], value = '') => renderToStaticMarkup(<TransferOwnerForm candidates={candidates} value={value} onChange={noop} onStart={noop} />)
/** the start button, as rendered */
const startButton = (html: string) => /<button[^>]*data-testid="transfer-start"[^>]*>/.exec(html)?.[0] ?? ''

test('candidates are the active admins and members, not the owner', () => {
  expect(transferCandidates(USERS, 'olga').map((u) => u.id)).toEqual(['ana', 'bob'])
})

test('the button stays disabled until a person is chosen', () => {
  const c = transferCandidates(USERS, 'olga')
  expect(startButton(form(c))).toContain('disabled=""')
  expect(startButton(form(c, 'bob'))).not.toContain('disabled=""')
})

test('with nobody to choose, the card says so and has no button', () => {
  const html = form([])
  expect(html).toContain('data-testid="transfer-none"')
  expect(startButton(html)).toBe('')
})

test('each person shows with the role name', () => {
  const html = form(transferCandidates(USERS, 'olga'))
  expect(html).toContain('ANA (Admin)')
  expect(html).toContain('BOB (Member)')
})

test('the Korean texts name the role 팀장 and never "owner"', () => {
  const keys = Object.keys(DICTS.en).filter((k) => k.startsWith('transfer.')) as MessageKey[]
  expect(keys.length).toBeGreaterThan(5)
  for (const k of keys) expect(translate('ko', k, { name: 'Ana' })).not.toMatch(/owner/i)
  expect(translate('ko', 'transfer.title' as MessageKey)).toBe('팀장 넘김')
  expect(translate('ko', 'transfer.done' as MessageKey, { name: 'Ana' })).toBe('이제 Ana님이 팀장이에요.')
})
