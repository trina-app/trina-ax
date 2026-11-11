// Who sees a chat, always (docs/DECISIONS.md "Who sees it, always"; lib/sharedChat.ts whoSees, components/chat/WhoSees.tsx,
// NewChatComposer.tsx): the line under the box says "나만 봐요" for a chat of one person and for a shared one nobody else
// sees, "나와 관리자만 봐요" for a shared one only the owner and admins see besides me (Project.alone: the server's
// role-blind check, sent only to someone who may read the project's rules; only a project made before outside projects/,
// docs/DECISIONS.md "Project contents only for members"), and otherwise how many see it ("멤버 N명"). It opens the members dialog only for a shared chat (or a box whose new chat will be shared)
// whose members the person may change, and its tooltip says so; never for a personal project or a chat of one person.
// The project page's 멤버 line says the same words by the same rule.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me, Project } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { whoSees } from '../../src/lib/sharedChat'
import { WhoSeesLine } from '../../src/components/chat/WhoSees'
import { NewChatComposer } from '../../src/components/chat/NewChatComposer'
import { MembersRow } from '../../src/pages/Projects'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const P1 = '01900000-0000-7000-8000-0000000000b1'
const ko = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars)
const project = (o: Partial<Project> = {}): Project =>
  ({ id: P1, name: 'Acme launch', folderPath: 'projects/acme', instructions: '', createdBy: { id: 'mia', name: 'Mia' }, createdAt: '2026-11-09T00:00:00.000Z', canEdit: true, audience: 1, shareChats: true, membersEditable: true, ...o })
const meAs = (role: 'owner' | 'admin' | 'member', confidential = false) => ({
  user: { id: 'mia', username: 'mia', name: 'Mia', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', projectCreators: 'members' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted', ...(confidential ? { allChatsConfidential: true } : {}) },
}) as unknown as Me
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
const realFetch = globalThis.fetch

beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
afterEach(() => { localStorage.clear() })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
})

describe('the words', () => {
  test('only me vs N people: a chat of one person, a count of 1, nobody else by a rule, more', () => {
    expect(whoSees(null)).toEqual({ kind: 'me' })
    expect(whoSees({ audience: 1 })).toEqual({ kind: 'me' })
    // a count of 1 already includes every admin: nobody else, whatever `alone` says
    expect(whoSees({ audience: 1, alone: true })).toEqual({ kind: 'me' })
    expect(whoSees({ audience: 3, alone: true })).toEqual({ kind: 'admins' })
    expect(whoSees({ audience: 3 })).toEqual({ kind: 'people', n: 3 })
    expect(ko('chat.whoMe')).toBe('나만 봐요')
    expect(ko('chat.whoMeAdmins')).toBe('나와 관리자만 봐요')
    expect(translate('en', 'chat.whoMe')).toBe('Only you')
    expect(translate('en', 'chat.whoMeAdmins')).toBe('You and admins')
  })

  test('the line in a box and in an open chat; a lock while only I see it', async () => {
    const lineOf = async (shared: { audience?: number; alone?: boolean } | null, place: 'new' | 'chat') => {
      const m = await mount(<WhoSeesLine shared={shared} place={place} />)
      try {
        const el = m.get('who-sees')
        return { text: el.textContent, kind: el.getAttribute('data-who'), lock: el.innerHTML.includes('lucide-lock'), tag: el.tagName }
      } finally { await m.unmount() }
    }
    expect(await lineOf(null, 'chat')).toEqual({ text: '나만 봐요', kind: 'me', lock: true, tag: 'SPAN' })
    expect(await lineOf({ audience: 4, alone: true }, 'chat')).toEqual({ text: '나와 관리자만 봐요', kind: 'admins', lock: false, tag: 'SPAN' })
    expect(await lineOf({ audience: 4 }, 'chat')).toEqual({ text: '멤버 4명이 이 채팅을 볼 수 있어요.', kind: 'people', lock: false, tag: 'SPAN' })
    expect(await lineOf({ audience: 2 }, 'new')).toEqual({ text: '새 채팅은 멤버 2명이 볼 수 있어요.', kind: 'people', lock: false, tag: 'SPAN' })
  })
})

