// A team project's page for the owner or an admin who is not a member (pages/Projects.tsx ProjectHome; docs/DECISIONS.md
// "Project contents only for members"), rendered and clicked:
// - it asks with manage=1 and gets the project without its contents (Project.member false): one quiet block in place of
//   the box, the files and the instructions ("Only members can open this project…") with [Add me] (only with
//   membersEditable), the Members row with its count and Manage, their own chats; the name's menu has Rename (the name
//   prompt, never the edit dialog) and Delete; no composer, no files, no instructions;
// - Add me: the app's confirm ("Add yourself to '…'?", "Members will see that you joined.", Add me / Cancel), then the
//   members as they are (not the creator row) plus me with the rules hash; the page loads again as a member's, without
//   manage; a change by someone else meanwhile (409 rules_changed) says so and loads the page again;
// - in the trash: the note with Restore (POST …/restore; its folder purged: the server's words, and Restore goes) and
//   Delete for good ("Its files are deleted too…"), and no name menu;
// - the trash and Delete for good confirms say only what happens (members can't open its files or shared chats).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Me, Project } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ProjectHome } from '../../src/pages/Projects'
import { DialogHost } from '../../src/components/ui'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const P1 = '01900000-0000-7000-8000-0000000000c1'
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const base = (o: Partial<Project> = {}): Project =>
  ({ id: P1, name: 'Acme legal', folderPath: 'projects/acme-legal', instructions: '', createdBy: { id: 'bob', name: 'Bob' }, createdAt: '2026-11-09T00:00:00.000Z', canEdit: false, audience: 2, membersEditable: true, creatorChangesMembers: true, ...o })
