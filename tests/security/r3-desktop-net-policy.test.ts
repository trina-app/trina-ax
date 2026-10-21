// Security round 3 (ai-tools #1, desktop side): the in-app browser's net guard let every request to a PUBLIC address
// through, so the AI could carry data out with no prompt: a redirect hop from an allowed site, a navigation or beacon
// from javascript_tool, or javascript_tool on a blank tab (which needed no site permission at all). The rules now
// live in desktop/src/common/net-policy.ts (pure); the Electron end-to-end version is desktop/e2e/exfil.spec.ts.
import { describe, expect, test } from 'bun:test'
import { isBlankPage, publicRequestVerdict, RUNS_AI_SCRIPT, type PublicRequest } from '../../desktop/src/common/net-policy'

const base: PublicRequest = { mainFrame: false, hasOwner: true, driving: false, anyScripted: false, scripted: false, sameSiteAsTop: false, siteAllowed: false }
const v = (o: Partial<PublicRequest>) => publicRequestVerdict({ ...base, ...o })

describe('public requests of the in-app browser', () => {
  test('a page load the AI causes (redirect hop included) to a site the person did not allow asks', () => {
    expect(v({ mainFrame: true, driving: true })).toBe('ask')
    expect(v({ mainFrame: true, anyScripted: true })).toBe('ask') // a script's later navigation, of any window
    expect(v({ mainFrame: true, scripted: true })).toBe('ask')
    expect(v({ mainFrame: true, driving: true, siteAllowed: true })).toBe('allow')
  })

  test('a scripted document reaches no other site the person did not allow; its own site works', () => {
    expect(v({ scripted: true })).toBe('block')
    expect(v({ scripted: true, sameSiteAsTop: true })).toBe('allow')
    expect(v({ scripted: true, siteAllowed: true })).toBe('allow')
    // a service worker the script may have registered
    expect(v({ hasOwner: false, anyScripted: true })).toBe('block')
  })

  test('the person browsing and pages the AI did not script behave as any browser', () => {
    expect(v({ mainFrame: true })).toBe('allow')
    expect(v({})).toBe('allow')
    expect(v({ driving: true })).toBe('allow') // third-party resources of a page the AI only reads
    expect(v({ hasOwner: false })).toBe('allow')
  })

  test('javascript_tool never runs on a blank tab', () => {
    expect(RUNS_AI_SCRIPT.has('javascript_tool')).toBe(true)
    for (const u of ['', 'about:blank', 'about:blank#x']) expect(isBlankPage(u)).toBe(true)
    expect(isBlankPage('https://shop.example/')).toBe(false)
  })
})
