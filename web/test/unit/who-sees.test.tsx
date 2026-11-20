// Who sees a chat, always (docs/DECISIONS.md "Who sees it, always"; lib/sharedChat.ts whoSees, components/chat/WhoSees.tsx,
// NewChatComposer.tsx): the line under the box says "나만 봐요" for a chat of one person and for a shared one nobody else
// sees, "나와 관리자만 봐요" for a shared one only the owner and admins see besides me (Project.alone: the server's
// role-blind check, sent only to someone who may read the project's rules; only a project made before outside projects/,
// docs/DECISIONS.md "Project contents only for members"), and otherwise how many see it ("멤버 N명"). It opens the members dialog only for a shared chat (or a box whose new chat will be shared)
// whose members the person may change, and its tooltip says so; never for a personal project or a chat of one person.
// The project page's title row (who sees it, beside Share) says the same words by the same rule.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me, Project } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { chatOpeners, chatWho, whoSees } from '../../src/lib/sharedChat'
import { WhoSeesLine } from '../../src/components/chat/WhoSees'
import { NewChatComposer } from '../../src/components/chat/NewChatComposer'
import { ProjectShareRow } from '../../src/pages/Projects'
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
    expect(translate('en', 'chat.whoMe')).toBe('Only me')
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
    // one sentence shape for who sees a chat, mine and shared alike (QA TC-1086)
    expect(await lineOf(null, 'chat')).toEqual({ text: '이 채팅은 나만 볼 수 있어요.', kind: 'me', lock: true, tag: 'SPAN' })
    expect(await lineOf(null, 'new')).toEqual({ text: '새 채팅은 나만 볼 수 있어요.', kind: 'me', lock: true, tag: 'SPAN' })
    expect(await lineOf({ audience: 4, alone: true }, 'chat')).toEqual({ text: '나와 관리자만 봐요', kind: 'admins', lock: false, tag: 'SPAN' })
    expect(await lineOf({ audience: 4 }, 'chat')).toEqual({ text: '4명이 이 채팅을 볼 수 있어요.', kind: 'people', lock: false, tag: 'SPAN' })
    expect(await lineOf({ audience: 2 }, 'new')).toEqual({ text: '새 채팅은 2명이 볼 수 있어요.', kind: 'people', lock: false, tag: 'SPAN' })
  })

  test('English: "Only you can see this chat." / "N people can see this chat." / "Only you can see new chats." / "Only me", and the footers say the same (QA TC-1086)', () => {
    const en = (k: Parameters<typeof translate>[1], p?: Record<string, number>) => translate('en', k, p)
    expect(en('chat.privateLabel')).toBe('Only you can see this chat.')
    expect(en('chat.sharedSeen', { n: 3 })).toBe('3 people can see this chat.')
    expect(en('projects.newChatMe')).toBe('Only you can see new chats.')
    expect(en('projects.onlyMe')).toBe('Only me')
    // the footers end with the same sentences: Home (a new chat), a chat only I see, a shared chat
    expect(en('chat.footer').endsWith(en('projects.newChatMe'))).toBe(true)
    expect(en('chat.footerPrivate').endsWith(en('chat.privateLabel'))).toBe(true)
    expect(en('chat.footerShared', { n: 3 }).endsWith(en('chat.sharedSeen', { n: 3 }))).toBe(true)
    for (const loc of ['ko', 'id', 'ja', 'es'] as const) {
      expect(translate(loc, 'chat.footer').endsWith(translate(loc, 'projects.newChatMe'))).toBe(true)
      expect(translate(loc, 'chat.footerPrivate').endsWith(translate(loc, 'chat.privateLabel'))).toBe(true)
    }
  })
})

describe('a project with a guest: who can open its chats', () => {
  test('chatWho: chatAudience when the server sends it, else audience; chatOpeners: a guest only on their own chat (the header faces)', () => {
    expect(chatWho(project({ audience: 4, chatAudience: 3 }))).toEqual({ audience: 3, alone: undefined })
    expect(chatWho(project({ audience: 4 }))).toEqual({ audience: 4, alone: undefined })
    const people = [{ id: 'mia', name: 'Mia' }, { id: 'jun', name: 'Jun' }, { id: 'gwen', name: 'Gwen', guest: true as const }]
    expect(chatOpeners(people, 'mia').map((x) => x.id)).toEqual(['mia', 'jun'])
    expect(chatOpeners(people, 'gwen').map((x) => x.id)).toEqual(['mia', 'jun', 'gwen'])
  })
})

