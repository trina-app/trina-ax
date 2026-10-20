// Starts the mock team server on 127.0.0.1:$MOCK_PORT (default 19143, component D's port range) serving web/dist.
//   bun test/mock/serve.ts            seeded team (sign in as olga / "correct horse battery")
//   MOCK_SETUP=1 bun test/mock/serve.ts   first-run setup (token "setup-token-0123456789")
import path from 'node:path'
import { MockServer } from './server'

const port = Number(process.env.MOCK_PORT ?? 19143)
const dist = path.resolve(import.meta.dir, '..', '..', 'dist')
const mock = new MockServer({ setup: process.env.MOCK_SETUP === '1' })
mock.serve(port, dist)
console.log(`mock team server on http://127.0.0.1:${port} (web from ${dist})`)
