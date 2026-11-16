// Guest states on the screens (docs/DECISIONS.md "Guest states: true reasons, a reset AI, and coming back with a
// restored place"): the day a limit resets is read in the team's time zone (QA TC-2201), a dead invite link's reason
// (TC-2219), a removed guest's place and a deleted Team AI account (TC-2255, 2295), and every reason has its words.
import { expect, test } from 'bun:test'
import type { InviteInfo, Me, User } from '@mycel/shared/api'
import { formatResetDay } from '../../src/lib/format'
import { inviteDeadReason, meGuest, userGuest } from '../../src/lib/guests'
import { DICTS } from '../../src/i18n'

test('the reset day is the team\'s: 00:00 KST on Dec 1 is Dec 1 in Seoul, Nov 30 in UTC', () => {
  const at = '2026-11-30T15:00:00.000Z'
  expect(formatResetDay(at, 'en', 'Asia/Seoul')).toBe('Dec 1')
  expect(formatResetDay(at, 'en', 'UTC')).toBe('Nov 30')
  expect(formatResetDay(at, 'ko', 'Asia/Seoul')).toBe('12월 1일')
  // an unknown zone does not throw: the browser's
  expect(typeof formatResetDay(at, 'en', 'Not/AZone')).toBe('string')
})

test("a dead link's reason only while it does not work; an older server says none", () => {
  const info = (o: Partial<InviteInfo>): InviteInfo => ({ teamName: 'Acme', role: 'guest', expiresAt: '2026-11-22T00:00:00.000Z', valid: true, ...o })
  expect(inviteDeadReason(info({}))).toBeNull()
  expect(inviteDeadReason(info({ valid: false, reason: 'inviter_gone' }))).toBe('inviter_gone')
  expect(inviteDeadReason(info({ valid: false }))).toBeNull()
  for (const r of ['expired', 'used', 'revoked', 'inviter_gone', 'place_gone'] as const) expect(DICTS.en[`invite.reason.${r}`]).toBeTruthy()
})

test('a Team AI guest whose account was deleted stays Team AI for their own screens; Admin reads why a removed guest is out', () => {
  const me = { user: { role: 'guest' }, guest: { places: [{ kind: 'room', id: 'r', name: 'Quote prep' }], ai: { mode: 'none' }, teamAiGone: true } } as unknown as Me
  expect(meGuest(me)?.ai).toBe('team')
  const u = { role: 'guest', status: 'disabled', guest: { places: [{ kind: 'project', id: 'p', name: 'Launch', out: 'trashed' }], ai: { mode: 'none' }, placeOut: 'trashed', teamAiGone: true } } as unknown as User
  expect(userGuest(u)).toMatchObject({ out: 'trashed', aiGone: true })
  const plain = { role: 'guest', status: 'active', guest: { places: [{ kind: 'room', id: 'r', name: 'x' }], ai: { mode: 'none' } } } as unknown as User
  expect(userGuest(plain)).toMatchObject({ out: null, aiGone: false })
})
