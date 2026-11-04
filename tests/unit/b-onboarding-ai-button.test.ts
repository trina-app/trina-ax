// Onboarding stream A: which button the chat error and the banner above the composer show (web/src/lib/aiAccess.ts).
import { expect, test } from 'bun:test'
import { aiButton, bannerText, isNoAiReason, trialLine } from '../../web/src/lib/aiAccess'

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
test('the no-AI errors get the button: no connection, none usable, the trial AI credit used up or over', () => {
  expect(isNoAiReason('no_credential')).toBe(true)
  expect(isNoAiReason('credential_unusable')).toBe(true)
  expect(isNoAiReason('trial_credit_used')).toBe(true)
  expect(isNoAiReason('trial_ended')).toBe(true)
  expect(isNoAiReason('rate_limit')).toBe(false)
  expect(isNoAiReason('auth')).toBe(false)
  expect(isNoAiReason(null)).toBe(false)
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
