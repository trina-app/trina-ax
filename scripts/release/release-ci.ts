// The release workflow's own steps (.github/workflows/release.yml, docs/RELEASE-CI.md): the workflow only calls these,
// the rules are here and tested (tests/unit/release-ci.test.ts).
//
//   bun scripts/release/release-ci.ts tag <tag>
//       the release of a tag: v<version> where <version> is server/package.json's; a tag with "-" (v0.3.0-beta.1) is
//       the beta channel, otherwise stable. Prints version=, channel=, prerelease= lines (for $GITHUB_OUTPUT).
//   bun scripts/release/release-ci.ts check-key <pem file>
//       the key's public part must be one of RELEASE_CHANNEL.keys (shared/src/release-channel.ts); prints its key id
//   bun scripts/release/release-ci.ts sign-linux <dir> <amd64|arm64> <pem file>
//       sign an unsigned Linux build (the --out folder of `build-bundle.ts --os linux`): manifest.sig, check the version
//       folder like an installed server does, then pack <version>-linux-<arch>.tar.zst and the install kit
//   bun scripts/release/release-ci.ts sums <out dir> <pem file> <file>...
//       <out dir>/SHA256SUMS of the files (by name) and SHA256SUMS.sig (the detached signature format of sign.ts)
//   bun scripts/release/release-ci.ts verify-sums <SHA256SUMS>
//       check SHA256SUMS.sig next to it with this build's release keys, then every listed file that is next to it
//
// The private key is never printed; errors name the key only by its key id.
import fs from 'node:fs'
import path from 'node:path'
import { checkSigningKey, hashFile, readKeyFile, signDetached, verifyDetached } from './sign'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'

const REPO = path.resolve(import.meta.dir, '..', '..')

/** A release version: 1.2.3 or 1.2.3-beta.1 (the office feed's VERSION_RE, server/src/office/release.ts: it is a folder
 * and file name part on the feed, so nothing else). */
export const RELEASE_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+){0,3})?$/

export type Channel = 'stable' | 'beta'
export interface TagRelease { tag: string; version: string; channel: Channel; prerelease: boolean }

