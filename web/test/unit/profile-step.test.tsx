// The company profile step (docs/DECISIONS.md "D — Company profile from the company website"): the review shows every
// field with its source page and excerpt and a way to remove it; only http(s) sources become links; tone stays at
// four chips; what is saved is trimmed and keeps sources only for fields that still have a value.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { profilePrefill, type CompanyProfile } from '@mycel/shared/api'
import ProfileStep, { tidyProfile, toneChips } from '../../src/components/onboarding/ProfileStep'

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
