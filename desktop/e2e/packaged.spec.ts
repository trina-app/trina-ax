// The packaged macOS app (bun run dist:mac): its Electron fuses are set (no ELECTRON_RUN_AS_NODE, NODE_OPTIONS or
// --inspect, cookies encrypted on disk, code only from app.asar), it starts, opens the remembered team and the
// team page finds the desktop bridge. Skipped when release/ has no build (the regular suite tests dist/).
// The app is started as a plain process: with the inspect fuse off, Playwright cannot attach to its main process.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ACME, newUserData, ROOT } from './helpers'

const APP = join(ROOT, 'release/mac-arm64/Team AX.app')
const exe = join(APP, 'Contents/MacOS/Team AX')
const framework = join(APP, 'Contents/Frameworks/Electron Framework.framework/Electron Framework')

/** Electron's fuse wire (https://github.com/electron/fuses): sentinel, version 1, length, one '0' / '1' per fuse. */
function readFuses(binary: string): string {
  const buf = readFileSync(binary)
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
  const at = buf.indexOf(sentinel)
  if (at < 0) throw new Error('no fuse wire')
  const len = buf[at + sentinel.length + 1]
  return buf.subarray(at + sentinel.length + 2, at + sentinel.length + 2 + len).toString('latin1')
}

test('packaged app: fuses are set, it starts and the team page gets the bridge', async () => {
  test.skip(process.platform !== 'darwin' || !existsSync(exe), 'no packaged build in release/')
  const fuses = readFuses(framework)
  // 0 RunAsNode, 1 EnableCookieEncryption, 2 NODE_OPTIONS, 3 --inspect, 5 OnlyLoadAppFromAsar, 7 file:// extras
  expect([fuses[0], fuses[1], fuses[2], fuses[3], fuses[5], fuses[7]]).toEqual(['0', '1', '0', '0', '1', '0'])
  expect(readFileSync(join(APP, 'Contents/Info.plist'), 'utf8')).toContain('NSLocalNetworkUsageDescription')

  // a user data folder that already knows the team (the first-run screen is covered by the dist/ tests)
  const userData = newUserData()
  const teamId = 'a1b2c3d4e5f60718'
  writeFileSync(
    join(userData, 'teams.json'),
    JSON.stringify({ version: 1, lastTeamId: teamId, teams: [{ id: teamId, origin: ACME, label: 'acme', addedAt: new Date().toISOString(), lastOpenedAt: null, direct: null }] }),
  )
  const before = (await (await fetch('http://127.0.0.1:19151/test/windows')).json()) as { bridged: string[] }
  // ELECTRON_RUN_AS_NODE must be ignored by the packaged app (fuse): it starts as the app anyway
  const proc = spawn(exe, [], { env: { ...process.env, MYCEL_DESKTOP_USER_DATA: userData, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' })
  try {
    await expect
      .poll(async () => ((await (await fetch('http://127.0.0.1:19151/test/windows')).json()) as { bridged: string[] }).bridged.filter((w) => !before.bridged.includes(w)).length, { timeout: 30_000 })
      .toBe(1)
  } finally {
    proc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    if (proc.exitCode === null) proc.kill('SIGKILL')
  }
})
