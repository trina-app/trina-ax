// QA TC-4737: a guest who joined an unnamed group chat shows "Group chat" (and the other members) on Admin's guest row,
// not nothing. A named one stays "Private channel · name".
import { describe, expect, test } from 'bun:test'
import { translate } from '../../src/i18n'
import { roomTitle as titleOf } from '../../src/lib/rooms'
import { placesWords } from '../../src/pages/admin/Guests'

const t = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const title = (r: Parameters<typeof titleOf>[0]) => titleOf(r, { all: 'Everyone', gone: 'gone', sep: ', ', names: (names, n) => (n > 0 ? `${names} +${n}` : names) })
const words = (places: Parameters<typeof placesWords>[2], out: Parameters<typeof placesWords>[3] = null) => placesWords(t, title, places, out)

describe('Admin guest row, the place', () => {
  test('a named room is a private channel, a project a project', () => {
    expect(words([{ kind: 'room', name: 'Quote prep' }])).toBe('Private channel · Quote prep')
    expect(words([{ kind: 'project', name: 'Launch' }])).toBe('Project · Launch')
  })
  test('an unnamed group chat says Group chat, with the other members when the server sent them', () => {
    expect(words([{ kind: 'room', name: '' }])).toBe('Group chat')
    expect(words([{ kind: 'room', name: '   ' }])).toBe('Group chat')
    expect(words([{ kind: 'room', name: '', peers: [{ id: 'a', name: 'Rita' }, { id: 'b', name: 'Otto' }], memberCount: 3 }])).toBe('Group chat · Rita, Otto')
    expect(words([{ kind: 'room', name: '', peers: [1, 2, 3, 4].map((n) => ({ id: `u${n}`, name: `P${n}` })), memberCount: 7 }])).toBe('Group chat · P1, P2 +4')
  })
  test('a group chat and a project together', () => {
    expect(words([{ kind: 'room', name: '' }, { kind: 'project', name: 'Launch' }])).toBe('Group chat · Project · Launch')
  })
  test('a removed guest keeps the old words: an unnamed place they are out of says nothing, a gone one says gone', () => {
    expect(words([{ kind: 'room', name: '', out: 'left' }], 'left')).toBeNull()
    expect(words([{ kind: 'room', name: '', out: 'gone' }], 'gone')).toBe(t('guest.admin.outGone'))
  })
  test('every language has the new words', () => {
    for (const l of ['en', 'ko', 'ja', 'zh', 'es', 'id'] as const) expect(translate(l, 'guest.admin.groupChat')).toBeTruthy()
  })
})
