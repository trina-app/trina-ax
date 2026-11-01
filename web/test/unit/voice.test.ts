// The composer's mic: shown when voice input is on (or the server is older), hidden for members when it is off, and a
// hint to the setting for admins and the owner.
import { describe, expect, test } from 'bun:test'
import { micState, SPEECH_SETTINGS_PATH, voiceBlockedHere } from '../../src/lib/voice'

const me = (role: 'owner' | 'admin' | 'member', voiceInput?: boolean) => ({ user: { role }, team: { name: 'T', defaultLocale: 'en' as const, ...(voiceInput === undefined ? {} : { voiceInput }) } })

describe('mic visibility', () => {
  test('on: everyone sees the mic', () => {
    for (const r of ['owner', 'admin', 'member'] as const) expect(micState(me(r, true))).toBe('on')
  })
  test('an older server (no voiceInput) or no session: the mic stays', () => {
    expect(micState(me('member'))).toBe('on')
    expect(micState(null)).toBe('on')
  })
  test('off: members do not see it, admins and the owner get a hint to Admin > Team settings', () => {
    expect(micState(me('member', false))).toBe('hidden')
    expect(micState(me('admin', false))).toBe('adminHint')
    expect(micState(me('owner', false))).toBe('adminHint')
    expect(SPEECH_SETTINGS_PATH).toBe('/admin/settings#speech')
  })
})

describe('confidential chats', () => {
  const team = (outside?: true) => ({ team: { name: 'T', defaultLocale: 'en' as const, voiceInput: true, ...(outside ? { voiceInputOutside: outside } : {}) } })
  test('voice input that goes to OpenRouter is not used in a confidential chat', () => {
    expect(voiceBlockedHere(team(true), true)).toBe(true)
  })
  test('an ordinary chat, a chat not known yet, voice input on this server, or an older server: the mic records', () => {
    expect(voiceBlockedHere(team(true), false)).toBe(false)
    // not known yet (a chat outside the loaded list being asked for): the server still refuses it if it must
    expect(voiceBlockedHere(team(true), null)).toBe(false)
    expect(voiceBlockedHere(team(), true)).toBe(false)
    expect(voiceBlockedHere(null, true)).toBe(false)
  })
})
