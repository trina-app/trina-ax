// Regenerate the Rust part of the HWP Preview plugin notices (resources/hwp/notices/rust-crates.txt and
// rust-crates.json): every crate linked into the pinned rhwp CLI (resources/hwp/manifest.json) on the four plugin
// targets, with the licence we follow for it and that licence's text from the crate itself. A developer step on a pin
// update (resources/hwp/README.md "Notices"); it needs a Rust toolchain and the rhwp source at the pinned commit:
//
//   bun scripts/plugins/hwp-notices.ts --rhwp <rhwp checkout> [--cargo <cargo>] [--check]
//
// Upstream built the pinned executables with `cargo build --locked --release --bin rhwp --features native-skia
// --target <t>` (notices/SOURCE-OFFER.txt). The linked set is `cargo tree -e normal,no-proc-macro` for that feature
// set and target: build scripts, proc-macros, dev-only and wasm-only crates are not in the executable. The C/C++ code
// inside skia-bindings (Skia and its third-party libraries) is covered separately by notices/native-libraries.txt.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pins from '../../resources/hwp/manifest.json'

const REPO = path.resolve(import.meta.dir, '../..')
const OUT = path.join(REPO, 'resources/hwp/notices')
const FEATURES = 'native-skia'
const TARGETS: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu', 'linux-x64': 'x86_64-unknown-linux-gnu',
}
/** Licence we follow when a crate offers a choice, most preferred first. Every crate must resolve to one of these. */
const PREFERENCE = ['MIT', 'MIT-0', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'Zlib', 'BSL-1.0', 'Unicode-3.0', 'CC0-1.0', '0BSD', 'Unlicense']
/** Which licence file of a crate carries which licence (when the crate ships more than one). */
const FILE_FOR: Record<string, RegExp> = {
  'MIT': /mit(?!-?0)/i, 'MIT-0': /mit-?0/i, 'Apache-2.0': /apache|_a2$/i, 'Zlib': /zlib/i, 'BSL-1.0': /boost|bsl/i,
  'Unicode-3.0': /unicode/i, 'CC0-1.0': /cc0/i, '0BSD': /0bsd/i, 'Unlicense': /unlicense/i,
}
/** Crates published without a licence file: the text from their project repository at the same licence. */
const FALLBACK: Record<string, { file: string; text: string }> = {
  'skia-safe': { file: 'LICENSE (rust-skia repository)', text: mit('Copyright (c) 2019 LongYinan & Armin Sander\nCopyright (c) 2019 rust-skia Contributors') },
  'skia-bindings': { file: 'LICENSE (rust-skia repository)', text: mit('Copyright (c) 2019 LongYinan & Armin Sander\nCopyright (c) 2019 rust-skia Contributors') },
  'zune-core': { file: 'LICENSE-MIT (zune-image repository)', text: mit('Copyright (c) zune-image developers') },
  'zune-jpeg': { file: 'LICENSE-MIT (zune-image repository)', text: mit('Copyright (c) zune-image developers') },
}
function mit(copyright: string) {
  return `MIT License\n\n${copyright}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`
}

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const fail = (msg: string): never => { console.error(msg); process.exit(1) }
const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex')

function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) fail(`${cmd.join(' ')} failed:\n${r.stderr.toString()}`)
  return r.stdout.toString()
}

/** "A OR B", "A/B", "(A OR B) AND C" → the conjuncts, each a list of alternatives. */
export function conjuncts(expr: string): string[][] {
  const parts: string[] = []
  let depth = 0, cur = ''
  const s = expr.replace(/\s*\/\s*/g, ' OR ')
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    if (s[i] === ')') depth--
    if (depth === 0 && s.startsWith(' AND ', i)) { parts.push(cur); cur = ''; i += 4; continue }
    cur += s[i]
  }
  parts.push(cur)
  return parts.map((p) => p.trim().replace(/^\((.*)\)$/, '$1').split(/\s+OR\s+/).map((x) => x.trim()))
}

/** The licences we follow for a declared expression: the most preferred alternative of each conjunct. */
export function elect(expr: string): string[] {
  return conjuncts(expr).map((alts) => PREFERENCE.find((p) => alts.includes(p)) ?? fail(`no accepted licence in '${expr}'`))
}

type Crate = { name: string; version: string; declared: string; elected: string[]; targets: string[]; texts: { file: string; text: string }[] }

