// Onboarding stream C: the skill form rendered (components/skills/SkillForm.tsx). It runs by name, so Run stays off
// until the person's skill list says "/<name>" runs this skill: off while the list loads, off when it fails, and off
// with a note naming the other skill when the name runs another one.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { SkillInfo } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { SkillForm } from '../../src/components/skills/SkillForm'
import { installDom, mount, removeDom } from './dom-host'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const pack: SkillInfo = { path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', description: 'Ad copy', inputs: [{ name: 'product', label: 'Product', required: true }] }
const older: SkillInfo = { path: 'skills/aaa/ad-copy/SKILL.md', name: 'ad-copy', description: 'An older one' }

/** GET /api/skills answers with `skills` (a promise held open = still loading); anything else is a 404 */
let skills: () => Response | Promise<Response> = () => json(200, { items: [] })
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'u1', name: 'U', role: 'member', prefs: {} } } } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    return key === 'GET /api/skills' ? skills() : json(404, { error: { code: 'not_found', message: 'not found' } })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})

const render = () => mount(<MemoryRouter><SkillForm path={pack.path} skill={pack} /></MemoryRouter>)

describe('skill form: Run only for the skill its name runs', () => {
  test('another skill with the same name: the note names it and Run stays off', async () => {
    skills = () => json(200, { items: [older, pack] })
    const m = await render()
    const alert = await m.until(() => m.find('skill-form-clash'), 'the clash note', 2000)
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toBe(translate('en', 'skillForm.sameName', { name: 'ad-copy', path: older.path }))
    expect(m.get('skill-form-run').hasAttribute('disabled')).toBe(true)
    await m.unmount()
  })

  test('while the list loads, Run is off; once it says this skill runs, Run is on', async () => {
    let answer!: (r: Response) => void
    skills = () => new Promise<Response>((resolve) => { answer = resolve })
    const m = await render()
    await m.until(() => m.find('skill-form'), 'the form (shown from the skill passed in)', 2000)
    expect(m.get('skill-form-run').hasAttribute('disabled')).toBe(true)
    answer(json(200, { items: [pack] }))
    await m.until(() => !m.get('skill-form-run').hasAttribute('disabled'), 'Run on', 2000)
    expect(m.find('skill-form-clash')).toBeNull()
    await m.unmount()
  })

  test('the list does not load: the error shows and Run stays off', async () => {
    skills = () => json(500, { error: { code: 'internal', message: 'boom' } })
    const m = await render()
    await m.until(() => m.html().includes('role="alert"'), 'the error', 2000)
    expect(m.find('skill-form')).not.toBeNull()
    expect(m.get('skill-form-run').hasAttribute('disabled')).toBe(true)
    await m.unmount()
  })
})

describe('skill form: chips and the fold (docs/DECISIONS.md "X — Lean onboarding")', () => {
  const short: SkillInfo = {
    path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', description: 'Ad copy — three options', inputs: [
      { name: 'product', label: 'Product' },
      { name: 'channel', label: 'Where', type: 'choice', default: 'feed', options: [{ value: 'feed', label: 'Feed' }, { value: 'sms', label: 'Text message' }] },
      { name: 'when', label: 'When', type: 'choice', options: [{ value: 'now', label: 'Now' }, { value: 'later', label: 'Later' }] },
      { name: 'audience', label: 'Audience', required: true, advanced: true },
    ],
  }
  const check = (el: { querySelector: (s: string) => unknown }) => {
    const radio = el.querySelector('input')!
    // a browser checks the radio before the click's listeners run, past React's value tracker (this small DOM does not)
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(radio), 'checked')!.set!.call(radio, true)
    return radio as never
  }

  test('a choice starts on its default, one pick; "(optional)" only where nothing is picked by default; the description can go', async () => {
    skills = () => json(200, { items: [short] })
    const m = await mount(<MemoryRouter><SkillForm path={short.path} skill={short} description={false} runLabel="Write ad copy" /></MemoryRouter>)
    await m.until(() => m.find('skill-choice-channel-feed')?.getAttribute('data-on') === 'true', 'the default', 2000)
    expect(m.get('skill-form').textContent).not.toContain('three options')
    expect(m.get('skill-input-channel').textContent).toContain('Where')
    expect(m.get('skill-input-channel').textContent).not.toContain(translate('en', 'skillForm.optional', { label: 'Where' }))
    expect(m.get('skill-input-when').textContent).toContain(translate('en', 'skillForm.optional', { label: 'When' }))
    expect(m.get('skill-input-channel').querySelectorAll('input[type="radio"]')).toHaveLength(2)
    await m.click(check(m.get('skill-choice-channel-sms')))
    expect(m.get('skill-choice-channel-sms').getAttribute('data-on')).toBe('true')
    expect(m.get('skill-choice-channel-feed').getAttribute('data-on')).toBeNull()
    expect(m.get('skill-form-run').textContent).toContain('Write ad copy')
    await m.unmount()
  })

  test('advanced fields stay folded; a required one left empty opens the fold and says so', async () => {
    skills = () => json(200, { items: [short] })
    let composed = ''
    const m = await mount(<MemoryRouter><SkillForm path={short.path} skill={short} onCompose={(t) => { composed = t }} /></MemoryRouter>)
    await m.until(() => !m.get('skill-form-run').hasAttribute('disabled'), 'Run on', 2000)
    expect(m.find('skill-input-audience')).toBeNull()
    expect(m.get('skill-form-more').getAttribute('aria-expanded')).toBe('false')
    await m.click('skill-form-run')
    await m.until(() => m.find('skill-input-audience'), 'the fold open', 2000)
    expect(m.get('skill-form-more').getAttribute('aria-expanded')).toBe('true')
    expect(m.html()).toContain(translate('en', 'skillForm.required'))
    expect(composed).toBe('')
    await m.type('skill-input-audience', 'Small offices')
    await m.click('skill-form-run')
    expect(composed).toBe('/ad-copy\nWhere: Feed\n\nAudience: Small offices')
    await m.unmount()
  })
})
