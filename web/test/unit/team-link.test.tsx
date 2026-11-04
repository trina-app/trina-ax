// The team invite link on screen (onboarding stream E): the token read from the #fragment and taken out of the address
// bar, sent only in a POST body; the join form with no password confirmation (an eye button instead); the ready-made
// message in every language; where a new member lands; the Members card and the wizard's InviteStep with its soft
// "later" dialog.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import type { TeamLinkResponse } from '@mycel/shared/api'
import { DICTS, LOCALES, translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { joinNext, readJoinToken, teamLinkMessage } from '../../src/lib/team-link'
import { JoinForm, TeamJoin } from '../../src/pages/Auth'
import { TeamLinkView } from '../../src/components/onboarding/TeamLinkPanel'
import { InviteStep } from '../../src/components/onboarding/InviteStep'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const URL_ = `https://acme.example/join#t=${TOKEN}`
const loc = (href: string) => { const u = new URL(href, 'https://acme.example'); return { pathname: u.pathname, search: u.search, hash: u.hash } }
const noop = () => {}

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
  test('Korean: who invites, the product, the link; with a skill, the skill too', () => {
    const t = (k: MessageKey, p?: Record<string, string | number>) => translate('ko', k, p)
    expect(teamLinkMessage(t, { name: '김하나', url: URL_ })).toBe(`김하나님이 ${PRODUCT.displayName}에서 함께 일하자고 초대했어요. 링크로 바로 들어올 수 있어요: ${URL_}`)
    expect(teamLinkMessage(t, { name: '김하나', url: URL_, skill: '광고 문구' })).toBe(`김하나님이 ${PRODUCT.displayName}에서 함께 일하자고 초대했어요. '광고 문구' 스킬을 같이 써 보자고 해요. 링크로 바로 들어올 수 있어요: ${URL_}`)
  })
  test('every language names the person, the product, the skill and ends with the whole link', () => {
    for (const { id } of LOCALES) {
      const t = (k: MessageKey, p?: Record<string, string | number>) => translate(id, k, p)
      for (const skill of [null, 'ad-copy']) {
        const m = teamLinkMessage(t, { name: 'Ana', url: URL_, skill })
        expect({ id, m: m.endsWith(URL_) && m.includes('Ana') && m.includes(PRODUCT.displayName) && (!skill || m.includes(skill)) }).toEqual({ id, m: true })
      }
    }
  })
  test('every teamLink text exists in all five languages', () => {
    const keys = Object.keys(DICTS.ko).filter((k) => k.startsWith('teamLink.') || k.startsWith('audit.act.team_link.'))
    expect(keys.length).toBeGreaterThan(40)
    for (const { id } of LOCALES) for (const k of keys) expect({ id, k, ok: !!DICTS[id][k as MessageKey]?.trim() }).toEqual({ id, k, ok: true })
  })
})

const LINK: TeamLinkResponse = {
  link: { id: '01900000-0000-7000-8000-000000000001', url: URL_, groupIds: [], skill: { path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy' }, maxUses: 10, uses: 3, createdBy: { id: 'olga', name: 'Olga' }, createdAt: '2026-11-04T00:00:00.000Z', expiresAt: '2026-11-18T00:00:00.000Z', state: 'active' },
  seats: { used: 4, limit: 10 },
}
const view = (data: TeamLinkResponse, skills: { path: string; name: string; description: string }[] | null = []) =>
  renderToStaticMarkup(<TeamLinkView data={data} inviter="Olga" groups={[]} skills={skills} busy={false} onCreate={noop} onRevoke={noop} />)

// rendered to a string, the screen language is the store's first one (English): the texts are compared in English
describe('the panel (Admin › Members, the wizard)', () => {
  test('an open link: the address, copy link, copy message, uses x/y, the expiry, change and turn off', () => {
    const html = view(LINK)
    expect(html).toContain(`data-testid="team-link-url">${URL_.replace(/&/g, '&amp;')}<`)
    expect(html).toContain('Copy link')
    expect(html).toContain('Copy message')
    expect(html).toContain(`Olga invited you to work together in ${PRODUCT.displayName} and to try the &#x27;ad-copy&#x27; skill together.`)
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
      expect(m!.html()).toContain('ad-copy')
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
      const m = await mount(<TeamLinkView data={LINK} inviter="Olga" groups={[]} skills={skills as never} busy={false} onCreate={(b) => made.push(b)} onRevoke={noop} />)
      try {
        await m.click('team-link-replace')
        await m.click('team-link-create')
        expect(made).toEqual([{ groupIds: [], expiresInDays: 14, skillPath: want }])
      } finally { await m.unmount() }
    }
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
    await m.click('team-link-create')
    await m.until(() => m.find('team-link-url'), 'the link')
    expect(JSON.parse(calls.find((c) => c.key === 'POST /api/admin/team-link')!.body!)).toEqual({ groupIds: [], expiresInDays: 14 })
    expect(m.get('team-link-message').textContent).toContain(URL_)
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
