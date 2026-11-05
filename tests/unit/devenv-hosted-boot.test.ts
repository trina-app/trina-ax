// The hosted boot of the dev environment on srt (docs/research/srt-hosted-boot.md): scripts/image/files/mycel-devenv-boot
// maps the control plane's plan.json to dev-env.json. Its output must pass the server's own parser (parsePlan, the same
// rules as mycel-boxd). The boot itself (files, drop-in, slice, restart rules) is tested in Docker by
// scripts/image/test-customize.sh.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parsePlan, sliceValues } from '../../server/src/devenv/srt/plan'

const REPO = path.resolve(import.meta.dir, '../..')
const SCRIPT = path.join(REPO, 'scripts/image/files/mycel-devenv-boot')
const hasJq = Bun.spawnSync(['sh', '-c', 'command -v jq']).exitCode === 0

function map(plan: object, machine?: { mib: number; cores: number }): { code: number; out: string } {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-boot-'))
  const f = path.join(d, 'plan.json')
  fs.writeFileSync(f, JSON.stringify(plan))
  const env = machine ? { ...process.env, MYCEL_DEVENV_MACHINE_MIB: String(machine.mib), MYCEL_DEVENV_MACHINE_CORES: String(machine.cores) } : process.env
  const p = Bun.spawnSync(['bash', SCRIPT, '--map', f], { stdout: 'pipe', stderr: 'pipe', env })
  fs.rmSync(d, { recursive: true, force: true })
  return { code: p.exitCode ?? -1, out: p.stdout.toString().trim() }
}

// the plans of the control plane (trina-cloud src/teams/plans.ts planFileFor; the ids are basic / team / pro)
const cp = (plan: string, memoryMiB: number, cpuCores: number, diskGiB: number, maxConcurrency: number) => ({
  format: 1, plan, updatedAt: '2026-11-05T00:00:00.000Z', maxConcurrency, memoryMiB, cpuCores, diskGiB,
  localBackupRetentionDays: 3, maxActiveMembers: 5, display: { name: { en: plan } }, links: null,
})

describe.skipIf(!hasJq)('mycel-devenv-boot --map (needs jq)', () => {
  test('Starter gets the owner numbers, and the server parser accepts them', () => {
    const r = map(cp('basic', 4096, 2, 80, 2))
    expect(r.code).toBe(0)
    expect(parsePlan(r.out)).toEqual({ format: 1, plan: 'basic', maxRunning: 1, cpus: 1.5, memoryMiB: 1536, pids: 512, diskGiB: 8, network: 'open' })
    expect(sliceValues(parsePlan(r.out))).toEqual({ MemoryMax: '1536M', CPUQuota: '150%', TasksMax: 2048 })
  })
  test('Team and Business are derived from the plan resources', () => {
    expect(parsePlan(map(cp('team', 8192, 2, 160, 3)).out)).toMatchObject({ maxRunning: 2, cpus: 1.5, memoryMiB: 3072, pids: 1024, diskGiB: 16 })
    expect(parsePlan(map(cp('pro', 16384, 4, 320, 6)).out)).toMatchObject({ maxRunning: 3, cpus: 3, memoryMiB: 6144, pids: 2048, diskGiB: 32 })
  })
  test('every plan size from 4 GiB to 256 GiB stays inside the parser ranges', () => {
    for (const mem of [4096, 5120, 6144, 12288, 24576, 32768, 65536, 262144]) {
      for (const cores of [1, 2, 3, 4, 8, 64]) {
        const r = map(cp('x', mem, cores, 100, 2))
        expect(r.code).toBe(0)
        expect(() => parsePlan(r.out)).not.toThrow()
      }
    }
  })
  test('a plan under 4096 MiB (Free, the old trial) and a bad file get no dev environment', () => {
    expect(map(cp('free', 2048, 2, 5, 1)).code).not.toBe(0)
    expect(map({ format: 2, plan: 'x', memoryMiB: 4096, cpuCores: 2 }).code).not.toBe(0)
    expect(map({ format: 1, plan: 'x', memoryMiB: '4096', cpuCores: 2 }).code).not.toBe(0)
  })
  test('the machine size caps the plan (a move up: the VM grows only at its next reboot)', () => {
    // a 4 GiB EC2 VM has a MemTotal of about 3.8 GiB: rounded up, it is a Starter machine
    expect(parsePlan(map(cp('basic', 4096, 2, 80, 2), { mib: 3890, cores: 2 }).out)).toMatchObject({ maxRunning: 1, cpus: 1.5, memoryMiB: 1536 })
    expect(parsePlan(map(cp('team', 8192, 2, 160, 3), { mib: 3890, cores: 2 }).out)).toMatchObject({ plan: 'team', maxRunning: 1, memoryMiB: 1536, pids: 512 })
    expect(parsePlan(map(cp('pro', 16384, 4, 320, 6), { mib: 7900, cores: 2 }).out)).toMatchObject({ maxRunning: 2, cpus: 1.5, memoryMiB: 3072 })
    // Starter on the 2 GiB VM of Free (MemTotal about 1.9 GiB): no dev environment until the reboot
    expect(map(cp('basic', 4096, 2, 80, 2), { mib: 1942, cores: 2 }).code).not.toBe(0)
  })
})
