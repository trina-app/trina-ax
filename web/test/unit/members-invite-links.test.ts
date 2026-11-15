// Admin › Members & invites lists only the invite links that still work (pages/admin/Members.tsx openInviteLinks,
// workingTeamLink): used, expired and stopped single-use links and a team link that stopped working are not listed.
import { describe, expect, test } from 'bun:test'
import type { Invite, TeamLink } from '@mycel/shared/api'
import { openInviteLinks, workingTeamLink } from '../../src/pages/admin/Members'

const NOW = Date.parse('2026-11-15T09:00:00.000Z')
const invite = (id: string, over: Partial<Invite> = {}): Invite => ({
  id, role: 'member', groupIds: [], createdBy: null, createdAt: '2026-11-14T09:00:00.000Z', expiresAt: '2026-11-17T09:00:00.000Z', usedAt: null, usedBy: null, ...over,
})

describe('openInviteLinks', () => {
  test('keeps open member and guest links, drops used, expired and stopped ones', () => {
    const items = [
      invite('open'),
      invite('guest', { role: 'guest', guestPlace: { kind: 'room', id: '01900000-0000-7000-8000-0000000000a1' } }),
      invite('used', { usedAt: '2026-11-14T10:00:00.000Z', usedBy: { id: 'kim', name: 'Kim' } }),
      invite('usedGuest', { role: 'guest', usedAt: '2026-11-14T10:00:00.000Z' }),
      invite('expired', { expiresAt: '2026-11-15T08:59:59.000Z' }),
      invite('endsNow', { expiresAt: '2026-11-15T09:00:00.000Z' }),
      // a guest link that stopped by itself: its project in the trash, its maker left the room, its team AI removed
      invite('placeGone', { role: 'guest', stopped: 'place_gone' }),
      invite('makerLeft', { role: 'guest', stopped: 'inviter_gone' }),
      invite('aiGone', { role: 'guest', stopped: 'ai_gone' }),
    ]
    expect(openInviteLinks(items, NOW).map((i) => i.id)).toEqual(['open', 'guest'])
  })
  test('nothing loaded yet or no links: an empty list', () => {
    expect(openInviteLinks(undefined, NOW)).toEqual([])
    expect(openInviteLinks(null, NOW)).toEqual([])
    expect(openInviteLinks([], NOW)).toEqual([])
  })
})

describe('workingTeamLink', () => {
  const link = { id: '01900000-0000-7000-8000-0000000000b1', url: 'https://acme.example/join#t=tl1', groupIds: [], skill: null, maxUses: 20, uses: 1, createdBy: null, createdAt: '2026-11-14T09:00:00.000Z', expiresAt: '2026-11-21T09:00:00.000Z', state: 'active' } satisfies TeamLink
  test('an active link is listed, a stopped one is not', () => {
    expect(workingTeamLink(link)).toBe(link)
    for (const state of ['expired', 'used_up', 'stopped'] as const) expect(workingTeamLink({ ...link, state })).toBeNull()
    expect(workingTeamLink(null)).toBeNull()
    expect(workingTeamLink(undefined)).toBeNull()
  })
})
