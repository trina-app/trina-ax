// The company profile step (docs/DECISIONS.md "D — Company profile from the company website"): the review shows every
// field with its source page and excerpt and a way to remove it; only http(s) sources become links; tone stays at
// four chips; what is saved is trimmed and keeps sources only for fields that still have a value.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { profilePrefill, type CompanyProfile, type ProfileDraftPage } from '@mycel/shared/api'
import ProfileStep, { DraftActivity, pagesUsed, shortUrl, tidyProfile, toneChips } from '../../src/components/onboarding/ProfileStep'

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
