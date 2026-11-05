import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// mobile/scripts/ci-install.sh with a fake npm first on PATH: only an unreachable registry is a skip, the rest fails.
const script = path.join(import.meta.dir, '../../mobile/scripts/ci-install.sh')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-ci-install-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function run(output: string, status: number) {
  const bin = fs.mkdtempSync(path.join(dir, 'bin-'))
  fs.writeFileSync(path.join(bin, 'npm-output'), output + '\n')
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash\ncat "$(dirname "$0")/npm-output"\nexit ${status}\n`, { mode: 0o755 })
  const out = path.join(bin, 'github-output')
  const r = Bun.spawnSync(['bash', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out } })
  return { status: r.exitCode, stdout: r.stdout.toString(), installed: fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '' }
}

test('installed: the typecheck runs', () => {
  expect(run('added 477 packages in 30s', 0)).toMatchObject({ status: 0, installed: 'installed=true' })
}, 30_000)

test('a registry that stays unreachable after the retries warns and skips', () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'E503', 'E500']) {
    const r = run(`npm error code ${code}\nnpm error network request failed`, 1)
    expect(r).toMatchObject({ status: 0, installed: 'installed=false' })
    expect(r.stdout).toContain('::warning::')
  }
  expect(run('npm ERR! code ECONNRESET', 1)).toMatchObject({ status: 0, installed: 'installed=false' }) // older npm
}, 60_000)

test('anything else fails: lockfile out of step, integrity mismatch, a network word elsewhere in the output', () => {
  for (const output of [
    'npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json are in sync',
    'npm error code EINTEGRITY\nnpm error sha512-... integrity checksum failed',
    'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope',
    'npm error code ELIFECYCLE\nnpm error retry after ETIMEDOUT was not the cause',
  ]) {
    const r = run(output, 1)
    expect(r.status).toBe(1)
    expect(r.installed).toBe('installed=false')
    expect(r.stdout).not.toContain('::warning::')
  }
}, 60_000)
