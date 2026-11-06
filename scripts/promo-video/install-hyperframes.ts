// Installs the pinned HyperFrames CLI that renders promo videos to MP4 on a development Mac (docs/DECISIONS.md "V"):
//   bun scripts/promo-video/install-hyperframes.ts
// A tool folder outside the repository's workspaces (~/.cache/mycel/hyperframes-<version>, or MYCEL_HYPERFRAMES_DIR),
// installed with `npm ci` from scripts/promo-video/hyperframes/package-lock.json (every package pinned with its
// integrity hash), so the server's own dependencies and bun.lock stay as they are. Then the CLI's own browser
// (chrome-headless-shell) is fetched once. Needs Node 22 or newer and npm. Telemetry and update checks are off.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const VERSION = '0.9.15'
const dir = process.env.MYCEL_HYPERFRAMES_DIR || path.join(os.homedir(), '.cache', 'mycel', `hyperframes-${VERSION}`)
const here = path.join(import.meta.dir, 'hyperframes')
const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_SKIP_SKILLS: '1' }

const node = Bun.which('node')
const major = node ? Number(spawnSync(node, ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }).stdout.trim()) : 0
if (!node || major < 22) { console.error('Node 22 or newer is needed (the HyperFrames CLI runs on Node).'); process.exit(1) }
if (!Bun.which('npm')) { console.error('npm is needed.'); process.exit(1) }

fs.mkdirSync(dir, { recursive: true })
for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(here, f), path.join(dir, f))
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd: dir, env, stdio: 'inherit' })
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')} failed`); process.exit(1) }
}
run('npm', ['ci', '--no-audit', '--no-fund'])
const cli = path.join(dir, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs')
run(node, [cli, 'browser', 'ensure'])
console.log(`HyperFrames ${VERSION} is in ${dir}. A development server (bun run dev) on this Mac now offers the MP4 of a promo video.`)
