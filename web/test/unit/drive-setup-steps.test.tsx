// Google Drive's setup dialog (Admin › 연결한 서비스 › Google Drive, DriveConnector.tsx DriveSetupDialog; QA TC-197): an
// admin can finish without other help. The Google Cloud steps come first, in order, each with the Google Cloud page it
// happens on (opened in a new tab), then the address to paste and the file to upload; every language has the words.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { DriveAdminStatus } from '@mycel/shared/api'
import { DICTS, translate, useLocaleStore } from '../../src/i18n'
import { DRIVE_CLOUD_STEPS, DriveSetupDialog } from '../../src/components/integrations/DriveConnector'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'ko' }) })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })
const REDIRECT = 'https://team.example.test/api/integrations/google-drive/callback'
const status: DriveAdminStatus = { configured: false, source: 'none', canSetUp: true, blocked: null, redirectUri: REDIRECT, connectedMembers: 0 }

test('the five Google Cloud steps in order, with their pages, before the address and the file', async () => {
  const m = await mount(<DriveSetupDialog status={status} onClose={() => {}} onSaved={() => {}} />)
  try {
    const page = document.body.innerHTML
    const steps = [...page.matchAll(/data-testid="drive-setup-step"/g)]
    expect(steps.length).toBe(5)
    const text = document.body.textContent ?? ''
    for (const x of DRIVE_CLOUD_STEPS) expect(text).toContain(translate('ko', x.key))
    const links = [...page.matchAll(/<a [^>]*href="([^"]+)"[^>]*data-testid="drive-setup-step-link"|<a [^>]*data-testid="drive-setup-step-link"[^>]*href="([^"]+)"/g)].map((x) => x[1] ?? x[2])
    expect(links).toEqual([
      'https://console.cloud.google.com/projectcreate',
      'https://console.cloud.google.com/apis/library/drive.googleapis.com',
      'https://console.cloud.google.com/apis/credentials/consent',
      'https://console.cloud.google.com/apis/credentials/oauthclient',
    ])
    expect(page).toMatch(/target="_blank"[^>]*rel="noopener noreferrer"|rel="noopener noreferrer"[^>]*target="_blank"/)
    // the steps come before the address to paste and the upload
    expect(page.indexOf('data-testid="drive-setup-steps"')).toBeLessThan(page.indexOf('data-testid="drive-setup-redirect"'))
    expect(text).toContain(REDIRECT)
    expect(text).toContain(translate('ko', 'driveSetup.redirect'))
  } finally { await m.unmount() }
})

test('every language has the steps and their links in its own words', () => {
  for (const [loc, dict] of Object.entries(DICTS)) {
    const d = dict as Record<string, string>
    for (const x of DRIVE_CLOUD_STEPS) for (const k of [x.key, x.link].filter(Boolean) as string[]) expect({ loc, k, text: !!d[k]?.trim() }).toEqual({ loc, k, text: true })
    expect({ loc, title: !!d['driveSetup.stepsTitle']?.trim() }).toEqual({ loc, title: true })
  }
})
