// The team invite link on screen (onboarding stream E): the token read from the #fragment and taken out of the address
// bar, sent only in a POST body; the join form with no password confirmation (an eye button instead); the ready-made
// message in every language; where a new member lands; the Members card and the wizard's InviteStep with its soft
// "later" dialog.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { useState } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { TeamLinkResponse } from '@mycel/shared/api'
import { DICTS, LOCALES, translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { formatDateTime } from '../../src/lib/format'
import { readJoinToken, teamLinkMessage, withInviteLink } from '../../src/lib/team-link'
import { namedProduct } from '../../src/lib/tabs'
import { JoinForm, TeamJoin } from '../../src/pages/Auth'
import { forgetPatched, joinsText, linkDiffers, markPatched, TeamLinkPanel, TeamLinkView } from '../../src/components/onboarding/TeamLinkPanel'
import { InviteStep } from '../../src/components/onboarding/InviteStep'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { installDom, mount, removeDom, type FakeElement as FakeEl, type Mounted } from './dom-host'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const URL_ = `https://acme.example/join#t=${TOKEN}`
/** a link's end as the message writes it (formatDateTime in the message's language) */
const UNTIL = 'Dec 2, 2026, 2:30 PM'
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

})

describe('the ready-made message', () => {
  const ko = (k: MessageKey, p?: Record<string, string | number>) => translate('ko', k, p)
  const en = (k: MessageKey, p?: Record<string, string | number>) => translate('en', k, p)
  test('Korean: a hello from the inviter, the team\'s line, what it is for, the skill set up for the team, the link alone on the last line', () => {
    expect(teamLinkMessage(ko, { until: UNTIL, name: '김하나', team: 'Acme 마케팅', url: URL_, skill: '광고 문구', about: '병원 마케팅 콘텐츠를 만드는 팀이에요' })).toBe([
      `안녕하세요, 김하나입니다. ${named('ko')}에서 Acme 마케팅에 초대할게요.`,
      '우리 팀 소개: 병원 마케팅 콘텐츠를 만드는 팀이에요',
      `우리 팀 AI ${named('ko')}가 일상 문서 작업을 도와줘요.`,
      "우리 팀용으로 '광고 문구' 스킬을 준비해 뒀어요.",
      `이 링크 하나로 팀원 여러 명이 들어올 수 있어요. ${UNTIL}까지 쓸 수 있어요.`,
      '아래 링크로 바로 들어오면 돼요.',
      URL_,
    ].join('\n'))
  })
  test('no team description: no "우리 팀 소개" line and no blank one; no skill: no skill line (never a made-up first task)', () => {
    const m = teamLinkMessage(ko, { until: UNTIL, name: '김하나', team: 'Acme 마케팅', url: URL_, about: '  ' })
    expect(m).toBe([
      `안녕하세요, 김하나입니다. ${named('ko')}에서 Acme 마케팅에 초대할게요.`,
      `우리 팀 AI ${named('ko')}가 일상 문서 작업을 도와줘요.`,
      `이 링크 하나로 팀원 여러 명이 들어올 수 있어요. ${UNTIL}까지 쓸 수 있어요.`,
      '아래 링크로 바로 들어오면 돼요.',
      URL_,
    ].join('\n'))
    expect(m).not.toContain('\n\n')
    expect(teamLinkMessage(ko, { until: UNTIL, name: '김하나', team: 'Acme', url: URL_, about: null })).not.toContain('우리 팀 소개')
  })
  test('English, with and without a description and a skill; a description over several lines stays one line', () => {
    expect(teamLinkMessage(en, { until: UNTIL, name: 'Dion', team: 'diontree', url: URL_, skill: 'SEO strategy plan', about: 'We make SEO content\nfor clinics' })).toBe([
      `Hi, it's Dion. I'd like you to join diontree on ${named('en')}.`,
      'About us: We make SEO content for clinics',
      `${named('en')}, our team's AI, helps us with everyday documents.`,
      "I set up 'SEO strategy plan' for us.",
      `Several teammates can join with this one link. It works until ${UNTIL}.`,
      'Join with this link:',
      URL_,
    ].join('\n'))
    expect(teamLinkMessage(en, { until: UNTIL, name: 'Dion', team: 'diontree', url: URL_ }).split('\n')).toEqual([
      `Hi, it's Dion. I'd like you to join diontree on ${named('en')}.`,
      `${named('en')}, our team's AI, helps us with everyday documents.`,
      `Several teammates can join with this one link. It works until ${UNTIL}.`,
      'Join with this link:',
      URL_,
    ])
    // no name known: a hello without one, never "Hi, it's ."
    expect(teamLinkMessage(en, { until: UNTIL, name: ' ', team: 'diontree', url: URL_ }).split('\n')[0]).toBe(`Hi! I'd like you to join diontree on ${named('en')}.`)
  })
  test('every language names the person, the team, the product, the description, the skill, keeps to seven lines and ends with the link on its own line', () => {
    for (const { id } of LOCALES) {
      const t = (k: MessageKey, p?: Record<string, string | number>) => translate(id, k, p)
      for (const skill of [null, 'ad-copy']) for (const about of [null, 'Desk fans for small offices']) {
        const m = teamLinkMessage(t, { until: UNTIL, name: 'Ana', team: 'Acme Sales', url: URL_, skill, about })
        const lines = m.split('\n')
        expect({ id, m: lines.at(-1) === URL_ && lines.length <= 7 && lines.every((l) => l.trim()) && m.includes('Ana') && m.includes('Acme Sales') && m.includes(named(id)) && (!skill || m.includes(skill)) && (!about || m.includes(about)) }).toEqual({ id, m: true })
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
  test('Korean: "본인 AI 계정이 필요해요" on its own line before the link, with and without a skill; never without ownAi', () => {
    const lines = (o: { skill?: string; ownAi?: boolean }) => teamLinkMessage(ko, { until: UNTIL, name: '김하나', team: 'Acme', url: URL_, ...o }).split('\n')
    expect(lines({ skill: '할 일 정리', ownAi: true }).slice(-5)).toEqual(["우리 팀용으로 '할 일 정리' 스킬을 준비해 뒀어요.", '본인 AI 계정이 필요해요.', `이 링크 하나로 팀원 여러 명이 들어올 수 있어요. ${UNTIL}까지 쓸 수 있어요.`, '아래 링크로 바로 들어오면 돼요.', URL_])
    expect(lines({ ownAi: true }).slice(-4)).toEqual(['본인 AI 계정이 필요해요.', `이 링크 하나로 팀원 여러 명이 들어올 수 있어요. ${UNTIL}까지 쓸 수 있어요.`, '아래 링크로 바로 들어오면 돼요.', URL_])
    expect(lines({ skill: '할 일 정리' }).join('\n')).not.toContain('본인 AI')
  })
  test('every language: the clause is there only with ownAi, and the message still ends with the whole link', () => {
    for (const { id } of LOCALES) {
      const t = (k: MessageKey, p?: Record<string, string | number>) => translate(id, k, p)
      for (const skill of [null, 'ad-copy']) {
        const plain = teamLinkMessage(t, { until: UNTIL, name: 'Ana', team: 'Acme', url: URL_, skill })
        const own = teamLinkMessage(t, { until: UNTIL, name: 'Ana', team: 'Acme', url: URL_, skill, ownAi: true })
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
    // the shared-link line with the link's real end, written as the Expires row writes it
    const sharedLine = translate('en', 'teamLink.msg.shared', { date: formatDateTime(data.link!.expiresAt, 'en') })
    expect(message(html)).toContain(`I set up &#x27;Weekly report&#x27; for us.\n${sharedLine}\nJoin with this link:\n${URL_.replace(/&/g, '&amp;')}`)
    // a team that writes in Korean: the date in Korean too
    const koMessage = message(renderToStaticMarkup(<TeamLinkView data={data} inviter="Olga" team="Acme" messageLocale="ko" groups={[]} skills={null} shared={shared} busy={false} folded onCreate={noop} onRevoke={noop} />))
    expect(koMessage).toContain(`이 링크 하나로 팀원 여러 명이 들어올 수 있어요. ${formatDateTime(data.link!.expiresAt, 'ko')}까지 쓸 수 있어요.\n아래 링크로 바로 들어오면 돼요.`)
    expect(message(html)).not.toContain('Quote draft')
    expect(html).toContain('data-testid="team-link-landing"')
    expect(message(html)).not.toContain('own AI account')
    html = render({ ...data, link: { ...data.link!, memberAi: 'connect_own' } })
    expect(message(html)).toContain(`You&#x27;ll need your own AI account.\n${sharedLine}\nJoin with this link:`)
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

describe('"Joins: …" (Admin › Members\' rows and the panel; QA TC-458)', () => {
  test('the group names, how many while they load, "Joins no groups"; every language', () => {
    const G = [{ id: 'g1', name: 'Leads' }, { id: 'g2', name: 'Sales' }] as never
    for (const { id } of LOCALES) {
      const t = ((k: MessageKey, p?: Record<string, string | number>) => translate(id, k, p)) as never
      expect(joinsText(t, ['g1', 'g2'], G)).toBe(translate(id, 'teamLink.joins', { groups: 'Leads, Sales' }))
      expect(joinsText(t, ['g1'], [])).toBe(translate(id, 'teamLink.joins', { groups: '1' }))
      expect(joinsText(t, [], G)).toBe(translate(id, 'teamLink.joinsNone'))
    }
    expect(translate('en', 'teamLink.joins', { groups: 'Leads' })).toBe('Joins: Leads')
    expect(translate('en', 'teamLink.joinsNone')).toBe('Joins no groups')
  })
})

// rendered to a string, the screen language is the store's first one (English): the texts are compared in English
describe('the panel (Admin › Members, the wizard)', () => {
  test('an open link: the address, copy link, copy message, uses x/y, the expiry, change and turn off', () => {
    const html = view(LINK)
    // the address on one line, cut in the middle: two spans that read as the whole address
    expect(/data-testid="team-link-url">(.*?)<\/span><\/span>/.exec(html)?.[1]?.replace(/<[^>]*>/g, '')).toBe(URL_.replace(/&/g, '&amp;'))
    expect(html).toContain('Copy link')
    expect(html).toContain('Copy message')
    // a skill without a title: its folder name as words, never the raw 'ad-copy' (also when the title only repeats it)
    expect(html).toContain(`Hi, it&#x27;s Olga. I&#x27;d like you to join Acme on ${named('en')}.`)
    expect(html).toContain('I set up &#x27;ad copy&#x27; for us.')
    expect(html).not.toContain('&#x27;ad-copy&#x27;')
    const repeated = view({ ...LINK, link: { ...LINK.link!, skill: { path: 'skills/general/quote-maker/SKILL.md', name: 'quote-maker', title: 'quote-maker' } } })
    expect(repeated).toContain('&#x27;quote maker&#x27; for us')
    expect(repeated).not.toContain('quote-maker&#x27;')
    expect(html).toContain('data-testid="team-link-uses">3 of 10<')
    expect(html).toContain('data-testid="team-link-seats">6<')
    expect(view({ ...LINK, seats: { used: 4, limit: null } })).not.toContain('data-testid="team-link-seats"')
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
  test('an open link while no seat is left: the panel says so above the message (QA TC-488); not while one is', () => {
    expect(view(LINK)).not.toContain('data-testid="team-link-no-seats"')
    expect(view({ ...LINK, seats: { used: 10, limit: 10 } })).toContain(`data-testid="team-link-no-seats">${translate('en', 'teamLink.noSeats')}<`)
    expect(view({ ...LINK, seats: { used: 10, limit: null } })).not.toContain('data-testid="team-link-no-seats"')
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
    for (const hidden of ['team-link-facts', 'team-link-uses', 'team-link-replace', 'team-link-revoke'])
      expect({ hidden, there: html.includes(`data-testid="${hidden}"`) }).toEqual({ hidden, there: false })
    // the link box, its Copy link and the QR code wait under "링크 관리" too: the message ends with the link
    for (const hidden of ['team-link-url', 'team-link-copy-link', 'team-link-qr']) expect({ hidden, there: html.includes(`data-testid="${hidden}"`) }).toEqual({ hidden, there: false })
    // the step's copy button is the primary until something was sent
    expect(/<button[^>]*data-testid="team-link-copy-message"[^>]*>/.exec(html)?.[0]).toContain('bg-accent text-accent-ink')
    // a link that opens on this computer only still says so outside the fold (QA TC-211)
    expect(view({ ...LINK, link: { ...LINK.link!, url: 'http://127.0.0.1:47820/join#t=AbCdEfGhIjKlMnOpQrSt' } }, null, true)).toContain('data-testid="local-link-note"')
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

  test('/join: the token goes in a POST body, never a path or query, leaves the address bar, and the member lands on Home', async () => {
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
      // the link's skill is not on the join page (the invite message names it), in no spelling
      expect(m!.html()).not.toContain('ad copy')
      expect(m!.html()).not.toContain('ad-copy')
      expect(m!.find('invite-password2')).toBeNull()
      await m!.type('invite-name', '김하나')
      await m!.type('invite-username', 'hana')
      await m!.type('invite-password', 'tulip meadow 2026')
      await m!.click('invite-submit')
      await m!.until(() => m!.find('where'), 'the next page')
      // an older server's skill form is not followed (docs/DECISIONS.md "A new member lands on Home")
      expect(m!.get('where').textContent).toBe('/')
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

  test('/join on a weak connection: the details that did not load say so with Try again, and a refresh still has the link', async () => {
    const g = globalThis as Record<string, unknown>
    const was = { location: Object.getOwnPropertyDescriptor(g, 'location'), history: Object.getOwnPropertyDescriptor(g, 'history') }
    const replaced: string[] = []
    Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { state: null, replaceState: (_s: unknown, _t: string, u: string) => replaced.push(u) } })
    const info = () => json(200, { teamName: 'Acme', valid: true, problem: null, expiresAt: '2026-11-18T00:00:00.000Z', skillName: null })
    let offline = true
    routes = { 'POST /api/team-link/info': () => { if (offline) throw new TypeError('Failed to fetch'); return info() } }
    sessionStorage.clear()
    let m: Mounted | null = null
    try {
      Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/join', search: '', hash: `#t=${TOKEN}`, origin: 'https://acme.example', href: URL_ } })
      m = await mount(<MemoryRouter initialEntries={['/join']}><TeamJoin /></MemoryRouter>)
      await m.until(() => m!.find('join-load-error'), 'the load error')
      // the token left the address bar at once, but this is not "the link does not work"
      expect(replaced).toEqual(['/join'])
      expect(m.get('join-load-error').textContent).toBe(translate('ko', 'error.network'))
      expect(m.find('join-problem')).toBeNull()
      // a refresh (the address has no token any more) still finds the link this tab kept
      await m.unmount()
      Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/join', search: '', hash: '', origin: 'https://acme.example', href: 'https://acme.example/join' } })
      m = await mount(<MemoryRouter initialEntries={['/join']}><TeamJoin /></MemoryRouter>)
      await m.until(() => m!.find('join-retry'), 'Try again after the refresh')
      expect(m.get('join-retry').textContent).toBe(translate('ko', 'common.retry'))
      // the connection is back: Try again loads the form
      offline = false
      await m.click('join-retry')
      await m.until(() => m!.find('join-form'), 'the join form')
      expect(calls.filter((c) => c.key === 'POST /api/team-link/info').every((c) => JSON.parse(c.body!).token === TOKEN)).toBe(true)
    } finally {
      await m?.unmount()
      sessionStorage.clear()
      for (const [k, d] of Object.entries(was)) { if (d) Object.defineProperty(g, k, d); else delete g[k] }
    }
  })

  test('/join: the tab forgets the link once the person joined, or once the server says it does not work', async () => {
    const g = globalThis as Record<string, unknown>
    const was = { location: Object.getOwnPropertyDescriptor(g, 'location'), history: Object.getOwnPropertyDescriptor(g, 'history') }
    Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { state: null, replaceState: noop } })
    const signedIn = useSession.getState().signedIn
    useSession.setState({ signedIn: noop })
    const me = { user: { id: 'hana', username: 'hana', name: '김하나', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true } }
    const at = (hash: string) => Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/join', search: '', hash, origin: 'https://acme.example', href: `https://acme.example/join${hash}` } })
    try {
      // joined
      at(`#t=${TOKEN}`)
      routes = {
        'POST /api/team-link/info': () => json(200, { teamName: 'Acme', valid: true, problem: null, expiresAt: '2026-11-18T00:00:00.000Z', skillName: null }),
        'POST /api/team-link/join': () => json(201, { me, next: null }),
      }
      let m = await mount(<MemoryRouter initialEntries={['/join']}><Routes><Route path="/join" element={<TeamJoin />} /><Route path="*" element={<p data-testid="home" />} /></Routes></MemoryRouter>)
      try {
        await m.until(() => m.find('join-form'), 'the join form')
        expect(sessionStorage.getItem('mycel.joinToken')).toBe(TOKEN)
        await m.type('invite-name', '김하나')
        await m.type('invite-username', 'hana')
        await m.type('invite-password', 'tulip meadow 2026')
        await m.click('invite-submit')
        await m.until(() => m.find('home'), 'Home')
        expect(sessionStorage.getItem('mycel.joinToken')).toBeNull()
      } finally { await m.unmount() }
      // a 404 page that is not the server's answer (a relay or proxy in between): a failed load, the link kept
      at(`#t=${TOKEN}`)
      routes = { 'POST /api/team-link/info': () => new Response('<html>Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } }) }
      m = await mount(<MemoryRouter initialEntries={['/join']}><TeamJoin /></MemoryRouter>)
      try {
        await m.until(() => m.find('join-retry'), 'Try again')
        expect(m.find('join-problem')).toBeNull()
        expect(sessionStorage.getItem('mycel.joinToken')).toBe(TOKEN)
      } finally { await m.unmount() }
      // the server: expired, or unknown
      for (const answer of [() => json(200, { teamName: 'Acme', valid: false, problem: 'expired', expiresAt: '2026-11-01T00:00:00.000Z', skillName: null }), () => json(404, { error: { code: 'not_found', message: 'x' } })]) {
        at(`#t=${TOKEN}`)
        routes = { 'POST /api/team-link/info': answer }
        m = await mount(<MemoryRouter initialEntries={['/join']}><TeamJoin /></MemoryRouter>)
        try {
          await m.until(() => m.find('join-problem'), 'the problem')
          expect(sessionStorage.getItem('mycel.joinToken')).toBeNull()
        } finally { await m.unmount() }
      }
    } finally {
      sessionStorage.clear()
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

  test('"Copied" is for the copied words: an edit or an emptied box brings "Copy message" back (QA TC-2846)', async () => {
    const g = globalThis as Record<string, unknown>
    const was = Object.getOwnPropertyDescriptor(g, 'navigator')
    const copied: string[] = []
    Object.defineProperty(g, 'navigator', { configurable: true, writable: true, value: { userAgent: 'test', clipboard: { writeText: async (s: string) => { copied.push(s) } } } })
    const m = await mount(<TeamLinkView data={LINK} inviter="Olga" team="Acme" groups={[]} skills={null} busy={false} folded onCreate={noop} onRevoke={noop} />)
    try {
      const button = () => m.get('team-link-copy-message')
      expect(button().textContent).toContain(translate('ko', 'teamLink.copyMessage'))
      await m.click('team-link-copy-message')
      await m.until(() => copied.length > 0, 'the copy')
      await m.until(() => button().textContent?.includes(translate('ko', 'common.copied')), '"Copied"')
      // an edit: the words on the clipboard are not these any more
      await m.type('team-link-message', `안녕하세요\n${URL_}`)
      expect(button().textContent).toContain(translate('ko', 'teamLink.copyMessage'))
      expect(button().textContent).not.toContain(translate('ko', 'common.copied'))
      // copied again, then the box emptied: the button is off and says what it does, not "Copied"
      await m.click('team-link-copy-message')
      await m.until(() => button().textContent?.includes(translate('ko', 'common.copied')), '"Copied" again')
      await m.type('team-link-message', '')
      expect(button().hasAttribute('disabled')).toBe(true)
      expect(button().textContent).toContain(translate('ko', 'teamLink.copyMessage'))
      expect(button().textContent).not.toContain(translate('ko', 'common.copied'))
    } finally {
      await m.unmount()
      if (was) Object.defineProperty(g, 'navigator', was); else delete g.navigator
    }
  })

  test('the groups people join (QA TC-458): "Joins: …", Change groups opens the same checks with "Make a new group"; Save sends the new set', async () => {
    const leads = { id: '01900000-0000-7000-8000-0000000000a1', name: 'Leads', description: '', memberIds: [] }
    const sales = { id: '01900000-0000-7000-8000-0000000000a2', name: 'Sales', description: '', memberIds: [] }
    const data = { ...LINK, link: { ...LINK.link!, groupIds: [leads.id] } }
    const sent: string[][] = []
    const m = await mount(<MemoryRouter><TeamLinkView data={data} inviter="Olga" team="Acme" groups={[leads, sales] as never} skills={null} busy={false} onCreate={noop} onRevoke={noop} onGroups={async (ids) => { sent.push(ids); return true }} /></MemoryRouter>)
    try {
      expect(m.get('team-link-groups').textContent).toBe('Leads')
      await m.click('team-link-groups-change')
      const edit = m.get('team-link-groups-edit')
      expect(edit.textContent).toContain(translate('ko', 'teamLink.groupsKeep'))
      expect(m.get('group-checks-new').getAttribute('href')).toBe('/admin/groups')
      const boxes = edit.querySelectorAll('input[type="checkbox"]') as unknown as FakeEl[]
      expect(boxes.map((b) => (b as unknown as { checked: boolean }).checked)).toEqual([true, false])
      // leads off, sales on (the browser turns a box over before its handlers run; the fake DOM leaves that out)
      for (const b of boxes) {
        const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(b), 'checked')!
        d.set!.call(b, !d.get!.call(b))
        await m.click(b)
      }
      await m.click('team-link-groups-save')
      expect(sent).toEqual([[sales.id]])
      await m.until(() => !m.find('team-link-groups-edit'), 'the editor closes after saving')
    } finally { await m.unmount() }
    // Save on the same groups sends nothing and closes
    const same = await mount(<MemoryRouter><TeamLinkView data={data} inviter="Olga" team="Acme" groups={[leads, sales] as never} skills={null} busy={false} onCreate={noop} onRevoke={noop} onGroups={async (ids) => { sent.push(ids); return true }} /></MemoryRouter>)
    try {
      await same.click('team-link-groups-change')
      await same.click('team-link-groups-save')
      await same.until(() => !same.find('team-link-groups-edit'), 'the editor closes')
      expect(sent).toEqual([[sales.id]])
    } finally { await same.unmount() }
    // no groups: "Joins no groups"; the folded invite step has no link out to Groups
    const none = await mount(<MemoryRouter><TeamLinkView data={LINK} inviter="Olga" team="Acme" groups={[]} skills={null} busy={false} folded onCreate={noop} onRevoke={noop} onGroups={async () => true} /></MemoryRouter>)
    try {
      await none.click('team-link-manage')
      expect(none.get('team-link-groups').textContent).toBe(translate('ko', 'teamLink.groupsNone'))
      await none.click('team-link-groups-change')
      expect(none.find('group-checks-new')).toBeNull()
    } finally { await none.unmount() }
  })

  test('making a link: the group checks link to Admin › Groups (no group made in place)', async () => {
    const g = { id: '01900000-0000-7000-8000-0000000000a1', name: 'Leads', description: '', memberIds: [] }
    const m = await mount(<MemoryRouter><TeamLinkView data={{ link: null, seats: { used: 1, limit: null } }} inviter="Olga" team="Acme" groups={[g] as never} skills={null} busy={false} onCreate={noop} onRevoke={noop} /></MemoryRouter>)
    try {
      expect(m.get('group-checks-new').getAttribute('href')).toBe('/admin/groups')
      expect(m.get('group-checks-new').textContent).toBe(translate('ko', 'teamLink.newGroup'))
    } finally { await m.unmount() }
  })

  test('folded: "링크 관리" opens the link, copy link, QR, its facts and "새 링크로 바꾸기" in place; never "링크 끄기"', async () => {
    const made: unknown[] = []
    const m = await mount(<TeamLinkView data={LINK} inviter="Olga" team="Acme" groups={[]} skills={null} busy={false} folded onCreate={(b) => made.push(b)} onRevoke={noop} />)
    try {
      expect(m.find('team-link-url')).toBeNull()
      expect(m.get('team-link-manage').getAttribute('aria-expanded')).toBe('false')
      await m.click('team-link-manage')
      expect(m.get('team-link-manage').getAttribute('aria-expanded')).toBe('true')
      expect(m.get('team-link-url').textContent).toBe(URL_)
      expect(m.find('team-link-qr')).not.toBeNull()
      const panel = m.get('team-link-manage-panel')
      expect(panel.hasAttribute('hidden')).toBe(false)
      expect(m.get('team-link-manage').getAttribute('aria-controls')).toBe(panel.id)
      for (const there of ['team-link-uses', 'team-link-expires', 'team-link-replace']) expect({ there, ok: !!m.find(there) }).toEqual({ there, ok: true })
      expect(m.find('team-link-revoke')).toBeNull()
      // a change asked for shows its settings open, with the skill the link had
      await m.click('team-link-replace')
      expect(m.find('team-link-uses-input')).not.toBeNull()
      await m.click('team-link-create')
      expect(made).toEqual([{ groupIds: [], expiresInDays: 14, skillPath: 'skills/marketing/ad-copy/SKILL.md' }])
    } finally { await m.unmount() }
  })

  test('the message: the team\'s line in it, in the team\'s language, edited in place; Copy message copies what is there; empty copies nothing', async () => {
    const copied: string[] = []
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { ...globalThis.navigator, clipboard: { writeText: async (x: string) => void copied.push(x) } } })
    const m = await mount(<TeamLinkView data={LINK} inviter="Olga" team="Acme" about="책상 선풍기를 만드는 팀이에요" messageLocale="ko" groups={[]} skills={null} busy={false} folded onCreate={noop} onRevoke={noop} />)
    const field = () => m.get('team-link-message') as unknown as { value: string }
    try {
      expect(field().value.split('\n').slice(0, 2)).toEqual([`안녕하세요, Olga입니다. ${named('ko')}에서 Acme에 초대할게요.`, '우리 팀 소개: 책상 선풍기를 만드는 팀이에요'])
      await m.type('team-link-message', `민지님, 같이 해요!\n${URL_}`)
      expect(field().value).toBe(`민지님, 같이 해요!\n${URL_}`)
      await m.click('team-link-copy-message')
      expect(copied).toEqual([`민지님, 같이 해요!\n${URL_}`])
      await m.type('team-link-message', '  ')
      expect(m.get('team-link-copy-message').hasAttribute('disabled')).toBe(true)
    } finally {
      await m.unmount()
      if (nav) Object.defineProperty(globalThis, 'navigator', nav)
    }
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
    expect((m.get('team-link-message') as unknown as { value: string }).value).toContain(URL_)
    // the link box waits under "링크 관리" (the message holds the link); no "링크 끄기" in this step
    expect(m.find('team-link-url')).toBeNull()
    await m.click('team-link-manage')
    expect(m.find('team-link-url')).not.toBeNull()
    expect(m.find('team-link-qr')).not.toBeNull()
    expect(m.find('team-link-revoke')).toBeNull()
    // later skips at once, with no question first (docs/decisions/20261123-ask-registry-findings.md, decision 13)
    await m.click('invite-step-skip')
    expect(m.container.ownerDocument!.body.querySelector('[role="dialog"]')).toBeNull()
    expect(skipped).toBe(1)
    await m.click('invite-step-done')
    expect(done).toBe(1)
    } finally { await m.unmount() }
  })

  test('InviteStep: after Copy message, "Done" is the one primary; "Later" skips with no dialog, on a phone too', async () => {
    routes = {
      'GET /api/admin/groups': () => json(200, { items: [] }),
      'GET /api/admin/team-link': () => json(200, LINK),
    }
    const copied: string[] = []
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const g = globalThis as Record<string, unknown>
    const media = g.matchMedia
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { ...globalThis.navigator, clipboard: { writeText: async (x: string) => void copied.push(x) } } })
    const primary = (id: string) => m.get(id).className.includes('bg-accent text-accent-ink')
    let skipped = 0
    let m = await mount(<MemoryRouter><InviteStep onDone={noop} onSkip={() => skipped++} /></MemoryRouter>)
    try {
      await m.until(() => m.find('team-link-message'), 'the message')
      expect(primary('team-link-copy-message')).toBe(true)
      expect(primary('invite-step-done')).toBe(false)
      await m.click('team-link-copy-message')
      await m.until(() => copied.length === 1, 'copied')
      await m.until(() => primary('invite-step-done'), 'Done turns primary')
      expect(primary('team-link-copy-message')).toBe(false)
      // already sent: "Later" skips with no dialog, on a computer too
      await m.click('invite-step-skip')
      expect(m.find('invite-step-later')).toBeNull()
      expect(skipped).toBe(1)
      await m.unmount()
      // a phone (no share sheet in this DOM): "Later" skips at once
      g.matchMedia = (q: string) => ({ matches: q.includes('767.98'), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
      m = await mount(<MemoryRouter><InviteStep onDone={noop} onSkip={() => skipped++} /></MemoryRouter>)
      await m.until(() => m.find('team-link-message'), 'the message on a phone')
      await m.click('invite-step-skip')
      expect(m.find('invite-step-later')).toBeNull()
      expect(skipped).toBe(2)
    } finally {
      await m.unmount()
      g.matchMedia = media
      if (nav) Object.defineProperty(globalThis, 'navigator', nav)
    }
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
    // an admin chose the link's groups (Admin › Members' "Change groups"): the team's group is not put back
    expect(linkDiffers({ ...there, groupIds: [], groupsChosen: true }, want)).toBe(false)
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
        expect((m.get('team-link-message') as unknown as { value: string }).value).toContain("우리 팀용으로 '견적서 쓰기' 스킬을 준비해 뒀어요")
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

    // review of #845: the message's words (team language, the profile line), an edit across a change, copy without the
    // link, and what counts as sent
    const panelRoutes = (profile: () => Response) => ({
      'GET /api/onboarding/welcome': () => json(200, { progress }),
      'GET /api/admin/groups': () => json(200, { items: groups }),
      'GET /api/admin/team-link': () => json(200, LINK),
      'GET /api/onboarding/profile': profile,
    })
    const PROFILE = { website: '', oneLine: 'We make desk fans', products: '', audience: '', tone: [], avoid: '', sources: [], updatedAt: '2026-11-15T00:00:00.000Z' }

    test('the message is in the team\'s language while the screen is in another; the profile line is in it', async () => {
      useSession.setState({ status: { kind: 'signed-in', me: { ...owner, team: { ...owner.team, defaultLocale: 'en' } } } } as never)
      routes = panelRoutes(() => json(200, { profile: PROFILE }))
      const m = await mount(<MemoryRouter><TeamLinkPanel skillPicker={false} folded /></MemoryRouter>)
      try {
        const msg = await m.until(() => (m.find('team-link-message') as unknown as { value: string } | null)?.value, 'the message')
        expect(msg.split('\n').slice(0, 2)).toEqual([`Hi, it's Olga. I'd like you to join Acme on ${named('en')}.`, 'About us: We make desk fans'])
        // the screen around it stays Korean
        expect(m.get('team-link-copy-message').textContent).toContain(translate('ko', 'teamLink.copyMessage'))
      } finally {
        await m.unmount()
        useSession.setState({ status: { kind: 'signed-in', me: owner } } as never)
      }
    })

    test('a profile that cannot be read: no "About us" line, the message still shows', async () => {
      routes = panelRoutes(() => json(500, { error: { code: 'internal', message: 'x' } }))
      const m = await mount(<MemoryRouter><TeamLinkPanel skillPicker={false} folded /></MemoryRouter>)
      try {
        const msg = await m.until(() => (m.find('team-link-message') as unknown as { value: string } | null)?.value, 'the message')
        expect(msg).not.toContain('우리 팀 소개')
        expect(msg.startsWith('안녕하세요, Olga입니다.')).toBe(true)
        expect(msg.endsWith(URL_)).toBe(true)
      } finally { await m.unmount() }
    })

    test('an edit stays while the message is the same, and starts again from the new words after another skill or link', async () => {
      let swap: (d: TeamLinkResponse) => void = noop
      function Harness() {
        const [d, setD] = useState<TeamLinkResponse>(LINK)
        swap = setD
        return <TeamLinkView data={d} inviter="Olga" team="Acme" groups={[]} skills={null} busy={false} folded onCreate={noop} onRevoke={noop} />
      }
      const m = await mount(<Harness />)
      const field = () => (m.get('team-link-message') as unknown as { value: string }).value
      try {
        await m.type('team-link-message', `Mina, join us\n${URL_}`)
        // the same link read again (a new object, the same message): the edit stays
        swap({ ...LINK, link: { ...LINK.link! } })
        await m.settle(10)
        expect(field()).toBe(`Mina, join us\n${URL_}`)
        // another skill: the message starts again from its own words
        swap({ ...LINK, link: { ...LINK.link!, skill: { path: QUOTES, name: 'quotes', title: 'Quotes' } } })
        await m.until(() => field().includes("'Quotes'"), 'the new skill in the message')
        expect(field()).not.toContain('Mina')
        // a new link (another address): the same
        await m.type('team-link-message', 'Mina, join us')
        const other = URL_.replace(TOKEN, 'Zz' + TOKEN.slice(2))
        swap({ ...LINK, link: { ...LINK.link!, url: other, skill: { path: QUOTES, name: 'quotes', title: 'Quotes' } } })
        await m.until(() => field().endsWith(other), 'the new address')
        expect(field()).not.toContain('Mina')
      } finally { await m.unmount() }
    })

    test('an edit without the link: Copy message puts the link back on its own last line', async () => {
      expect(withInviteLink('Hi', 'https://x/join#t=a')).toBe('Hi\nhttps://x/join#t=a')
      expect(withInviteLink('Hi  \n', 'https://x/join#t=a')).toBe('Hi\nhttps://x/join#t=a')
      expect(withInviteLink('Hi https://x/join#t=a', 'https://x/join#t=a')).toBe('Hi https://x/join#t=a')
      const copied: string[] = []
      const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
      Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { ...globalThis.navigator, clipboard: { writeText: async (x: string) => void copied.push(x) } } })
      const m = await mount(<TeamLinkView data={LINK} inviter="Olga" team="Acme" groups={[]} skills={null} busy={false} folded onCreate={noop} onRevoke={noop} />)
      try {
        await m.type('team-link-message', '민지님, 같이 해요!')
        await m.click('team-link-copy-message')
        await m.until(() => copied.length, 'copied')
        expect(copied).toEqual([`민지님, 같이 해요!\n${URL_}`])
      } finally {
        await m.unmount()
        if (nav) Object.defineProperty(globalThis, 'navigator', nav)
      }
    })

    test('sent means sent: a used share sheet calls onSent, a closed one and a refused copy do not', async () => {
      const g = globalThis as Record<string, unknown>
      const media = g.matchMedia
      const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
      let answer: 'shared' | 'cancelled' = 'cancelled'
      g.matchMedia = (q: string) => ({ matches: q.includes('767.98'), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
      Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {
        ...globalThis.navigator,
        share: async () => { if (answer === 'cancelled') throw Object.assign(new Error('closed'), { name: 'AbortError' }) },
        // a refused clipboard, and no copy command in this DOM: nothing was copied
        clipboard: { writeText: async () => { throw new Error('denied') } },
      } })
      let sent = 0
      const m = await mount(<TeamLinkView data={LINK} inviter="Olga" team="Acme" groups={[]} skills={null} busy={false} folded onCreate={noop} onRevoke={noop} onSent={() => sent++} />)
      try {
        await m.click('team-link-share')
        await m.settle(20)
        expect(sent).toBe(0)
        await m.click('team-link-copy-message')
        await m.settle(20)
        expect(sent).toBe(0)
        expect(m.get('team-link-copy-message').textContent).not.toContain(translate('ko', 'common.copied'))
        answer = 'shared'
        await m.click('team-link-share')
        await m.until(() => sent === 1, 'sent once')
      } finally {
        await m.unmount()
        g.matchMedia = media
        if (nav) Object.defineProperty(globalThis, 'navigator', nav)
      }
    })
  })
})
