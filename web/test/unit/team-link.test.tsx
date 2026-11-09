// The team invite link on screen (onboarding stream E): the token read from the #fragment and taken out of the address
// bar, sent only in a POST body; the join form with no password confirmation (an eye button instead); the ready-made
// message in every language; where a new member lands; the Members card and the wizard's InviteStep with its soft
// "later" dialog.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { TeamLinkResponse } from '@mycel/shared/api'
import { DICTS, LOCALES, translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { joinNext, readJoinToken, teamLinkMessage } from '../../src/lib/team-link'
import { namedProduct } from '../../src/lib/tabs'
import { JoinForm, TeamJoin } from '../../src/pages/Auth'
import { forgetPatched, linkDiffers, markPatched, TeamLinkPanel, TeamLinkView } from '../../src/components/onboarding/TeamLinkPanel'
import { InviteStep } from '../../src/components/onboarding/InviteStep'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const URL_ = `https://acme.example/join#t=${TOKEN}`
const loc = (href: string) => { const u = new URL(href, 'https://acme.example'); return { pathname: u.pathname, search: u.search, hash: u.hash } }
const noop = () => {}
/** the product as the message names it in each language: the AI's name where the product is named after it ("트리나에서",
 * as beside "트리나에게 묻기"; tabs.ts namedProduct), else the product's name */
const named = (l: Parameters<typeof translate>[0]) => namedProduct((k) => translate(l, k)).product

describe('the address', () => {
  test('the token comes from the fragment only, and the clean address keeps everything else', () => {
    expect(readJoinToken(loc(`/join#t=${TOKEN}`))).toEqual({ token: TOKEN, cleanUrl: '/join' })
    expect(readJoinToken(loc(`/join?x=1#t=${TOKEN}&y=2`))).toEqual({ token: TOKEN, cleanUrl: '/join?x=1#y=2' })
    // never from the query
    expect(readJoinToken(loc(`/join?t=${TOKEN}`))).toEqual({ token: null, cleanUrl: null })
    // a broken token is not sent, but still leaves the address bar
    expect(readJoinToken(loc('/join#t=short'))).toEqual({ token: null, cleanUrl: '/join' })
    expect(readJoinToken(loc('/join#t=<script>alert(1)</script>xxxxxxxxxxxx'))).toEqual({ token: null, cleanUrl: '/join' })
    expect(readJoinToken(loc('/join'))).toEqual({ token: null, cleanUrl: null })
  })

  test('after joining: only the skill form the server named, else Home', () => {
    const run = `/skills?run=${encodeURIComponent('skills/marketing/ad-copy/SKILL.md')}`
    expect(joinNext(run)).toBe(run)
    for (const bad of [null, undefined, '', '/admin', '//evil.example/skills?run=skills/x', 'https://evil.example/skills?run=skills/x', '/skills?run=users%2Fbob%2Fx.md', '/skills?run=skills/x&review=1', '/skills']) expect(joinNext(bad)).toBe('/')
  })
})

describe('the ready-made message', () => {
  test('Korean: who invites, to which team, the product, the link; with a skill, the skill too', () => {
    const t = (k: MessageKey, p?: Record<string, string | number>) => translate('ko', k, p)
    expect(teamLinkMessage(t, { name: '김하나', team: 'Acme 마케팅', url: URL_ })).toBe(`김하나님이 ${named('ko')}에서 Acme 마케팅에 함께하자고 초대했어요. 링크로 바로 들어올 수 있어요: ${URL_}`)
    expect(teamLinkMessage(t, { name: '김하나', team: 'Acme 마케팅', url: URL_, skill: '광고 문구' })).toBe(`김하나님이 ${named('ko')}에서 Acme 마케팅에 함께하자고 초대했어요. '광고 문구' 스킬을 같이 써 보자고 해요. 링크로 바로 들어올 수 있어요: ${URL_}`)
  })
  test('every language names the person, the team, the product, the skill and ends with the whole link', () => {
    for (const { id } of LOCALES) {
      const t = (k: MessageKey, p?: Record<string, string | number>) => translate(id, k, p)
      for (const skill of [null, 'ad-copy']) {
        const m = teamLinkMessage(t, { name: 'Ana', team: 'Acme Sales', url: URL_, skill })
        expect({ id, m: m.endsWith(URL_) && m.includes('Ana') && m.includes('Acme Sales') && m.includes(named(id)) && (!skill || m.includes(skill)) }).toEqual({ id, m: true })
      }
    }
  })
  test('every teamLink text exists in all five languages', () => {
    const keys = Object.keys(DICTS.ko).filter((k) => k.startsWith('teamLink.') || k.startsWith('audit.act.team_link.'))
    expect(keys.length).toBeGreaterThan(40)
    for (const { id } of LOCALES) for (const k of keys) expect({ id, k, ok: !!DICTS[id][k as MessageKey]?.trim() }).toEqual({ id, k, ok: true })
  })
})

describe('one skill, and the own-AI clause (docs/DECISIONS.md "W5")', () => {
  const ko = (k: MessageKey, p?: Record<string, string | number>) => translate('ko', k, p)
  test('Korean: "본인 AI 계정이 필요해요" before the link sentence, with and without a skill; never without ownAi', () => {
    expect(teamLinkMessage(ko, { name: '김하나', team: 'Acme', url: URL_, skill: '할 일 정리', ownAi: true })).toBe(`김하나님이 ${named('ko')}에서 Acme에 함께하자고 초대했어요. '할 일 정리' 스킬을 같이 써 보자고 해요. 본인 AI 계정이 필요해요. 링크로 바로 들어올 수 있어요: ${URL_}`)
    expect(teamLinkMessage(ko, { name: '김하나', team: 'Acme', url: URL_, ownAi: true })).toBe(`김하나님이 ${named('ko')}에서 Acme에 함께하자고 초대했어요. 본인 AI 계정이 필요해요. 링크로 바로 들어올 수 있어요: ${URL_}`)
    expect(teamLinkMessage(ko, { name: '김하나', team: 'Acme', url: URL_, skill: '할 일 정리' })).not.toContain('본인 AI')
  })
  test('every language: the clause is there only with ownAi, and the message still ends with the whole link', () => {
    for (const { id } of LOCALES) {
      const t = (k: MessageKey, p?: Record<string, string | number>) => translate(id, k, p)
      for (const skill of [null, 'ad-copy']) {
        const plain = teamLinkMessage(t, { name: 'Ana', team: 'Acme', url: URL_, skill })
        const own = teamLinkMessage(t, { name: 'Ana', team: 'Acme', url: URL_, skill, ownAi: true })
        expect({ id, skill, ok: own !== plain && own.endsWith(URL_) && own.includes('Ana') && (!skill || own.includes(skill)) && own.length > plain.length }).toEqual({ id, skill, ok: true })
      }
    }
  })
  test('the panel: several skills shared, the message names the one the link opens (the line under it says so); connect_own adds the clause', () => {
    const weekly = 'skills/weekly-report/SKILL.md', quote = 'skills/quote-draft/SKILL.md'
    const data: TeamLinkResponse = { ...LINK, link: { ...LINK.link!, skill: { path: weekly, name: 'weekly-report', title: 'Weekly report' } } }
    const shared = { landing: weekly, options: [{ path: weekly, title: 'Weekly report' }, { path: quote, title: 'Quote draft' }], onLanding: noop }
    const render = (d: TeamLinkResponse) => renderToStaticMarkup(<TeamLinkView data={d} inviter="Olga" team="Acme" groups={[]} skills={null} shared={shared} busy={false} folded onCreate={noop} onRevoke={noop} />)
    const message = (html: string) => /data-testid="team-link-message">([^<]*)</.exec(html)?.[1] ?? ''
    let html = render(data)
    expect(message(html)).toBe(`Olga invited you to Acme on ${named('en')} to try the &#x27;Weekly report&#x27; skill together. You can join right away with this link: ${URL_.replace(/&/g, '&amp;')}`)
    expect(message(html)).not.toContain('Quote draft')
    expect(html).toContain('data-testid="team-link-landing"')
    expect(message(html)).not.toContain('own AI account')
    html = render({ ...data, link: { ...data.link!, memberAi: 'connect_own' } })
    expect(message(html)).toContain("You&#x27;ll need your own AI account. You can join right away")
    // a team whose AI answers everyone (or an older server): no clause
    for (const memberAi of ['ready', 'ask_owner', undefined] as const) expect(message(render({ ...data, link: { ...data.link!, memberAi } }))).not.toContain('own AI account')
  })
})

const LINK: TeamLinkResponse = {
  link: { id: '01900000-0000-7000-8000-000000000001', url: URL_, groupIds: [], skill: { path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy' }, maxUses: 10, uses: 3, createdBy: { id: 'olga', name: 'Olga' }, createdAt: '2026-11-04T00:00:00.000Z', expiresAt: '2026-11-18T00:00:00.000Z', state: 'active' },
  seats: { used: 4, limit: 10 },
}
const view = (data: TeamLinkResponse, skills: { path: string; name: string; description: string }[] | null = [], folded = false) =>
  renderToStaticMarkup(<TeamLinkView data={data} inviter="Olga" team="Acme" groups={[]} skills={skills} busy={false} folded={folded} onCreate={noop} onRevoke={noop} />)

// rendered to a string, the screen language is the store's first one (English): the texts are compared in English
describe('the panel (Admin › Members, the wizard)', () => {
  test('an open link: the address, copy link, copy message, uses x/y, the expiry, change and turn off', () => {
    const html = view(LINK)
    expect(html).toContain(`data-testid="team-link-url">${URL_.replace(/&/g, '&amp;')}<`)
    expect(html).toContain('Copy link')
    expect(html).toContain('Copy message')
    // a skill without a title: its folder name as words, never the raw 'ad-copy' (also when the title only repeats it)
    expect(html).toContain(`Olga invited you to Acme on ${named('en')} to try the &#x27;ad copy&#x27; skill together.`)
    expect(html).not.toContain('&#x27;ad-copy&#x27;')
    const repeated = view({ ...LINK, link: { ...LINK.link!, skill: { path: 'skills/general/quote-maker/SKILL.md', name: 'quote-maker', title: 'quote-maker' } } })
    expect(repeated).toContain('&#x27;quote maker&#x27; skill')
    expect(repeated).not.toContain('quote-maker&#x27;')
    expect(html).toContain('data-testid="team-link-uses">3 of 10<')
    expect(html).toContain('Seats left: 6')
    expect(html).toContain('data-testid="team-link-replace"')
    expect(html).toContain('data-testid="team-link-revoke"')
    expect(html).not.toContain('data-testid="team-link-form"')
  })
  test('a link held back by its limit says so, and that a new link lifts it', () => {
    expect(view(LINK)).not.toContain('data-testid="team-link-limited"')
    const html = view({ ...LINK, link: { ...LINK.link!, limitedUntil: '2026-11-04T10:00:00.000Z' } })
    expect(html).toContain('data-testid="team-link-limited"')
    expect(html).toContain('Replacing the link lifts it at once.')
  })
  test('no link yet: the form, its uses default to the seats left and never above the plan', () => {
    const html = view({ link: null, seats: { used: 4, limit: 10 } }, [{ path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', description: '' }])
    expect(html).toContain('data-testid="team-link-form"')
    expect(html).toMatch(/data-testid="team-link-uses-input"/)
    expect(html).toMatch(/max="10"[^>]*placeholder="6"|placeholder="6"[^>]*max="10"/)
    expect(html).toContain('<option value="14" selected="">')
    expect(html).toContain('skills/marketing/ad-copy/SKILL.md')
    expect(html).not.toContain('data-testid="team-link-full"')
  })
  test('no seats left: the form says so and cannot make a link', () => {
    const html = view({ link: null, seats: { used: 10, limit: 10 } })
    expect(html).toContain('data-testid="team-link-full"')
    expect(/<button[^>]*data-testid="team-link-create"[^>]*>/.exec(html)?.[0]).toContain('disabled=""')
  })
  test('an expired, used-up, stopped or unreadable link: why, and the form for a new one', () => {
    for (const [state, url, key] of [['expired', URL_, 'teamLink.state.expired'], ['used_up', URL_, 'teamLink.state.used_up'], ['stopped', URL_, 'teamLink.state.stopped'], ['active', null, 'teamLink.state.unreadable']] as const) {
      const html = view({ ...LINK, link: { ...LINK.link!, state, url } })
      expect(html).toContain(translate('en', key).replace(/'/g, '&#x27;'))
      expect(html).toContain('data-testid="team-link-form"')
      expect(html).not.toContain('data-testid="team-link-url"')
      // it can be turned off for good from here (a stopped link would work again if its maker got the right back)
      expect(html).toContain('data-testid="team-link-revoke"')
    }
  })
})

describe('folded (the invite step): the message, one copy button, the rest under "링크 관리"', () => {
  test('an open link: the message and "Copy message"; the link, its facts and "replace" wait in a collapsed row; never "turn off"', () => {
    const html = view(LINK, null, true)
    expect(html).toContain('data-testid="team-link-message"')
    expect(html).toContain('data-testid="team-link-copy-message"')
    const toggle = /<button[^>]*data-testid="team-link-manage"[^>]*>/.exec(html)?.[0]
    expect(toggle).toContain('aria-expanded="false"')
    expect(toggle).toContain('aria-controls=')
    expect(html).toContain(translate('en', 'teamLink.manage'))
    expect(/<div[^>]*data-testid="team-link-manage-panel"[^>]*>/.exec(html)?.[0]).toContain('hidden=""')
    for (const hidden of ['team-link-url', 'team-link-copy-link', 'team-link-qr', 'team-link-facts', 'team-link-uses', 'team-link-replace', 'team-link-revoke'])
      expect({ hidden, there: html.includes(`data-testid="${hidden}"`) }).toEqual({ hidden, there: false })
    // the link is only in the message, never as its own line
    expect(html.split(URL_.replace(/&/g, '&amp;')).length - 1).toBe(1)
  })
  test('a link held back by its limit still says so, outside the fold', () => {
    const html = view({ ...LINK, link: { ...LINK.link!, limitedUntil: '2026-11-04T10:00:00.000Z' } }, null, true)
    expect(html).toContain('data-testid="team-link-limited"')
  })
  test('no link yet: the create button shows; the settings are folded; an old link is never turned off from here', () => {
    const html = view({ link: null, seats: { used: 4, limit: 10 } }, null, true)
    expect(html).toContain('data-testid="team-link-create"')
    expect(html).toContain('data-testid="team-link-manage"')
    for (const hidden of ['team-link-uses-input', 'team-link-days', 'team-link-skill'])
      expect({ hidden, there: html.includes(`data-testid="${hidden}"`) }).toEqual({ hidden, there: false })
    for (const state of ['expired', 'used_up', 'stopped'] as const) {
      const stale = view({ ...LINK, link: { ...LINK.link!, state } }, null, true)
      expect(stale).toContain('data-testid="team-link-stale"')
      expect(stale).toContain('data-testid="team-link-create"')
      expect(stale).not.toContain('data-testid="team-link-revoke"')
    }
  })
  test('no seats left: why the button is off stays in view', () => {
    const html = view({ link: null, seats: { used: 10, limit: 10 } }, null, true)
    expect(html).toContain('data-testid="team-link-full"')
    expect(/<button[^>]*data-testid="team-link-create"[^>]*>/.exec(html)?.[0]).toContain('disabled=""')
  })
})

describe('on screen', () => {
  const realFetch = globalThis.fetch
  const before = useLocaleStore.getState().locale
  let routes: Record<string, (init?: RequestInit) => Response> = {}
  const calls: { key: string; body: string | null }[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'ko' })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
      calls.push({ key: `${init?.method ?? 'GET'} ${String(input)}`, body: typeof init?.body === 'string' ? init.body : null })
      return routes[key]?.(init) ?? json(500, { error: { code: 'internal', message: `no route ${key}` } })
    }) as unknown as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    removeDom()
    useLocaleStore.setState({ locale: before })
  })

  test('the join form: name, username, password; no second password; the eye shows what was typed', async () => {
    const sent: unknown[] = []
    let short = 0
    const m = await mount(<JoinForm submitLabel="가입" busy={false} error={null} onSubmit={(v) => sent.push(v)} onTooShort={() => short++} />)
    try {
    expect(m.find('invite-password2')).toBeNull()
    expect(m.html()).not.toContain(translate('ko', 'auth.passwordAgain'))
    expect(m.container.querySelectorAll('input').length).toBe(3)
    await m.type('invite-name', ' 김하나 ')
    await m.type('invite-username', 'hana')
    await m.type('invite-password', 'short')
    await m.click('invite-submit')
    expect([short, sent.length]).toEqual([1, 0])
    expect(m.get('invite-password').getAttribute('type')).toBe('password')
    await m.click('invite-password-show')
    expect(m.get('invite-password').getAttribute('type')).toBe('text')
    expect(m.get('invite-password-show').getAttribute('aria-pressed')).toBe('true')
    await m.type('invite-password', 'tulip meadow 2026')
    await m.click('invite-submit')
    expect(sent).toEqual([{ name: '김하나', username: 'hana', password: 'tulip meadow 2026' }])
    } finally { await m.unmount() }
  })

  test('/join: the token goes in a POST body, never a path or query, leaves the address bar, and the member lands on the skill', async () => {
    const replaced: string[] = []
    const g = globalThis as Record<string, unknown>
    const was = { location: Object.getOwnPropertyDescriptor(g, 'location'), history: Object.getOwnPropertyDescriptor(g, 'history') }
    Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/join', search: '', hash: `#t=${TOKEN}`, origin: 'https://acme.example', href: `https://acme.example/join#t=${TOKEN}` } })
    Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { state: null, replaceState: (_s: unknown, _t: string, u: string) => replaced.push(u) } })
    const me = { user: { id: 'hana', username: 'hana', name: '김하나', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true } }
    const run = `/skills?run=${encodeURIComponent('skills/marketing/ad-copy/SKILL.md')}`
    routes = {
      'POST /api/team-link/info': () => json(200, { teamName: 'Acme', valid: true, problem: null, expiresAt: '2026-11-18T00:00:00.000Z', skillName: 'ad-copy' }),
      'POST /api/team-link/join': () => json(201, { me, next: run }),
    }
    calls.length = 0
    function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname + l.search}</p> }
    // the session store's own sign-in (theme, team icon, language) is not what this tests
    const signedIn = useSession.getState().signedIn
    const signedInWith: unknown[] = []
    useSession.setState({ signedIn: (me) => { signedInWith.push(me.user.id) } })
    let m: Mounted | null = null
    try {
      m = await mount(<MemoryRouter initialEntries={['/join']}><Routes><Route path="/join" element={<TeamJoin />} /><Route path="*" element={<Where />} /></Routes></MemoryRouter>)
      await m!.until(() => m!.find('join-form'), 'the join form')
      expect(replaced).toEqual(['/join'])
      // the skill's folder name as words when it has no title (never 'ad-copy')
      expect(m!.html()).toContain('ad copy')
      expect(m!.html()).not.toContain('ad-copy')
      expect(m!.find('invite-password2')).toBeNull()
      await m!.type('invite-name', '김하나')
      await m!.type('invite-username', 'hana')
      await m!.type('invite-password', 'tulip meadow 2026')
      await m!.click('invite-submit')
      await m!.until(() => m!.find('where'), 'the next page')
      expect(m!.get('where').textContent).toBe(run)
      // no request carries the token in its address (a health check may run beside them)
      for (const c of calls) expect(c.key.includes(TOKEN)).toBe(false)
      const ours = calls.filter((c) => c.key.includes('/team-link'))
      expect(ours.map((c) => c.key)).toEqual(['POST /api/team-link/info', 'POST /api/team-link/join'])
      expect(JSON.parse(ours[0]!.body!)).toEqual({ token: TOKEN })
      expect(JSON.parse(ours[1]!.body!)).toMatchObject({ token: TOKEN, name: '김하나', username: 'hana', password: 'tulip meadow 2026' })
      expect(JSON.parse(ours[1]!.body!)).not.toHaveProperty('password2')
      expect(signedInWith).toEqual(['hana'])
    } finally {
      await m?.unmount()
      useSession.setState({ signedIn })
      for (const [k, d] of Object.entries(was)) { if (d) Object.defineProperty(g, k, d); else delete g[k] }
    }
  })

  test('/join with a link that no longer works: a clear "ask for a new link", no form', async () => {
    const g = globalThis as Record<string, unknown>
    const was = { location: Object.getOwnPropertyDescriptor(g, 'location'), history: Object.getOwnPropertyDescriptor(g, 'history') }
    Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { state: null, replaceState: noop } })
    try {
      for (const [problem, key] of [['expired', 'teamLink.problem.expired'], ['used_up', 'teamLink.problem.used_up'], ['revoked', 'teamLink.problem.revoked'], ['stopped', 'teamLink.problem.revoked'], ['full', 'teamLink.problem.full'], [null, 'teamLink.problem.missing']] as const) {
        Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/join', search: '', hash: `#t=${TOKEN}` } })
        routes = { 'POST /api/team-link/info': () => problem ? json(200, { teamName: 'Acme', valid: false, problem, expiresAt: '2026-11-18T00:00:00.000Z', skillName: null }) : json(404, { error: { code: 'not_found', message: 'x' } }) }
        const m = await mount(<MemoryRouter initialEntries={['/join']}><TeamJoin /></MemoryRouter>)
        try {
          await m.until(() => m.find('join-problem'), `the problem ${problem}`)
          expect(m.get('join-problem').textContent).toBe(translate('ko', key))
          expect(m.get('join-problem').textContent).toMatch(/새 링크|알려 주세요/)
          expect(m.find('join-form')).toBeNull()
        } finally { await m.unmount() }
      }
    } finally {
      for (const [k, d] of Object.entries(was)) { if (d) Object.defineProperty(g, k, d); else delete g[k] }
    }
  })

  test('changing a link without a skill picker (the wizard) keeps its skill; the picker\'s choice wins where there is one', async () => {
    const made: unknown[] = []
    for (const [skills, want] of [[null, 'skills/marketing/ad-copy/SKILL.md'], [[{ path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', description: '' }], 'skills/marketing/ad-copy/SKILL.md']] as const) {
      made.length = 0
      const m = await mount(<TeamLinkView data={LINK} inviter="Olga" team="Acme" groups={[]} skills={skills as never} busy={false} onCreate={(b) => made.push(b)} onRevoke={noop} />)
      try {
        await m.click('team-link-replace')
        await m.click('team-link-create')
        expect(made).toEqual([{ groupIds: [], expiresInDays: 14, skillPath: want }])
      } finally { await m.unmount() }
    }
  })

  test('folded: "링크 관리" opens the link, copy link, QR, its facts and "새 링크로 바꾸기" in place; never "링크 끄기"', async () => {
    const made: unknown[] = []
    const m = await mount(<TeamLinkView data={LINK} inviter="Olga" team="Acme" groups={[]} skills={null} busy={false} folded onCreate={(b) => made.push(b)} onRevoke={noop} />)
    try {
      expect(m.find('team-link-url')).toBeNull()
      expect(m.get('team-link-manage').getAttribute('aria-expanded')).toBe('false')
      await m.click('team-link-manage')
      expect(m.get('team-link-manage').getAttribute('aria-expanded')).toBe('true')
      const panel = m.get('team-link-manage-panel')
      expect(panel.hasAttribute('hidden')).toBe(false)
      expect(m.get('team-link-manage').getAttribute('aria-controls')).toBe(panel.id)
      expect(m.get('team-link-url').textContent).toBe(URL_)
      for (const there of ['team-link-copy-link', 'team-link-qr', 'team-link-uses', 'team-link-expires', 'team-link-replace']) expect({ there, ok: !!m.find(there) }).toEqual({ there, ok: true })
      expect(m.find('team-link-revoke')).toBeNull()
      // a change asked for shows its settings open, with the skill the link had
      await m.click('team-link-replace')
      expect(m.find('team-link-uses-input')).not.toBeNull()
      await m.click('team-link-create')
      expect(made).toEqual([{ groupIds: [], expiresInDays: 14, skillPath: 'skills/marketing/ad-copy/SKILL.md' }])
    } finally { await m.unmount() }
  })

  test('folded, no link yet: "링크 관리" opens the settings; what is set there goes with the one press', async () => {
    const made: unknown[] = []
    const m = await mount(<TeamLinkView data={{ link: null, seats: { used: 1, limit: null } }} inviter="Olga" team="Acme" groups={[]} skills={null} busy={false} folded onCreate={(b) => made.push(b)} onRevoke={noop} />)
    try {
      expect(m.find('team-link-uses-input')).toBeNull()
      await m.click('team-link-manage')
      await m.type('team-link-uses-input', '5')
      // a number that does not fit keeps the settings open, so the reason the button is off stays readable
      await m.type('team-link-uses-input', '0')
      await m.click('team-link-manage')
      expect(m.find('team-link-uses-input')).not.toBeNull()
      expect(m.get('team-link-create').hasAttribute('disabled')).toBe(true)
      await m.type('team-link-uses-input', '5')
      await m.click('team-link-manage')
      expect(m.find('team-link-uses-input')).toBeNull()
      await m.click('team-link-create')
      expect(made).toEqual([{ groupIds: [], expiresInDays: 14, maxUses: 5 }])
    } finally { await m.unmount() }
  })

  test('InviteStep: makes the link in one press, shows the message; "later" asks softly first', async () => {
    let link: TeamLinkResponse = { link: null, seats: { used: 1, limit: null } }
    routes = {
      'GET /api/admin/groups': () => json(200, { items: [] }),
      'GET /api/admin/team-link': () => json(200, link),
      'POST /api/admin/team-link': () => { link = { ...LINK, link: { ...LINK.link!, skill: null, uses: 0, maxUses: 20 }, seats: { used: 1, limit: null } }; return json(201, link) },
    }
    calls.length = 0
    let done = 0, skipped = 0
    const m = await mount(<MemoryRouter><InviteStep onDone={() => done++} onSkip={() => skipped++} /></MemoryRouter>)
    try {
    await m.until(() => m.find('team-link-create'), 'the create button')
    // the wizard has no group or skill picker
    expect(m.find('team-link-skill')).toBeNull()
    // the settings wait under "링크 관리"; the one press makes the link with the defaults
    expect(m.find('team-link-uses-input')).toBeNull()
    await m.click('team-link-create')
    await m.until(() => m.find('team-link-message'), 'the link')
    expect(JSON.parse(calls.find((c) => c.key === 'POST /api/admin/team-link')!.body!)).toEqual({ groupIds: [], expiresInDays: 14 })
    expect(m.get('team-link-message').textContent).toContain(URL_)
    // the link itself is folded; no "링크 끄기" in this step
    expect(m.find('team-link-url')).toBeNull()
    expect(m.find('team-link-revoke')).toBeNull()
    // later → the soft dialog; 초대하기 goes back, 나중에 skips
    await m.click('invite-step-skip')
    expect(m.html()).toContain('대부분의 팀은 1~2명부터 초대해요')
    await m.click('invite-step-invite')
    expect(m.find('invite-step-invite')).toBeNull()
    expect(skipped).toBe(0)
    await m.click('invite-step-skip')
    await m.click('invite-step-later')
    expect(skipped).toBe(1)
    await m.click('invite-step-done')
    expect(done).toBe(1)
    } finally { await m.unmount() }
  })
})

// docs/DECISIONS.md "M — One meeting note, everyone's own tasks": the team's own group (from the welcome steps) is a new
// link's default group; the invite that points at a skill changes an open link that leads elsewhere (PATCH, same
// address). The link's starter (the lead's files and a question) is gone with 할 일 정리 (docs/DECISIONS.md "DS3").
describe('the team\'s group and the invite\'s skill', () => {
  const GROUP = '01900000-0000-7000-8000-0000000000e1'
  const QUOTES = 'skills/sales/quote-maker/SKILL.md'

  test('whether the open link leads elsewhere: its skill and the team\'s group; a wish already sent for this link is not sent again', () => {
    forgetPatched()
    const want = { skillPath: QUOTES, groupId: GROUP }
    const there = { ...LINK.link!, groupIds: [GROUP], skill: { path: QUOTES, name: 'quote-maker', title: '견적서 쓰기' } }
    expect(linkDiffers(there, want)).toBe(false)
    // another skill, or the team's group missing: it differs, until that wish was sent once
    const other = { ...there, skill: { path: 'skills/other/SKILL.md', name: 'other', title: null } }
    expect(linkDiffers(other, want)).toBe(true)
    expect(linkDiffers({ ...there, groupIds: [] }, want)).toBe(true)
    markPatched(other, want)
    expect(linkDiffers(other, want)).toBe(false)
    // another wish for the same link is still sent
    expect(linkDiffers(other, { ...want, skillPath: 'skills/third/SKILL.md' })).toBe(true)
    // a link that cannot be shared is not changed (a new one is made instead)
    expect(linkDiffers({ ...there, state: 'expired', skill: null }, want)).toBe(false)
    forgetPatched()
  })

  describe('on screen', () => {
    const realFetch = globalThis.fetch
    const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
    let routes: Record<string, (body: any) => Response> = {}
    let calls: { key: string; body: any }[] = []
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const owner = { user: { id: 'olga', username: 'olga', name: 'Olga', email: null, role: 'owner', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'ko' } }
    const progress = {
      startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: null, steps: { profile: 'done', result: 'done', invite: null }, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
      general: { at: '2026-11-04T00:00:00.000Z' }, teamGroup: { id: GROUP, name: 'Acme', folder: 'groups/Acme', notesFolder: 'groups/Acme/회의록' },
    }
    const groups = [{ id: GROUP, name: 'Acme', description: null, memberIds: ['olga'] }]
    beforeAll(() => {
      installDom()
      useLocaleStore.setState({ locale: 'ko' })
      useSession.setState({ status: { kind: 'signed-in', me: owner } } as never)
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        calls.push({ key, body })
        return routes[key]?.(body) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
      }) as unknown as typeof fetch
    })
    afterEach(() => { calls = []; useWelcome.getState().reset() })
    afterAll(() => {
      globalThis.fetch = realFetch
      removeDom()
      useLocaleStore.setState({ locale: before.locale })
      useSession.setState({ status: before.status })
    })
    const called = (key: string) => calls.filter((c) => c.key === key)

    test('a new link starts with the team\'s group and the skill; a link before keeps its own groups', async () => {
      const made: unknown[] = []
      let m = await mount(<TeamLinkView data={{ link: null, seats: { used: 1, limit: null } }} inviter="Olga" team="Acme" groups={groups} skills={null} fixedSkillPath={QUOTES} defaultGroupIds={[GROUP]} busy={false} folded onCreate={(b) => made.push(b)} onRevoke={noop} />)
      try {
        await m.click('team-link-create')
        expect(made).toEqual([{ groupIds: [GROUP], expiresInDays: 14, skillPath: QUOTES }])
      } finally { await m.unmount() }
      made.length = 0
      m = await mount(<TeamLinkView data={{ ...LINK, link: { ...LINK.link!, state: 'expired' } }} inviter="Olga" team="Acme" groups={groups} skills={null} defaultGroupIds={[GROUP]} busy={false} onCreate={(b) => made.push(b)} onRevoke={noop} />)
      try {
        await m.click('team-link-create')
        expect(made).toEqual([{ groupIds: [], expiresInDays: 14, skillPath: 'skills/marketing/ad-copy/SKILL.md' }])
      } finally { await m.unmount() }
    })

    test('Admin › Members: no link yet, the team\'s group is checked; nothing is changed by itself', async () => {
      let link: TeamLinkResponse = { link: null, seats: { used: 1, limit: null } }
      routes = {
        'GET /api/onboarding/welcome': () => json(200, { progress }),
        'GET /api/admin/groups': () => json(200, { items: groups }),
        'GET /api/skills': () => json(200, { items: [] }),
        'GET /api/admin/team-link': () => json(200, link),
        'POST /api/admin/team-link': (b) => { link = { ...LINK, link: { ...LINK.link!, groupIds: b.groupIds, skill: null } }; return json(201, link) },
      }
      const m = await mount(<MemoryRouter><TeamLinkPanel /></MemoryRouter>)
      try {
        await m.until(() => m.find('team-link-create'), 'the form')
        // (a checkbox's checked is a property React sets)
        await m.until(() => (m.container.querySelector('input[type="checkbox"]') as unknown as { checked: boolean } | null)?.checked, 'the team\'s group checked')
        await m.click('team-link-create')
        await m.until(() => called('POST /api/admin/team-link').length, 'made')
        expect(called('POST /api/admin/team-link')[0]!.body).toEqual({ groupIds: [GROUP], expiresInDays: 14 })
        expect(called('PATCH /api/admin/team-link')).toEqual([])
      } finally { await m.unmount() }
    })

    test('the invite that points at a skill and an open link that leads elsewhere: changed once (same address), then its message', async () => {
      let link: TeamLinkResponse = LINK
      routes = {
        'GET /api/onboarding/welcome': () => json(200, { progress }),
        'GET /api/admin/groups': () => json(200, { items: groups }),
        'GET /api/admin/team-link': () => json(200, link),
        'PATCH /api/admin/team-link': (b) => {
          link = { ...LINK, link: { ...LINK.link!, groupIds: [...LINK.link!.groupIds, ...b.addGroupIds], skill: { path: b.skillPath, name: 'quote-maker', title: '견적서 쓰기' } } }
          return json(200, link)
        },
      }
      forgetPatched()
      let m = await mount(<MemoryRouter><InviteStep title={null} skillPath={QUOTES} retarget onDone={noop} /></MemoryRouter>)
      try {
        await m.until(() => m.find('team-link-message'), 'the message')
        expect(called('PATCH /api/admin/team-link').map((c) => c.body)).toEqual([{ skillPath: QUOTES, addGroupIds: [GROUP] }])
        expect(m.get('team-link-message').textContent).toContain("'견적서 쓰기' 스킬을 같이 써 보자고 해요")
        expect(called('POST /api/admin/team-link')).toEqual([])
      } finally { await m.unmount() }
      // opened again: the link leads there now, nothing to change
      calls = []
      m = await mount(<MemoryRouter><InviteStep title={null} skillPath={QUOTES} retarget onDone={noop} /></MemoryRouter>)
      try {
        await m.until(() => m.find('team-link-message'), 'the message')
        await m.settle(30)
        expect(called('PATCH /api/admin/team-link')).toEqual([])
      } finally { await m.unmount() }
    })
  })
})
