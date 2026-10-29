import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'
import { OWNER } from './helpers'

/** Separate from the normal suite server: only this fixture owns/stops these listeners. */
export async function offlineServer() {
  const port = 19842
  const url = `http://127.0.0.1:${port}`
  const control = `http://127.0.0.1:${port + 1}`
  const child = spawn('bun', [fileURLToPath(new URL('../mock/offline-serve.ts', import.meta.url))], {
    env: { ...process.env, MOCK_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  const onExit = () => { child.kill('SIGTERM') }
  process.once('exit', onExit)
  const close = async () => {
    process.off('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(`offline fixture exited: ${errors}`)
      return fetch(control, { signal: AbortSignal.timeout(2000) }).then(r => r.text()).then(text => text === `offline-fixture:${child.pid}`).catch(() => false)
    }).toBe(true)
  } catch (error) { await close(); throw error }
  return {
    url, close,
    async mode(mode: 'stop' | 'online' | 'api-down' | '503') {
      const response = await fetch(control, { method: 'POST', body: mode })
      expect(response.ok).toBe(true)
      if (mode === 'stop') await expect.poll(() => fetch(`${url}/api/health`).then(() => false).catch(() => true)).toBe(true)
    },
  }
}

export async function warmWorker(page: Page) {
  // Finish the desktop's initial navigation before waiting for the load-triggered registration.
  await page.reload()
  await expect.poll(() => page.evaluate(async () => ({
    state: (await navigator.serviceWorker.getRegistration())?.active?.state,
    controlled: !!navigator.serviceWorker.controller,
  }))).toEqual({ state: 'activated', controlled: true })
  await page.reload()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect.poll(() => cachedPaths(page)).toContainEqual(expect.stringMatching(/^\/assets\/.*\.js$/))
}

export async function cachedPaths(page: Page) {
  return page.evaluate(async () => {
    const paths: string[] = []
    for (const key of await caches.keys()) for (const request of await (await caches.open(key)).keys()) paths.push(new URL(request.url).pathname)
    return paths
  })
}

export async function signInOfflineTeam(page: Page, url: string, locale: 'ko' | 'en' | 'id') {
  await page.request.post(`${url}/__test/reset`, { data: { teamLocale: locale, usersFollowTeam: true } })
  await page.goto(`${url}/login`)
  await page.getByTestId('login-username').fill(OWNER.username)
  await page.getByTestId('login-password').fill(OWNER.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
}

export const account = (page: Page) => page.evaluate(async () => {
  const me = await (await fetch('/api/me')).json()
  return { user: me.user.id, session: me.session.id }
})
