// Writes a Python program's pinned wheels into scripts/system/packages.json ("python": its version, the Python it needs
// and every wheel's sha256), from the project's own uv.lock. packages.sh installs them with pip --require-hashes
// --only-binary :all: --no-deps into a venv of their own (pk_python_install). Only the wheels a Linux server can use:
// CPython 3.11 to 3.13 (Debian 12, Ubuntu 24.04, Debian 13), amd64 and arm64, glibc (manylinux) or pure Python.
//
// A new version (workspace-mcp as the example; docs/GOOGLE-APPS-RUNTIME.md "A new version"):
//   1. the tag's commit: gh api repos/taylorwilsdon/google_workspace_mcp/tags
//   2. its lock:  gh api "repos/taylorwilsdon/google_workspace_mcp/contents/uv.lock?ref=<commit>" -H "Accept: application/vnd.github.raw" > uv.lock
//   3. the wheel's sha256 and the requirements: curl -s https://pypi.org/pypi/workspace-mcp/<version>/json > pypi.json
//   4. bun scripts/system/python-lock.ts workspace-mcp <version> uv.lock pypi.json
//   5. bun test tests/unit/system-packages.test.ts; a changed list is a root update (docs/RELEASE-CI.md)
import fs from 'node:fs'
import { LIST_FILE } from './packages'

/** the Pythons and machines of the list's systems: [python, glibc] per distribution release */
export const PY_TARGETS = [['3.11.2', 36], ['3.12.3', 39], ['3.13.5', 41]] as const
export const PY_MACHINES = ['x86_64', 'aarch64'] as const

type Env = { python_full_version: string; python_version: string; sys_platform: string; platform_system: string; platform_machine: string; platform_python_implementation: string; implementation_name: string; os_name: string; extra: string }
const envOf = (py: string, machine: string): Env => ({
  python_full_version: py, python_version: py.split('.').slice(0, 2).join('.'), sys_platform: 'linux', platform_system: 'Linux',
  platform_machine: machine, platform_python_implementation: 'CPython', implementation_name: 'cpython', os_name: 'posix', extra: '',
})

const norm = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-')

