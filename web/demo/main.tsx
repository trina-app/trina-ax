// The demo build's entry (web/demo/vite.ts points index.html here; docs/AGENTS/plan/20261114-0507-mina-demo.md). It
// connects the page to the in-page server first (requests wait until the server is made), then loads web/demo/boot.ts,
// which makes the server from the story and starts the real app (src/main.tsx) and the demo's guide line. Nothing else
// is imported here: the bundler may hoist the app's modules into chunks this entry imports, and they would run (and
// ask /api/me of the network) before the bridge is in place.
import { installBridge } from './bridge'
import type { DemoServer } from './server'

let made!: (s: DemoServer) => void
installBridge(new Promise<DemoServer>((r) => { made = r }))
void import('./boot').then((m) => m.boot(made))