/** the project as the server answers someone who manages it without being a member */
const outside = (o: Partial<Project> = {}) => base({ member: false, canManage: true, ...o })
/** …and once they are a member */
const inside = (o: Partial<Project> = {}) => base({ instructions: '# Legal\n\nContracts only.', canEdit: true, canManage: true, audience: 3, ...o })
const meAs = (role: 'owner' | 'admin' | 'member') => ({
  user: { id: 'olga', username: 'olga', name: 'Olga', email: null, role, locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
}) as unknown as Me
const OWN_CHAT = { id: '01900000-0000-7000-8000-0000000000d1', projectId: P1, title: 'My old notes', engine: 'claude-code', model: null, createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', deletedAt: null, runState: 'idle' }

let routes: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response>> = {}
const sent: { key: string; url: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    sent.push({ key, url, body: init?.body ? JSON.parse(String(init.body)) : null })
    return routes[key]?.(url, init) ?? json(500, { error: { code: 'internal', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => { sent.length = 0; useUi.setState({ toasts: [] }) })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
})

const signedIn = (role: 'owner' | 'admin' | 'member') => useSession.setState({ status: { kind: 'signed-in', me: meAs(role) } } as never)
const page = () => mount(
  <MemoryRouter initialEntries={[`/projects/${P1}`]}>
    <Routes><Route path="/projects/:projectId" element={<ProjectHome />} /><Route path="*" element={<p data-testid="elsewhere" />} /></Routes>
    <DialogHost />
  </MemoryRouter>,
)
const calls = (key: string) => sent.filter((x) => x.key === key)
const dialogText = (m: Mounted) => m.container.ownerDocument!.body.querySelector('[role="dialog"]')?.textContent ?? ''
const menuItems = async (m: Mounted) => {
  await m.click('project-menu')
  return ([...m.container.querySelectorAll('[role="menuitem"]')] as unknown as { getAttribute: (n: string) => string | null }[]).map((e) => e.getAttribute('data-testid'))
}

describe('the page of a project I manage without being a member', () => {
  test('one quiet block with Add me, the Members row, my own chats; no box, files or instructions; Rename and Delete', async () => {
    signedIn('owner')
    routes = {
      [`GET /api/projects/${P1}`]: () => json(200, outside()),
      'GET /api/chats': () => json(200, { items: [OWN_CHAT], nextCursor: null }),
    }
    const m = await page()
    try {
      const block = await m.until(() => m.find('project-members-only'), 'the block', 2000)
      expect(calls(`GET /api/projects/${P1}`)[0]!.url).toContain('manage=1')
      expect(block.textContent).toContain(en('projects.membersOnly'))
      expect(en('projects.membersOnly')).toBe('Only members can open this project. Add yourself to see its files.')
      expect(translate('ko', 'projects.membersOnly')).toBe('멤버만 이 프로젝트를 열 수 있어요. 나를 멤버로 추가하면 파일을 볼 수 있어요.')
      expect(m.get('project-add-me').textContent).toContain(en('projects.addMe'))
      // nothing of its contents
      for (const id of ['composer-input', 'project-instructions', 'project-files', 'project-summary']) expect({ id, shown: !!m.find(id) }).toEqual({ id, shown: false })
      expect(calls('GET /api/files/tree')).toEqual([])
      expect(m.html()).not.toContain('projects/acme-legal')
      // the Members row: its count and Manage
      expect(m.get('project-members').textContent).toBe(`${en('projects.participants')}${en('projects.membersN', { n: 2 })}${en('projects.manage')}`)
      // my own chats there
      await m.until(() => m.find('project-chat'), 'my chat', 2000)
      expect(m.get('project-chats').textContent).toContain('My old notes')
      // the name's menu: Rename and Delete, no Edit
      expect(await menuItems(m)).toEqual(['project-rename', 'project-delete'])
    } finally { await m.unmount() }
  })

  test('no Add me for someone who may not change its members', async () => {
    signedIn('admin')
    routes = {
      [`GET /api/projects/${P1}`]: () => json(200, outside({ membersEditable: false })),
      'GET /api/chats': () => json(200, { items: [], nextCursor: null }),
    }
    const m = await page()
    try {
      await m.until(() => m.find('project-members-only'), 'the block', 2000)
      expect(m.find('project-add-me')).toBeNull()
    } finally { await m.unmount() }
  })

  test('Rename is the name prompt and sends the name only', async () => {
    signedIn('admin')
    routes = {
      [`GET /api/projects/${P1}`]: () => json(200, outside()),
      'GET /api/chats': () => json(200, { items: [], nextCursor: null }),
      [`PATCH /api/projects/${P1}`]: (_u, init) => json(200, outside(JSON.parse(String(init!.body)) as Partial<Project>)),
    }
    const m = await page()
    try {
      await m.until(() => m.find('project-members-only'), 'the block', 2000)
      await menuItems(m)
      await m.click('project-rename')
      const field = await m.until(() => m.container.ownerDocument!.body.querySelector('[data-testid="dialog-input"]'), 'the prompt', 2000)
      expect(m.find('project-form')).toBeNull()
      await m.type(field as never, 'Acme legal 2027')
      await m.click('dialog-confirm')
      await m.until(() => calls(`PATCH /api/projects/${P1}`).length, 'the rename', 2000)
      expect(calls(`PATCH /api/projects/${P1}`)[0]!.body).toEqual({ name: 'Acme legal 2027' })
      await m.until(() => m.html().includes('Acme legal 2027'), 'the new name', 2000)
    } finally { await m.unmount() }
  })
})

describe('Add me', () => {
  test('the confirm, then the members as they are and me with the hash; the page loads again as a member\'s, without manage', async () => {
    signedIn('owner')
    let joined = false
    routes = {
      [`GET /api/projects/${P1}`]: () => json(200, joined ? inside() : outside()),
      'GET /api/chats': () => json(200, { items: [OWN_CHAT], nextCursor: null }),
      'GET /api/files/tree': () => json(200, { path: 'projects/acme-legal', access: 'write', entries: [{ name: 'nda.md', path: 'projects/acme-legal/nda.md', type: 'file', size: 10, mtime: '2026-11-09T00:00:00.000Z', mime: 'text/markdown', access: 'write' }], nextCursor: null }),
      [`GET /api/projects/${P1}/access`]: () => json(200, { editable: true, rulesHash: 'h7', people: 2, otherRules: [], participants: [{ subjectType: 'user', subjectId: 'bob', name: 'Bob', creator: true }, { subjectType: 'group', subjectId: 'g-legal', name: 'Legal' }] }),
      [`PUT /api/projects/${P1}/participants`]: () => { joined = true; return json(200, { editable: true, rulesHash: 'h8', people: 3, otherRules: [], participants: [] }) },
    }
    const m = await page()
    try {
      await m.click(await m.until(() => m.find('project-add-me'), 'Add me', 2000))
      await m.until(() => m.find('project-add-me-confirm'), 'the confirm', 2000)
      expect(dialogText(m)).toContain("Add yourself to 'Acme legal'?")
      expect(m.get('project-add-me-confirm').textContent).toBe('Members will see that you joined.')
      expect(translate('ko', 'projects.addMeTitle', { name: 'Acme legal' })).toBe("'Acme legal'에 나를 추가할까요?")
      expect(translate('ko', 'projects.addMeBody')).toBe('멤버들에게 내가 들어왔다고 알려요.')
      expect(m.get('dialog-confirm').textContent).toBe('Add me')
      // cancel: nothing asked or saved
      const cancel = m.get('dialog-confirm').parentElement!.querySelector('button')!
      expect(cancel.textContent).toBe('Cancel')
      await m.click(cancel)
      await m.settle(30)
      expect(calls(`GET /api/projects/${P1}/access`)).toEqual([])
      // again, yes
      await m.click('project-add-me')
      await m.until(() => m.find('project-add-me-confirm'), 'the confirm', 2000)
      await m.click('dialog-confirm')
      await m.until(() => m.find('composer-input'), 'the page as a member\'s', 3000)
      expect(calls(`PUT /api/projects/${P1}/participants`)[0]!.body).toEqual({ participants: [{ subjectType: 'group', subjectId: 'g-legal' }, { subjectType: 'user', subjectId: 'olga' }], expectedHash: 'h7' })
      const gets = calls(`GET /api/projects/${P1}`)
      expect(gets.at(-1)!.url).not.toContain('manage')
      // its files and instructions now, and no block
      await m.until(() => m.find('project-files'), 'the files', 2000)
      expect(m.find('project-instructions')).not.toBeNull()
      expect(m.find('project-members-only')).toBeNull()
      expect(m.get('project-summary').textContent).toBe('Contracts only.')
    } finally { await m.unmount() }
  })

  test('someone changed the members meanwhile: the server\'s words, and the page as it is now', async () => {
    signedIn('admin')
    routes = {
      [`GET /api/projects/${P1}`]: () => json(200, outside()),
      'GET /api/chats': () => json(200, { items: [], nextCursor: null }),
      [`GET /api/projects/${P1}/access`]: () => json(200, { editable: true, rulesHash: 'h7', people: 2, otherRules: [], participants: [{ subjectType: 'user', subjectId: 'bob', name: 'Bob', creator: true }] }),
      [`PUT /api/projects/${P1}/participants`]: () => json(409, { error: { code: 'conflict', message: 'Someone changed who sees this project in the meantime.', params: { reason: 'rules_changed' } } }),
    }
    const m = await page()
    try {
      await m.click(await m.until(() => m.find('project-add-me'), 'Add me', 2000))
      await m.click(await m.until(() => m.find('dialog-confirm'), 'the confirm', 2000))
      await m.until(() => useUi.getState().toasts.some((x) => x.text === 'Someone changed who sees this project in the meantime.'), 'the words', 2000)
      await m.until(() => calls(`GET /api/projects/${P1}`).length === 2, 'loaded again', 2000)
      expect(m.find('project-members-only')).not.toBeNull()
    } finally { await m.unmount() }
  })
})

describe('in the trash', () => {
  test('the note with Restore and Delete for good, no name menu; Restore brings it back', async () => {
    signedIn('owner')
    let restored = false
    routes = {
      [`GET /api/projects/${P1}`]: () => json(200, restored ? outside() : outside({ inTrash: true, audience: 0, membersEditable: false })),
      'GET /api/chats': () => json(200, { items: [], nextCursor: null }),
      [`POST /api/projects/${P1}/restore`]: () => {
        restored = true
        return json(200, outside())
      },
    }
    const m = await page()
    try {
      const note = await m.until(() => m.find('project-in-trash'), 'the note', 2000)
      expect(note.textContent).toContain(en('projects.inTrash'))
      expect(m.find('project-restore')).not.toBeNull()
      expect(m.get('project-delete-for-good').textContent).toBe(en('projects.deleteForGood'))
      expect(m.find('project-members')).toBeNull()
      expect(m.find('composer-input')).toBeNull()
      // no Delete or Rename beside Delete for good: the name is plain text
      expect(m.find('project-menu')).toBeNull()
      expect(m.get('project-topline').textContent).toContain('Acme legal')
      await m.click('project-restore')
      await m.until(() => m.find('project-members-only'), 'back, as one I manage', 2000)
      expect(m.find('project-in-trash')).toBeNull()
      // out of the trash: the name's menu again
      expect(await menuItems(m)).toEqual(['project-rename', 'project-delete'])
    } finally { await m.unmount() }
  })

  test('its folder purged meanwhile: the server\'s words, and Restore goes (it would only be refused again); Delete for good stays', async () => {
    signedIn('admin')
    routes = {
      [`GET /api/projects/${P1}`]: () => json(200, outside({ inTrash: true, audience: 0, membersEditable: false })),
      'GET /api/chats': () => json(200, { items: [], nextCursor: null }),
      [`POST /api/projects/${P1}/restore`]: () => json(409, { error: { code: 'conflict', message: "This project's folder was deleted for good, so it can't come back. You can delete the project.", params: { reason: 'project_folder_purged' } } }),
    }
    const m = await page()
    try {
      await m.click(await m.until(() => m.find('project-restore'), 'Restore', 2000))
      await m.until(() => useUi.getState().toasts.some((x) => x.text.startsWith("This project's folder was deleted for good")), 'the words', 2000)
      await m.until(() => !m.find('project-restore'), 'Restore gone', 2000)
      expect(m.find('project-in-trash')).not.toBeNull()
      expect(m.find('project-delete-for-good')).not.toBeNull()
      expect(calls(`POST /api/projects/${P1}/restore`)).toHaveLength(1)
    } finally { await m.unmount() }
  })

  test('another refusal of Restore keeps it there to try again', async () => {
    signedIn('owner')
    routes = {
      [`GET /api/projects/${P1}`]: () => json(200, outside({ inTrash: true, audience: 0, membersEditable: false })),
      'GET /api/chats': () => json(200, { items: [], nextCursor: null }),
      [`POST /api/projects/${P1}/restore`]: () => json(503, { error: { code: 'unavailable', message: 'Try again in a moment.' } }),
    }
    const m = await page()
    try {
      await m.click(await m.until(() => m.find('project-restore'), 'Restore', 2000))
      await m.until(() => useUi.getState().toasts.some((x) => x.text === 'Try again in a moment.'), 'the words', 2000)
      await m.settle(30)
      expect(m.find('project-restore')).not.toBeNull()
    } finally { await m.unmount() }
  })

  test('Delete for good: its own confirm, then back to the list', async () => {
    signedIn('admin')
    routes = {
      [`GET /api/projects/${P1}`]: () => json(200, outside({ inTrash: true, audience: 0, membersEditable: false })),
      'GET /api/chats': () => json(200, { items: [], nextCursor: null }),
      [`DELETE /api/projects/${P1}`]: () => new Response(null, { status: 204 }),
    }
    const m = await page()
    try {
      // (a click focuses the button in a browser; the test DOM does not)
      const button = await m.until(() => m.find('project-delete-for-good'), 'the button', 2000)
      ;(button as unknown as HTMLElement).focus()
      await m.click(button)
      await m.until(() => m.find('dialog-confirm'), 'the confirm', 2000)
      expect(dialogText(m)).toContain("Delete 'Acme legal' for good?")
      expect(dialogText(m)).toContain("Its files are deleted too. This can't be undone.")
      expect(translate('ko', 'projects.deleteForGoodBody')).toBe('파일도 함께 지워지고 되돌릴 수 없어요.')
      expect(translate('ko', 'projects.deleteForGoodTitle', { name: '주간 보고' })).toBe("'주간 보고'을(를) 완전히 삭제할까요?")
      await m.click('dialog-confirm')
      await m.until(() => m.find('elsewhere'), 'the list', 2000)
      expect(calls(`DELETE /api/projects/${P1}`)).toHaveLength(1)
    } finally { await m.unmount() }
  })
})