describe('the project box', () => {
  const box = async (p: Project, role: 'owner' | 'admin' | 'member', o: { confidential?: boolean } = {}) => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs(role, o.confidential) } } as never)
    let opened = 0
    const m = await mount(<MemoryRouter><NewChatComposer projectId={p.id} project={p} onMembers={() => { opened++ }} aiLine={false} /></MemoryRouter>)
    // a team project: one chip in the box's row right after + (QA TC-1401), the "Only me" switch named by who sees the
    // chat being started (a fixed chip when it cannot be shared); any other project: the line in the row under the box
    // (computers), which opens the members dialog for whoever may change them while the chat is shared
    const chip = m.find('only-me-toggle') ?? m.find('chat-visibility')
    let out: { text: string | null; where: string; toggle?: boolean; button?: boolean }
    if (chip) {
      out = { text: m.get('chat-visibility-why').textContent, where: m.get('composer-tools').contains(chip) ? 'tools' : 'elsewhere', toggle: chip.tagName === 'BUTTON' }
      expect(m.find('who-sees')).toBeNull()
    } else {
      const el = m.get('who-sees')
      out = { text: el.textContent, where: m.get('composer-footer').contains(el) ? 'footer' : 'elsewhere', button: el.tagName === 'BUTTON' }
      if (out.button) await m.click(el)
    }
    await m.unmount()
    return { ...out, opened }
  }

  test('an admin vs a member caller, each alone in a shared project of theirs', async () => {
    // the owner or an admin alone: the count (which includes every admin) is 1
    expect(await box(project({ audience: 1, alone: true }), 'owner')).toEqual({ text: '새 채팅은 나만 볼 수 있어요.', where: 'tools', toggle: true, opened: 0 })
    // a member alone: the owner and the admins are counted, and nobody else sees it by a rule
    expect(await box(project({ audience: 3, alone: true }), 'member')).toEqual({ text: '나와 관리자만 봐요', where: 'tools', toggle: true, opened: 0 })
    // someone else added
    expect(await box(project({ audience: 4 }), 'member')).toEqual({ text: '지금 시작하는 채팅은 이 프로젝트의 4명이 보고 이어 쓸 수 있어요.', where: 'tools', toggle: true, opened: 0 })
    // an admin on a member's project: someone else sees it by a rule (the member), so the count
    expect(await box(project({ audience: 3, createdBy: { id: 'jun', name: 'Jun' } }), 'admin')).toEqual({ text: '지금 시작하는 채팅은 이 프로젝트의 3명이 보고 이어 쓸 수 있어요.', where: 'tools', toggle: true, opened: 0 })
  })

  test('a project with a guest: the chip counts who can open the new chat (chatAudience), not who reads its files (audience)', async () => {
    // 4 read its folder, one of them a guest, who never opens another member's chat there
    expect(await box(project({ audience: 4, chatAudience: 3 }), 'member')).toEqual({ text: '지금 시작하는 채팅은 이 프로젝트의 3명이 보고 이어 쓸 수 있어요.', where: 'tools', toggle: true, opened: 0 })
    // a member with only the guest besides them: only me
    expect(await box(project({ audience: 2, chatAudience: 1 }), 'member')).toEqual({ text: '새 채팅은 나만 볼 수 있어요.', where: 'tools', toggle: true, opened: 0 })
    // an older server without the field: its audience, as before
    expect(await box(project({ audience: 4 }), 'member')).toEqual({ text: '지금 시작하는 채팅은 이 프로젝트의 4명이 보고 이어 쓸 수 있어요.', where: 'tools', toggle: true, opened: 0 })
  })

  test('a switch only while the new chat can be shared; the members dialog opens from a personal box\'s line only when shared', async () => {
    // a member of someone else's project: the same words, the switch too
    expect(await box(project({ audience: 4, membersEditable: false, createdBy: { id: 'jun', name: 'Jun' } }), 'member')).toEqual({ text: '지금 시작하는 채팅은 이 프로젝트의 4명이 보고 이어 쓸 수 있어요.', where: 'tools', toggle: true, opened: 0 })
    // a team project an older build left not sharing its chats: the new chat is mine alone, no switch
    expect(await box(project({ audience: 4, shareChats: false }), 'owner')).toEqual({ text: '새 채팅은 나만 볼 수 있어요.', where: 'tools', toggle: false, opened: 0 })
    // a personal project: never shared, never clickable
    expect(await box(project({ folderPath: 'users/mia/projects/notes', audience: 1, shareChats: undefined, membersEditable: undefined }), 'member')).toEqual({ text: '새 채팅은 나만 볼 수 있어요.', where: 'footer', button: false, opened: 0 })
    // safe operations (1A): a new chat is never shared, no switch
    expect(await box(project({ audience: 4 }), 'owner', { confidential: true })).toEqual({ text: '팀 보안 설정 때문에 지금은 새 채팅을 나만 볼 수 있어요.', where: 'tools', toggle: false, opened: 0 })
    // a folder in the trash: no shared new chat either (the page shows no box then)
    expect(await box(project({ audience: 2, inTrash: true }), 'admin')).toEqual({ text: '새 채팅은 나만 볼 수 있어요.', where: 'footer', button: false, opened: 0 })
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

describe('the project page\'s title row: who sees it and Share, the same words as the box elsewhere', () => {
  const person = (id: string, name: string) => ({ id, name, creator: id === 'mia' })
  const row = async (p: Project, role: 'owner' | 'admin' | 'member', o: { people?: { people: ReturnType<typeof person>[] } | null | false; canShare?: boolean; adminsOnly?: boolean } = {}) => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs(role) } } as never)
    let opened = 0, shared = 0
    const m = await mount(<MemoryRouter><ProjectShareRow project={p} people={(o.people ?? false) as never} canShare={o.canShare ?? false} adminsOnly={o.adminsOnly ?? false} onShare={() => { shared++ }} onOpen={() => { opened++ }} /></MemoryRouter>)
    try {
      const who = m.find('project-who-sees')
      const r = { who: who?.textContent ?? null, whoTag: who?.tagName ?? null, faces: !!m.find('project-header-open'), share: !!m.find('project-share'), adminsOnly: m.find('project-share-admins-only')?.textContent ?? null, row: !!m.find('project-share-row'), opened: 0, shared: 0 }
      if (who?.tagName === 'BUTTON') { await m.click('project-who-sees'); r.opened = opened }
      if (r.faces) { await m.click('project-header-open'); r.opened = opened }
      if (r.share) { await m.click('project-share'); r.shared = shared }
      return r
    } finally { await m.unmount() }
  }

  test('a team project in projects/ (docs/DECISIONS.md "Project contents only for members"): only me, the faces of two or more, else its count', async () => {
    // I am its only member: "나만 봐요", a button that opens the members dialog
    const alone = await row(project({ audience: 1, alone: true }), 'owner', { people: { people: [person('mia', 'Mia')] }, canShare: true })
    expect(alone).toMatchObject({ who: ko('chat.whoMe'), whoTag: 'BUTTON', opened: 1, share: true, shared: 1, faces: false })
    // more people: their faces (they open the dialog), no words
    const more = await row(project({ audience: 3 }), 'member', { people: { people: [person('mia', 'Mia'), person('jun', 'Jun'), person('sam', 'Sam')] }, canShare: false })
    expect(more).toMatchObject({ who: null, faces: true, opened: 1, share: false })
    // an owner or admin who is not a member: the members' count, also of one ("멤버 1명", not "나만 봐요")
    expect((await row(project({ audience: 1, member: false }), 'admin', { canShare: true })).who).toBe(ko('projects.whoMembers', { n: 1 }))
    // nobody active in it
    expect((await row(project({ audience: 0, member: false }), 'owner')).who).toBe(ko('projects.noMembers'))
    // in the trash: nothing at all
    expect((await row(project({ audience: 2, inTrash: true }), 'owner', { canShare: true })).row).toBe(false)
  })

  test('a personal project: "나만 봐요" in plain words; Share when I may share, else the admins-only line', async () => {
    const mine = project({ folderPath: 'users/mia/projects/notes', audience: 1, membersEditable: undefined })
    const may = await row(mine, 'member', { canShare: true })
    expect(may).toMatchObject({ who: ko('projects.members.onlyMe'), whoTag: 'SPAN', share: true, shared: 1, adminsOnly: null })
    const not = await row(mine, 'member', { adminsOnly: true })
    expect(not).toMatchObject({ who: ko('projects.members.onlyMe'), share: false, adminsOnly: ko('projects.shareAdminsOnly') })
  })

  test('a project made before outside projects/: the box\'s words, "나와 관리자만 봐요" only there', async () => {
    const legacy = (o: Partial<Project> = {}) => project({ folderPath: 'shared/acme', ...o })
    const alone = await row(legacy({ audience: 3, alone: true }), 'member')
    expect(alone.who).toBe('나와 관리자만 봐요')
    expect((await row(legacy({ audience: 4 }), 'member')).who).toContain('4명이 봐요')
    // the owner and admins: its people by its rules ("멤버 3명"), the box the total
    expect((await row(legacy({ audience: 5, audienceSplit: { direct: 3, byRole: 2 } }), 'admin')).who).toBe(ko('projects.whoMembers', { n: 3 }))
    expect(ko('projects.legacyNote')).toBe('이 프로젝트는 예전에 프로젝트 폴더 밖에 만들어져서 팀장·관리자도 봐요. 볼 수 있는 사람은 관리자 › 폴더 권한에서 바꿔요.')
  })
})
