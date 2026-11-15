// The Mac app's last step before publishing (docs/RELEASE-CI.md "Mac app"), after
// `bun run --cwd desktop dist:mac:release` (desktop/electron-builder.devid.config.ts: the app signed with the Developer
// ID Application certificate, hardened runtime, notarized and stapled by electron-builder; a signed dmg and the update
// zip around it, latest-mac.yml naming both):
//
//   APPLE_API_KEY=<AuthKey .p8 file> APPLE_API_KEY_ID=… APPLE_API_ISSUER=… bun scripts/release/mac-app.ts [desktop/release]
//
//   1. the app: codesign --verify --deep --strict, its Team ID, hardened runtime, Gatekeeper (spctl -a -vv) and the
//      stapled ticket (stapler validate); the app in the update zip the same, and the same code (cdhash) as in the dmg
//   2. the dmg: notarized by Apple itself (notarytool submit --wait with the API key), the ticket stapled to it, then
//      stapler validate and Gatekeeper as a download (spctl -a -t install, and -t open with the primary signature)
//   3. latest-mac.yml: stapling changes the dmg's bytes, so its entry's sha512 and size are written again (the update
//      zip's entry and `path`, which the Mac updater uses, are checked to be that zip and stay as they are)
// Nothing is printed of the key. Exits non-zero on the first check that fails.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PRODUCT } from '../../shared/src/product'
import { checkLatestMacYml } from '../../server/src/office/update'

export const TEAM_ID = 'YWW96288YY'

const hash = (f: string, algo: 'sha256' | 'sha512', enc: 'hex' | 'base64') => crypto.createHash(algo).update(fs.readFileSync(f)).digest(enc)

