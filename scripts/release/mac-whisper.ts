// whisper-cli for the office zip's Apple silicon Macs (docs/decisions/20261116-mac-local-speech.md, docs/RELEASE-CI.md
// "whisper-cli for the office Mac"): after scripts/macos/build-whisper.sh, in .github/workflows/mac-whisper.yml.
//
//   bun scripts/release/mac-whisper.ts sign <whisper-cli>        Developer ID Application (the Mac app's identity, the
//                                                                keychain in CSC_KEYCHAIN), hardened runtime, timestamp
//   APPLE_API_KEY=… APPLE_API_KEY_ID=… APPLE_API_ISSUER=… bun scripts/release/mac-whisper.ts notarize <whisper-cli>
//                                                                Apple's notary service (a bare program takes no stapled
//                                                                ticket: Gatekeeper looks the ticket up online)
//   bun scripts/release/mac-whisper.ts check <whisper-cli>       what build-office.ts checks before it copies it in
//   bun scripts/release/mac-whisper.ts smoke <whisper-cli> [model] a spoken English sentence (`say`, then afconvert)
//                                                                comes back as text
// Nothing of the keys is printed.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TEAM_ID } from './mac-app'

/** the code signing identifier of the program (its signature names it; Gatekeeper and the checks below read it) */
export const WHISPER_IDENTIFIER = 'app.trina.ax.whisper-cli'
export const DEVELOPER_ID = `Developer ID Application: Trina Inc. (${TEAM_ID})`

function run(argv: string[], o: { quiet?: boolean } = {}): string {
  if (!o.quiet) console.log(`$ ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
  const p = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
  const out = `${p.stdout.toString()}${p.stderr.toString()}`
  if (!o.quiet) process.stdout.write(out)
  if (p.exitCode !== 0) throw new Error(`${path.basename(argv[0]!)} ${argv[1] ?? ''} failed (${p.exitCode})${o.quiet ? `: ${out.trim().slice(0, 2000)}` : ''}`)
  return out
}

/** What `codesign -dvvv` says about a whisper-cli the office zip may carry, or why it may not (null = fine). Exported
 * for tests (the text only; checkWhisper runs codesign). */
export function whisperSignatureProblem(info: string, archs: string): string | null {
  if (archs.trim() !== 'arm64') return `it is built for "${archs.trim()}", not Apple silicon (arm64) alone`
  if (!new RegExp(`^Identifier=${WHISPER_IDENTIFIER.replace(/\./g, '\\.')}$`, 'm').test(info)) return `its signing identifier is not ${WHISPER_IDENTIFIER}`
  if (!new RegExp(`^TeamIdentifier=${TEAM_ID}$`, 'm').test(info)) return `it is not signed by team ${TEAM_ID}`
  if (!/^Authority=Developer ID Application: /m.test(info)) return 'it is not signed with a Developer ID Application certificate'
  if (!/flags=0x10000\(runtime\)/.test(info)) return 'it has no hardened runtime'
  if (!/^Timestamp=/m.test(info)) return 'its signature has no secure timestamp'
  return null
}

/** The checks before the office zip takes `file` (scripts/build-office.ts --whisper): Apple silicon only, a valid
 * Developer ID signature of this product's team with the hardened runtime, only system libraries. Returns its sha256. */
export function checkWhisper(file: string): string {
  if (!fs.statSync(file).isFile()) throw new Error(`${file} is not a file`)
  // the chain ends at Apple's root and the leaf is this team's (a self-made certificate with the same name fails here)
  run(['/usr/bin/codesign', '--verify', '--strict', '--verbose=2', `-R=anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}" and identifier "${WHISPER_IDENTIFIER}"`, file], { quiet: true })
  const problem = whisperSignatureProblem(run(['/usr/bin/codesign', '-dvvv', file], { quiet: true }), run(['/usr/bin/lipo', '-archs', file], { quiet: true }))
  if (problem) throw new Error(`${file}: ${problem}`)
  const libs = run(['/usr/bin/otool', '-L', file], { quiet: true }).split('\n').slice(1).map((l) => l.trim().split(' ')[0]!).filter(Boolean)
  const odd = libs.filter((l) => !l.startsWith('/usr/lib/') && !l.startsWith('/System/Library/'))
  if (odd.length) throw new Error(`${file} links libraries outside the system: ${odd.join(', ')}`)
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function sign(file: string) {
  const kc = process.env.CSC_KEYCHAIN
  run(['/usr/bin/codesign', '--force', '--options', 'runtime', '--timestamp', '-i', WHISPER_IDENTIFIER, ...(kc ? ['--keychain', kc] : []), '--sign', DEVELOPER_ID, file])
}

function notarize(file: string) {
  const key = process.env.APPLE_API_KEY, id = process.env.APPLE_API_KEY_ID, issuer = process.env.APPLE_API_ISSUER
  if (!key || !id || !issuer || !fs.existsSync(key)) throw new Error('APPLE_API_KEY (the .p8 file), APPLE_API_KEY_ID and APPLE_API_ISSUER are needed')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-notary-'))
  try {
    const zip = path.join(dir, 'whisper-cli.zip')
    run(['/usr/bin/ditto', '-c', '-k', '--keepParent', file, zip])
    const out = run(['/usr/bin/xcrun', 'notarytool', 'submit', zip, '--key', key, '--key-id', id, '--issuer', issuer, '--wait', '--timeout', '60m'])
    if (!/^\s*status: Accepted\s*$/m.test(out)) throw new Error('notarization was not accepted (see the notarytool output above)')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

/** `say` -> afconvert -> whisper-cli: the program reads 16 kHz WAV and writes text (CPU or Metal, whatever the runner has) */
async function smoke(file: string, model?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-smoke-'))
  try {
    let m = model
    if (!m) {
      // the tiny model with its pinned size and sha256 (server/src/jobs/transcribe.ts WHISPER_MODELS)
      const { WHISPER_MODELS, MODEL_BASE_URL } = await import('../../server/src/jobs/transcribe')
      const spec = WHISPER_MODELS.tiny
      const res = await fetch(MODEL_BASE_URL + spec.file)
      if (!res.ok) throw new Error(`tiny model: HTTP ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.length !== spec.size || crypto.createHash('sha256').update(bytes).digest('hex') !== spec.sha256) throw new Error('tiny model: wrong size or sha256')
      m = path.join(dir, spec.file)
      fs.writeFileSync(m, bytes)
    }
    run(['/usr/bin/say', '-o', path.join(dir, 'a.aiff'), 'Saturday delivery is fine, and twenty boxes of paper are confirmed.'])
    run(['/usr/bin/afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path.join(dir, 'a.aiff'), path.join(dir, 'a.wav')])
    const out = run([file, '-m', m, '-f', path.join(dir, 'a.wav'), '-l', 'en', '-np', '-nt'], { quiet: true })
    console.log(out.trim())
    if (!/saturday/i.test(out)) throw new Error('whisper-cli did not hear "Saturday"')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const [cmd, file, extra] = process.argv.slice(2)
  if (!cmd || !file) { console.error('usage: mac-whisper.ts sign|notarize|check|smoke <whisper-cli> [model]'); process.exit(2) }
  if (cmd === 'sign') sign(file)
  else if (cmd === 'notarize') notarize(file)
  else if (cmd === 'check') console.log(`ok ${file} sha256 ${checkWhisper(file)}`)
  else if (cmd === 'smoke') await smoke(file, extra)
  else { console.error(`unknown command ${cmd}`); process.exit(2) }
}