/** PEP 440, enough for comparing pins and floors: release numbers, then pre (a, b, rc) < final < post */
export function cmpVersion(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?(?:\.dev(\d+))?$/.exec(v.trim())
    if (!m) throw new Error(`not a version: ${v}`)
    const rel = m[1]!.split('.').map(Number)
    const pre = m[2] ? ({ a: -3, b: -2, rc: -1 } as Record<string, number>)[m[2]]! * 1e6 + Number(m[3]) : 0
    return { rel, pre, post: m[4] ? Number(m[4]) + 1 : 0, dev: m[5] ? -1e9 + Number(m[5]) : 0 }
  }
  const x = parse(a), y = parse(b)
  for (let i = 0; i < Math.max(x.rel.length, y.rel.length); i++) {
    const d = (x.rel[i] ?? 0) - (y.rel[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return Math.sign(x.pre - y.pre) || Math.sign(x.post - y.post) || Math.sign(x.dev - y.dev)
}

/** a PEP 508 marker (the subset uv.lock writes), evaluated for one system */
export function markerTrue(marker: string, env: Env): boolean {
  const toks = marker.match(/'[^']*'|"[^"]*"|===|==|!=|<=|>=|~=|<|>|\(|\)|[A-Za-z_][A-Za-z0-9_.]*/g) ?? []
  let i = 0
  const peek = () => toks[i], next = () => toks[i++]!
  const value = (t: string): { s: string; isVar: boolean } => /^['"]/.test(t) ? { s: t.slice(1, -1), isVar: false } : { s: (env as Record<string, string>)[t] ?? (() => { throw new Error(`unknown marker variable ${t}`) })(), isVar: true }
  const VERSIONS = new Set(['python_full_version', 'python_version'])
  const cmp = (): boolean => {
    if (peek() === '(') { next(); const v = or(); if (next() !== ')') throw new Error(`marker: ${marker}`); return v }
    const lt = next()
    let op = next()
    if (op === 'not' && peek() === 'in') { next(); op = 'not in' }
    const rt = next()
    const l = value(lt), r = value(rt)
    if (op === 'in') return r.s.includes(l.s)
    if (op === 'not in') return !r.s.includes(l.s)
    const isVersion = (lt && VERSIONS.has(lt)) || (rt && VERSIONS.has(rt))
    if (!isVersion) {
      if (op === '==' || op === '===') return l.s === r.s
      if (op === '!=') return l.s !== r.s
      throw new Error(`marker: ${op} on ${lt}`)
    }
    if (r.s.endsWith('.*') && (op === '==' || op === '!=')) {
      const hit = `${l.s}.`.startsWith(r.s.slice(0, -1))
      return op === '==' ? hit : !hit
    }
    const c = cmpVersion(l.s, r.s)
    switch (op) {
      case '==': case '===': return c === 0
      case '!=': return c !== 0
      case '<': return c < 0
      case '<=': return c <= 0
      case '>': return c > 0
      case '>=': return c >= 0
      default: throw new Error(`marker: ${op}`)
    }
  }
  const and = (): boolean => { let v = cmp(); while (peek() === 'and') { next(); const w = cmp(); v = v && w } return v }
  const or = (): boolean => { let v = and(); while (peek() === 'or') { next(); const w = and(); v = v || w } return v }
  const v = or()
  if (i !== toks.length) throw new Error(`marker: ${marker}`)
  return v
}

/** can CPython <py> on Linux <machine> with glibc 2.<glibc> install this wheel? */
export function wheelFits(file: string, py: string, machine: string, glibc: number): boolean {
  const parts = file.replace(/\.whl$/, '').split('-')
  if (parts.length < 5) return false
  const [pys, abis, plats] = parts.slice(-3).map((p) => p.split('.')) as [string[], string[], string[]]
  const minor = Number(py.split('.')[1])
  const platOk = plats.some((p) => {
    if (p === 'any') return true
    const m = /^manylinux(?:_2_(\d+)|2014|2010|1)_(x86_64|aarch64)$/.exec(p)
    if (!m || m[2] !== machine) return false
    const need = m[1] ? Number(m[1]) : p.startsWith('manylinux2014') ? 17 : p.startsWith('manylinux2010') ? 12 : 5
    return need <= glibc
  })
  if (!platOk) return false
  return pys.some((t) => abis.some((a) => {
    if (a === 'none') return t === 'py3' || t === `py3${minor}` || t === `cp3${minor}`
    if (a === 'abi3') { const m = /^cp3(\d+)$/.exec(t); return !!m && Number(m[1]) <= minor }
    return a === `cp3${minor}` && t === `cp3${minor}`
  }))
}

interface LockDep { name: string; version?: string; marker?: string; extra?: string[] }
interface LockPkg { name: string; version: string; source: Record<string, string>; dependencies?: LockDep[]; 'optional-dependencies'?: Record<string, LockDep[]>; wheels?: { url: string; hash: string }[]; sdist?: unknown }

/** name==version -> the sha256 of every wheel a list system can use, for the program's runtime closure */
export function pinnedWheels(lockText: string, program: string): Map<string, string[]> {
  const lock = Bun.TOML.parse(lockText) as { package: LockPkg[] }
  const byName = new Map<string, LockPkg[]>()
  for (const p of lock.package) byName.set(norm(p.name), [...(byName.get(norm(p.name)) ?? []), p])
  const root = byName.get(norm(program))?.[0]
  if (!root) throw new Error(`${program} is not in the lock`)
  const sets: string[] = []
  const out = new Map<string, string[]>()
  for (const [py, glibc] of PY_TARGETS) for (const machine of PY_MACHINES) {
    const env = envOf(py, machine)
    const seen = new Map<string, LockPkg>()
    const visit = (deps: LockDep[] | undefined) => {
      for (const d of deps ?? []) {
        if (d.marker && !markerTrue(d.marker, env)) continue
        const cands = (byName.get(norm(d.name)) ?? []).filter((p) => !d.version || p.version === d.version)
        if (cands.length !== 1) throw new Error(`${d.name}: ${cands.length} packages in the lock for this dependency`)
        const p = cands[0]!
        const fresh = !seen.has(norm(p.name))
        seen.set(norm(p.name), p)
        if (fresh) visit(p.dependencies)
        for (const e of d.extra ?? []) visit(p['optional-dependencies']?.[e])
      }
    }
    visit(root.dependencies)
    sets.push([...seen.keys()].sort().join(' '))
    for (const p of seen.values()) {
      if (!p.source.registry) throw new Error(`${p.name}: not from a registry (${JSON.stringify(p.source)})`)
      const key = `${norm(p.name)}==${p.version}`
      const fits = (p.wheels ?? []).filter((w) => wheelFits(decodeURIComponent(w.url.split('/').pop()!), py, machine, glibc))
      if (!fits.length) throw new Error(`${key}: no wheel for CPython ${py} on Linux ${machine} (glibc 2.${glibc}); --only-binary would fail`)
      const all = new Set(out.get(key) ?? [])
      for (const w of fits) all.add(w.hash.replace(/^sha256:/, ''))
      out.set(key, [...all])
    }
  }
  // one set for every system: no environment markers needed in the requirements
  if (new Set(sets).size !== 1) throw new Error(`the dependencies differ between the list's systems; this script writes no markers:\n${[...new Set(sets)].join('\n')}`)
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)))
}

