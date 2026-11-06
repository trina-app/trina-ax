// The company profile step (docs/DECISIONS.md "D — Company profile from the company website"): the review shows every
// field with its source page and excerpt and a way to remove it; only http(s) sources become links; tone stays at
// four chips; what is saved is trimmed and keeps sources only for fields that still have a value. The reading lines
// ("R"), and what the server collected while reading ("N"): the images line, the brand colours as swatches that can
// only be removed, saved with the profile, and shown in Admin › Team settings. While it reads, only "later" ("W2").
// In the welcome steps (autoSave) a website draft with a one-line intro is saved as it came, without the review, only
// while the team has no saved profile.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { profilePrefill, type CompanyProfile, type ProfileDraftPage } from '@mycel/shared/api'
import ProfileStep, { brandColors, DraftActivity, pagesUsed, shortUrl, tidyProfile, toneChips } from '../../src/components/onboarding/ProfileStep'
import CompanyProfileCard from '../../src/components/onboarding/CompanyProfileCard'
import { useLocaleStore } from '../../src/i18n'
import { useAiAccess } from '../../src/store/aiAccess'
import { chatActivity } from '../../src/store/live'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const noop = () => {}
const PROFILE: CompanyProfile = {
  website: 'https://www.acme.example/', oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', audience: '', tone: ['friendly', 'plain'], avoid: '',
  sources: [
    { field: 'oneLine', url: 'https://www.acme.example/about', excerpt: 'We make quiet fans.' },
    { field: 'products', url: 'javascript:alert(1)', excerpt: 'planted' },
  ],
  updatedAt: '2026-11-04T00:00:00.000Z',
}
const render = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>)

test('tone: chips from commas, no repeats, at most four, each cut to 20 characters', () => {
  expect(toneChips('friendly, Friendly , expert，calm、warm, loud')).toEqual(['friendly', 'expert', 'calm', 'warm'])
  expect(toneChips('a, b', ['a'])).toEqual(['a', 'b'])
  expect(toneChips('x'.repeat(30))).toEqual(['x'.repeat(20)])
})

test('what is saved: trimmed, the website normalized, sources only for fields that still have a value', () => {
  const out = tidyProfile({ ...PROFILE, website: ' acme.example ', oneLine: '  Acme  ', products: '' })
  expect(out.website).toBe('https://acme.example/')
  expect(out.oneLine).toBe('Acme')
  expect(out.sources.map((s) => s.field)).toEqual(['oneLine'])
  expect('updatedAt' in out).toBe(false)
})

test('a saved profile opens in the review: fields, sources as links, remove buttons', () => {
  const html = render(<ProfileStep initial={PROFILE} onDone={noop} onSkip={noop} skipLabel="Cancel" />)
  expect(html).toContain('data-testid="profile-step-review"')
  expect(html).toContain('value="Acme makes quiet desk fans."')
  // the source page as a link that opens apart from the app, with the excerpt
  expect(html).toContain('href="https://www.acme.example/about" target="_blank" rel="noopener noreferrer"')
  expect(html).toContain('www.acme.example/about')
  expect(html).toContain('“We make quiet fans.”')
  // a source address that is not http(s) never becomes a link
  expect(html).not.toContain('javascript:')
  // each tone chip has its own remove button; a filled field has one too
  expect(html).toContain('aria-label="Remove friendly"')
  expect(html).toContain('aria-label="Remove plain"')
  expect(html).toContain('aria-label="Remove One-line intro"')
  expect(html).not.toContain('aria-label="Remove Customers"')
  expect(html).toContain('>Cancel<')
})

test('without a profile it asks for the website, prefilled when one is given', () => {
  const html = render(<ProfileStep onDone={noop} initialWebsite="https://acme.example/" />)
  expect(html).toContain('data-testid="profile-step-site"')
  expect(html).toContain('value="https://acme.example/"')
  // no skip button without onSkip
  expect(html).not.toContain('>Later<')
})

test('skill inputs read the profile as company.<field> (tone as one text); empty fields are left out', () => {
  expect(profilePrefill(PROFILE)).toEqual({
    'company.website': 'https://www.acme.example/', 'company.oneLine': 'Acme makes quiet desk fans.', 'company.products': 'Desk fans', 'company.tone': 'friendly, plain',
  })
  expect(profilePrefill(null)).toEqual({})
})

