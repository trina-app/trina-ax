// Onboarding stream C: skill forms (lib/skillForm.ts, components/skills/SkillForm.tsx) and the recommended pack on
// the empty Team skills page (components/AvailableSkills.tsx).
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompanyProfileResponse, profilePrefill, SKILL_INPUT_PREFILL, type Locale, type SkillInfo, type SkillInput } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { AvailableSkillsList } from '../../src/components/AvailableSkills'
import { composeSkillMessage, initialValues, missingRequired, prefillValue, skillRunBy, skillRunLink, valueText, withPrefill } from '../../src/lib/skillForm'
import { matchSkills } from '../../src/components/chat/SkillMenu'

const inputs: SkillInput[] = [
  { name: 'product', label: '알릴 제품', required: true, prefill: 'company.products' },
  { name: 'tone', label: '말투', prefill: 'company.tone' },
  { name: 'notes', label: '참고 메모', multiline: true },
]
// a saved profile as GET /api/onboarding/profile returns it (the shared contract of the profile work), read through the
// same shared helper the form uses
const saved = CompanyProfileResponse.parse({ profile: {
  website: 'https://www.acme.example/', oneLine: 'Acme makes planners', products: '종이 플래너\n데스크 매트', audience: '', tone: ['친근하게', '짧게'],
  avoid: '', sources: [{ field: 'products', url: 'https://www.acme.example/shop', excerpt: '종이 플래너' }], updatedAt: '2026-11-04T00:00:00.000Z',
} })
const prefill = profilePrefill(saved.profile)