if (import.meta.main) {
  const rhwp = path.resolve(arg('--rhwp') ?? fail('usage: bun scripts/plugins/hwp-notices.ts --rhwp <rhwp checkout> [--cargo <cargo>] [--check]'))
  const cargo = arg('--cargo') ?? 'cargo'
  const commit = pins.source.split('/').pop()!
  if (run(['git', 'rev-parse', 'HEAD'], rhwp).trim() !== commit) fail(`rhwp checkout is not at the pinned commit ${commit}`)
  if (!new RegExp(`^version = "${pins.version.replace(/\./g, '\\.')}"$`, 'm').test(fs.readFileSync(path.join(rhwp, 'Cargo.toml'), 'utf8'))) fail(`rhwp Cargo.toml is not version ${pins.version}`)
  const lockSha = sha256(fs.readFileSync(path.join(rhwp, 'Cargo.lock')))

  const meta = JSON.parse(run([cargo, 'metadata', '--locked', '--format-version', '1', '--features', FEATURES], rhwp)) as { packages: { name: string; version: string; license: string | null; manifest_path: string; source: string | null }[] }
  const pkgs = new Map(meta.packages.map((p) => [`${p.name} ${p.version}`, p]))
  const on = new Map<string, Set<string>>()
  for (const [target, triple] of Object.entries(TARGETS)) {
    const tree = run([cargo, 'tree', '--locked', '-p', 'rhwp', '-e', 'normal,no-proc-macro', '--features', FEATURES, '--target', triple, '--prefix', 'none', '--format', '{p}'], rhwp)
    for (const line of tree.split('\n')) {
      const m = /^(\S+) v(\S+)/.exec(line)
      if (m) { const k = `${m[1]} ${m[2]}`; if (!on.has(k)) on.set(k, new Set()); on.get(k)!.add(target) }
    }
  }

  const rootLicense = fs.readFileSync(path.join(rhwp, 'LICENSE'), 'utf8')
  const crates: Crate[] = [...on.keys()].sort().map((k) => {
    const p = pkgs.get(k) ?? fail(`${k} is not in cargo metadata`)
    const declared = p.license ?? fail(`${k} declares no licence`)
    const elected = [...new Set(elect(declared))]
    const dir = path.dirname(p.manifest_path)
    const files = fs.readdirSync(dir).filter((f) => /^(licen[cs]e|copying|unlicense)/i.test(f)).sort()
    const extra = fs.readdirSync(dir).filter((f) => /^(notice|copyright)/i.test(f)).sort()
    const read = (f: string) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') })
    let texts: { file: string; text: string }[]
    if (!files.length) {
      if (!p.source && path.resolve(dir).startsWith(rhwp)) texts = [{ file: 'LICENSE (rhwp repository root)', text: rootLicense }]
      else texts = [FALLBACK[p.name] ?? fail(`${k} ships no licence file and has no fallback`)]
    } else if (files.length === 1) {
      // a single file must not name a licence other than the one we follow (e.g. only LICENSE-APACHE for "MIT OR ...")
      const named = Object.entries(FILE_FOR).find(([, re]) => re.test(files[0]))?.[0]
      if (named && !elected.includes(named)) fail(`${k}: ships only ${files[0]} but is used under ${elected.join(' AND ')}`)
      texts = [read(files[0])]
    } else {
      texts = elected.map((id) => {
        const re = FILE_FOR[id]
        const hit = re ? files.filter((f) => re.test(f)) : files.filter((f) => !/mit|apache|_a2|zlib|boost|unicode|cc0|0bsd/i.test(f))
        if (hit.length !== 1) fail(`${k}: cannot tell which of ${files.join(', ')} carries ${id}`)
        return read(hit[0])
      })
    }
    return { name: p.name, version: p.version, declared, elected, targets: [...on.get(k)!].sort(), texts: [...texts, ...extra.map(read)] }
  })

  const all = Object.keys(TARGETS).sort()
  const electedUnion = PREFERENCE.filter((id) => crates.some((c) => c.elected.includes(id)))
  const groups = new Map<string, { text: string; owners: string[] }>()
  for (const c of crates) for (const t of c.texts) {
    const key = sha256(t.text.replace(/\s+/g, ' ').trim())
    if (!groups.has(key)) groups.set(key, { text: t.text.replace(/\s+$/, ''), owners: [] })
    groups.get(key)!.owners.push(`${c.name} ${c.version} (${t.file})`)
  }

  const head = [
    `Rust crates linked into the rhwp ${pins.version} command-line program shipped in the HWP Preview plugin`,
    '',
    `Source: ${pins.source}`,
    `Cargo.lock SHA-256: ${lockSha}`,
    `Build: cargo build --locked --release --bin rhwp --features ${FEATURES} --target <target>`,
    `Targets: ${all.map((t) => `${t} (${TARGETS[t]})`).join(', ')}`,
    `Generated by scripts/plugins/hwp-notices.ts from cargo tree -e normal,no-proc-macro. Crates only used at build time`,
    `(build scripts, procedural macros), in tests or in the WebAssembly build are not part of the program and are not listed.`,
    '',
    'Where a crate offers a choice of licences, it is used here under the licence named in "used under"; the text of',
    'that licence, as shipped by the crate, follows. NOTICE and COPYRIGHT files of a crate are reproduced in full.',
    '',
    `${crates.length} crates. Licences used: ${electedUnion.join(', ')}.`,
    '',
    'crate | version | declared licence | used under | targets',
    '----- | ------- | ---------------- | ---------- | -------',
    ...crates.map((c) => `${c.name} | ${c.version} | ${c.declared} | ${c.elected.join(' AND ')} | ${c.targets.length === all.length ? 'all' : c.targets.join(', ')}`),
    '',
  ]
  const body = [...groups.values()].flatMap((g) => ['', '='.repeat(80), ...g.owners.map((o) => `Applies to: ${o}`), '='.repeat(80), '', g.text, ''])
  const txt = [...head, ...body].join('\n')
  const json = JSON.stringify({
    rhwp: pins.version, source: pins.source, cargoLockSha256: lockSha, features: [FEATURES], targets: TARGETS, licenses: electedUnion,
    crates: crates.map((c) => ({ name: c.name, version: c.version, declared: c.declared, usedUnder: c.elected, targets: c.targets.length === all.length ? 'all' : c.targets })),
  }, null, 1) + '\n'

  if (process.argv.includes('--check')) {
    const same = fs.readFileSync(path.join(OUT, 'rust-crates.txt'), 'utf8') === txt && fs.readFileSync(path.join(OUT, 'rust-crates.json'), 'utf8') === json
    if (!same) fail('resources/hwp/notices/rust-crates.* are out of date: run without --check')
    console.log('rust-crates notices are up to date')
  } else {
    fs.writeFileSync(path.join(OUT, 'rust-crates.txt'), txt)
    fs.writeFileSync(path.join(OUT, 'rust-crates.json'), json)
    console.log(`${crates.length} crates, ${groups.size} licence texts; licences used: ${electedUnion.join(', ')}`)
  }
}
