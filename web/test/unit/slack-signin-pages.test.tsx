// The two pages of "Sign in with Slack" outside Settings (web/src/pages/SlackSignIn.tsx): the return page sends the
// browser only to the server's callback with only a checked state and code, never anywhere a parameter names; the end
// page says plainly that it is done (or why not).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SlackDone, SlackSignInReturn } from '../../src/pages/SlackSignIn'
import { resumeTarget } from '../../src/lib/slackSignIn'
import { useLocaleStore } from '../../src/i18n'
import { installDom, mount, removeDom } from './dom-host'

const STATE = 'S'.repeat(43)
let replaced: string[] = []
beforeAll(() => {
  installDom(); useLocaleStore.setState({ locale: 'en' })
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { origin: 'http://team.localhost', href: 'http://team.localhost/', replace(u: string) { replaced.push(u) } } })
})
afterAll(() => { removeDom(); delete (globalThis as { location?: unknown }).location })
beforeEach(() => { replaced = [] })

describe('the return page', () => {
  test('only the callback, with only the state and the code', async () => {
    const m = await mount(<MemoryRouter initialEntries={[`/slack/signin-return?state=${STATE}&code=1234.5678.abcdef&next=https://evil.example&return=//evil.example`]}><Routes><Route path="/slack/signin-return" element={<SlackSignInReturn />} /></Routes></MemoryRouter>)
    await m.until(() => replaced.length > 0, 'went on')
    expect(replaced).toEqual([`/api/integrations/slack/oauth/callback?state=${STATE}&code=1234.5678.abcdef`])
    await m.unmount()
  })
  test('anything else goes nowhere', async () => {
    for (const q of [`state=${STATE}&code=https://evil.example/x`, `state=${STATE}&code=//evil.example/abcdef`, 'state=short&code=1234.5678.abcdef', `state=${STATE}`, '']) expect(resumeTarget(`?${q}`)).toBeNull()
    const m = await mount(<MemoryRouter initialEntries={['/slack/signin-return?state=x&code=https://evil.example']}><Routes><Route path="/slack/signin-return" element={<SlackSignInReturn />} /></Routes></MemoryRouter>)
    await m.settle(50)
    expect(replaced).toEqual([])
    expect(m.get('slack-signin-return').textContent).toContain('cannot continue the link')
    await m.unmount()
  })
})

describe('the end page', () => {
  const page = (q: string) => mount(<MemoryRouter initialEntries={[`/slack/done?${q}`]}><Routes><Route path="/slack/done" element={<SlackDone signedIn />} /></Routes></MemoryRouter>)
  test('linked: done, back to the app', async () => {
    const m = await page('slack=linked')
    expect(m.get('slack-done-text').textContent).toBe('Your Slack account is linked. You can close this window and go back to the app.')
    await m.unmount()
  })
  test('another account, or a name that is not an outcome', async () => {
    let m = await page('slack=signin_other_user')
    expect(m.get('slack-done-text').textContent).toContain('signed in to a different account')
    await m.unmount()
    m = await page('slack=constructor')
    expect(m.get('slack-done-text').textContent).toBe('Could not link with the Slack sign-in. Try again in a moment.')
    await m.unmount()
  })
})
