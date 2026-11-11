// QA TC-211: the installers' copy of the one-time setup code (<base>/setup/code, for `sudo cat`) stayed on disk after
// setup. The server now removes it with its own copy (tests/unit/a-auth.test.ts "first-run setup"); a reinstall or
// update removes one an older server left behind: on Linux `drop_spent_setup_code` (also on an uninstall that keeps
// the data), on the Mac the same condition in one line. Here: each, run by bash on a scratch folder.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..', '..')
const read = (script: string) => fs.readFileSync(path.join(REPO, 'scripts', script), 'utf8')
const MAKES_CODE = 'put "$ITMP/code" "$SRV_USER" "$SRV_GRP" 600 "$BASE/data/setup-token"'

/** The cleanup as bash runs it in each installer, and where it is called after the block that makes a new code. */
const CLEANUP: Record<string, { code: () => string; at: (s: string) => number }> = {
  'install-linux.sh': {
    code: () => {
      const fn = /^drop_spent_setup_code\(\) \{.*\n(?:.*\n)*?\}$/m.exec(read('install-linux.sh'))?.[0]
      expect(fn).toBeTruthy()
      return `${fn}\ndrop_spent_setup_code`
    },
    at: (s) => s.indexOf('\ndrop_spent_setup_code\n', s.indexOf(MAKES_CODE)),
  },
  'install-macos.sh': {
    code: () => {
      const line = /^if \[ -f "\$BASE\/setup\/code" \] && \[ -f "\$BASE\/data\/app\.db" \] && \[ ! -e "\$BASE\/data\/setup-token" \]; then rm -f "\$BASE\/setup\/code"; fi$/m.exec(read('install-macos.sh'))?.[0]
      expect(line).toBeTruthy()
      return line!
    },
    at: (s) => s.search(/^if \[ -f "\$BASE\/setup\/code" \] && \[ -f "\$BASE\/data\/app\.db" \]/m),
  },
}

for (const [script, c] of Object.entries(CLEANUP)) {
  test(`${script} removes a spent setup code, and only that`, () => {
    const s = read(script)
    // after the block that makes a new code (a team not set up yet keeps its code)
    expect(c.at(s)).toBeGreaterThan(s.indexOf(MAKES_CODE))
    const code = c.code()
    const run = (files: string[]) => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-setup-code-'))
      try {
        for (const f of ['setup/code', 'setup/lan-cert.sha256', ...files]) { fs.mkdirSync(path.dirname(path.join(base, f)), { recursive: true }); fs.writeFileSync(path.join(base, f), 'x') }
        const p = Bun.spawnSync(['/bin/bash', '-c', code], { env: { BASE: base, PATH: process.env.PATH ?? '' } })
        expect(p.exitCode).toBe(0)
        return { code: fs.existsSync(path.join(base, 'setup/code')), other: fs.existsSync(path.join(base, 'setup/lan-cert.sha256')) }
      } finally { fs.rmSync(base, { recursive: true, force: true }) }
    }
    expect(run(['data/app.db'])).toEqual({ code: false, other: true }) // set up: the code is spent
    expect(run(['data/app.db', 'data/setup-token'])).toEqual({ code: true, other: true }) // started, not set up yet
    expect(run([])).toEqual({ code: true, other: true }) // a fresh install
  })
}
