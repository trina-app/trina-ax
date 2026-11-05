// Onboarding stream A: which button the chat error and the banner above the composer show (web/src/lib/aiAccess.ts);
// a connect button opens the simple "AI 연결" dialog in place (docs/DECISIONS.md "W2").
import { expect, test } from 'bun:test'
import { aiButton, bannerText, isNoAiReason, noAiErrorKey, trialLine } from '../../web/src/lib/aiAccess'

test('owner and own-connection people connect in place (the simple dialog, the team\'s or their own); everyone else asks once', () => {
  expect(aiButton('connect_team', false)).toEqual({ kind: 'connect', personal: false, label: 'aiAccess.connectTeam' })
  expect(aiButton('connect_own', false)).toEqual({ kind: 'connect', personal: true, label: 'aiAccess.connectOwn' })
  expect(aiButton('ask_owner', false)).toEqual({ kind: 'ask', label: 'aiAccess.askOwner', done: false })
  expect(aiButton('ask_owner', true)).toEqual({ kind: 'ask', label: 'aiAccess.asked', done: true })
})
test('the banner sentence follows the action and the ask', () => {
  expect(bannerText('ask_owner', false)).toBe('aiAccess.banner.askOwner')
  expect(bannerText('ask_owner', true)).toBe('aiAccess.banner.asked')
  expect(bannerText('connect_own', true)).toBe('aiAccess.banner.connectOwn')
})
test('the no-AI errors get the button: no connection, none usable, the trial AI credit used up or over', () => {
  expect(isNoAiReason('no_credential')).toBe(true)
  expect(isNoAiReason('credential_unusable')).toBe(true)
  expect(isNoAiReason('trial_credit_used')).toBe(true)
  expect(isNoAiReason('trial_ended')).toBe(true)
  expect(isNoAiReason('rate_limit')).toBe(false)
  expect(isNoAiReason('auth')).toBe(false)
  expect(isNoAiReason(null)).toBe(false)
})
test('a failed answer\'s words by who reads it: the owner can connect, an admin tells the owner, a member keeps the server\'s', () => {
  expect(noAiErrorKey('no_credential', 'owner', true)).toBe('aiConnect.error.no_credential')
  expect(noAiErrorKey('credential_unusable', 'owner', true)).toBe('aiConnect.error.credential_unusable')
  expect(noAiErrorKey('trial_credit_used', 'owner', true)).toBe('aiConnect.error.trial_credit_used')
  expect(noAiErrorKey('trial_ended', 'owner', true)).toBe('aiConnect.error.trial_ended')
  expect(noAiErrorKey('no_credential', 'admin', true)).toBe('aiConnect.error.admin.no_credential')
  expect(noAiErrorKey('credential_unusable', 'admin', true)).toBe('aiConnect.error.admin.credential_unusable')
  // the trial texts already say "the owner can connect …": right for an admin
  expect(noAiErrorKey('trial_ended', 'admin', true)).toBeNull()
  expect(noAiErrorKey('no_credential', 'member', true)).toBeNull()
  expect(noAiErrorKey('no_credential', undefined, true)).toBeNull()
  expect(noAiErrorKey('rate_limit', 'owner', true)).toBeNull()
  expect(noAiErrorKey(null, 'owner', true)).toBeNull()
  // AI answers the owner (another engine connected, or connected since): the server's per-engine words stay
  expect(noAiErrorKey('no_credential', 'owner', false)).toBeNull()
  expect(noAiErrorKey('credential_unusable', 'admin', false)).toBeNull()
})
test('the banner\'s first line when the trial AI credit is gone', () => {
  expect(trialLine('used')).toBe('aiAccess.banner.trialUsed')
  expect(trialLine('ended')).toBe('aiAccess.banner.trialEnded')
})

test('the store forgets the last person on sign-out, and the button hides while AI works', async () => {
  const { useAiAccess } = await import('../../web/src/store/aiAccess')
  useAiAccess.setState({ loaded: true, usable: false, action: 'connect_team', requested: true, trial: 'used' })
  useAiAccess.getState().reset()
  expect(useAiAccess.getState()).toMatchObject({ loaded: false, usable: true, action: 'ask_owner', requested: false, trial: null })
})

test('an answer that arrives after sign-out does not reach the next person', async () => {
  const { useAiAccess } = await import('../../web/src/store/aiAccess')
  const { api } = await import('../../web/src/lib/api')
  const real = api.call
  let release!: (v: unknown) => void
  ;(api as any).call = () => new Promise((r) => { release = r })
  try {
    useAiAccess.getState().reset()
    const pending = useAiAccess.getState().load()
    useAiAccess.getState().reset()
    release({ usable: false, action: 'connect_team', requested: true })
    await pending
    expect(useAiAccess.getState()).toMatchObject({ loaded: false, usable: true, requested: false })
  } finally { (api as any).call = real }
})

test('the store keeps the trial state of the answer (absent: none)', async () => {
  const { useAiAccess } = await import('../../web/src/store/aiAccess')
  const { api } = await import('../../web/src/lib/api')
  const real = api.call
  try {
    useAiAccess.getState().reset()
    ;(api as any).call = async () => ({ usable: false, action: 'ask_owner', requested: false, trial: 'ended' })
    await useAiAccess.getState().load(true)
    expect(useAiAccess.getState()).toMatchObject({ loaded: true, usable: false, trial: 'ended' })
    ;(api as any).call = async () => ({ usable: false, action: 'ask_owner', requested: false })
    await useAiAccess.getState().load(true)
    expect(useAiAccess.getState().trial).toBeNull()
  } finally { (api as any).call = real; useAiAccess.getState().reset() }
})
