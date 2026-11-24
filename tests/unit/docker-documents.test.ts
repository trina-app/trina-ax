// Documents in the Docker image (docs/decisions/20261124-doc-kit-docker.md): the run kit in the image, srt runs with no
// systemd, the root-owned plan file (offline, one run at a time), the runner's memory and process watch, and one
// render at a time. The real container is checked by docker/test.sh; the watch's kills by tests/linux/srt-subagent.ts.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runTree, DIRECT_WATCH_MS, procTable, descendants, containerMemory, directArgv, directCommand, sweepLeftoverRuns, DIRECT_HEADROOM_MIB, SRT_OOM_SCORE, PAYLOAD_OOM_SCORE } from '../../server/src/devenv/srt/system'
import { parsePlan, effectiveLimits } from '../../server/src/devenv/srt/plan'
import { renderParallel, RENDER_PARALLEL } from '../../server/src/files/html-pdf'
import { groupsFor, packagesFor, pythonsFor, type PackageList } from '../../scripts/system/packages'

const REPO = path.join(import.meta.dir, '..', '..')
const read = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8')
const LIST = JSON.parse(read('scripts/system/packages.json')) as PackageList

function fakeProc(procs: { pid: number; ppid: number; comm: string; rssKiB?: number; uid?: number; start?: number; ns?: string; cmd?: string }[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'))
  for (const p of procs) {
    const dir = path.join(d, String(p.pid))
    fs.mkdirSync(path.join(dir, 'ns'), { recursive: true })
    // fields after the comm: state(3) ppid(4) ... starttime(22)
    const rest = ['S', p.ppid, p.pid, p.pid, 0, -1, 4194560, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, p.start ?? 1000 + p.pid]
    fs.writeFileSync(path.join(dir, 'stat'), `${p.pid} (${p.comm}) ${rest.join(' ')} 0\n`)
    fs.writeFileSync(path.join(dir, 'status'), `Name:\t${p.comm}\nPPid:\t${p.ppid}\nUid:\t${p.uid ?? 980}\t${p.uid ?? 980}\t${p.uid ?? 980}\t${p.uid ?? 980}\nThreads:\t1\n${p.rssKiB === undefined ? '' : `VmRSS:\t${p.rssKiB} kB\n`}`)
    fs.writeFileSync(path.join(dir, 'cmdline'), (p.cmd ?? p.comm).split(' ').join('\0') + '\0')
    fs.symlinkSync(p.ns ?? 'pid:[1]', path.join(dir, 'ns', 'pid'))
  }
  fs.mkdirSync(path.join(d, 'self'))
  return d
}

describe('the direct runner counts a run\'s whole process tree', () => {

  test('children in other sessions and deep chains are counted; other processes are not', () => {
    // srt's bwrap starts its own sessions (--new-session), so the run's process group alone misses its commands
    const d = fakeProc([
      { pid: 100, ppid: 1, comm: 'setsid', rssKiB: 1000 },
      { pid: 101, ppid: 100, comm: 'node srt (cli) )x', rssKiB: 50_000 },
      { pid: 102, ppid: 101, comm: 'bwrap', rssKiB: 2000 },
      { pid: 103, ppid: 102, comm: 'python3', rssKiB: 900_000 },
      { pid: 104, ppid: 103, comm: 'kernel thread' },
      { pid: 200, ppid: 1, comm: 'server', rssKiB: 400_000 },
      { pid: 201, ppid: 200, comm: 'bun', rssKiB: 10 },
    ])
    try {
      const t = runTree(100, d)
      expect(t.pids.sort()).toEqual([100, 101, 102, 103, 104])
      expect(t.rssKiB).toBe(1000 + 50_000 + 2000 + 900_000)
      // no cap on the count: a run cannot hide memory in more processes than a fixed walk would read
      const many = Array.from({ length: 300 }, (_, i) => ({ pid: 1000 + i, ppid: i ? 1000 + i - 1 : 100, comm: 'sh', rssKiB: 10 }))
      const d2 = fakeProc([{ pid: 100, ppid: 1, comm: 'setsid', rssKiB: 0 }, ...many])
      try { expect(runTree(100, d2)).toEqual({ pids: expect.any(Array), rssKiB: 3000 }); expect(runTree(100, d2).pids.length).toBe(301) } finally { fs.rmSync(d2, { recursive: true, force: true }) }
      expect(runTree(999, d)).toEqual({ pids: [], rssKiB: 0 })
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
    expect(DIRECT_WATCH_MS).toBeLessThanOrEqual(500)
  })

  test('start times tell a process from a later one with its pid; descendants follow orphans of a seen root', () => {
    const d = fakeProc([{ pid: 10, ppid: 1, comm: 'bwrap', start: 555 }, { pid: 11, ppid: 10, comm: 'bash' }, { pid: 12, ppid: 11, comm: 'sleep' }, { pid: 20, ppid: 1, comm: 'other' }])
    try {
      const t = procTable(d)
      expect(t.get(10)).toEqual({ ppid: 1, start: '555', uid: 980 })
      expect(descendants([10], t).sort()).toEqual([10, 11, 12])
      expect(descendants([99], t)).toEqual([])
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  test('a restarted server kills what an earlier one left: its own account, another pid namespace or a run\'s program; never itself, its parents or its children', () => {
    const d = fakeProc([
      { pid: 1, ppid: 0, comm: 'mycel-ctl', uid: 0 },
      { pid: 50, ppid: 1, comm: 'bootstrap' }, { pid: 60, ppid: 50, comm: 'bun', cmd: 'bun main.js' },
      { pid: 61, ppid: 60, comm: 'bwrap', cmd: '/usr/bin/bwrap --unshare-all soffice', ns: 'pid:[9]' }, { pid: 62, ppid: 61, comm: 'soffice', ns: 'pid:[9]' },
      // left by an earlier server: orphans of a run (reparented to PID 1)
      { pid: 70, ppid: 1, comm: 'bash', cmd: 'bash -c while true', ns: 'pid:[7]' }, { pid: 71, ppid: 70, comm: 'python3', ns: 'pid:[7]' },
      { pid: 80, ppid: 1, comm: 'node', cmd: '/opt/trina/node/bin/node /opt/trina/srt/0.0.81/cli.js -c x' },
      // the engine account's turn and another account: not this server's to kill
      { pid: 90, ppid: 1, comm: 'claude', uid: 981, ns: 'pid:[8]' }, { pid: 95, ppid: 1, comm: 'cron', uid: 0 },
      { pid: 96, ppid: 1, comm: 'sh', cmd: 'sh -c something' },
    ])
    try {
      const killed: number[] = []
      const orig = process.kill
      ;(process as { kill: unknown }).kill = (pid: number) => { killed.push(pid); return true }
      try { expect(sweepLeftoverRuns(d, 60, 980)).toBe(3) } finally { (process as { kill: unknown }).kill = orig }
      expect(killed.sort((a, b) => a - b)).toEqual([70, 71, 80])
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  test('the container\'s memory: current, limit (or the machine\'s memory), OOM kills', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cg-'))
    try {
      fs.writeFileSync(path.join(d, 'memory.current'), '3221225472\n'); fs.writeFileSync(path.join(d, 'memory.max'), '4294967296\n'); fs.writeFileSync(path.join(d, 'memory.events'), 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 2\n')
      expect(containerMemory(d)).toEqual({ current: 3221225472, max: 4294967296, ooms: 2 })
      // the working set: inactive page cache does not count, tmpfs (shmem) does
      fs.writeFileSync(path.join(d, 'memory.stat'), 'anon 1000\nshmem 2147483648\ninactive_file 1073741824\nactive_file 5\n')
      expect(containerMemory(d)!.current).toBe(3221225472 - 1073741824)
      fs.writeFileSync(path.join(d, 'memory.max'), 'max\n')
      if (process.platform === 'linux') expect(containerMemory(d)!.max).toBeGreaterThan(0)
      expect(containerMemory(path.join(d, 'none'))).toBeNull()
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
    expect(DIRECT_HEADROOM_MIB).toBe(768)
    expect(SRT_OOM_SCORE).toBeLessThan(PAYLOAD_OOM_SCORE)
    expect(read('scripts/dev-env/srt/run-wrap')).toContain(`echo ${SRT_OOM_SCORE} > /proc/self/oom_score_adj`)
  })

  test('a direct run: its own session, lowest CPU priority, a hard process cap over the account\'s tasks, then run-wrap and srt', () => {
    const s = { exitFile: '/b/x.exit', settingsFile: '/b/s.json', command: 'echo', limits: { cpus: 1, memoryMiB: 1024, pids: 512, runtimeMaxSec: 60 } }
    const a = directArgv(s, 140, () => true)
    expect(a.slice(0, 9)).toEqual(['/usr/bin/setsid', '/usr/bin/nice', '-n', '19', '/usr/bin/chrt', '--idle', '0', '/usr/bin/prlimit', '--nproc=652'])
    expect(a.slice(9, 12)).toEqual(['/opt/trina/devenv/run-wrap', '/b/x.exit', '--'])
    // the sandboxed shell raises its own OOM score before the command, on a line of its own (a heredoc stays whole)
    expect(directCommand("cat <<'EOF'\nx\nEOF")).toBe(`echo ${PAYLOAD_OOM_SCORE} > /proc/self/oom_score_adj 2>/dev/null\ncat <<'EOF'\nx\nEOF`)
    // a missing program is left out, never the run
    expect(directArgv(s, 0, (f) => f !== '/usr/bin/chrt')).not.toContain('/usr/bin/chrt')
  })

  test('on this machine: the test process itself is a tree of one or more', () => {
    if (process.platform !== 'linux') return
    const t = runTree(process.pid)
    expect(t.pids).toContain(process.pid)
    expect(t.rssKiB).toBeGreaterThan(0)
  })
})

describe('one render at a time where the server sets it', () => {
  test('MYCEL_RENDER_PARALLEL lowers the server-wide renders, never raises them', () => {
    expect(renderParallel({})).toBe(RENDER_PARALLEL)
    expect(renderParallel({ MYCEL_RENDER_PARALLEL: '1' })).toBe(1)
    expect(renderParallel({ MYCEL_RENDER_PARALLEL: '9' })).toBe(RENDER_PARALLEL)
    for (const bad of ['0', '-1', 'x', '1.5', '']) expect(renderParallel({ MYCEL_RENDER_PARALLEL: bad })).toBe(RENDER_PARALLEL)
  })
})

describe('the Docker image builds documents in a run', () => {
  const docker = read('docker/Dockerfile'), entry = read('docker/entrypoint.sh'), srt = read('scripts/dev-env/srt/install-srt.sh')

  test('the image takes the run kit from the kit\'s own install-srt.sh, and only the docrun groups', () => {
    expect(docker).toContain('bash "$srt" --image-mode --documents')
    // an older kit has no --documents: the image still builds, with make_file
    expect(docker).toContain("grep -q -- '--documents) DOCUMENTS=1' \"$srt\"")
    expect(srt).toContain('[ "$DOCUMENTS" = 0 ] || PKG_GROUPS="core media fonts docrun"')
    expect(srt).toContain('--documents is for --image-mode')
    const pk = packagesFor(LIST, 'debian-13', 'arm64', ['core', 'media', 'fonts', 'docrun'])
    for (const p of ['build-essential', 'chromium', 'git', 'polkitd', 'python3-pip']) expect(pk).not.toContain(p)
    for (const p of ['bubblewrap', 'socat', 'ripgrep', 'xz-utils', 'python3-venv', 'python3-docx', 'python3-openpyxl', 'python3-pandas', 'fonts-noto-cjk', 'fonts-liberation']) expect(pk).toContain(p)
    expect(pythonsFor(LIST, ['core', 'media', 'fonts', 'docrun'])).toEqual(['python-pptx'])
    // a default install keeps everything it had: docrun comes with devenv
    expect(groupsFor(LIST, ['default'])).toEqual(expect.arrayContaining(['docrun', 'devenv']))
    // LibreOffice, Carlito and Caladea for the page views: the office-view group, which the image adds with the fonts
    expect(docker).toContain('if pk_groups office-view >/dev/null 2>&1; then groups="$groups office-view";')
    expect(packagesFor(LIST, 'debian-13', 'arm64', ['minimal', 'docker', 'office-view', 'fonts'])).toEqual(expect.arrayContaining(['libreoffice-writer', 'fonts-crosextra-carlito', 'fonts-noto-cjk', 'fonts-liberation']))
  })

  test('the entrypoint starts runs with no systemd only when the kit is there, offline and one at a time by a root-owned plan', () => {
    expect(entry).toContain('echo "MYCEL_DEV_ENV=1"')
    expect(entry).toContain('echo "MYCEL_DEV_ENV_SRT_DIRECT=1"')
    expect(entry).toContain('echo "MYCEL_RENDER_PARALLEL=1"')
    // the operator's switch: off for every team on the server
    expect(entry).toContain('case "${TRINA_AX_DEV_ENV:-1}" in\n  0) DOCS=0 ;;')
    expect(read('docker/docker-compose.yml')).toContain('TRINA_AX_DEV_ENV: ${TRINA_AX_DEV_ENV:-1}')
    expect(entry).toContain('if [ -x /opt/trina/devenv/run-wrap ] && [ -x /opt/trina/node/bin/node ] && compgen -G "/opt/trina/srt/*/cli.js"')
    expect(entry).toContain('chown root:root "$PLAN.tmp" && chmod 644 "$PLAN.tmp"')
    const line = /printf '%s\\n' '(\{[^']+\})' > "\$PLAN\.tmp"/.exec(entry)
    expect(line).not.toBeNull()
    const plan = parsePlan(line![1]!)
    expect(plan).toMatchObject({ plan: 'docker', maxRunning: 1, memoryMiB: 1024, pids: 512, network: 'offline' })
    // whatever the team setting asks: offline, the plan's memory
    expect(effectiveLimits({ cpus: 2, memoryMiB: 4096, pids: 1024, diskGiB: 8, idleStopMin: 30 }, 'open', plan)).toEqual({ cpus: 1, memoryMiB: 1024, pids: 512, network: 'offline', maxRunning: 1 })
    // the plan file is written after the install (root/ exists then) and before the server starts
    expect(entry.indexOf('PLAN="$BASE/root/dev-env.json"')).toBeGreaterThan(entry.indexOf('"$KIT/install-linux.sh" "$CMD" "${ARGS[@]}"'))
    expect(entry.indexOf('PLAN="$BASE/root/dev-env.json"')).toBeLessThan(entry.indexOf('exec "$BASE/root/mycel-ctl" supervise'))
  })
})
