// A member and a team skill someone made from their own work (docs/DECISIONS.md "S"):
// - joining with a link to a skill with a form: the join page keeps who made it for that form, which says so on top
//   ("김지훈님이 만든 팀 스킬이에요 · 이 채팅은 민지님만 봐요"), until the form goes away;
// - a skill without fields lands on its form too (its box starts with the skill's own example, docs/DECISIONS.md
//   "W5"): the join page never holds a starter without files (kind 'skill') for Home; Home's arrival for one held
//   before still reads one line ("김지훈님이 만든 팀 스킬이에요"), its title as the box's chip and "이 방식대로 해 줘";
// - the answer's receipt names the maker: "김지훈님의 팀 스킬 '견적서 쓰기' · 팀 파일 1개".
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { JoinStarter, SkillInfo } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import Home from '../../src/pages/Home'
import { TeamJoin } from '../../src/pages/Auth'
import Steps from '../../src/components/chat/Steps'
import { SkillFormDialog } from '../../src/components/skills/SkillForm'
import { forgetStarters, heldMadeBy, heldStarter, holdMadeBy, holdStarter } from '../../src/lib/starter'
import { forgetTeamAttach } from '../../src/lib/teamAttach'
import { forgetSkillList } from '../../src/lib/skillTitles'
import { teamLinkMessage } from '../../src/lib/team-link'
import { fileLabel } from '../../src/components/onboarding/SkillShareCard'
import { translate } from '../../src/i18n'
import { useAiAccess } from '../../src/store/aiAccess'
import { useChats } from '../../src/store/chats'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { installDom, mount, removeDom } from './dom-host'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const QUOTE: SkillInfo = { path: 'skills/general/gyeonjeokseo-sseugi/SKILL.md', name: 'gyeonjeokseo-sseugi', title: '견적서 쓰기', description: '견적서 쓰기 — 팀 양식으로 견적서를 만들어요', inputs: [{ name: 'customer', label: '고객사', required: true }, { name: 'items', label: '품목' }] }
const BRIEF: JoinStarter = { kind: 'skill', skill: { path: 'skills/general/bogoseo-yoyak/SKILL.md', name: 'bogoseo-yoyak', title: '보고서 요약' }, files: [], by: '김지훈' }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const meOf = (id: string, name: string) => ({
  user: { id, username: id, name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})

let calls: { key: string; body: any }[] = []
const routes: Record<string, (body: any) => Response> = {
  'GET /api/me/ai-access': () => json(200, { usable: true, action: 'ask_owner', requested: false }),
  'GET /api/skills': () => json(200, { items: [QUOTE, { path: BRIEF.skill.path, name: BRIEF.skill.name, title: BRIEF.skill.title, description: '보고서 요약' }] }),
  'GET /api/questions/frequent': () => json(200, { items: [] }),
  'GET /api/skills/popular': () => json(200, { items: [] }),
  'GET /api/onboarding/welcome': () => json(200, { progress: null }),
  'GET /api/onboarding/goal': () => json(200, { goal: null }),
  'GET /api/onboarding/profile': () => json(200, { profile: null }),
}
const called = (key: string) => calls.filter((c) => c.key === key)
const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status, signedIn: useSession.getState().signedIn }
beforeAll(() => {
  // another file can leave its skill list in memory; this file's receipt needs the titles from its own /api/skills
  forgetSkillList()
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ key, body })
    return routes[key]?.(body) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  calls = []
  forgetStarters()
  forgetTeamAttach()
  sessionStorage.clear()
  localStorage.clear()
  useChats.getState().reset()
  useAiAccess.getState().reset()
  useWelcome.getState().reset()
})
afterAll(() => {
  globalThis.fetch = realFetch
  // the stores first: a component still on the page re-renders on their change and needs the window
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status, signedIn: before.signedIn })
  forgetSkillList()
  removeDom()
})
function Where() { const l = useLocation(); return <p data-testid="where">{`${l.pathname}${l.search}`}</p> }