describe('skill form values', () => {
  test('a choice field: its default to start, its option label in the message, never prefilled (docs/DECISIONS.md "X — Lean onboarding")', () => {
    const form: SkillInput[] = [
      { name: 'product', label: '알릴 제품', required: true, prefill: 'company.products' },
      { name: 'channel', label: '어디에 실을까요', type: 'choice', default: 'instagram', options: [{ value: 'instagram', label: '인스타그램 피드' }, { value: 'sms', label: '문자' }] },
      { name: 'when', label: '언제', type: 'choice', required: true, options: [{ value: 'now', label: '지금' }, { value: 'later', label: '나중에' }] },
      { name: 'tone', label: '말투', prefill: 'company.tone', advanced: true },
    ]
    expect(initialValues(form)).toEqual({ channel: 'instagram' })
    expect(withPrefill(form, prefill, initialValues(form), new Set())).toEqual({ product: '종이 플래너, 데스크 매트', channel: 'instagram', tone: '친근하게, 짧게' })
    expect(valueText(form[1]!, { channel: 'sms' })).toBe('문자')
    // a value that is not one of the options is nothing
    expect(valueText(form[1]!, { channel: 'kakao' })).toBe('')
    expect(missingRequired(form, { product: 'x', channel: 'sms' })).toEqual(['when'])
    expect(missingRequired(form, { product: 'x', when: 'bogus' })).toEqual(['when'])
    // folded fields filled from the profile still go along
    expect(composeSkillMessage('ad-copy', form, { product: '플래너', channel: 'sms', when: 'now', tone: '친근하게' }))
      .toBe('/ad-copy\n알릴 제품: 플래너\n\n어디에 실을까요: 문자\n\n언제: 지금\n\n말투: 친근하게')
  })

  test('every prefill key a form may ask for is one the company profile gives', () => {
    const full = profilePrefill({ ...saved.profile!, audience: 'Small offices', avoid: 'Superlatives' }, 'Acme team')
    expect(Object.keys(full).sort()).toEqual([...SKILL_INPUT_PREFILL].sort())
    // the company name: the profile's own, else the team's name (no name and no team name: left out)
    expect(full['company.name']).toBe('Acme team')
    expect(profilePrefill({ ...saved.profile!, name: 'Acme' }, 'Acme team')['company.name']).toBe('Acme')
    expect(profilePrefill(saved.profile)).not.toHaveProperty('company.name')
  })

  test('the profile fills the fields that ask for it, never over what the person typed', () => {
    // a one-line field gets the lines of a longer profile field joined (a text box would glue them together)
    expect(prefillValue(prefill, { prefill: 'company.products' })).toBe('종이 플래너, 데스크 매트')
    expect(prefillValue(prefill, { prefill: 'company.products', multiline: true })).toBe('종이 플래너\n데스크 매트')
    expect(prefillValue(prefill, { prefill: 'company.tone' })).toBe('친근하게, 짧게')
    expect(prefillValue(prefill, { prefill: 'company.website' })).toBe('https://www.acme.example/')
    expect(prefillValue(prefill, { prefill: 'company.avoid' })).toBe('')
    expect(prefillValue({}, { prefill: 'company.products' })).toBe('')
    expect(profilePrefill(null)).toEqual({})
    expect(withPrefill(inputs, prefill, {}, new Set())).toEqual({ product: '종이 플래너, 데스크 매트', tone: '친근하게, 짧게', notes: '' })
    // typed (even typed empty) stays as typed
    expect(withPrefill(inputs, prefill, { product: '다이어리', tone: '' }, new Set(['product', 'tone']))).toMatchObject({ product: '다이어리', tone: '' })
  })

  test('required fields left empty', () => {
    expect(missingRequired(inputs, { product: '  ' })).toEqual(['product'])
    expect(missingRequired(inputs, { product: 'x' })).toEqual([])
  })

  test('the message is the skill command with one "label: value" per filled field', () => {
    expect(composeSkillMessage('ad-copy', inputs, { product: ' 종이 플래너 ', tone: '', notes: '첫 줄\r\n둘째 줄' }))
      .toBe('/ad-copy\n알릴 제품: 종이 플래너\n\n참고 메모:\n첫 줄\n둘째 줄')
    // nothing filled in: "/<name> ", which the message box's "/" menu takes as chosen (it does not open again)
    expect(composeSkillMessage('ad-copy', inputs, {})).toBe('/ad-copy ')
    expect(matchSkills([{ path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', description: '' }], composeSkillMessage('ad-copy', inputs, {}))).toBeNull()
    // a skill without a form: one free text after its name
    expect(composeSkillMessage('weekly', undefined, {}, '  이번 주 것만 ')).toBe('/weekly 이번 주 것만')
    expect(composeSkillMessage('weekly', [], {}, '')).toBe('/weekly ')
  })

  test('the skill "/<name>" runs for this person: a personal one first, then the first path (as the server picks)', () => {
    const pack = { path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', description: '' }
    const older = { path: 'skills/ad-copy/SKILL.md', name: 'Ad-Copy', description: '' }
    const mine = { path: 'users/u1/skills/ad-copy/SKILL.md', name: 'ad-copy', description: '', personal: true }
    expect(skillRunBy([pack], 'ad-copy')).toBe(pack)
    expect(skillRunBy([pack, older], 'ad-copy')).toBe(older)
    expect(skillRunBy([older, pack, mine], 'ad-copy')).toBe(mine)
    expect(skillRunBy([pack], 'other')).toBeNull()
  })

  test('the run link', () => {
    expect(skillRunLink('skills/marketing/ad-copy/SKILL.md')).toBe('/skills?run=skills%2Fmarketing%2Fad-copy%2FSKILL.md')
  })
})

const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const beforeLocale = useLocaleStore.getInitialState().locale
// a static render reads the stores' initial state (as the locale above)
const beforeSession = useSession.getInitialState().status
afterEach(() => { setLocale(beforeLocale); Object.assign(useSession.getInitialState(), { status: beforeSession }) })
const signIn = (role: 'owner' | 'admin' | 'member') => Object.assign(useSession.getInitialState(), { status: { kind: 'signed-in', me: { user: { id: 'u1', role } } } })
const render = (list: SkillInfo[]) => renderToStaticMarkup(<AvailableSkillsList items={list} />)

describe('Team skills page', () => {
  test('no skills: owners and admins get the install button, members a line that an admin can', () => {
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      setLocale(l)
      for (const role of ['owner', 'admin'] as const) {
        signIn(role)
        const html = render([])
        expect(html).toContain('data-testid="skill-pack-install"')
        expect(html).toContain(translate(l, 'skillPack.install'))
      }
      signIn('member')
      const html = render([])
      expect(html).not.toContain('skill-pack-install')
      expect(html).toContain(translate(l, 'skillPack.memberHint'))
    }
  })

  test('a skill with a form has a run button; one without keeps the old row', () => {
    signIn('member')
    setLocale('en')
    const html = render([
      { path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', description: 'Ad copy', inputs },
      { path: 'skills/weekly.md', name: 'weekly', description: '' },
    ])
    expect((html.match(/data-testid="skill-run"/g) ?? []).length).toBe(1)
    // a skill without a title is named as words, as the invite names it (shared skillLabel: "ad copy", never "ad-copy")
    expect(html).toContain(`aria-label="${translate('en', 'skillForm.runNamed', { name: 'ad copy' })}"`)
    expect((html.match(/data-testid="skill-use"/g) ?? []).length).toBe(2)
  })
})
