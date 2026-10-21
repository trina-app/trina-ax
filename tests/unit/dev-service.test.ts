// `bun run dev:service` (scripts/dev-service.ts): the LaunchAgent that keeps `bun run dev` running. Only the plist and
// the PATH are checked here; installing it would start the real product.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { jobPath, LABEL, plist } from '../../scripts/dev-service'
import { WORK } from '../lib/env'

describe('dev service plist', () => {
  const text = plist({ bun: '/Users/x/.bun/bin/bun', root: '/Users/x/team & ax', path: '/a:/b', home: '/Users/x', devDir: '/Users/x/.dev<1>', log: '/Users/x/Library/Logs/team-ax-dev/dev.log' })

  test('runs `bun run dev` in the checkout, kept alive, logging to one file', () => {
    expect(text).toContain(`<key>Label</key><string>${LABEL}</string>`)
    expect(text).toContain('<array><string>/Users/x/.bun/bin/bun</string><string>run</string><string>dev</string></array>')
    expect(text).toContain('<key>WorkingDirectory</key><string>/Users/x/team &amp; ax</string>')
    expect(text).toContain('<key>KeepAlive</key><true/>')
    expect(text).toContain('<key>TEAM_AX_DEV_DIR</key><string>/Users/x/.dev&lt;1&gt;</string>')
    expect(text).toContain('<key>NO_COLOR</key><string>1</string>')
    expect(text.match(/dev\.log/g)!.length).toBe(2)
  })

  test.if(process.platform === 'darwin')('is a valid property list', () => {
    const f = path.join(WORK, 'dev-service', 'job.plist')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, text)
    const p = Bun.spawnSync(['plutil', '-lint', f])
    expect(p.stdout.toString()).toContain('OK')
  })

  test('PATH finds the tools first and keeps the system directories', () => {
    const p = jobPath({ PATH: path.dirname(process.execPath) }).split(':')
    expect(p[0]).toBe(path.dirname(process.execPath))
    for (const d of ['/usr/bin', '/bin', '/opt/homebrew/bin']) expect(p).toContain(d)
    expect(new Set(p).size).toBe(p.length)
  })
})
