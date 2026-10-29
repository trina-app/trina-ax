// linux-runtime spec 3.8.2 (L12): the server's converter cgroup, against a fake cgroupfs folder (runs on any OS).
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _resetCgroupsForTest, cgexecPrefix, convBudgetMiB, converterCgroup, setupServerCgroups } from '../../server/src/system/cgroups'

function fakeCgroupFs(o: { controllers?: string; procs?: string[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-cgfs-'))
  const s = path.join(root, 'system.slice', 'mycel-server.service')
  fs.mkdirSync(s, { recursive: true })
  fs.writeFileSync(path.join(s, 'cgroup.controllers'), o.controllers ?? 'cpuset cpu io memory pids\n')
  fs.writeFileSync(path.join(s, 'cgroup.procs'), (o.procs ?? ['100', '101']).join('\n') + '\n')
  fs.writeFileSync(path.join(s, 'cgroup.subtree_control'), '')
  const helper = path.join(root, 'mycel-sandbox')
  fs.writeFileSync(helper, '')
  return { root, s, helper }
}

afterEach(() => _resetCgroupsForTest())

describe('server converter cgroup (spec 3.8.2)', () => {
  test('moves the bootstrap and the server into S/main, enables the controllers, limits S/conv', () => {
    const { root, s, helper } = fakeCgroupFs()
    const plan = path.join(root, 'plan.json')
    fs.writeFileSync(plan, JSON.stringify({ format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 50 }))
    const r = setupServerCgroups({ mode: 'prod', platform: 'linux', cgroupFs: root, selfCgroup: '0::/system.slice/mycel-server.service\n',
      pid: 101, ppid: 100, uid: process.getuid!(), helper, planFile: plan, cpus: 8 })
    expect(r.state).toBe('delegated')
    // the fake cgroup.procs keeps the last write: each pid is written on its own (the kernel takes one per write)
    expect(fs.readFileSync(path.join(s, 'main', 'cgroup.procs'), 'utf8')).toBe('101')
    expect(fs.readFileSync(path.join(s, 'cgroup.subtree_control'), 'utf8')).toBe('+memory +pids +cpu')
    const conv = path.join(s, 'conv')
    expect(fs.readFileSync(path.join(conv, 'memory.max'), 'utf8')).toBe(String(1024 * 1048576)) // Team: 4096 × 0.25
    expect(fs.readFileSync(path.join(conv, 'memory.high'), 'utf8')).toBe(String(870 * 1048576))
    expect(fs.readFileSync(path.join(conv, 'pids.max'), 'utf8')).toBe('128')
    expect(fs.readFileSync(path.join(conv, 'cpu.max'), 'utf8')).toBe('200000 100000')
    expect(converterCgroup()?.dir).toBe(conv)
    expect(cgexecPrefix(60_000)).toEqual([helper, 'cgexec', '--cgroup', path.join(conv,'legacy'), '--oom-score-adj', '500', '--rlimit-cpu', '65',
      '--rlimit-fsize', String(1024 ** 3), '--rlimit-nofile', '1024', '--'])
  })

  test('a restart inside S/main finds S again', () => {
    const { root, s, helper } = fakeCgroupFs()
    fs.mkdirSync(path.join(s, 'main'))
    const r = setupServerCgroups({ mode: 'prod', platform: 'linux', cgroupFs: root, selfCgroup: '0::/system.slice/mycel-server.service/main\n',
      pid: 7, ppid: 6, uid: process.getuid!(), helper, machineMiB: 8192 })
    expect(r.state).toBe('delegated')
    expect(converterCgroup()?.dir).toBe(path.join(s, 'conv'))
    expect(converterCgroup()?.memoryMiB).toBe(1536)
  })

  test('nothing happens off Linux, in dev, without the helper, without delegation or controllers', () => {
    const { root, helper } = fakeCgroupFs()
    const base = { cgroupFs: root, selfCgroup: '0::/system.slice/mycel-server.service\n', pid: 1, ppid: 2, uid: process.getuid!(), helper }
    expect(setupServerCgroups({ ...base, mode: 'prod', platform: 'darwin' }).state).toBe('off')
    expect(setupServerCgroups({ ...base, mode: 'dev', platform: 'linux' }).state).toBe('off')
    expect(setupServerCgroups({ ...base, mode: 'prod', platform: 'linux', helper: '/nonexistent/mycel-sandbox' }).state).toBe('none')
    expect(setupServerCgroups({ ...base, mode: 'prod', platform: 'linux', uid: process.getuid!() + 1 }).state).toBe('none')
    expect(setupServerCgroups({ ...base, mode: 'prod', platform: 'linux', selfCgroup: '0::/../../etc\n' }).state).toBe('none')
    const noMem = fakeCgroupFs({ controllers: 'cpu pids' })
    expect(setupServerCgroups({ ...base, cgroupFs: noMem.root, helper: noMem.helper, mode: 'prod', platform: 'linux' }).state).toBe('none')
    expect(converterCgroup()).toBeNull()
    expect(cgexecPrefix(1000)).toEqual([])
  })

  test('converter budget follows the plan (spec 3.8.5 table)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-plan-'))
    const f = path.join(dir, 'plan.json')
    for (const [mem, want] of [[2048, 512], [4096, 1024], [8192, 1536]] as const) {
      fs.writeFileSync(f, JSON.stringify({ format: 1, memoryMiB: mem }))
      expect(convBudgetMiB(f, 999_999)).toBe(want)
    }
    fs.writeFileSync(f, JSON.stringify({ format: 1, memoryMiB: 4096, convMemoryMaxMiB: 700 }))
    expect(convBudgetMiB(f)).toBe(700)
    expect(convBudgetMiB(path.join(dir, 'missing.json'), 3000)).toBe(750)
  })
})
