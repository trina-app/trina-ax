// HTML printing in its own cgroup on Linux (system/cgroups.ts S/print, files/html-pdf.ts), with the server's own setup
// and the real helper (native/bin/linux-<arch>/mycel-sandbox cgexec). Run by tests/linux/html-pdf.sh inside the
// container, already in cgroup /S. Prints the numbers and exits 1 when a check fails.
import fs from 'node:fs'
import path from 'node:path'
import { _resetCgroupsForTest, converterCgroup, PRINT_ONE_MIB, PRINT_ONE_PIDS, printCgroup, setupServerCgroups } from '../../server/src/system/cgroups'
import { findPdfBrowser, htmlPdfUnavailable, renderHtmlPdf, renderParallel, serverFontDirs } from '../../server/src/files/html-pdf'

const repo = path.resolve(import.meta.dir, '..', '..')
const helper = path.join(repo, 'native', 'bin', `linux-${process.arch === 'x64' ? 'amd64' : process.arch}`, 'mycel-sandbox')
const read = (f: string) => { try { return fs.readFileSync(f, 'utf8').trim() } catch { return 'n/a' } }
const problems: string[] = []
const check = (ok: boolean, what: string) => { if (!ok) problems.push(what) }

// a 2 GB machine: no room for one print, HTML printing not offered
setupServerCgroups({ mode: 'prod', helper, uid: 0, machineMiB: 2048 })
check(printCgroup() === null, '2 GB: no print cgroup')
check((htmlPdfUnavailable() ?? '').includes('memory'), '2 GB: not offered, because of memory')
_resetCgroupsForTest()
// 4 GB: one print; 8 GB: two (both checked)
for (const [mib, parallel] of [[8192, 2], [4096, 1]] as const) {
  _resetCgroupsForTest()
  const st = setupServerCgroups({ mode: 'prod', helper, uid: 0, machineMiB: mib })
  const p = printCgroup()
  check(st.state === 'delegated' && !!p, `${mib} MiB: delegated with a print cgroup`)
  check(p?.parallel === parallel && renderParallel() === parallel, `${mib} MiB: ${parallel} at a time`)
  check(read(path.join(p!.dir, 'memory.max')) === String(parallel * PRINT_ONE_MIB * 1048576), `${mib} MiB: S/print memory.max`)
  check(read(path.join(p!.dir, 'pids.max')) === String(parallel * PRINT_ONE_PIDS), `${mib} MiB: S/print pids.max`)
  check(path.dirname(p!.dir) === path.dirname(converterCgroup()!.dir), 'S/print is beside S/conv')
}
const pc = printCgroup()!

const browser = findPdfBrowser()
if (!browser) { console.log('no browser'); process.exit(1) }
const base = fs.mkdtempSync('/tmp/hp-cg-')
const photos = new Map(Array.from({ length: 12 }, (_, i) => [`s/p${i}.png`, Buffer.alloc(5 * 1024 * 1024, i)]))
const pages = (n: number) => '<!doctype html><meta charset="utf-8"><style>td{border:1px solid #000;background:#ffe066} .b{break-before:page}</style>' +
  Array.from({ length: n }, (_, i) => `<div class="b"><h2>${i + 1}쪽 견적 항목</h2><img src="p${i % 12}.png" width="300"><table>${'<tr><td>셀</td><td>값 1,000,000원</td><td>비고</td></tr>'.repeat(20)}</table></div>`).join('')
// where the browser's processes are: sampled from /proc while it prints
const where = new Set<string>()
const sampler = setInterval(() => {
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      // the browser itself (not the helper and bwrap on their way into the leaf)
      if (cmd.startsWith(browser)) where.add(fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim())
    } catch { /* gone */ }
  }
}, 30)
const runs: { name: string; pages?: number; ms?: number; usage?: unknown; error?: string }[] = []
for (const [name, html] of [['one page', '<!doctype html><meta charset="utf-8"><h1>견적서</h1>'], ['18 pages, twelve 5 MB photos', pages(18)], ['190 pages', pages(190)]] as const) {
  const t = Date.now()
  try {
    const r = await renderHtmlPdf({ browser, html: Buffer.from(html), page: 's/a.html', workBase: base, fonts: serverFontDirs(), asset: (p) => photos.get(p) ?? null })
    runs.push({ name, pages: r.pages, ms: Date.now() - t, usage: r.usage })
    check(!!r.usage?.memoryMiB && r.usage.memoryMiB < PRINT_ONE_MIB, `${name}: peak memory under the leaf's limit`)
    if (r.usage?.pids !== undefined) check(r.usage.pids < PRINT_ONE_PIDS, `${name}: peak tasks under the leaf's limit`)
  } catch (e) { runs.push({ name, error: (e as Error).message.slice(0, 200) }); problems.push(`${name}: ${(e as Error).message.slice(0, 120)}`) }
}
clearInterval(sampler)
check(where.size > 0 && [...where].every((c) => c.startsWith(`0::/${path.relative('/sys/fs/cgroup', pc.dir)}/p-`)), 'the browser ran only in print leaves')
check(fs.readdirSync(pc.dir).filter((d) => d.startsWith('p-')).length === 0, 'no leaf left after the prints')
check(read(path.join(converterCgroup()!.dir, 'legacy', 'cgroup.procs')) === '', 'nothing in the converters\' cgroup')

// a fake browser whose child outlives it: the leaf's cgroup.kill takes the child too
const fake = path.join(fs.mkdtempSync('/tmp/hp-fb-'), 'browser')
fs.chmodSync(path.dirname(fake), 0o755)
fs.writeFileSync(fake, '#!/bin/sh\n( n=0; while [ $n -lt 40000000 ]; do n=$((n+1)); done ) &\nexit 0\n', { mode: 0o755 })
await renderHtmlPdf({ browser: fake, html: Buffer.from('<p>x</p>'), page: 's/a.html', workBase: base, asset: () => null, limits: { timeoutMs: 4000 } }).catch(() => {})
await Bun.sleep(300)
const orphans = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(fake) } catch { return false } })
check(orphans.length === 0, 'the fake browser\'s child was killed')
check(fs.readdirSync(pc.dir).filter((d) => d.startsWith('p-')).length === 0, 'no leaf left after the fake browser')

console.log(JSON.stringify({ browser, print: { dir: pc.dir, memoryMiB: pc.memoryMiB, parallel: pc.parallel, pidsMax: read(path.join(pc.dir, 'pids.max')) }, runs, where: [...where], problems }, null, 1))
fs.rmSync(base, { recursive: true, force: true })
process.exit(problems.length ? 1 : 0)
