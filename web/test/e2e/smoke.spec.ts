import { expect, test } from '@playwright/test'
import { reset, signIn, watchConsole } from './helpers'

test('sign in and see the new chat screen', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await expect(page.getByRole('heading', { name: /Olga님/ })).toBeVisible()
  expect(errors.filter((e) => !e.includes('401'))).toEqual([])
})
