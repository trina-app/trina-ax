// `bun run dev admin ...` runs the account CLI on the data folder `bun run dev` uses (TEAM_AX_DEV_DIR, by default
// ~/.team-ax-dev). Plain `bun run admin` looks at <repo>/.dev, so an owner of the `bun run dev` team who forgot the
// password got "no account yet" there instead of a reset link.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { WORK } from '../lib/env'

const REPO = path.resolve(import.meta.dir, '..', '..')
const HOME = path.join(WORK, 'dev-admin')

function dev(args: string[], stdin?: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TEAM_AX_DEV_DIR: HOME }
  for (const k of ['MYCEL_DATA_DIR', 'MYCEL_TEAM_ROOT', 'MYCEL_CONFIG', 'MYCEL_MODE']) delete env[k]
  const p = Bun.spawnSync(['bun', path.join(REPO, 'scripts', 'dev.ts'), 'admin', ...args], { cwd: REPO, env, stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin) })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}

describe('bun run dev admin', () => {
  test('creates the owner in the dev data folder and makes a reset link for it there', () => {
    fs.rmSync(HOME, { recursive: true, force: true })
    expect(dev(['status']).out).toContain('setup needed')
    const made = dev(['create-owner', '--username', 'olga', '--name', 'Olga', '--team', 'Acme'], 'a long enough password 123\n')
    expect(made.code).toBe(0)
    expect(fs.existsSync(path.join(HOME, 'data', 'app.db'))).toBe(true)
    const link = dev(['reset-link'])
    expect(link.code).toBe(0)
    expect(link.out).toMatch(/reset-password\/[A-Za-z0-9_-]+/)
  }, 60_000)
})