describe('the project box', () => {
  const box = async (p: Project, role: 'owner' | 'admin' | 'member', o: { confidential?: boolean } = {}) => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs(role, o.confidential) } } as never)
    let opened = 0
    const m = await mount(<MemoryRouter><NewChatComposer projectId={p.id} project={p} onMembers={() => { opened++ }} aiLine={false} /></MemoryRouter>)
    const el = m.get('who-sees')
    const out = { text: el.textContent, button: el.tagName === 'BUTTON', inRow: !!m.get('composer-footer').querySelector('[data-testid="who-sees"]') }
    // a button says what it opens (its tooltip, read as its description)
    if (out.button) expect(el.getAttribute('title')).toBe(ko('chat.whoOpens'))
    if (out.button) await m.click(el)
    await m.unmount()
    return { ...out, opened }
  }

  test('an admin vs a member caller, each alone in a shared project of theirs', async () => {
    // the owner or an admin alone: the count (which includes every admin) is 1
    expect(await box(project({ audience: 1, alone: true }), 'owner')).toEqual({ text: '나만 봐요', button: true, inRow: true, opened: 1 })
    // a member alone: the owner and the admins are counted, and nobody else sees it by a rule
    expect(await box(project({ audience: 3, alone: true }), 'member')).toEqual({ text: '나와 관리자만 봐요', button: true, inRow: true, opened: 1 })
    // someone else added
    expect(await box(project({ audience: 4 }), 'member')).toEqual({ text: '새 채팅은 멤버 4명이 볼 수 있어요.', button: true, inRow: true, opened: 1 })
    // an admin on a member's project: someone else sees it by a rule (the member), so the count
    expect(await box(project({ audience: 3, createdBy: { id: 'jun', name: 'Jun' } }), 'admin')).toEqual({ text: '새 채팅은 멤버 3명이 볼 수 있어요.', button: true, inRow: true, opened: 1 })
  })

  test('clickable only when the person may change the members and the new chat will be shared', async () => {
    // a member of someone else's project: the same words, nothing to open
    expect(await box(project({ audience: 4, membersEditable: false, createdBy: { id: 'jun', name: 'Jun' } }), 'member')).toEqual({ text: '새 채팅은 멤버 4명이 볼 수 있어요.', button: false, inRow: true, opened: 0 })
    // a team project that does not share its chats: the new chat is mine alone, and members do not change that
    expect(await box(project({ audience: 4, shareChats: false }), 'owner')).toEqual({ text: '나만 봐요', button: false, inRow: true, opened: 0 })
    // a personal project: never shared, never clickable
    expect(await box(project({ folderPath: 'users/mia/projects/notes', audience: 1, shareChats: undefined, membersEditable: undefined }), 'member')).toEqual({ text: '나만 봐요', button: false, inRow: true, opened: 0 })
    // safe operations (1A): a new chat is never shared
    expect(await box(project({ audience: 4 }), 'owner', { confidential: true })).toEqual({ text: '나만 봐요', button: false, inRow: true, opened: 0 })
    // a folder in the trash: no shared new chat either (the page shows no box then)
    expect(await box(project({ audience: 2, inTrash: true }), 'admin')).toEqual({ text: '나만 봐요', button: false, inRow: true, opened: 0 })
  })

  test('the box of a chat without a project (Home) has no line: its page says it', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs('member') } } as never)
    const m = await mount(<MemoryRouter><NewChatComposer projectId={null} aiLine={false} /></MemoryRouter>)
    try {
      expect(m.find('who-sees')).toBeNull()
      expect(m.find('composer-footer')).toBeNull()
    } finally { await m.unmount() }
  })
})

