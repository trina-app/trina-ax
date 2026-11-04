// Onboarding stream A: which button the chat error and the banner above the composer show (web/src/lib/aiAccess.ts).
import { expect, test } from 'bun:test'
import { aiButton, bannerText, isNoAiReason } from '../../web/src/lib/aiAccess'

test('owner and own-connection people get a link; everyone else asks once', () => {
  expect(aiButton('connect_team', false)).toEqual({ kind: 'link', to: '/admin/credentials', label: 'aiAccess.connectTeam' })
  expect(aiButton('connect_own', false)).toEqual({ kind: 'link', to: '/settings/credentials', label: 'aiAccess.connectOwn' })
  expect(aiButton('ask_owner', false)).toEqual({ kind: 'ask', label: 'aiAccess.askOwner', done: false })
  expect(aiButton('ask_owner', true)).toEqual({ kind: 'ask', label: 'aiAccess.asked', done: true })
})
test('the banner sentence follows the action and the ask', () => {
  expect(bannerText('ask_owner', false)).toBe('aiAccess.banner.askOwner')
  expect(bannerText('ask_owner', true)).toBe('aiAccess.banner.asked')
  expect(bannerText('connect_own', true)).toBe('aiAccess.banner.connectOwn')
})
test('only the two no-AI errors get the button', () => {
  expect(isNoAiReason('no_credential')).toBe(true)
  expect(isNoAiReason('credential_unusable')).toBe(true)
  expect(isNoAiReason('rate_limit')).toBe(false)
  expect(isNoAiReason(null)).toBe(false)
})

test('the store forgets the last person on sign-out, and the button hides while AI works', async () => {
  const { useAiAccess } = await import('../../web/src/store/aiAccess')
  useAiAccess.setState({ loaded: true, usable: false, action: 'connect_team', requested: true })
  useAiAccess.getState().reset()
  expect(useAiAccess.getState()).toMatchObject({ loaded: false, usable: true, action: 'ask_owner', requested: false })
})
