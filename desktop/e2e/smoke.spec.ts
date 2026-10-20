import { expect, test } from '@playwright/test'
import { ACME, addTeam, close, launch, newUserData, welcome } from './helpers'

test('smoke: welcome screen, add a team, the page gets the bridge', async () => {
  const app = await launch(newUserData())
  try {
    const w = await welcome(app)
    await expect(w.getByRole('heading', { name: '팀 주소를 입력하세요' })).toBeVisible()
    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    await expect(page.locator('#bridge')).toHaveText('desktop')
  } finally {
    await close(app)
  }
})
