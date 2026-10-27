// The production relay bundle (scripts/build-relay.ts, RL-9): only the relay, its wire protocol, the operator API
// types, ws and the deploy files; every file in MANIFEST.json with its hash; and it runs under Node from a folder
// outside the repository (no access to the repo's node_modules), the way relay/deploy runs it.
import { afterAll, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildRelay } from '../../scripts/build-relay.ts'
import { readFileChunks, zstdDecompress } from '../../server/src/system/streams.ts'
import { extractTar } from '../../server/src/system/tar.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bundle-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('bundle: contents, manifest, sha256 file, and it serves under Node outside the repository', async () => {
  const out = await buildRelay({ outDir: path.join(tmp, 'dist'), version: '0.0.0-test' })
  expect(fs.readFileSync(`${out.file}.sha256`, 'utf8')).toBe(`${out.sha256}  teamax-relay-0.0.0-test.tar.zst\n`)
  const h = crypto.createHash('sha256')
  for await (const c of readFileChunks(out.file)) h.update(c)
  expect(h.digest('hex')).toBe(out.sha256)

  const dest = path.join(tmp, 'x')
  fs.mkdirSync(dest)
  await extractTar(zstdDecompress(readFileChunks(out.file)), dest)
  const root = path.join(dest, 'teamax-relay-0.0.0-test')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST.json'), 'utf8')) as { version: string; files: Record<string, { size: number; sha256: string }> }
  expect(manifest.version).toBe('0.0.0-test')
  const names = Object.keys(manifest.files)
  for (const must of ['package.json', 'VERSION', 'relay/src/main.ts', 'relay/src/ops-api.ts', 'shared/src/relay-protocol/index.ts', 'shared/src/cloud-protocol/relay-ops.ts', 'shared/src/cloud-protocol/LICENSE', 'node_modules/ws/package.json', 'deploy/mycel-relay@.service', 'deploy/relay-deploy.sh']) expect(names).toContain(must)
  // nothing of the team server, the tests or the zod-based contracts
  expect(names.filter((n) => /^(server|web|tests|desktop)\//.test(n) || n.startsWith('shared/src/api') || n === 'shared/src/cloud-protocol/enroll.ts')).toEqual([])
  for (const [n, m] of Object.entries(manifest.files)) {
    const b = fs.readFileSync(path.join(root, n))
    expect({ n, size: b.byteLength, sha256: crypto.createHash('sha256').update(b).digest('hex') }).toEqual({ n, ...m })
  }
  expect(fs.statSync(path.join(root, 'deploy/relay-deploy.sh')).mode & 0o111).not.toBe(0)

  if (!Bun.which('node')) return
  const port = 19288
  const data = path.join(tmp, 'data')
  const p = Bun.spawn(['node', '--disable-warning=ExperimentalWarning', path.join(root, 'relay/src/main.ts'), '--dev', '--port', String(port), '--data', data], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  try {
    let ok = false
    for (let i = 0; i < 100 && !ok; i++) {
      try { ok = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok } catch {}
      if (!ok) await Bun.sleep(100)
    }
    if (!ok) throw new Error(`bundle relay did not start: ${await new Response(p.stderr).text()}`)
    expect(((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { ok: boolean }).ok).toBe(true)
  } finally {
    p.kill('SIGTERM')
    await p.exited
  }
}, 60_000)
