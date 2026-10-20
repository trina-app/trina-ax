// The real Electron app (desktop/dist, built by `bun run --cwd desktop build`) with a throw-away user data folder.
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { REPO } from './dev'

const DESKTOP = path.join(REPO, 'desktop')

export async function launchDesktop(userData: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [path.join(DESKTOP, 'dist/main.cjs')],
    cwd: DESKTOP,
    env: { ...(process.env as Record<string, string>), MYCEL_DESKTOP_USER_DATA: userData, LANG: 'ko_KR.UTF-8' },
  })
  if (process.env.E2E_DESKTOP_DEBUG === '1') {
    app.process().stdout?.on('data', (d) => process.stdout.write(`[app] ${d}`))
    app.process().stderr?.on('data', (d) => process.stdout.write(`[app:err] ${d}`))
  }
  return app
}

/** The view (welcome screen, pane toolbar, team page, browser tab: separate web contents) whose URL matches. */
export async function desktopView(app: ElectronApplication, match: (url: string) => boolean, timeout = 30_000): Promise<Page> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const p = app.windows().find((w) => !w.isClosed() && match(w.url()))
    if (p) return p
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no desktop view matching; have: ${app.windows().map((w) => w.url()).join(', ')}`)
}

export async function closeDesktop(app: ElectronApplication) {
  const proc = app.process()
  const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000)
  await app.close().catch(() => proc.kill('SIGKILL'))
  clearTimeout(timer)
}