test('the company name is the first field: the profile\'s own, else the team\'s name to confirm', async () => {
  const { useSession } = await import('../../src/store/session')
  const before = useSession.getInitialState().status
  // a static render reads the store's initial state
  Object.assign(useSession.getInitialState(), { status: { kind: 'signed-in', me: { user: { id: 'u1', role: 'owner' }, team: { name: 'Acme Team', defaultLocale: 'en' } } } })
  try {
    const html = render(<ProfileStep initial={PROFILE} onDone={noop} />)
    expect(html).toContain('data-testid="profile-name"')
    expect(html).toContain('value="Acme Team"')
    // first: before the website and the one-line intro
    expect(html.indexOf('data-testid="profile-name"')).toBeLessThan(html.indexOf('value="https://www.acme.example/"'))
    expect(html.indexOf('>Company name<')).toBeLessThan(html.indexOf('>One-line intro<'))
    expect(render(<ProfileStep initial={{ ...PROFILE, name: 'Acme' }} onDone={noop} />)).toContain('value="Acme"')
    // what is saved keeps the name, trimmed
    expect(tidyProfile({ ...PROFILE, name: '  Acme  ' }).name).toBe('Acme')
  } finally { Object.assign(useSession.getInitialState(), { status: before }) }
})

// While the AI reads the website: what will happen first, then one line per page as the server opened or skipped it
// (real addresses, the page title when there is one, a short reason), then "writing" (docs/DECISIONS.md "R").
const page = (p: Partial<ProfileDraftPage> & Pick<ProfileDraftPage, 'url' | 'status'>): ProfileDraftPage =>
  ({ finalUrl: null, reason: null, title: null, startedAt: '2026-11-05T00:00:00.000Z', endedAt: null, ...p })

test('reading: before any page, one line that says what will happen, with the site', () => {
  const html = render(<DraftActivity source="website" site="acme.example" steps={[]} writing={false} />)
  expect(html).toContain('data-testid="profile-activity-intro"')
  expect(html).toContain('Public pages only: up to 4 on acme.example')
  expect(html).not.toContain('profile-activity-ok')
  expect(html).not.toContain('Writing the company profile')
})

test('reading: one plain line per page, newest last: reading, read with its title, not read with why, then writing', () => {
  const steps = [
    page({ url: 'https://www.acme.example/', status: 'ok', finalUrl: 'https://www.acme.example/ko/', title: 'Acme Fans | Quiet desk fans for every small office in town' }),
    page({ url: 'https://acme.example/about', status: 'ok', finalUrl: 'https://acme.example/about' }),
    page({ url: 'https://acme.example/blank', status: 'failed', reason: 'empty', finalUrl: 'https://acme.example/blank' }),
    page({ url: 'https://acme.example/missing', status: 'failed', reason: 'unreachable' }),
    page({ url: 'https://acme.example/go', status: 'failed', reason: 'off_site', finalUrl: 'https://other.example/landing' }),
    page({ url: 'https://acme.example/guess', status: 'failed', reason: 'not_linked' }),
    page({ url: 'https://acme.example/more', status: 'refused', reason: 'limit' }),
    page({ url: 'https://other.example/x', status: 'refused', reason: 'off_site' }),
    page({ url: 'https://acme.example/%ED%9A%8C%EC%82%AC', status: 'running' }),
  ]
  const html = render(<DraftActivity source="website" site="acme.example" steps={steps} writing />)
  // the page title, then where it really was (after redirects)
  expect(html).toContain('Read · Acme Fans | Quiet desk fans for every s… (acme.example/ko)')
  expect(html).toContain('Read · acme.example/about')
  expect(html).toContain('Not read · acme.example/blank (almost no text)')
  expect(html).toContain('Not read · acme.example/missing (did not open)')
  // a refused redirect: the page asked for and where it tried to go
  expect(html).toContain('Not read · acme.example/go → other.example/landing (outside this site, skipped)')
  expect(html).toContain('Not read · acme.example/guess (not linked from a page, skipped)')
  expect(html).toContain('Not read · acme.example/more (only 4 pages, skipped)')
  expect(html).toContain('Not read · other.example/x (outside this site, skipped)')
  // a Korean path reads as written
  expect(html).toContain('Reading · acme.example/회사')
  expect(html).toContain('Writing the company profile')
  // newest last: the intro first, the writing line at the end
  const at = (s: string) => html.indexOf(s)
  expect(at('Public pages only')).toBeLessThan(at('Read · Acme Fans'))
  expect(at('Not read · other.example/x')).toBeLessThan(at('Reading · acme.example/회사'))
  expect(at('Reading · acme.example/회사')).toBeLessThan(at('Writing the company profile'))
  // plain lines, no boxes; a page title is text, never markup
  expect(html).not.toContain('border')
  expect(render(<DraftActivity source="website" site="acme.example" steps={[page({ url: 'https://acme.example/', status: 'ok', title: '<img src=x onerror=alert(1)>' })]} writing={false} />)).not.toContain('<img')
  // the count: pages that took a place (refused ones did not), at most 4
  expect(pagesUsed(steps)).toBe(4)
  expect(pagesUsed(steps.slice(0, 2))).toBe(2)
  expect(pagesUsed([])).toBe(0)
})

