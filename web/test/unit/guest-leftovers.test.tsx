// Guest leftovers from QA (docs/DECISIONS.md "Guests: only what they were invited to"): the Activity line when a guest
// joins names the place they joined as a guest (components/settings/Notifications.tsx joinedText), and a guest's
// delete-account page lists only what a guest has (components/settings/AccountDeletion.tsx): no personal folder, no
// team folders or shared skills.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { joinedText, noticeLink } from '../../src/components/settings/Notifications'
import { AccountDeletionView } from '../../src/components/settings/AccountDeletion'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const en = (k: MessageKey, p?: Params) => translate('en', k, p)

describe('joined notice', () => {
  test("its link: Admin › Members for the owner and admins, the place for the member who invited them, nowhere for anyone else", () => {
    const item = (guestPlace?: { kind: 'room' | 'project'; name: string; id?: string | null }) => ({ id: 'n1', eventType: 'team.joined', sourceId: 'gina', code: 'team.joined', createdAt: '2026-11-15T00:00:00.000Z', readAt: null, chatId: null, link: null, outcome: null, joined: { name: 'Gina', ...(guestPlace ? { guestPlace } : {}) } }) as never
    expect(noticeLink(item())?.to).toBe('/admin/members')
    expect(noticeLink(item({ kind: 'room', name: 'Quote prep' }))?.to).toBe('/admin/members')
    expect(noticeLink(item({ kind: 'room', name: 'Quote prep', id: 'r1' }))?.to).toBe('/rooms/r1')
    expect(noticeLink(item({ kind: 'project', name: 'Acme bid', id: 'p1' }))?.to).toBe('/projects/p1')
    expect(noticeLink(item({ kind: 'room', name: '', id: null }))).toBeNull()
  })

  test('a member joined the team; a guest joined their place as a guest (a group chat with no name says so)', () => {
    expect(joinedText({ name: 'Nora' }, en)).toBe('Nora joined the team.')
    expect(joinedText({ name: 'Gina', guestPlace: { kind: 'project', name: 'Quote prep' } }, en)).toBe("Gina joined 'Quote prep' as a guest.")
    expect(joinedText({ name: 'Gina', guestPlace: { kind: 'room', name: '' } }, en)).toBe('Gina joined a group chat as a guest.')
    expect(joinedText({ name: 'Gina', guestPlace: { kind: 'project', name: '' } }, en)).toBe('Gina joined a project as a guest.')
  })
})

const guestMe = (place: { kind: 'room' | 'project'; id: string; name: string }, ai: 'none' | 'own' | 'team'): Me => ({
  user: { id: 'gina', username: 'gina', name: 'Gina', email: null, role: 'guest', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
  guest: { place, ai: ai === 'team' ? { mode: 'team', credentialId: 'c1', limitUsd: 20 } : { mode: ai } },
} as unknown as Me)

describe("a guest's delete-account page", () => {
  const status = useSession.getState().status
  const locale = useLocaleStore.getState().locale
  beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
  afterAll(() => { removeDom(); useSession.setState({ status }); useLocaleStore.setState({ locale }) })
  const shown = async (me: Me) => {
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    const m = await mount(<MemoryRouter><AccountDeletionView value={{ state: 'none', requestedAt: null, dueAt: null, auditDays: 30 }} busy={false} onRequest={() => {}} onCancel={() => {}} /></MemoryRouter>)
    const text = m.get('account-deletion-what').textContent ?? ''
    await m.unmount()
    return text
  }

  test('a room guest with AI off: their account and what they sent in their room; nothing of a member', async () => {
    const text = await shown(guestMe({ kind: 'room', id: 'r1', name: 'Quote prep' }, 'none'))
    expect(text).toContain('Deleted: your sign-in, your profile and photo, and your notifications.')
    expect(text).toContain("Stays with the team: the messages and files you sent in 'Quote prep' and to its people")
    for (const member of ['personal folder', 'team folders', 'skills', 'scheduled tasks', 'app connections', 'memories']) expect(text).not.toContain(member)
  })

  test('a project guest with their own sign-in: their AI chats and AI sign-in go; the files and chats they added stay', async () => {
    const text = await shown(guestMe({ kind: 'project', id: 'p1', name: 'Acme bid' }, 'own'))
    expect(text).toContain('your chats with the AI, your AI sign-in')
    expect(text).toContain("the files and chats you added to 'Acme bid'")
    expect(text).not.toContain('personal folder')
    expect(text).toContain('Files you saved in Your files move to an archive')
  })

  test('a member keeps the full list', async () => {
    const member = { ...guestMe({ kind: 'room', id: 'r1', name: 'x' }, 'none'), guest: undefined, user: { ...guestMe({ kind: 'room', id: 'r1', name: 'x' }, 'none').user, role: 'member' } } as unknown as Me
    const text = await shown(member)
    expect(text).toContain(en('accountDeletion.folder'))
    expect(text).toContain(en('accountDeletion.stays'))
  })
})

describe("a guest's file pickers (lib/guestFiles.ts)", () => {
  test('the top is their project and their own folder, never the folders on the way or the team folder', async () => {
    const { readGuestTop, guestPassThrough } = await import('../../src/lib/guestFiles')
    const real = globalThis.fetch
    const folder = (path: string, access: 'none' | 'read' | 'write') => ({ path, name: path.split('/').pop(), type: 'folder', size: null, mtime: '2026-11-01T00:00:00.000Z', mime: 'inode/directory', access })
    const trees: Record<string, unknown[]> = {
      '': [folder('projects', 'none'), folder('users', 'read')],
      projects: [folder('projects/acme-bid', 'write'), folder('projects/other', 'none')],
      users: [folder('users/gina', 'write')],
    }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://x').searchParams.get('path') ?? ''
      return new Response(JSON.stringify({ path, access: 'none', entries: trees[path] ?? [], nextCursor: null }), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    try {
      const top = await readGuestTop()
      expect(top.entries.map((e) => e.path)).toEqual(['projects/acme-bid', 'users/gina'])
      expect(top.access).toBe('none')
    } finally { globalThis.fetch = real }
    expect(guestPassThrough('projects')).toBe(true)
    expect(guestPassThrough('projects/acme-bid')).toBe(false)
  })
})
