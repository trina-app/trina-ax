// The relay runs .ts files directly under Node with type STRIPPING (no transform): parameter properties, enums and
// namespaces would only fail when the relay starts in production. Load every relay module in Node here.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')

test('every relay module (and the shared files it loads) loads in Node without a transform', () => {
  if (!Bun.which('node')) return
  const files = fs.readdirSync(path.join(ROOT, 'relay/src')).filter((f) => f.endsWith('.ts') && f !== 'main.ts').map((f) => path.join(ROOT, 'relay/src', f))
  files.push(path.join(ROOT, 'shared/src/cloud-protocol/relay-ops.ts'), path.join(ROOT, 'shared/src/relay-protocol/index.ts'))
  const script = `Promise.all(${JSON.stringify(files)}.map((f) => import(f))).then(() => console.log('loaded'), (e) => { console.error(e.code ?? '', e.message); process.exit(1) })`
  const p = Bun.spawnSync(['node', '--disable-warning=ExperimentalWarning', '-e', script], { cwd: ROOT })
  expect({ out: p.stdout.toString().trim(), err: p.stderr.toString().trim().split('\n')[0] }).toEqual({ out: 'loaded', err: '' })
})