test('reading pasted text: one line, no pages', () => {
  const html = render(<DraftActivity source="text" site={null} steps={[]} writing={false} />)
  expect(html).toContain('Going through the pasted text')
  expect(html).not.toContain('Public pages only')
})

test('addresses as shown: no scheme, www. or trailing slash, cut when long', () => {
  expect(shortUrl('https://www.acme.example/')).toBe('acme.example')
  expect(shortUrl('http://shop.acme.example/p?id=1')).toBe('shop.acme.example/p?id=1')
  expect(shortUrl(`https://acme.example/${'a'.repeat(80)}`)).toHaveLength(48)
  expect(shortUrl('not a url')).toBe('not a url')
})

test('brand colours: "#rrggbb" in lower case, each once, at most five; saved only when some are left', () => {
  expect(brandColors(['#37EE6A', '#37ee6a', ' #0b140d ', 'red', '#fff', 'url(x)', '#123456', '#abcdef', '#000000', '#ffffff'])).toEqual(['#37ee6a', '#0b140d', '#123456', '#abcdef', '#000000'])
  expect(brandColors(undefined)).toEqual([])
  expect(tidyProfile({ ...PROFILE, colors: ['#37EE6A', 'nope'] }).colors).toEqual(['#37ee6a'])
  // none left (or a profile from before them): no key at all
  expect('colors' in tidyProfile({ ...PROFILE, colors: [] })).toBe(false)
  expect('colors' in tidyProfile(PROFILE)).toBe(false)
})

test('the review: the brand colours as round swatches, the hex as their name, each with its own remove button; none: no field', () => {
  const html = render(<ProfileStep initial={{ ...PROFILE, colors: ['#37ee6a', '#0b140d'] }} onDone={noop} />)
  expect(html).toContain('data-testid="profile-colors"')
  expect(html).toContain('>Brand colors<')
  expect(html).toContain('role="img" aria-label="#37ee6a" title="#37ee6a"')
  expect(html).toContain('background-color:#37ee6a')
  expect(html).toContain('aria-label="Remove #37ee6a"')
  expect(html).toContain('aria-label="Remove #0b140d"')
  // no picker and no way to add one
  expect(html).not.toContain('type="color"')
  expect(render(<ProfileStep initial={PROFILE} onDone={noop} />)).not.toContain('profile-colors')
})