describe('a member and a team skill someone made', () => {
  test('the join page keeps who made the link\'s skill for its form (not without a maker, not with a starter)', async () => {
    const g = globalThis as Record<string, unknown>
    const was = { location: Object.getOwnPropertyDescriptor(g, 'location'), history: Object.getOwnPropertyDescriptor(g, 'history') }
    Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/join', search: '', hash: `#t=${TOKEN}`, origin: 'https://acme.example', href: `https://acme.example/join#t=${TOKEN}` } })
    Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { state: null, replaceState: () => {} } })
    routes['POST /api/team-link/info'] = () => json(200, { teamName: 'Acme', valid: true, problem: null, expiresAt: '2026-11-18T00:00:00.000Z', skillName: QUOTE.name, skillTitle: QUOTE.title })
    routes['POST /api/team-link/join'] = () => json(201, { me: meOf('minji', '민지'), next: `/skills?run=${encodeURIComponent(QUOTE.path)}`, starter: null, skillBy: '김지훈' })
    useSession.setState({ signedIn: () => {} } as never)
    const m = await mount(<MemoryRouter initialEntries={['/join']}><Routes><Route path="/join" element={<TeamJoin />} /><Route path="*" element={<Where />} /></Routes></MemoryRouter>)
    try {
      await m.until(() => m.find('join-form'), 'the join form')
      await m.type('invite-name', '민지')
      await m.type('invite-username', 'minji')
      await m.type('invite-password', 'tulip meadow 2026')
      await m.click('invite-submit')
      await m.until(() => m.find('where'), 'the next page')
      expect(m.get('where').textContent).toBe(`/skills?run=${encodeURIComponent(QUOTE.path)}`)
      expect(heldMadeBy('minji', QUOTE.path)).toBe('김지훈')
      expect(heldMadeBy('minji', 'skills/general/other/SKILL.md')).toBeNull()
    } finally {
      await m.unmount()
      delete routes['POST /api/team-link/info']
      delete routes['POST /api/team-link/join']
      for (const [k, d] of Object.entries(was)) { if (d) Object.defineProperty(g, k, d); else delete g[k] }
    }
  })

  test('a skill without fields: the join lands on its form with who made it, never Home with "이 방식대로 해 줘" (a \'skill\' starter included)', async () => {
    const g = globalThis as Record<string, unknown>
    const was = { location: Object.getOwnPropertyDescriptor(g, 'location'), history: Object.getOwnPropertyDescriptor(g, 'history') }
    Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/join', search: '', hash: `#t=${TOKEN}`, origin: 'https://acme.example', href: `https://acme.example/join#t=${TOKEN}` } })
    Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { state: null, replaceState: () => {} } })
    const form = `/skills?run=${encodeURIComponent(BRIEF.skill.path)}`
    routes['POST /api/team-link/info'] = () => json(200, { teamName: 'Acme', valid: true, problem: null, expiresAt: '2026-11-18T00:00:00.000Z', skillName: BRIEF.skill.name, skillTitle: BRIEF.skill.title })
    // the answer as a server before W5 gave it (a starter without files); today's has `starter: null` and `skillBy`
    routes['POST /api/team-link/join'] = () => json(201, { me: meOf('minji', '민지'), next: form, starter: BRIEF, skillBy: null })
    useSession.setState({ signedIn: () => {} } as never)
    const m = await mount(<MemoryRouter initialEntries={['/join']}><Routes><Route path="/join" element={<TeamJoin />} /><Route path="*" element={<Where />} /></Routes></MemoryRouter>)
    try {
      await m.until(() => m.find('join-form'), 'the join form')
      await m.type('invite-name', '민지')
      await m.type('invite-username', 'minji')
      await m.type('invite-password', 'tulip meadow 2026')
      await m.click('invite-submit')
      await m.until(() => m.find('where'), 'the next page')
      expect(m.get('where').textContent).toBe(form)
      expect(heldStarter('minji')).toBeNull()
      expect(heldMadeBy('minji', BRIEF.skill.path)).toBe('김지훈')
    } finally {
      await m.unmount()
      delete routes['POST /api/team-link/info']
      delete routes['POST /api/team-link/join']
      for (const [k, d] of Object.entries(was)) { if (d) Object.defineProperty(g, k, d); else delete g[k] }
    }
  })

  test('the form says who made it and who sees the chat, in place of the description; gone with the form', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meOf('minji', '민지') } } as never)
    holdMadeBy('minji', QUOTE.path, '김지훈')
    const m = await mount(<MemoryRouter><SkillFormDialog path={QUOTE.path} onClose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-form-by'), 'the line')
      expect(m.get('skill-form-by').textContent).toBe('김지훈님이 만든 팀 스킬이에요 · 이 채팅은 민지님만 봐요')
      expect(m.get('skill-form').textContent).not.toContain('팀 양식으로 견적서를 만들어요')
      expect(m.find('skill-input-customer')).not.toBeNull()
    } finally { await m.unmount() }
    expect(heldMadeBy('minji', QUOTE.path)).toBeNull()
    // another time (from the Team skills page): the usual form
    const again = await mount(<MemoryRouter><SkillFormDialog path={QUOTE.path} onClose={() => {}} /></MemoryRouter>)
    try {
      await again.until(() => again.find('skill-input-customer'), 'the form')
      expect(again.find('skill-form-by')).toBeNull()
    } finally { await again.unmount() }
  })

  test('a skill without a form: Home\'s one line, its title in the box with "이 방식대로 해 줘", no files', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meOf('minji', '민지') } } as never)
    holdStarter('minji', BRIEF)
    const m = await mount(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<Home />} /><Route path="*" element={<Where />} /></Routes></MemoryRouter>)
    try {
      await m.until(() => m.find('starter-line'), 'the line')
      expect(m.get('starter-line').textContent).toBe('김지훈님이 만든 팀 스킬이에요')
      expect((m.get('composer-input') as unknown as { value: string }).value).toBe('이 방식대로 해 줘')
      expect(m.get('composer-skill').textContent).toBe('보고서 요약')
      expect(m.get('starter-private').textContent).toBe('이 채팅은 민지님만 봐요. 김지훈님도 못 봐요.')
      await m.settle(30)
      expect(called('POST /api/attachments/team-file')).toEqual([])
    } finally { await m.unmount() }
  })

  test('the receipt names who made the skill; without a maker as before', async () => {
    const steps = [{ id: 's1', kind: 'tool' as const, tool: 'read', label: 'read 견적서_양식.xlsx', status: 'ok' as const }]
    const m = await mount(<Steps steps={steps as never} streaming={false} receipt={{ skill: { path: QUOTE.path, name: QUOTE.name, by: '김지훈' }, teamFiles: 1 }} />)
    try {
      await m.until(() => m.find('steps-receipt')?.textContent === "김지훈님의 팀 스킬 '견적서 쓰기' · 팀 파일 1개", 'the receipt')
    } finally { await m.unmount() }
    const plain = await mount(<Steps steps={steps as never} streaming={false} receipt={{ skill: { path: QUOTE.path, name: QUOTE.name }, teamFiles: 1 }} />)
    try {
      await plain.until(() => plain.find('steps-receipt')?.textContent === "팀 스킬 '견적서 쓰기' · 팀 파일 1개", 'the receipt')
    } finally { await plain.unmount() }
  })

  test('the lead\'s message for a skill just made, in every language with the link', () => {
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      const t = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate(l, k, p)
      const text = teamLinkMessage(t, { name: '올가', team: 'Acme 영업', url: 'https://acme.example/join#t=x', skill: '견적서 쓰기', made: true })
      expect(text).toContain('견적서 쓰기')
      expect(text).toContain('Acme 영업')
      expect(text.endsWith('https://acme.example/join#t=x')).toBe(true)
    }
    const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
    expect(teamLinkMessage(ko, { name: '올가', team: 'Acme 영업', url: 'u', skill: '견적서 쓰기', made: true })).toBe("Acme 영업에 '견적서 쓰기' 스킬을 만들어 뒀어요. 링크 열면 같은 방식으로 바로 써요.\nu")
    // not made here: the usual invitation
    expect(teamLinkMessage(ko, { name: '올가', team: 'Acme 영업', url: 'u', skill: '견적서 쓰기' })).toContain('올가님이')
  })

  test('the card names a team file, or a folder\'s newest file of the kind the run used', () => {
    const t = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
    expect(fileLabel({ path: 'groups/Acme/회의록/견적서_양식.xlsx', latest: false }, t)).toBe('견적서_양식.xlsx')
    expect(fileLabel({ path: 'groups/Acme/회의록', latest: true }, t)).toBe('Acme 회의록 폴더의 가장 최근 회의록')
    expect(fileLabel({ path: 'groups/Acme/회의록', latest: true, like: '월간보고' }, t)).toBe('Acme 회의록 폴더의 가장 최근 월간보고')
    expect(fileLabel({ path: 'shared/보고서', latest: true }, t)).toBe('보고서 폴더의 가장 최근 파일')
    // English reads the team's folder as a place and the notes in plain words, not "the newest Meeting notes in the
    // Acme Marketing Meeting notes folder"
    const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
    expect(fileLabel({ path: 'groups/Acme Marketing/Meeting notes', latest: true }, en)).toBe('the newest meeting notes in Acme Marketing › Meeting notes')
    expect(fileLabel({ path: 'groups/Acme Marketing/Meeting notes', latest: true, like: 'Weekly sync' }, en)).toBe('the newest Weekly sync in Acme Marketing › Meeting notes')
    expect(fileLabel({ path: 'shared/Reports', latest: true }, en)).toBe('the newest file in Reports')
    // Spanish no longer reads "el Actas de reuniones más reciente"
    expect(fileLabel({ path: 'groups/Acme/Actas de reuniones', latest: true }, (k, p) => translate('es', k, p))).toBe('las actas de reunión más recientes de la carpeta Acme › Actas de reuniones')
    // the card news' brand images folder (docs/DECISIONS.md "N"): the whole folder, its team joined as each language
    // reads it; the company intro beside it stays a file
    expect(fileLabel({ path: 'groups/마케팅팀/브랜드/이미지', latest: false }, t)).toBe('마케팅팀 이미지 폴더의 사진')
    expect(fileLabel({ path: 'groups/Acme Marketing/Brand/Images', latest: false }, en)).toBe('the photos in Acme Marketing › Images')
    expect(fileLabel({ path: 'groups/Acme Marketing/Brand/Company intro.md', latest: false }, en)).toBe('Company intro.md')
  })
})
