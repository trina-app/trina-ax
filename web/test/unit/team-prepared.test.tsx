// "팀에 준비된 것" on a first-time Home (docs/DECISIONS.md "W6.3 — What a new member sees first";
// components/onboarding/TeamPrepared.tsx, GET /api/skills/examples), rendered and clicked against a small fake of the
// server, per persona:
// - a member with skills and files: 3 skill rows in the server's order and "팀 스킬 N개 더", the files row; ONE filled
//   button (the first 써 보기); 자연스러운 글 fills the box with "/humanizer 아래 글을 자연스럽게 다듬어 줘:" (no form); another
//   skill opens its form over Home and 취소 comes back; 예시 opens the viewer; 물어보기 fills the box with the folder;
// - files only: 물어보기 is the filled one; skills only: the first 써 보기, no files row;
// - nothing: "이렇게 시작해 보세요" with one filled question (the profile's, else the person's own folder), and the "no team
//   folder" line when they can open none; a phone gets the same question;
// - chats before this (no team skill run): the skills still show, the files row does not; after a team skill run: gone;
// - no AI (a member): rows and 예시, no 써 보기 / 물어보기 / question;
// - owners and admins: no filled button; nothing prepared: "스킬 넣기 · 팀 파일 넣기", no question;
// - a phone: a skill row's tap is 써 보기, 예시 its own target; the files row is one row;
// - a failed read: one "다시 불러오기", never the empty state; a skill change reads again;
// - the invite step's line: an empty team only, its links (the welcome steps' or the pages'), never for a member.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { PreparedSkill, TeamPrepared as Data } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { folderLabel, preparedView, TeamPrepared } from '../../src/components/onboarding/TeamPrepared'
import { EmptyTeamLine, InviteStep } from '../../src/components/onboarding/InviteStep'
import { useHandover } from '../../src/store/handover'
import { skillsChanged } from '../../src/store/live'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'
import { packExample } from '../../../server/src/onboarding/skill-examples'

const ko = (k: MessageKey, p?: Record<string, string | number>) => translate('ko', k, p)
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const skill = (path: string, title: string, o: Partial<PreparedSkill> = {}): PreparedSkill => ({ path, name: path.split('/').at(-2)!, title, summary: `${title} 한 줄`, ...o })
const HUMANIZER = skill('skills/work/humanizer/SKILL.md', '자연스러운 글', { example: packExample('ko', 'humanizer')!, locale: 'ko', source: { kind: 'team_writing' } })
const CARDS = skill('skills/general/card-news/SKILL.md', '카드뉴스', { example: { kind: 'image', url: '/skill-examples/ko/card-news.webp' }, locale: 'ko', source: { kind: 'team' } })
const VIDEO = skill('skills/general/promo-video/SKILL.md', '홍보 영상', { example: { kind: 'image', url: '/skill-examples/ko/promo-video.webp' }, locale: 'ko', source: { kind: 'team' } })
const DECK = skill('skills/general/intro-deck/SKILL.md', '회사 소개서', { source: { kind: 'team' } })
const FOLDER = 'groups/Acme'
/** the team folder's count as the server sends it: the brand folder and the group's skills left out */
const tf = (files: number, more = false) => ({ path: FOLDER, files, more, without: ['브랜드', 'skills'] })
const full = (o: Partial<Data> = {}): Data => ({ skills: [HUMANIZER, CARDS, VIDEO, DECK], teamFolder: tf(18, false), landing: null, ranTeamSkill: false, hasProfile: false, ...o })