// A DOM and a small fake of the server for what a person does: remove a colour and save, a draft's colours, the card.
describe('colours and images, clicked', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const CHAT = '01900000-0000-7000-8000-0000000000c9'
  let calls: { key: string; body: any }[] = []
  let draftState: unknown = null
  let saved: CompanyProfile | null = null
  const routes: Record<string, (body: any) => Response> = {
    'GET /api/me/ai-access': () => json(200, { usable: true, action: 'connect_team', requested: false }),
    'GET /api/onboarding/profile': () => json(200, { profile: saved }),
    'PUT /api/onboarding/profile': (b) => json(200, { ...b, updatedAt: '2026-11-05T00:00:00.000Z' }),
    'POST /api/onboarding/profile/draft': (b) => json(201, b.text ? { chatId: CHAT, website: '', site: null } : { chatId: CHAT, website: 'https://acme.example/', site: 'acme.example' }),
    [`GET /api/onboarding/profile/draft/${CHAT}`]: () => json(200, draftState),
  }
  const realFetch = globalThis.fetch
  const localeBefore = useLocaleStore.getState().locale
  const sessionBefore = useSession.getState().status
  const g = globalThis as Record<string, unknown>
  const resizeBefore = Object.getOwnPropertyDescriptor(g, 'ResizeObserver')
  beforeAll(() => {
    installDom()
    // the admin Card measures its description (nothing to measure in this small DOM)
    Object.defineProperty(g, 'ResizeObserver', { configurable: true, writable: true, value: class { observe() {} unobserve() {} disconnect() {} } })
    useLocaleStore.setState({ locale: 'ko' })
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'olga', role: 'owner', prefs: {} }, team: { name: 'Acme', defaultLocale: 'ko' } } } } as never)
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ key, body })
      return routes[key]?.(body) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
    }) as unknown as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    if (resizeBefore) Object.defineProperty(g, 'ResizeObserver', resizeBefore)
    else delete g.ResizeObserver
    useAiAccess.getState().reset()
    useSession.setState({ status: sessionBefore } as never)
    useLocaleStore.setState({ locale: localeBefore })
    removeDom()
  })
  const puts = () => calls.filter((c) => c.key === 'PUT /api/onboarding/profile').map((c) => c.body)
  const saveButton = () => (globalThis.document as any).body.querySelectorAll('button').find((b: any) => b.textContent === '저장')

  test('the images line: after the pages, before "정리 중"; the logo named when it is among them', async () => {
    const steps = [page({ url: 'https://acme.example/', status: 'ok', title: 'Acme' })]
    const lines = async (assets: { images: number; logo: boolean } | null, writing = true) => {
      const m = await mount(<DraftActivity source="website" site="acme.example" steps={steps} writing={writing} assets={assets} />)
      try { return { images: m.find('profile-activity-images')?.textContent ?? null, html: m.html() } } finally { await m.unmount() }
    }
    expect((await lines({ images: 4, logo: false })).images).toBe('이미지 4개 가져옴')
    expect((await lines({ images: 4, logo: true })).images).toBe('로고와 이미지 3개 가져옴')
    expect((await lines({ images: 2, logo: true })).images).toBe('로고와 이미지 1개 가져옴')
    expect((await lines({ images: 1, logo: true })).images).toBe('로고 가져옴')
    expect((await lines({ images: 1, logo: false })).images).toBe('이미지 1개 가져옴')
    // nothing collected (or a server from before it): no line
    expect((await lines({ images: 0, logo: false })).images).toBeNull()
    expect((await lines(null)).images).toBeNull()
    const { html } = await lines({ images: 3, logo: false })
    expect(html.indexOf('읽음 · Acme')).toBeLessThan(html.indexOf('이미지 3개 가져옴'))
    expect(html.indexOf('이미지 3개 가져옴')).toBeLessThan(html.indexOf('회사 소개 정리 중'))
    // pasted text: never
    const m = await mount(<DraftActivity source="text" site={null} steps={[]} writing assets={{ images: 3, logo: true }} />)
    try { expect(m.find('profile-activity-images')).toBeNull() } finally { await m.unmount() }
  })

  test('a saved profile\'s colours: one removed, the rest saved; all removed, no colours in the body', async () => {
    calls = []
    let done: CompanyProfile | null = null
    const m = await mount(<MemoryRouter><ProfileStep initial={{ ...PROFILE, colors: ['#37ee6a', '#0b140d'] }} onDone={(p) => { done = p }} /></MemoryRouter>)
    try {
      expect(m.get('profile-colors').textContent).toContain('브랜드 색')
      expect(m.container.querySelectorAll('[data-testid="profile-color"]').map((e) => e.getAttribute('data-color'))).toEqual(['#37ee6a', '#0b140d'])
      await m.click(m.container.querySelector('button[aria-label="#37ee6a 지우기"]')!)
      expect(m.container.querySelectorAll('[data-testid="profile-color"]').map((e) => e.getAttribute('data-color'))).toEqual(['#0b140d'])
      await m.click(saveButton())
      await m.until(() => done, 'saved')
      expect(puts()[0].colors).toEqual(['#0b140d'])
      // the last one too: the field goes, the body has no colours
      await m.click(m.container.querySelector('button[aria-label="#0b140d 지우기"]')!)
      expect(m.find('profile-colors')).toBeNull()
      await m.click(saveButton())
      await m.until(() => puts().length === 2, 'saved again')
      expect('colors' in puts()[1]).toBe(false)
    } finally { await m.unmount() }
  })

  test('a new draft from the website: the images line while it reads, then the colours the server found, saved with the profile', async () => {
    calls = []
    draftState = { status: 'running', website: 'https://acme.example/', draft: null, error: null, steps: [page({ url: 'https://acme.example/', status: 'ok', title: 'Acme' })], writing: true, assets: { images: 3, logo: true, colors: ['#37ee6a', '#f5f9f2'] } }
    const m = await mount(<MemoryRouter><ProfileStep onDone={noop} initialWebsite="https://acme.example/" /></MemoryRouter>)
    try {
      await m.until(() => !m.get('profile-step-site').querySelector('button[type="submit"]')!.hasAttribute('disabled'), 'Read on')
      await m.click(m.get('profile-step-site').querySelector('button[type="submit"]')!)
      await m.until(() => m.find('profile-step-reading'), 'reading')
      chatActivity.emit(CHAT)
      await m.until(() => m.find('profile-activity-images'), 'the images line')
      expect(m.get('profile-activity-images').textContent).toBe('로고와 이미지 2개 가져옴')
      // the draft itself carries no colours: the ones the server collected fill the field
      draftState = { status: 'done', website: 'https://acme.example/', draft: { website: 'https://acme.example/', name: 'Acme', oneLine: 'Quiet desk fans', products: 'Desk fans', audience: '', tone: [], avoid: '', sources: [] }, error: null, steps: [], assets: { images: 3, logo: true, colors: ['#37ee6a', '#f5f9f2'] } }
      chatActivity.emit(CHAT)
      await m.until(() => m.find('profile-step-review'), 'the review')
      expect(m.container.querySelectorAll('[data-testid="profile-color"]').map((e) => e.getAttribute('data-color'))).toEqual(['#37ee6a', '#f5f9f2'])
      await m.click(saveButton())
      await m.until(() => puts().length, 'saved')
      expect(puts()[0].colors).toEqual(['#37ee6a', '#f5f9f2'])
    } finally { await m.unmount() }
  })

  test('while it reads, only "later" (docs/DECISIONS.md "W2"): no chat link, no "write it myself"; a reading that fails opens the fallback by itself', async () => {
    calls = []
    draftState = { status: 'running', website: 'https://acme.example/', draft: null, error: null, steps: [page({ url: 'https://acme.example/', status: 'ok', title: 'Acme' })], writing: false }
    let skipped = 0
    const m = await mount(<MemoryRouter><ProfileStep onDone={noop} onSkip={() => { skipped++ }} skipLabel="나중에 하기" initialWebsite="https://acme.example/" /></MemoryRouter>)
    try {
      await m.until(() => !m.get('profile-step-site').querySelector('button[type="submit"]')!.hasAttribute('disabled'), 'Read on')
      await m.click(m.get('profile-step-site').querySelector('button[type="submit"]')!)
      await m.until(() => m.find('profile-step-reading'), 'reading')
      const reading = m.get('profile-step-reading')
      expect(reading.querySelectorAll('button').map((b: any) => b.textContent)).toEqual(['나중에 하기'])
      expect(reading.querySelectorAll('a')).toEqual([])
      expect(m.html()).not.toContain('대화로 보기')
      expect(m.html()).not.toContain('직접 쓸게요')
      await m.click(reading.querySelectorAll('button')[0]!)
      expect(skipped).toBe(1)
      // the reading fails: the pasted text and the three questions open without a click
      draftState = { status: 'failed', website: 'https://acme.example/', draft: null, error: '홈페이지를 열지 못했어요', steps: [] }
      chatActivity.emit(CHAT)
      await m.until(() => m.find('profile-step-fallback'), 'the fallback')
      expect(m.html()).toContain('홈페이지에서 회사 소개를 읽지 못했어요.')
    } finally { await m.unmount() }
  })

  test('a reading that fails says what it read (pasted text is not "the homepage"), with the answer\'s reason; 다시 시도 reads the same input again', async () => {
    const button = (label: string) => (globalThis.document as any).body.querySelectorAll('button').find((b: any) => b.textContent === label)
    const drafts = () => calls.filter((c) => c.key === 'POST /api/onboarding/profile/draft').map((c) => c.body)
    const LIMIT = 'AI 사용 한도에 잠시 도달했어요. 조금 뒤 다시 시도해 주세요.'
    const TEXT = 'Acme makes quiet desk fans.'
    // pasted text, no website: its own words, then the same text again without typing it
    calls = []
    draftState = { status: 'failed', website: '', draft: null, error: LIMIT, steps: [] }
    let m = await mount(<MemoryRouter><ProfileStep onDone={noop} onSkip={noop} skipLabel="나중에 하기" /></MemoryRouter>)
    try {
      await m.until(() => m.find('profile-step-site'), 'the website form')
      await m.click(button('홈페이지가 없어요'))
      await m.click(await m.until(() => m.find('profile-step-to-paste'), 'the fallback'))
      await m.type(m.get('profile-step-paste').querySelector('textarea')!, TEXT)
      await m.click(m.get('profile-step-paste').querySelector('button[type="submit"]')!)
      await m.until(() => m.find('profile-step-reading'), 'reading')
      chatActivity.emit(CHAT)
      const note = await m.until(() => m.find('profile-step-unreadable'), 'the reason')
      expect(note.textContent).toContain(`붙여 넣은 글로 회사 소개를 만들지 못했어요. ${LIMIT}`)
      expect(note.textContent).not.toContain('홈페이지')
      expect(m.get('profile-step-to-site').textContent).toBe('홈페이지 주소 넣기')
      draftState = { status: 'done', website: '', error: null, steps: [], draft: { website: '', name: '', oneLine: TEXT, products: '', audience: '', tone: [], avoid: '', sources: [] } }
      await m.click('profile-step-retry')
      await m.until(() => m.find('profile-step-reading'), 'reading again')
      chatActivity.emit(CHAT)
      await m.until(() => m.find('profile-step-review'), 'the review')
      expect(drafts()).toEqual([{ text: TEXT }, { text: TEXT }])
    } finally { await m.unmount() }
    // the website: "홈페이지에서 …", 다시 시도 reads the same address; "주소 다시 넣기" to fix it
    calls = []
    draftState = { status: 'failed', website: 'https://acme.example/', draft: null, error: LIMIT, steps: [] }
    m = await mount(<MemoryRouter><ProfileStep onDone={noop} onSkip={noop} skipLabel="나중에 하기" initialWebsite="https://acme.example/" /></MemoryRouter>)
    try {
      await m.until(() => !m.get('profile-step-site').querySelector('button[type="submit"]')!.hasAttribute('disabled'), 'Read on')
      await m.click(m.get('profile-step-site').querySelector('button[type="submit"]')!)
      await m.until(() => m.find('profile-step-reading'), 'reading')
      chatActivity.emit(CHAT)
      const note = await m.until(() => m.find('profile-step-unreadable'), 'the reason')
      expect(note.textContent).toContain(`홈페이지에서 회사 소개를 읽지 못했어요. ${LIMIT}`)
      expect(m.get('profile-step-to-site').textContent).toBe('주소 다시 넣기')
      await m.click('profile-step-retry')
      await m.until(() => m.find('profile-step-reading'), 'reading again')
      expect(drafts()).toEqual([{ website: 'https://acme.example/' }, { website: 'https://acme.example/' }])
    } finally { await m.unmount() }
  })

  test('"다른 방법으로 만들어요": one primary, pasting what the company does; the questions and the address quiet; "홈페이지 주소 넣기" when no address was read', async () => {
    calls = []
    const button = (label: string) => (globalThis.document as any).body.querySelectorAll('button').find((b: any) => b.textContent === label)
    const m = await mount(<MemoryRouter><ProfileStep onDone={noop} onSkip={noop} skipLabel="나중에 하기" /></MemoryRouter>)
    try {
      await m.until(() => m.find('profile-step-site'), 'the website form')
      await m.click(button('홈페이지가 없어요'))
      const fallback = await m.until(() => m.find('profile-step-fallback'), 'the fallback')
      const cls = (b: any) => b.getAttribute('class') ?? ''
      expect(fallback.querySelectorAll('button').filter((b: any) => cls(b).includes('bg-accent ')).map((b: any) => b.textContent)).toEqual(['소개 글 붙여 넣기'])
      // nothing else stands out: no outline buttons either
      expect(fallback.querySelectorAll('button').filter((b: any) => cls(b).includes('border-field-border'))).toEqual([])
      expect(m.get('profile-step-to-questions').textContent).toBe('세 가지 질문에 답하기')
      expect(m.get('profile-step-to-site').textContent).toBe('홈페이지 주소 넣기')
      expect(m.find('profile-step-unreadable')).toBeNull()
      expect(m.html()).not.toContain('주소 다시 넣기')
    } finally { await m.unmount() }
  })

  // the recheck of onboarding v5: after "홈페이지가 없어요" and a pasted text the review still offered "홈페이지 다시 읽기"
  test('"홈페이지 다시 읽기" only with a homepage: none after "홈페이지가 없어요" and a pasted text, nor for a saved profile without one; a website reading keeps it', async () => {
    const button = (label: string) => (globalThis.document as any).body.querySelectorAll('button').find((b: any) => b.textContent === label)
    const TEXT = 'Acme makes quiet desk fans.'
    // no homepage, a pasted text: nothing to read again
    calls = []
    draftState = { status: 'done', website: '', error: null, steps: [], draft: { website: '', name: '', oneLine: TEXT, products: '', audience: '', tone: [], avoid: '', sources: [] } }
    let m = await mount(<MemoryRouter><ProfileStep onDone={noop} onSkip={noop} skipLabel="나중에 하기" /></MemoryRouter>)
    try {
      await m.until(() => m.find('profile-step-site'), 'the website form')
      await m.click(button('홈페이지가 없어요'))
      await m.click(await m.until(() => m.find('profile-step-to-paste'), 'the fallback'))
      await m.type(m.get('profile-step-paste').querySelector('textarea')!, TEXT)
      await m.click(m.get('profile-step-paste').querySelector('button[type="submit"]')!)
      await m.until(() => m.find('profile-step-reading'), 'reading')
      chatActivity.emit(CHAT)
      await m.until(() => m.find('profile-step-review'), 'the review')
      expect(button('홈페이지 다시 읽기')).toBeUndefined()
      expect(m.find('profile-step-read-again')).toBeNull()
      expect(m.find('profile-step-save')).not.toBeNull()
    } finally { await m.unmount() }
    // a saved profile without a website: none either
    m = await mount(<MemoryRouter><ProfileStep initial={{ ...PROFILE, website: '' }} onDone={noop} /></MemoryRouter>)
    try {
      expect(button('홈페이지 다시 읽기')).toBeUndefined()
    } finally { await m.unmount() }
    // a website reading: "홈페이지 다시 읽기" reads the same address again
    calls = []
    draftState = { status: 'done', website: 'https://acme.example/', error: null, steps: [], draft: { website: 'https://acme.example/', name: '', oneLine: TEXT, products: '', audience: '', tone: [], avoid: '', sources: [] } }
    m = await mount(<MemoryRouter><ProfileStep onDone={noop} initialWebsite="https://acme.example/" /></MemoryRouter>)
    try {
      await m.until(() => !m.get('profile-step-site').querySelector('button[type="submit"]')!.hasAttribute('disabled'), 'Read on')
      await m.click(m.get('profile-step-site').querySelector('button[type="submit"]')!)
      await m.until(() => m.find('profile-step-reading'), 'reading')
      chatActivity.emit(CHAT)
      await m.until(() => m.find('profile-step-review'), 'the review')
      expect(m.get('profile-step-read-again').textContent).toBe('홈페이지 다시 읽기')
      await m.click('profile-step-read-again')
      const input = m.get('profile-step-site').querySelector('input') as unknown as { value: string }
      expect(input.value).toBe('https://acme.example/')
    } finally { await m.unmount() }
  })

  test('autoSave (the welcome steps): a website draft with a one-line intro is saved as it came, no review; without one, from pasted text, a failed save or without autoSave: the review', async () => {
    const done = (oneLine: string, website = 'https://acme.example/') => ({
      status: 'done', website, error: null, steps: [], assets: { images: 2, logo: true, colors: ['#37ee6a', '#0b140d'] },
      draft: { website, name: '', oneLine, products: ' Desk fans ', audience: '', tone: ['friendly'], avoid: '', sources: [
        { field: 'oneLine', url: 'https://acme.example/about', excerpt: 'Quiet desk fans' }, { field: 'audience', url: 'https://acme.example/', excerpt: 'offices' }] },
    })
    const putRoute = routes['PUT /api/onboarding/profile']!
    const run = async (o: { autoSave?: boolean; oneLine: string; text?: boolean; putFails?: boolean }) => {
      calls = []
      draftState = done(o.oneLine, o.text ? '' : 'https://acme.example/')
      if (o.putFails) routes['PUT /api/onboarding/profile'] = () => json(500, { error: { code: 'internal', message: '저장하지 못했어요' } })
      let saved: CompanyProfile | null = null
      const m = await mount(<MemoryRouter><ProfileStep onDone={(p) => { saved = p }} onSkip={noop} skipLabel="나중에 하기" initialWebsite="https://acme.example/" autoSave={o.autoSave} /></MemoryRouter>)
      try {
        await m.until(() => !m.get('profile-step-site').querySelector('button[type="submit"]')!.hasAttribute('disabled'), 'Read on')
        if (o.text) {
          const button = (label: string) => (globalThis.document as any).body.querySelectorAll('button').find((b: any) => b.textContent === label)
          await m.click(button('홈페이지가 없어요'))
          await m.until(() => m.find('profile-step-fallback'), 'the fallback')
          await m.click(button('소개 글 붙여 넣기'))
          await m.until(() => m.find('profile-step-paste'), 'the paste form')
          await m.type(m.get('profile-step-paste').querySelector('textarea')!, 'Acme makes quiet desk fans.')
          await m.click(m.get('profile-step-paste').querySelector('button[type="submit"]')!)
        } else await m.click(m.get('profile-step-site').querySelector('button[type="submit"]')!)
        await m.until(() => m.find('profile-step-reading'), 'reading')
        chatActivity.emit(CHAT)
        await m.until(() => saved || m.find('profile-step-review'), 'saved or the review')
        // a late step event of the same draft saves nothing twice
        chatActivity.emit(CHAT)
        await m.settle(400)
        const values = m.container.querySelectorAll('input').map((i) => (i as unknown as { value: string }).value)
        return { saved: saved as CompanyProfile | null, review: !!m.find('profile-step-review'), html: m.html(), values, puts: puts() }
      } finally {
        await m.unmount()
        routes['PUT /api/onboarding/profile'] = putRoute
      }
    }
    // the welcome steps: saved as it came, once, with the save's own body: trimmed, sources only for filled fields, the
    // colours the server found; no company name filled in (an empty one reads as the team's name everywhere)
    const auto = await run({ autoSave: true, oneLine: ' Acme makes quiet desk fans. ' })
    expect(auto.review).toBe(false)
    expect(auto.puts).toEqual([{ website: 'https://acme.example/', name: '', oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', audience: '', tone: ['friendly'], avoid: '',
      sources: [{ field: 'oneLine', url: 'https://acme.example/about', excerpt: 'Quiet desk fans' }], colors: ['#37ee6a', '#0b140d'] }])
    expect(auto.saved).toMatchObject({ oneLine: 'Acme makes quiet desk fans.' })
    // no one-line intro: the review, nothing saved
    const noLine = await run({ autoSave: true, oneLine: '  ' })
    expect(noLine.review).toBe(true)
    expect(noLine.puts).toEqual([])
    // pasted text: the review
    const pasted = await run({ autoSave: true, oneLine: 'Acme makes quiet desk fans.', text: true })
    expect(pasted.review).toBe(true)
    expect(pasted.puts).toEqual([])
    // the save fails: the review with the draft and the reason
    const failed = await run({ autoSave: true, oneLine: 'Acme makes quiet desk fans.', putFails: true })
    expect(failed.review).toBe(true)
    expect(failed.saved).toBeNull()
    expect(failed.html).toContain('저장하지 못했어요')
    expect(failed.values).toContain('Acme makes quiet desk fans.')
    // Admin › Team settings (no autoSave): the review, as before
    const admin = await run({ oneLine: 'Acme makes quiet desk fans.' })
    expect(admin.review).toBe(true)
    expect(admin.puts).toEqual([])
  })

  test('autoSave never overwrites a saved profile: a re-read from its review, or one saved meanwhile in another tab, shows the review and saves nothing', async () => {
    const draftDone = { status: 'done', website: 'https://acme.example/', error: null, steps: [], assets: { images: 0, logo: false, colors: [] },
      draft: { website: 'https://acme.example/', name: '', oneLine: 'A newer reading', products: '', audience: '', tone: [], avoid: '', sources: [] } }
    const button = (label: string) => (globalThis.document as any).body.querySelectorAll('button').find((b: any) => b.textContent === label)
    const read = async (m: Awaited<ReturnType<typeof mount>>) => {
      await m.until(() => m.find('profile-step-site') && !m.get('profile-step-site').querySelector('button[type="submit"]')!.hasAttribute('disabled'), 'Read on')
      await m.click(m.get('profile-step-site').querySelector('button[type="submit"]')!)
      await m.until(() => m.find('profile-step-reading'), 'reading')
      chatActivity.emit(CHAT)
      await m.until(() => m.find('profile-step-review'), 'the review')
      await m.settle(300)
    }
    // the owner's saved profile, re-read from its review ("홈페이지 다시 읽기"): the review with the new reading
    calls = []
    draftState = draftDone
    saved = PROFILE
    let done: CompanyProfile | null = null
    let m = await mount(<MemoryRouter><ProfileStep initial={PROFILE} onDone={(p) => { done = p }} onSkip={noop} skipLabel="나중에 하기" autoSave /></MemoryRouter>)
    try {
      await m.until(() => m.find('profile-step-review'), 'the saved review')
      await m.click(button('홈페이지 다시 읽기'))
      await read(m)
      expect(puts()).toEqual([])
      expect(done).toBeNull()
      expect(m.container.querySelectorAll('input').map((i) => (i as unknown as { value: string }).value)).toContain('A newer reading')
    } finally { await m.unmount() }
    // none when the step opened, but one saved meanwhile (another tab, an admin): asked again right before, the review
    calls = []
    saved = PROFILE
    m = await mount(<MemoryRouter><ProfileStep onDone={(p) => { done = p }} onSkip={noop} skipLabel="나중에 하기" initialWebsite="https://acme.example/" autoSave /></MemoryRouter>)
    try {
      await read(m)
      expect(calls.filter((c) => c.key === 'GET /api/onboarding/profile').length).toBeGreaterThan(0)
      expect(puts()).toEqual([])
      expect(done).toBeNull()
    } finally { await m.unmount(); saved = null }
  })

  test('Admin › Team settings: the saved colours as a row of swatches; none, no row', async () => {
    saved = { ...PROFILE, colors: ['#37ee6a', '#0b140d'] }
    let m = await mount(<MemoryRouter><CompanyProfileCard /></MemoryRouter>)
    try {
      await m.until(() => m.find('company-profile-colors'), 'the colours')
      expect(m.get('company-profile-colors').querySelectorAll('[data-testid="profile-color-swatch"]').map((e) => e.getAttribute('aria-label'))).toEqual(['#37ee6a', '#0b140d'])
      expect(m.html()).toContain('브랜드 색')
    } finally { await m.unmount() }
    saved = PROFILE
    m = await mount(<MemoryRouter><CompanyProfileCard /></MemoryRouter>)
    try {
      await m.until(() => m.html().includes('Acme makes quiet desk fans.'), 'the profile')
      expect(m.find('company-profile-colors')).toBeNull()
      expect(m.html()).not.toContain('브랜드 색')
    } finally { await m.unmount(); saved = null }
  })
})