function run(argv: string[], o: { quiet?: boolean } = {}): string {
  if (!o.quiet) console.log(`$ ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
  const p = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
  const out = `${p.stdout.toString()}${p.stderr.toString()}`
  if (!o.quiet) process.stdout.write(out)
  if (p.exitCode !== 0) throw new Error(`${path.basename(argv[0]!)} ${argv[1] ?? ''} failed (${p.exitCode})${o.quiet ? `: ${out.trim().slice(0, 2000)}` : ''}`)
  return out
}

/** The checks every copy of the app must pass (the one in the dmg and the one in the update zip). */
export function checkApp(app: string): { cdhash: string } {
  run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', app])
  const info = run(['/usr/bin/codesign', '-dvvv', app], { quiet: true })
  if (!new RegExp(`^TeamIdentifier=${TEAM_ID}$`, 'm').test(info)) throw new Error(`${app} is not signed by team ${TEAM_ID}`)
  if (!/^Authority=Developer ID Application: /m.test(info)) throw new Error(`${app} is not signed with a Developer ID Application certificate`)
  if (!/flags=0x10000\(runtime\)/.test(info)) throw new Error(`${app} has no hardened runtime`)
  const cdhash = /^CDHash=([0-9a-f]{40})$/m.exec(info)?.[1]
  if (!cdhash) throw new Error(`${app}: no CDHash`)
  const ent = run(['/usr/bin/codesign', '-d', '--entitlements', ':-', app], { quiet: true })
  if (/com\.apple\.security\.app-sandbox/.test(ent)) throw new Error(`${app} is sandboxed: that is the Mac App Store build`)
  run(['/usr/sbin/spctl', '-a', '-vv', app])
  run(['/usr/bin/xcrun', 'stapler', 'validate', app])
  return { cdhash }
}

function notaryAuth(): string[] {
  const key = process.env.APPLE_API_KEY, id = process.env.APPLE_API_KEY_ID, issuer = process.env.APPLE_API_ISSUER
  if (!key || !id || !issuer) throw new Error('APPLE_API_KEY (the .p8 file), APPLE_API_KEY_ID and APPLE_API_ISSUER are needed')
  if (!fs.existsSync(key)) throw new Error('APPLE_API_KEY must name the .p8 file')
  return ['--key', key, '--key-id', id, '--issuer', issuer]
}

/** latest-mac.yml with the dmg entry's sha512 and size set to the file's (the stapled dmg) */
export function rewriteDmgEntry(text: string, dmg: string, sha512: string, size: number): string {
  const lines = text.split('\n')
  let inDmg = false, done = 0
  for (let i = 0; i < lines.length; i++) {
    const url = /^\s*-\s*url:\s*'?([^'\n]*?)'?\s*$/.exec(lines[i]!)
    if (url) { inDmg = url[1] === dmg; continue }
    if (!/^\s/.test(lines[i]!)) inDmg = false
    if (!inDmg) continue
    if (/^\s*sha512:/.test(lines[i]!)) { lines[i] = lines[i]!.replace(/sha512:.*$/, `sha512: ${sha512}`); done++ }
    else if (/^\s*size:/.test(lines[i]!)) { lines[i] = lines[i]!.replace(/size:.*$/, `size: ${size}`); done++ }
  }
  if (done !== 2) throw new Error(`latest-mac.yml has no entry for ${dmg} with a sha512 and a size`)
  return lines.join('\n')
}

async function main() {
  const dir = path.resolve(process.argv[2] ?? 'desktop/release')
  const yml = path.join(dir, 'latest-mac.yml')
  const version = /^version:\s*'?([^'\n]+?)'?\s*$/m.exec(fs.readFileSync(yml, 'utf8'))?.[1]
  if (!version) throw new Error(`${yml}: no version`)
  const base = `${PRODUCT.artifactBase}-${version}-mac-universal`
  const dmg = path.join(dir, `${base}.dmg`), zip = path.join(dir, `${base}.zip`)
  for (const f of [dmg, zip]) if (!fs.existsSync(f)) throw new Error(`${f} not found`)
  const app = path.join(dir, 'mac-universal', `${PRODUCT.displayName}.app`)

  console.log(`== the app (${path.relative(process.cwd(), app)})`)
  const built = checkApp(app)

  console.log('== the app in the update zip')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-app-'))
  try {
    run(['/usr/bin/ditto', '-x', '-k', zip, tmp], { quiet: true })
    const inZip = checkApp(path.join(tmp, `${PRODUCT.displayName}.app`))
    if (inZip.cdhash !== built.cdhash) throw new Error('the update zip holds other code than the app that was checked')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }

  console.log('== the dmg: notarize, staple, Gatekeeper')
  run(['/usr/bin/codesign', '--verify', '--verbose=2', dmg])
  const out = run(['/usr/bin/xcrun', 'notarytool', 'submit', dmg, ...notaryAuth(), '--wait', '--timeout', '45m', '--output-format', 'json'], { quiet: true })
  const res = JSON.parse(out.slice(out.indexOf('{'))) as { id?: string; status?: string }
  console.log(`notarytool: ${res.status} (submission ${res.id})`)
  if (res.status !== 'Accepted') {
    if (res.id) run(['/usr/bin/xcrun', 'notarytool', 'log', res.id, ...notaryAuth()])
    throw new Error(`Apple did not accept the dmg: ${res.status}`)
  }
  run(['/usr/bin/xcrun', 'stapler', 'staple', dmg])
  run(['/usr/bin/xcrun', 'stapler', 'validate', dmg])
  run(['/usr/sbin/spctl', '-a', '-vvv', '-t', 'install', dmg])
  run(['/usr/sbin/spctl', '-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', dmg])

  console.log('== latest-mac.yml')
  const dmg512 = hash(dmg, 'sha512', 'base64'), size = fs.statSync(dmg).size
  const text = rewriteDmgEntry(fs.readFileSync(yml, 'utf8'), path.basename(dmg), dmg512, size)
  checkLatestMacYml(text, version, { file: path.basename(zip), sha512: hash(zip, 'sha512', 'base64'), size: fs.statSync(zip).size }, { file: path.basename(dmg), sha512: dmg512, size })
  fs.writeFileSync(yml, text)
  for (const f of [dmg, zip, yml]) console.log(`${hash(f, 'sha256', 'hex')}  ${path.basename(f)}`)
  console.log(`Mac app ${version}: signed (Developer ID, team ${TEAM_ID}), notarized and stapled`)
}

if (import.meta.main) {
  main().catch((e) => { console.error(`mac-app: ${(e as Error).message}`); process.exit(1) })
}