describe('the project page\'s 멤버 line: members only in projects/, the same words as the box elsewhere', () => {
  const row = async (p: Project, role: 'owner' | 'admin' | 'member') => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs(role) } } as never)
    const m = await mount(<MemoryRouter><MembersRow project={p} sideAction="" onManage={() => {}} /></MemoryRouter>)
    try {
      const line = m.get('project-members')
      // the box's line for a project whose new chat is shared, to compare
      const box = await mount(<WhoSeesLine shared={p} place="new" />)
      const boxText = box.get('who-sees').textContent
      await box.unmount()
      return { row: line.textContent ?? '', box: boxText }
    } finally { await m.unmount() }
  }

  test('a team project in projects/ (docs/DECISIONS.md "Project contents only for members"): only me, else its members', async () => {
    // the owner alone: 1, as the box says
    const owner = await row(project({ audience: 1, alone: true }), 'owner')
    expect(owner.row).toContain('나만 봐요')
    expect(owner.row).not.toContain('1명')
    expect(owner.box).toBe('나만 봐요')
    // more people: its members, "4명", the box "새 채팅은 멤버 4명이 …"
    const more = await row(project({ audience: 4 }), 'member')
    expect(more.row).toBe(`${ko('projects.participants')}${ko('projects.membersN', { n: 4 })}${ko('projects.manage')}`)
    expect(more.box).toBe('새 채팅은 멤버 4명이 볼 수 있어요.')
    // the owner and admins: the same, never a role part or "관리자만"
    const admin = await row(project({ audience: 3, audienceSplit: { direct: 3, byRole: 0 } }), 'admin')
    expect(admin.row).toBe(`${ko('projects.participants')}${ko('projects.membersN', { n: 3 })}${ko('projects.manage')}`)
    expect(admin.row).not.toContain('관리자만')
    // an owner or admin who is not a member: the members' count, also of one ("1명", not "나만 봐요")
    expect((await row(project({ audience: 1, member: false }), 'admin')).row).toBe(`${ko('projects.participants')}${ko('projects.membersN', { n: 1 })}${ko('projects.manage')}`)
    // nobody active in it
    expect((await row(project({ audience: 0, member: false }), 'owner')).row).toContain(ko('projects.noMembers'))
    // a member who may not change the members: the count, and who changes them
    const other = await row(project({ audience: 3, membersEditable: false, createdBy: { id: 'jun', name: 'Jun' } }), 'member')
    expect(other.row).toContain('3명')
    expect(other.row).not.toContain('관리자만')
  })

  test('a project made before outside projects/: the box\'s words, "나와 관리자만 봐요" only there; admins read where to change it, without a path', async () => {
    const legacy = (o: Partial<Project> = {}) => project({ folderPath: 'shared/acme', ...o })
    const alone = await row(legacy({ audience: 3, alone: true }), 'member')
    expect(alone.row).toContain('나와 관리자만 봐요')
    expect(alone.box).toBe('나와 관리자만 봐요')
    const more = await row(legacy({ audience: 4 }), 'member')
    expect(more.row).toContain('4명이 봐요')
    // the owner and admins: its people by its rules ("3명"), the box the total
    const admin = await row(legacy({ audience: 5, audienceSplit: { direct: 3, byRole: 2 } }), 'admin')
    expect(admin.row).toBe(`${ko('projects.participants')}${ko('projects.membersN', { n: 3 })}${ko('projects.manage')}`)
    expect(admin.box).toBe(ko('projects.sharedNewChat', { n: 5 }))
    // an admin on one whose members are not changed here: the line opens to say where, with no path in the words
    useSession.setState({ status: { kind: 'signed-in', me: meAs('admin') } } as never)
    const m = await mount(<MemoryRouter><MembersRow project={legacy({ audience: 5, membersEditable: false })} sideAction="" onManage={() => {}} /></MemoryRouter>)
    try {
      await m.click('project-members-toggle')
      const hint = m.get('project-members-hint').textContent ?? ''
      expect(hint).toContain(ko('projects.legacyNote'))
      expect(hint).not.toContain('shared/acme')
    } finally { await m.unmount() }
    expect(ko('projects.legacyNote')).toBe('이 프로젝트는 예전에 프로젝트 폴더 밖에 만들어져서 팀장·관리자도 봐요. 볼 수 있는 사람은 관리자 › 폴더 권한에서 바꿔요.')
  })
})
