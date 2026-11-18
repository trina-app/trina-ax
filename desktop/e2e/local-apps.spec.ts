// Apps on this computer (docs/decisions/20261118-local-app-connectors.md) in the real app: the team page's bridge
// (localApps) hands a call to the main process, which asks the person once in its own dialog (replaced here: what it
// was asked is kept), starts the program from an argument list (a small MCP server over stdio,
// tests/fixtures/local-apps/fake-mcp.ts, run by this machine's bun), keeps a setting value sealed on this computer and
// hides it in the answer, and stops the program on Stop. A team page in a frame gets no bridge.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { ACME, addTeam, close, launch, newUserData, ROOT, stopLeftoverApps } from './helpers'

stopLeftoverApps()

const FAKE = join(ROOT, '..', 'tests', 'fixtures', 'local-apps', 'fake-mcp.ts')
const BUN = (() => { try { return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() } catch { return process.execPath } })()
const SECRET = 'sk-desktop-e2e-246813579'
const spec = { adapter: 'mcp', command: BUN, args: [FAKE], env: ['FAKE_TOKEN'] }
const msg = (id: string, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method, params })
let n = 0
const callOf = (message: Record<string, unknown>) => ({ callId: `e2e-${++n}`, turnId: null, connectionId: 'conn-e2e', name: 'Fake app', spec, message, deadline: Date.now() + 20_000 })

/** Replace the app's message box: the answers in order (1 = Connect), and what it showed is kept. */
async function stubMessageBox(app: ElectronApplication, answers: number[]) {
  await app.evaluate(({ dialog }, list) => {
    const g = globalThis as any
    g.__boxes ??= []
    g.__boxAnswers = list
    dialog.showMessageBox = (async (...a: any[]) => {
      g.__boxes.push(a.length > 1 ? a[1] : a[0])
      return { response: g.__boxAnswers.shift() ?? 0, checkboxChecked: false }
    }) as any
  }, answers)
}
const boxes = (app: ElectronApplication) => app.evaluate(() => ((globalThis as any).__boxes ?? []) as { message: string; detail: string; buttons: string[] }[])

test('a program on this computer: asked once in the app\'s own dialog, run without a shell, its setting hidden, stopped on Stop', async () => {
  const app = await launch(newUserData())
  try {
    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    expect(await page.evaluate(() => typeof (window as any).mycelDesktop.localApps?.run)).toBe('function')
    await stubMessageBox(app, [0, 1])
    const run = (m: Record<string, unknown>) => page.evaluate((c) => (window as any).mycelDesktop.localApps.run(c), callOf(m))

    // Cancel: nothing starts
    expect(await run(msg('1', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }))).toMatchObject({ ok: false, failure: 'declined' })
    expect(await page.evaluate(() => (window as any).mycelDesktop.localApps.running())).toEqual([])
    // a check asks again; Connect: it runs
    expect(await page.evaluate((v) => (window as any).mycelDesktop.localApps.setSettings('conn-e2e', { FAKE_TOKEN: v }), SECRET)).toBe('saved')
    expect(await page.evaluate(() => (window as any).mycelDesktop.localApps.settingNames('conn-e2e'))).toEqual(['FAKE_TOKEN'])
    expect(await run(msg('2', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }))).toMatchObject({ ok: true, message: { result: { serverInfo: { name: 'fake' } } } })
    const shown = await boxes(app)
    expect(shown).toHaveLength(2)
    expect(shown[1]!.message).toBe('이 프로그램을 연결할까요?')
    expect(shown[1]!.detail).toContain('fake-mcp.ts')
    expect(shown[1]!.detail).toContain('믿을 수 있는 프로그램만 연결해 주세요')
    expect(shown[1]!.buttons).toEqual(['취소', '연결'])

    // asked once: the next calls run without a dialog; the setting reached the program and came back hidden
    const env = await run(msg('3', 'tools/call', { name: 'env', arguments: { name: 'FAKE_TOKEN' } }))
    expect(JSON.stringify(env)).not.toContain(SECRET)
    expect(env).toMatchObject({ ok: true, message: { result: { content: [{ text: 'value: [hidden]' }] } } })
    expect(await boxes(app)).toHaveLength(2)
    expect(await page.evaluate(() => (window as any).mycelDesktop.localApps.running())).toEqual(['conn-e2e'])

    // Stop
    await page.evaluate(() => (window as any).mycelDesktop.localApps.stop('conn-e2e'))
    await expect.poll(() => page.evaluate(() => (window as any).mycelDesktop.localApps.running())).toEqual([])
  } finally {
    await close(app)
  }
})
