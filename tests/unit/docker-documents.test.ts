// Documents in the Docker image (docs/decisions/20261124-docker-documents.md): the run kit in the image, srt runs with no
// systemd, the root-owned plan file (offline, one run at a time), the runner's memory and process watch, and one
// render at a time. The real container is checked by docker/test.sh; the watch's kills by tests/linux/srt-subagent.ts.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runTree, DIRECT_WATCH_MS } from '../../server/src/devenv/srt/system'
import { parsePlan, effectiveLimits } from '../../server/src/devenv/srt/plan'
import { renderParallel, RENDER_PARALLEL } from '../../server/src/files/html-pdf'
import { groupsFor, packagesFor, pythonsFor, type PackageList } from '../../scripts/system/packages'

const REPO = path.join(import.meta.dir, '..', '..')
const read = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8')
const LIST = JSON.parse(read('scripts/system/packages.json')) as PackageList

describe('the direct runner counts a run\'s whole process tree', () => {
  function fakeProc(procs: { pid: number; ppid: number; comm: string; rssKiB?: number }[]): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'))
    for (const p of procs) {
      fs.mkdirSync(path.join(d, String(p.pid)))
      fs.writeFileSync(path.join(d, String(p.pid), 'stat'), `${p.pid} (${p.comm}) S ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194560 0 0 0 0 0 0\n`)
      fs.writeFileSync(path.join(d, String(p.pid), 'status'), `Name:\t${p.comm}\nPPid:\t${p.ppid}\n${p.rssKiB === undefined ? '' : `VmRSS:\t${p.rssKiB} kB\n`}`)
    }
    fs.mkdirSync(path.join(d, 'self'))
    return d
  }

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
