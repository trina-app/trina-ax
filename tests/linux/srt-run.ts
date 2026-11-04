// Builds tests/linux/Dockerfile.srt and runs the srt attack suite (tests/linux/srt-attack.ts) in it. --privileged:
// bwrap's user namespaces and mounts, as in tests/linux/run.ts. Needs network: the suite checks that an allowed site
// works through srt's proxy and that others do not.
//   bun tests/linux/srt-run.ts
import path from 'node:path'
const root = path.join(import.meta.dir, '..', '..')
const tag = 'trina-srt-attack:local'
const build = Bun.spawnSync(['docker', 'build', '-f', 'tests/linux/Dockerfile.srt', '-t', tag, '.'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
const run = Bun.spawnSync(['docker', 'run', '--rm', '--privileged', tag], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
process.exit(run.exitCode ?? 1)
