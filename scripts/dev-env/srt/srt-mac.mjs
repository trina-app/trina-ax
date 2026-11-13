// srt's CLI for a Mac team server (docs/DECISIONS.md "Dev environment on a Mac team server"). The installer puts this
// file next to srt's cli.js as mac.mjs, owned by root. It changes srt's macOS sandbox profile before srt starts the
// command, then runs full.mjs (the Full internet callback), which runs cli.js.
//
// Why: macOS has no network namespace. All runs and the Trina server share one localhost. With allowLocalBinding true,
// srt allows a connection to EVERY localhost port (the server's API, the model proxy, other runs' dev servers). The
// runner writes allowLocalBinding false (config.ts), so srt allows only its own proxy ports, and this file adds the
// run's own port (TRINA_PREVIEW_PORT, one port per slot, from the runner):
//   - bind and accept on that port only (a run cannot take another run's port or a server port first);
//   - connect to that port on localhost only (a command can test its own dev server).
// It also denies kern.proc.all (the list of every process on the Mac; srt allows it, engine.sb denies it).
// SBPL applies the last rule that matches, so the rules go after srt's rules of the same kind.
//
// Fail closed: when srt's profile does not have the expected shape (a new srt version), the run does not start.
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { SandboxManager } from './node_modules/@anthropic-ai/sandbox-runtime/dist/index.js'
import { quote } from './node_modules/@anthropic-ai/sandbox-runtime/dist/utils/shell-quote.js'

/** The line of srt's profile after which the network rules are added. srt 0.0.81 macos-sandbox-utils.js
 * generateSandboxProfile: after its sysctl allows (so the kern.proc.all deny wins), before its file rules. */
export const MARK = '\n; Network\n'
/** srt's rule with allowLocalBinding true: must never be in a profile of a run */
export const OPEN_LOCALHOST = '(allow network-outbound (remote ip "localhost:*"))'
/** Added at the end of the profile, after srt's file rules: the links /etc, /var and /tmp at the top of the disk
 * (to /private/...) can be followed. Only the link itself; what it points to keeps srt's read rules. */
export const END_RULES = '\n; Trina (srt-mac.mjs): follow the links /etc, /var and /tmp\n(allow file-read-metadata (literal "/etc") (literal "/var") (literal "/tmp"))\n'

/** The network rules for one run. port: 1024-65535, or null (a run with no port: no bind, no connect) */
export function extraRules(port) {
  const out = ['; Trina (srt-mac.mjs): the own port of the run only; no list of every process', '(deny sysctl-read (sysctl-name-prefix "kern.proc.all"))']
  if (port !== null) {
    out.push(`(allow network-bind (local ip "*:${port}"))`, `(allow network-inbound (local ip "*:${port}"))`, `(allow network-outbound (remote ip "localhost:${port}"))`)
  }
  return out.join('\n') + '\n'
}

/** The run's port from the environment, or null. Anything else than a plain number in range is an error. */
export function portOf(v) {
  if (v === undefined || v === '') return null
  if (!/^[0-9]{4,5}$/.test(v) || Number(v) < 1024 || Number(v) > 65535) throw new Error(`srt-mac: bad TRINA_PREVIEW_PORT ${String(v).slice(0, 20)}`)
  return Number(v)
}

/** The words of a command made by srt's quote() (dist/utils/shell-quote.js): bare words and single-quoted parts, a
 * quote inside as '"'"'. Throws on anything else. */
export function words(s) {
  const out = []
  let i = 0
  while (i < s.length) {
    if (s[i] === ' ') { i++; continue }
    let w = ''
    while (i < s.length && s[i] !== ' ') {
      if (s[i] === "'") {
        const j = s.indexOf("'", i + 1)
        if (j < 0) throw new Error('srt-mac: an open quote')
        w += s.slice(i + 1, j); i = j + 1
      } else if (s.startsWith(`"'"`, i)) { w += "'"; i += 3 }
      else if (/[A-Za-z0-9_./:=@+,-]/.test(s[i])) { w += s[i]; i++ }
      else throw new Error(`srt-mac: unexpected character ${JSON.stringify(s[i])} in srt's command`)
    }
    out.push(w)
  }
  return out
}

/** Add the rules to the wrapped command (a shell string that holds the profile). Throws when the shape is unexpected. */
export function patch(wrapped, port) {
  const w = words(wrapped)
  // the parse must give back exactly srt's string, else the words are not what srt meant
  if (quote(w) !== wrapped) throw new Error('srt-mac: srt\'s command does not parse back to itself')
  const at = w.indexOf('/usr/bin/sandbox-exec')
  if (at < 0 || w[at + 1] !== '-p') throw new Error('srt-mac: not a sandbox-exec -p command')
  const profile = w[at + 2]
  const parts = profile.split(MARK)
  if (!profile.startsWith('(version 1)') || parts.length !== 2) throw new Error(`srt-mac: srt's profile has ${parts.length - 1} network sections, expected 1`)
  if (profile.includes(OPEN_LOCALHOST)) throw new Error('srt-mac: srt allows every localhost port (allowLocalBinding must be false)')
  w[at + 2] = parts[0] + MARK + extraRules(port) + parts[1] + END_RULES
  return quote(w)
}

/** run as a program (node mac.mjs ...), not imported (the unit test imports patch()) */
const isMain = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href } catch { return false } })()

if (!isMain) {
  // imported: the functions only
} else if (process.argv[2] !== '--self-test') {
  if (process.platform !== 'darwin') { console.error('srt-mac: macOS only'); process.exit(2) }
  const port = portOf(process.env.TRINA_PREVIEW_PORT)
  const wrap = SandboxManager.wrapWithSandbox.bind(SandboxManager)
  SandboxManager.wrapWithSandbox = async (...args) => patch(await wrap(...args), port)
  await import('./full.mjs')
} else {
  const bad = []
  const sample = quote(['env', 'HTTP_PROXY=http://localhost:4100', '/usr/bin/sandbox-exec', '-p', `(version 1)\n(deny default)${MARK}(allow network-outbound (remote ip "localhost:4100"))\n(allow file-read* (subpath "/a/Bob's"))\n`, '/bin/bash', '-c', "echo 'hi' $x"])
  const p = patch(sample, 47901)
  if (words(p)[7] !== "echo 'hi' $x" || !words(p)[4].includes("Bob's") || !words(p)[4].endsWith(END_RULES)) bad.push('words')
  if (!p.includes('(allow network-outbound (remote ip "localhost:47901"))')) bad.push('port rule')
  if (!p.includes('kern.proc.all')) bad.push('kern.proc.all')
  for (const t of [sample.replace(MARK, '\n'), sample.replace('(deny default)', `(deny default)${MARK}`), sample.replace('localhost:4100"', 'localhost:*"'), sample.replace('/usr/bin/sandbox-exec', '/tmp/x'), sample + ' "x"']) { try { patch(t, 1); bad.push('accepted a bad command') } catch {} }
  for (const v of ['80', '70000', '1e4', ' 4000', '4000;']) { try { portOf(v); bad.push(`port ${v}`) } catch {} }
  console.log(bad.length ? `bad: ${bad.join(', ')}` : 'ok')
  process.exit(bad.length ? 1 : 0)
}
