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