// ---- the fake server
let data: Data | null = full()
let fails = 0
let reads = 0
/** the folders a person can open (GET /api/files/tree at the top) */
let folders: { name: string; path: string }[] = []
const realFetch = globalThis.fetch
const g = globalThis as Record<string, unknown>
const media = (phone: boolean) => () => (q: string) => ({ matches: phone && q === '(max-width: 767.98px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
const meOf = (role: 'owner' | 'admin' | 'member') => ({
  user: { id: 'minji', username: 'minji', name: '민지', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000b', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})
const signIn = (role: 'owner' | 'admin' | 'member') => useSession.setState({ status: { kind: 'signed-in', me: meOf(role) } } as never)
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }

beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const key = `${init?.method ?? 'GET'} ${url.pathname}`
    if (key === 'GET /api/skills/examples') {
      reads++
      if (fails > 0) { fails--; return json(500, { error: { code: 'internal', message: 'down' } }) }
      return json(200, data)
    }
    if (key === 'GET /api/files/tree') {
      const path = url.searchParams.get('path') ?? ''
      return json(200, { path, access: 'read', entries: path ? [] : folders.map((f) => ({ ...f, type: 'folder', size: null, mtime: '2026-11-01T00:00:00.000Z', mime: null, access: 'write' })), nextCursor: null })
    }
    // the skill form's own list (SkillFormDialog)
    if (key === 'GET /api/skills') return json(200, { items: (data?.skills ?? []).map((s) => ({ path: s.path, name: s.name, description: s.summary, title: s.title })) })
    if (key === 'GET /api/me/ai-access') return json(200, { usable: true, action: 'connect_team', requested: false })
    return json(404, { error: { code: 'not_found', message: key } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  data = full()
  fails = 0
  reads = 0
  folders = []
  g.matchMedia = media(false)()
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
})

let composed: string[] = []
const open = async (o: { role?: 'owner' | 'admin' | 'member'; firstTime?: boolean; readOnly?: boolean; phone?: boolean } = {}) => {
  signIn(o.role ?? 'member')
  g.matchMedia = media(!!o.phone)()
  composed = []
  return mount(<MemoryRouter><TeamPrepared firstTime={o.firstTime ?? true} readOnly={o.readOnly} onCompose={(t) => composed.push(t)} /></MemoryRouter>)
}
/** the filled (primary) buttons inside the block */
const filled = (m: Mounted) => m.get('team-prepared').querySelectorAll('button').filter((b) => /(^|\s)bg-accent(\s|$)/.test(b.className))
const rows = (m: Mounted) => m.get('team-prepared').querySelectorAll('[data-testid="team-prepared-skill"]')

describe('the rules (no screen)', () => {
  test('skills until a team skill ran; files with no chats; the ready question for a member with nothing; the filled one by role', () => {
    const member = { firstTime: true, admin: false, readOnly: false }
    expect(preparedView(full(), member)).toMatchObject({ more: 1, primary: 'skill', ready: false, add: false, shown: true })
    expect(preparedView(full(), member).rows.map((s) => s.title)).toEqual(['자연스러운 글', '카드뉴스', '홍보 영상'])
    expect(preparedView(full({ skills: [] }), member)).toMatchObject({ primary: 'files', ready: false })
    expect(preparedView(full({ teamFolder: tf(0, false) }), member)).toMatchObject({ primary: 'skill', files: null })
    expect(preparedView(full({ skills: [], teamFolder: null }), member)).toMatchObject({ primary: 'ready', ready: true, shown: true })
    // chatted before (no team skill run): the skills stay, the files row goes, no question
    expect(preparedView(full(), { ...member, firstTime: false })).toMatchObject({ primary: 'skill', files: null, shown: true })
    expect(preparedView(full({ ranTeamSkill: true }), { ...member, firstTime: false }).shown).toBe(false)
    // ran one, no chats left: the files row
    expect(preparedView(full({ ranTeamSkill: true }), member)).toMatchObject({ rows: [], primary: 'files' })
    // no AI: nothing filled, no question
    expect(preparedView(full({ skills: [], teamFolder: null }), { ...member, readOnly: true }).shown).toBe(false)
    expect(preparedView(full(), { ...member, readOnly: true }).primary).toBeNull()
    // owners and admins: never a filled one; nothing prepared at all: the two ways to prepare it
    const admin = { firstTime: true, admin: true, readOnly: false }
    expect(preparedView(full(), admin).primary).toBeNull()
    expect(preparedView(full({ skills: [], teamFolder: tf(0, false) }), admin)).toMatchObject({ add: true, ready: false, primary: null })
    // a skill run and no documents: not "nothing prepared"
    expect(preparedView(full({ ranTeamSkill: true, teamFolder: null }), admin).shown).toBe(false)
    // a count that stopped before it found a document (a folder of many folders): not "nothing prepared" either
    expect(preparedView(full({ skills: [], teamFolder: tf(0, true) }), admin)).toMatchObject({ add: false, shown: false })
    expect(folderLabel('groups/Acme/회사 자료')).toBe('Acme › 회사 자료')
    // a team that started since docs/DECISIONS.md "Team folder basics": shared/ by its word on screen
    expect(folderLabel('shared', 'ko')).toBe('전사 공유')
    expect(folderLabel('shared/회사 자료', 'en')).toBe('Company-wide › 회사 자료')
  })
})

describe('a member', () => {
  test('skills and files: three rows, "팀 스킬 1개 더", the files row; one filled button, the first 써 보기', async () => {
    const m = await open()
    try {
      await m.until(() => m.find('team-prepared'), 'the block')
      expect(m.get('team-prepared').querySelector('h2')!.textContent).toBe(ko('home.prepared.title'))
      expect(rows(m).map((r) => r.getAttribute('data-path'))).toEqual([HUMANIZER.path, CARDS.path, VIDEO.path])
      expect(rows(m)[0]!.textContent).toContain('자연스러운 글 한 줄')
      expect(m.get('team-prepared-more').textContent).toContain(ko('home.prepared.more', { n: 1 }))
      expect(m.get('team-prepared-more').getAttribute('href')).toBe('/skills')
      expect(m.get('team-prepared-files').textContent).toContain(`Acme · ${ko('home.prepared.filesCount', { n: 18 })}`)
      expect(filled(m).map((b) => b.getAttribute('data-testid'))).toEqual(['team-prepared-try'])
      expect(rows(m)[0]!.getAttribute('data-primary')).toBe('true')
      // 예시 only on a row with an example
      expect(m.get('team-prepared').querySelectorAll('[data-testid="team-prepared-example"]').length).toBe(3)
    } finally { await m.unmount() }
  })

  test('자연스러운 글: the box gets "/humanizer 아래 글을 자연스럽게 다듬어 줘:" and a new line; no form', async () => {
    const m = await open()
    try {
      await m.until(() => m.find('team-prepared'), 'the block')
      await m.click(rows(m)[0]!.querySelector('[data-testid="team-prepared-try"]')!)
      expect(composed).toEqual([`/humanizer ${ko('home.prepared.humanizerAsk')}\n`])
      expect(composed[0]).toBe('/humanizer 아래 글을 자연스럽게 다듬어 줘:\n')
      expect(m.find('skill-form')).toBeNull()
    } finally { await m.unmount() }
  })

  test('another skill opens its form over Home; ✕ comes back to the block', async () => {
    const m = await open()
    try {
      await m.until(() => m.find('team-prepared'), 'the block')
      await m.click(rows(m)[1]!.querySelector('[data-testid="team-prepared-try"]')!)
      await m.until(() => m.find('skill-form'), 'the form')
      expect(m.get('skill-form').getAttribute('data-path')).toBe(CARDS.path)
      expect(composed).toEqual([])
      const close = m.container.ownerDocument!.body.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === ko('common.close'))!
      await m.click(close)
      await m.until(() => !m.find('skill-form'), 'the form closed')
      expect(m.find('team-prepared')).not.toBeNull()
    } finally { await m.unmount() }
  })

  test('예시 opens the viewer with the example; 물어보기 fills the box with the folder (not sent)', async () => {
    const m = await open()
    try {
      await m.until(() => m.find('team-prepared'), 'the block')
      await m.click(rows(m)[0]!.querySelector('[data-testid="team-prepared-example"]')!)
      await m.until(() => m.find('skill-example'), 'the viewer')
      expect(m.get('skill-example').getAttribute('data-name')).toBe('humanizer')
      expect(m.get('skill-example-source').getAttribute('data-kind')).toBe('team_writing')
      await m.click('team-prepared-ask')
      expect(composed).toEqual([ko('home.prepared.filesAsk', { path: FOLDER, skip: '브랜드, skills' })])
      expect(composed[0]).toBe('groups/Acme 폴더의 파일 이름과 종류만 보고(브랜드, skills 폴더는 빼고), 내가 먼저 보면 좋을 것 3개를 골라 줘')
    } finally { await m.unmount() }
  })

  test('files only: 물어보기 is the filled one; "100개 넘게" past the count', async () => {
    data = full({ skills: [], teamFolder: tf(100, true) })
    const m = await open()
    try {
      await m.until(() => m.find('team-prepared-files'), 'the files row')
      expect(rows(m)).toEqual([])
      expect(m.get('team-prepared-files').textContent).toContain(ko('home.prepared.filesMore', { n: 100 }))
      expect(filled(m).map((b) => b.getAttribute('data-testid'))).toEqual(['team-prepared-ask'])
    } finally { await m.unmount() }
  })

  test('skills only (the brand folder does not count, so no files row): the first 써 보기 is filled', async () => {
    data = full({ teamFolder: tf(0, false) })
    const m = await open()
    try {
      await m.until(() => m.find('team-prepared'), 'the block')
      expect(m.find('team-prepared-files')).toBeNull()
      expect(filled(m).length).toBe(1)
      expect(rows(m)[0]!.getAttribute('data-primary')).toBe('true')
    } finally { await m.unmount() }
  })

  test('nothing prepared: "이렇게 시작해 보세요" and one filled question (the profile\'s, else their own folder); the "no team folder" line', async () => {
    data = full({ skills: [], teamFolder: null, hasProfile: true })
    let m = await open()
    try {
      await m.until(() => m.find('team-prepared-ready'), 'the question')
      expect(m.get('team-prepared').querySelector('h2')!.textContent).toBe(ko('home.prepared.startTitle'))
      expect(m.get('team-prepared-ready').textContent).toBe('우리 회사가 하는 일을 3줄로 정리해 줘')
      expect(filled(m).map((b) => b.getAttribute('data-testid'))).toEqual(['team-prepared-ready'])
      await m.until(() => m.find('team-prepared-no-folders'), 'the line')
      expect(m.get('team-prepared-no-folders').textContent).toBe(ko('home.noFolders'))
      await m.click('team-prepared-ready')
      expect(composed).toEqual(['우리 회사가 하는 일을 3줄로 정리해 줘'])
    } finally { await m.unmount() }
    data = full({ skills: [], teamFolder: null, hasProfile: false })
    folders = [{ name: 'shared', path: 'shared' }]
    m = await open({ phone: true })
    try {
      await m.until(() => m.find('team-prepared-ready'), 'the question')
      expect(m.get('team-prepared-ready').textContent).toBe(ko('home.example1', { folder: 'users/minji' }))
      await m.settle(40)
      expect(m.find('team-prepared-no-folders')).toBeNull()
    } finally { await m.unmount() }
  })

  test('chatted before this (no team skill run): the skills show, the files row does not; after a run: nothing', async () => {
    let m = await open({ firstTime: false })
    try {
      await m.until(() => m.find('team-prepared'), 'the block')
      expect(rows(m).length).toBe(3)
      expect(m.find('team-prepared-files')).toBeNull()
    } finally { await m.unmount() }
    data = full({ ranTeamSkill: true })
    m = await open({ firstTime: false })
    try {
      await m.until(() => reads > 0, 'the read')
      await m.settle(40)
      expect(m.find('team-prepared')).toBeNull()
    } finally { await m.unmount() }
  })

  test('no AI: the rows and 예시, no 써 보기, 물어보기 or question', async () => {
    const m = await open({ readOnly: true })
    try {
      await m.until(() => m.find('team-prepared'), 'the block')
      expect(rows(m).length).toBe(3)
      expect(m.find('team-prepared-try')).toBeNull()
      expect(m.find('team-prepared-ask')).toBeNull()
      expect(m.find('team-prepared-example')).not.toBeNull()
      expect(m.get('team-prepared-files').textContent).toContain('Acme')
      expect(filled(m)).toEqual([])
    } finally { await m.unmount() }
  })

  test('a phone: a skill row\'s tap is 써 보기, 예시 is its own target; the files row is one row', async () => {
    const m = await open({ phone: true })
    try {
      await m.until(() => m.find('team-prepared'), 'the block')
      const first = rows(m)[0]!
      const tap = first.querySelector('[data-testid="team-prepared-try"]')!
      expect(tap.getAttribute('aria-label')).toBe(ko('home.prepared.tryNamed', { title: '자연스러운 글' }))
      expect(tap.textContent).toContain('자연스러운 글')
      expect(first.querySelector('[data-testid="team-prepared-example"]')!.className).toContain('max-md:min-h-11')
      await m.click(tap)
      expect(composed).toEqual(['/humanizer 아래 글을 자연스럽게 다듬어 줘:\n'])
      const files = m.get('team-prepared-ask')
      expect(files.textContent).toBe(`${ko('home.prepared.files')} · ${ko('home.prepared.filesCount', { n: 18 })}${ko('home.prepared.ask')}`)
    } finally { await m.unmount() }
  })

  test('a failed read: one "다시 불러오기" (no empty state); it reads again; a skill change reads again', async () => {
    fails = 1
    data = full({ skills: [], teamFolder: null })
    const m = await open()
    try {
      await m.until(() => m.find('team-prepared-retry'), 'the retry')
      expect(m.find('team-prepared-ready')).toBeNull()
      expect(m.get('team-prepared-retry').textContent).toBe(ko('home.prepared.retry'))
      await m.click('team-prepared-retry')
      await m.until(() => m.find('team-prepared-ready'), 'the block after the retry')
      data = full()
      const was = reads
      await act(async () => { skillsChanged.emit() })
      await m.until(() => reads > was && rows(m).length === 3, 'read again')
    } finally { await m.unmount() }
  })
})

describe('owners and admins', () => {
  test('the same rows, no filled button; nothing prepared: "스킬 넣기 · 팀 파일 넣기" and no question', async () => {
    for (const role of ['owner', 'admin'] as const) {
      data = full()
      let m = await open({ role })
      try {
        await m.until(() => m.find('team-prepared'), 'the block')
        expect(rows(m).length).toBe(3)
        expect(filled(m)).toEqual([])
        expect(m.get('team-prepared').getAttribute('data-primary')).toBeNull()
      } finally { await m.unmount() }
      data = full({ skills: [], teamFolder: tf(0, false) })
      m = await open({ role })
      try {
        await m.until(() => m.find('team-prepared-add'), 'the links')
        expect(m.find('team-prepared-ready')).toBeNull()
        expect(m.get('team-prepared-add-skills').getAttribute('href')).toBe('/skills')
        expect(m.get('team-prepared-add-files').getAttribute('href')).toBe('/files')
        expect(m.get('team-prepared-add').textContent).toBe(`${ko('home.prepared.addSkills')} · ${ko('home.prepared.addFiles')}`)
        expect(filled(m)).toEqual([])
      } finally { await m.unmount() }
    }
  })
})

describe('the invite step\'s empty-team line', () => {
  const line = async (role: 'owner' | 'member', steps?: { skills: () => void; files: () => void }) => {
    signIn(role)
    return mount(<MemoryRouter><EmptyTeamLine steps={steps} /></MemoryRouter>)
  }
  test('no skills and no documents: one line; its links go to the steps in /welcome, else to 팀 스킬 and 파일', async () => {
    data = full({ skills: [], teamFolder: tf(0, false) })
    const went: string[] = []
    let m = await line('owner', { skills: () => went.push('skills'), files: () => went.push('files') })
    try {
      await m.until(() => m.find('invite-empty-team'), 'the line')
      expect(m.get('invite-empty-team').textContent).toBe(`${ko('home.prepared.inviteEmpty')} · ${ko('home.prepared.addSkills')} · ${ko('home.prepared.addFiles')}`)
      expect(m.get('invite-empty-team').textContent).toBe('지금 초대하면 팀원이 볼 게 없어요 · 스킬 넣기 · 팀 파일 넣기')
      await m.click('invite-empty-skills')
      await m.click('invite-empty-files')
      expect(went).toEqual(['skills', 'files'])
    } finally { await m.unmount() }
    // no team group yet: no documents either
    data = full({ skills: [], teamFolder: null })
    m = await line('owner')
    try {
      await m.until(() => m.find('invite-empty-team'), 'the line')
      expect(m.get('invite-empty-skills').getAttribute('href')).toBe('/skills')
      expect(m.get('invite-empty-files').getAttribute('href')).toBe('/files')
    } finally { await m.unmount() }
  })

  test('the welcome steps\' invite step: the line above the message; gone while "이 사람이 팀장이에요" is ticked (the lead sets up), back when unticked', async () => {
    data = full({ skills: [], teamFolder: tf(0) })
    signIn('owner')
    useHandover.setState({ loaded: true, state: { flag: true, recovery: 'server', openLead: null, card: null, connections: [] } } as never)
    /** a click on a checkbox turns it over before its handlers run (the browser's own step, which the fake DOM leaves out) */
    const tick = async (m: Mounted, box: FakeElement) => {
      const checked = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'checked')!
      checked.set!.call(box, !checked.get!.call(box))
      await m.click(box)
    }
    const went: string[] = []
    const m = await mount(<MemoryRouter><InviteStep prepare onDone={() => {}} steps={{ skills: () => went.push('skills'), files: () => went.push('files') }} /></MemoryRouter>)
    try {
      await m.until(() => m.find('invite-empty-team'), 'the line')
      expect(m.find('lead-flag')).not.toBeNull()
      // above the team link's part, inside the invite step
      const html = m.html()
      expect(html.indexOf('data-testid="invite-empty-team"')).toBeGreaterThan(html.indexOf('data-testid="lead-flag"'))
      await m.click('invite-empty-skills')
      expect(went).toEqual(['skills'])
      await tick(m, m.get('lead-flag-check'))
      await m.until(() => m.find('lead-create'), 'the lead link part')
      expect(m.find('invite-empty-team')).toBeNull()
      await tick(m, m.get('lead-flag-check'))
      await m.until(() => m.find('invite-empty-team'), 'the line again')
    } finally {
      await m.unmount()
      useHandover.getState().reset()
    }
  })

  test('a skill or a document: no line; never for a member', async () => {
    for (const d of [full({ teamFolder: tf(0, false) }), full({ skills: [] }), full({ skills: [], teamFolder: tf(0, true) })]) {
      data = d
      const m = await line('owner')
      try {
        await m.until(() => reads > 0, 'the read')
        await m.settle(40)
        expect(m.find('invite-empty-team')).toBeNull()
      } finally { await m.unmount() }
      reads = 0
    }
    data = full({ skills: [], teamFolder: null })
    const m = await line('member')
    try {
      await m.settle(60)
      expect(reads).toBe(0)
      expect(m.find('invite-empty-team')).toBeNull()
    } finally { await m.unmount() }
  })
})
