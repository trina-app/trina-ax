// QA TC-4695: a guest invited into a group chat with no name is told "group chat", not the general "private channel,
// group chat or project": a guest's room is a private channel when it has a name of its own and a group chat when it
// has none (lib/guests.ts roomWording, the same pair lib/rooms.ts isPrivateChannel reads).
import { describe, expect, test } from 'bun:test'
import { translate, LOCALES as ALL } from '../../src/i18n'
import { joinLineKey, roomWording } from '../../src/lib/guests'
import { joinedText } from '../../src/components/settings/Notifications'
import { isPrivateChannel } from '../../src/lib/rooms'

const LOCALES = ALL.map((l) => l.id)

describe('roomWording', () => {
  test('a room: its own name makes it a private channel, no name (or only spaces) a group chat; a project is a project', () => {
    expect(roomWording({ kind: 'room', name: 'Quote prep' })).toBe('privateChannel')
    expect(roomWording({ kind: 'room', name: '' })).toBe('groupChat')
    expect(roomWording({ kind: 'room', name: '   ' })).toBe('groupChat')
    expect(roomWording({ kind: 'room' })).toBe('groupChat')
    expect(roomWording({ kind: 'project', name: 'Acme bid' })).toBe('project')
  })
  test('no place, or a project the server did not name: the general words', () => {
    expect(roomWording(null)).toBeNull()
    expect(roomWording({ kind: 'project', name: '' })).toBeNull()
  })
  test('the same answer as the web rooms list gives for a group room', () => {
    for (const name of ['Quote prep', '', null, '  ']) expect(roomWording({ kind: 'room', name }) === 'privateChannel').toBe(isPrivateChannel({ kind: 'group', name }))
  })
})

describe('the join page line', () => {
  test('picks the line by the room name and kind', () => {
    expect(joinLineKey({ kind: 'room', name: 'Quote prep' })).toBe('guest.join.room')
    expect(joinLineKey({ kind: 'room', name: '' })).toBe('guest.join.roomGroup')
    expect(joinLineKey({ kind: 'project', name: 'Acme bid' })).toBe('guest.join.project')
    expect(joinLineKey(null)).toBe('guest.join.some')
  })
  test('an unnamed group chat reads as a group chat, not the general list, in every language', () => {
    expect(translate('en', 'guest.join.roomGroup')).toBe("You'll join only this group chat. You won't see the rest of the team.")
    for (const l of LOCALES) {
      expect(translate(l, 'guest.join.roomGroup')).not.toBe(translate(l, 'guest.join.some'))
    }
  })
})

describe('Admin › Members › Guests, an invite with no room name', () => {
  test('says one group chat, not "private channel or group chat"', () => {
    expect(translate('en', 'guest.admin.inviteRoomGroup')).toBe('Joins one group chat')
    for (const l of LOCALES) expect(translate(l, 'guest.admin.inviteRoomGroup')).toBeTruthy()
  })
})

describe('the joined notice', () => {
  const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
  test('an unnamed room the reader is in, or an admin reads: a group chat; one the reader cannot see into stays general', () => {
    expect(joinedText({ name: 'Gina', guestPlace: { kind: 'room', name: '' } }, en)).toBe('Gina joined a group chat as a guest.')
    expect(joinedText({ name: 'Gina', guestPlace: { kind: 'room', name: '', id: 'r1' } }, en)).toBe('Gina joined a group chat as a guest.')
    expect(joinedText({ name: 'Gina', guestPlace: { kind: 'room', name: '', id: null } }, en)).toBe('Gina joined a private channel or group chat as a guest.')
  })
})
