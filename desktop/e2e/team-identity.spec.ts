import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACME, addTeam, close, launch, newUserData } from './helpers'

test('sign-in navigation reads the new identity after an earlier anonymous request finishes', async () => {
  const control = (mode: string) => fetch(`${ACME}/test/anonymous-me?mode=${mode}`).then(r => r.json())
  const profile = newUserData()
  await control('hold')
  const app = await launch(profile).catch(async error => { await control('release'); throw error })
  try {
    const page = await addTeam(app, new URL(ACME).host, ACME)
    // Hold the actual native /api/me response across login + reload, without relying on a sleep.
    await expect.poll(async () => (await control('status')).hits).toBeGreaterThan(0)
    await page.evaluate(() => fetch('/test/login'))
    await page.reload()
    await control('release')
    await expect.poll(() => JSON.parse(readFileSync(join(profile, 'teams.json'), 'utf8')).teams[0].label).toBe('Acme Team')
  } finally { await control('release'); await close(app) }
})