/** What a tag releases; throws unless it is exactly v<packageVersion>. */
export function parseReleaseTag(rawTag: string, packageVersion: string): TagRelease {
  const tag = rawTag.trim().replace(/^refs\/tags\//, '')
  if (!tag.startsWith('v')) throw new Error(`tag ${JSON.stringify(tag)}: a release tag is v<version>, like v0.3.0 or v0.3.0-beta.1`)
  const version = tag.slice(1)
  if (!RELEASE_VERSION_RE.test(version)) throw new Error(`tag ${tag}: ${version} is not a version like 0.3.0 or 0.3.0-beta.1`)
  if (version !== packageVersion) throw new Error(`tag ${tag} is not the version in server/package.json (${packageVersion}): bump it in a commit, then tag that commit v${packageVersion}`)
  const beta = version.includes('-')
  return { tag, version, channel: beta ? 'beta' : 'stable', prerelease: beta }
}

export function packageVersion(root = REPO): string {
  return (JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8')) as { version: string }).version
}

/** SHA256SUMS text ("<sha256>  <name>" per file, sorted by name, like sha256sum writes) */
export function sha256sums(files: string[]): string {
  const names = files.map((f) => path.basename(f))
  if (new Set(names).size !== names.length) throw new Error('two release files have the same name')
  return files
    .map((f) => ({ name: path.basename(f), sum: hashFile(f) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((x) => `${x.sum}  ${x.name}\n`)
    .join('')
}

export function writeSums(outDir: string, pem: string, files: string[], keys: readonly string[] = RELEASE_CHANNEL.keys): { sums: string; sig: string } {
  checkSigningKey(pem, keys)
  const text = sha256sums(files)
  fs.mkdirSync(outDir, { recursive: true })
  const sums = path.join(outDir, 'SHA256SUMS'), sig = sums + '.sig'
  fs.writeFileSync(sums, text)
  fs.writeFileSync(sig, signDetached(Buffer.from(text), pem))
  return { sums, sig }
}

/** Check SHA256SUMS(.sig) and the files listed in it that are next to it; returns the names checked. */
export function verifySums(sumsFile: string, keys: readonly string[] = RELEASE_CHANNEL.keys): string[] {
  const text = fs.readFileSync(sumsFile)
  const sig = fs.readFileSync(sumsFile + '.sig', 'utf8')
  if (!verifyDetached(text, sig, keys)) throw new Error(`${path.basename(sumsFile)}.sig does not verify with this product's release keys`)
  const dir = path.dirname(sumsFile)
  const checked: string[] = []
  for (const line of text.toString('utf8').split('\n').filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._+-]{0,150})$/.exec(line)
    if (!m) throw new Error(`SHA256SUMS: unreadable line ${JSON.stringify(line.slice(0, 80))}`)
    const f = path.join(dir, m[2]!)
    if (!fs.existsSync(f)) continue
    if (hashFile(f) !== m[1]) throw new Error(`${m[2]} does not match SHA256SUMS`)
    checked.push(m[2]!)
  }
  if (!checked.length) throw new Error('none of the files in SHA256SUMS is next to it')
  return checked
}

/**
 * Sign an unsigned Linux build (the --out folder of build-bundle.ts --os linux: app/<version>/, install-linux.sh,
 * VERSION, product.env) and pack what is published: <version>-linux-<arch>.tar.zst and the install kit.
 */
export async function signLinuxBuild(o: { dir: string; arch: string; pem: string; keys?: readonly string[] }) {
  const keys = o.keys ?? RELEASE_CHANNEL.keys
  if (o.arch !== 'amd64' && o.arch !== 'arm64') throw new Error(`arch must be amd64 or arm64, not ${o.arch}`)
  const arch = o.arch
  const keyId = checkSigningKey(o.pem, keys)
  const version = fs.readFileSync(path.join(o.dir, 'VERSION'), 'utf8').trim()
  if (!RELEASE_VERSION_RE.test(version)) throw new Error(`${o.dir}/VERSION: ${JSON.stringify(version)} is not a release version`)
  const app = path.join(o.dir, 'app', version)
  if (!fs.existsSync(path.join(app, 'manifest.json'))) throw new Error(`${app}/manifest.json missing: not a build-bundle.ts --os linux folder`)
  const { elfArch, packLinuxKit } = await import('../build-bundle')
  const ctl = path.join(app, 'root', 'mycel-ctl')
  if (!fs.existsSync(ctl) || elfArch(ctl) !== arch) throw new Error(`${ctl} is not a linux-${arch} program: this is not the ${arch} build`)
  const { packBundle, signManifest } = await import('../../server/src/system/bundle')
  const { verifyBundleDir } = await import('../../server/src/system/update')
  await signManifest(app, o.pem)
  // what an installed server checks before it runs a version: signed with a key this build trusts, every file as listed
  await verifyBundleDir(app, { keys, allowUnsigned: false })
  for (const f of fs.readdirSync(o.dir)) if (/\.(tar\.zst|tar\.gz)$/.test(f)) fs.rmSync(path.join(o.dir, f)) // unsigned packs, if any
  const archive = path.join(o.dir, `${version}-linux-${arch}.tar.zst`)
  const packed = await packBundle(app, archive)
  const kit = await packLinuxKit(o.dir, version, arch)
  return { version, arch, keyId, archive, archiveSize: packed.size, archiveSha256: packed.sha256, kit: kit.file, kitSize: kit.size, kitSha256: kit.sha256 }
}

export async function main(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s)): Promise<void> {
  const [cmd, ...a] = argv
  if (cmd === 'tag' && a.length === 1) {
    const r = parseReleaseTag(a[0]!, packageVersion())
    out(`tag=${r.tag}\nversion=${r.version}\nchannel=${r.channel}\nprerelease=${r.prerelease}\n`)
  } else if (cmd === 'check-key' && a.length === 1) {
    out(`release key ${checkSigningKey(readKeyFile(a[0]!))}: one of this product's release keys\n`)
  } else if (cmd === 'sign-linux' && a.length === 3) {
    const r = await signLinuxBuild({ dir: path.resolve(a[0]!), arch: a[1]!, pem: readKeyFile(a[2]!) })
    out(JSON.stringify(r, null, 1) + '\n')
  } else if (cmd === 'sums' && a.length >= 3) {
    const r = writeSums(path.resolve(a[0]!), readKeyFile(a[1]!), a.slice(2).map((f) => path.resolve(f)))
    out(fs.readFileSync(r.sums, 'utf8'))
  } else if (cmd === 'verify-sums' && a.length === 1) {
    for (const n of verifySums(path.resolve(a[0]!))) out(`${n}: OK\n`)
  } else {
    throw new Error('usage: release-ci.ts tag <tag> | check-key <pem> | sign-linux <dir> <arch> <pem> | sums <out> <pem> <file>... | verify-sums <SHA256SUMS>')
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`release-ci: ${(e as Error).message}\n`); process.exit(1) })
}
