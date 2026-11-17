// Meeting notes (components/MeetingNotes.tsx) appear only in the desktop app that offers them: a plain browser, and the
// phone app (no desktop bridge either), get no button on My files and no card, so nothing is offered that cannot work.
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }

test('a plain browser: no Take meeting notes on My files, no card', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page, BOB)
  await page.request.post('/__test/file', { data: { path: 'users/bob/memo.md', text: 'memo' } })
  await page.goto('/files?path=users%2Fbob')
  await expect(page.getByText('memo.md')).toBeVisible()
  await expect(page.getByTestId('meeting-entry')).toHaveCount(0)
  await expect(page.getByTestId('meeting-card')).toHaveCount(0)
})