/** the floors of the release's own requirements (PyPI's requires_dist): each pin must meet them */
export function floorProblems(pins: Map<string, string[]>, requiresDist: string[]): string[] {
  const have = new Map([...pins.keys()].map((k) => [k.split('==')[0]!, k.split('==')[1]!]))
  const p: string[] = []
  for (const r of requiresDist) {
    if (r.includes(';')) continue // extras and markers: not installed
    const m = /^([A-Za-z0-9._-]+)(?:\[[^\]]*\])?\s*>=\s*([0-9][0-9A-Za-z.]*)\s*$/.exec(r)
    if (!m) { p.push(`unread requirement ${r}`); continue }
    const v = have.get(norm(m[1]!))
    if (!v) p.push(`${m[1]} is not in the lock`)
    else if (cmpVersion(v, m[2]!) < 0) p.push(`${m[1]} ${v} is below ${m[2]}`)
  }
  return p
}

if (import.meta.main) {
  const [program, version, lockFile, pypiFile] = process.argv.slice(2)
  if (!program || !version || !lockFile || !pypiFile) { console.error('usage: bun scripts/system/python-lock.ts <program> <version> <uv.lock> <pypi.json>'); process.exit(2) }
  const pypi = JSON.parse(fs.readFileSync(pypiFile, 'utf8')) as { info: { version: string; requires_dist: string[]; requires_python: string }; urls: { filename: string; digests: { sha256: string }; packagetype: string }[] }
  if (pypi.info.version !== version) throw new Error(`pypi.json is ${pypi.info.version}, not ${version}`)
  const wheel = pypi.urls.filter((u) => u.packagetype === 'bdist_wheel' && u.filename.endsWith('-py3-none-any.whl'))
  if (wheel.length !== 1) throw new Error(`${program} ${version}: ${wheel.length} pure-Python wheels on PyPI`)
  const lockText = fs.readFileSync(lockFile, 'utf8')
  const pins = pinnedWheels(lockText, program)
  // the lock names the project itself as an editable source; the PyPI wheel of this version takes its place
  for (const k of [...pins.keys()]) if (k.startsWith(`${norm(program)}==`)) pins.delete(k)
  const problems = floorProblems(pins, pypi.info.requires_dist)
  if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
  const reqs: Record<string, string> = { [`${norm(program)}==${version}`]: wheel[0]!.digests.sha256 }
  for (const [k, h] of pins) reqs[k] = h.sort().join(' ')
  // only this entry's version and requirements change: the rest of the file keeps its layout
  const text = fs.readFileSync(LIST_FILE, 'utf8')
  const at = text.indexOf(`\n  "python": {`), start = text.indexOf(`\n    "${program}": {`, at)
  if (at < 0 || start < 0) throw new Error(`packages.json has no python.${program}: add it (version, for, python, program, requirements {}) first`)
  const end = text.indexOf('\n    }', start)
  const block = text.slice(start, end)
  const reqText = `"requirements": {\n${Object.entries(reqs).map(([k, v]) => `        ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n      }`
  const nb = block.replace(/"version": "[^"]*"/, `"version": ${JSON.stringify(version)}`).replace(/"requirements": \{[\s\S]*?\n?\s*\}(?=\s*$|,)/, reqText)
  const out = text.slice(0, start) + nb + text.slice(end)
  const check = JSON.parse(out) as { python: Record<string, { version: string; requirements: Record<string, string> }> }
  if (check.python[program]!.version !== version || JSON.stringify(check.python[program]!.requirements) !== JSON.stringify(reqs)) throw new Error('packages.json: the entry was not replaced cleanly; edit it by hand')
  fs.writeFileSync(LIST_FILE, out)
  console.log(`packages.json: python.${program} ${version}, ${Object.keys(reqs).length} wheels pinned (${Object.values(reqs).join(' ').split(' ').length} sha256)`)
}
