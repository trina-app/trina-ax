// The release feed's hosting (docs/OFFICE.md "자동 업데이트"): the feed's host (RELEASE_CHANNEL.feed) = the Worker
// scripts/release/worker.js in front of the private R2 bucket RELEASE_CHANNEL.hosting.bucket. Run once on the owner's
// Mac (again after changing worker.js or the channel); it changes nothing else in the account or the zone.
//
//   bun scripts/release/hosting.ts setup     bucket (if missing), Worker with the bucket binding, custom domain
//                                            (the feed's host; Cloudflare makes its DNS record), no workers.dev
//   bun scripts/release/hosting.ts status    what exists, and what the feed answers
import fs from 'node:fs'
import path from 'node:path'
import { BUCKET, Cloudflare, HOST, WORKER } from './cloudflare'
import { workerCode } from './worker-code'

const cf = new Cloudflare()
const cmd = process.argv[2] ?? 'status'
const { account, zone } = await cf.accountAndZone()

async function status() {
  const buckets = await cf.json<{ buckets: { name: string }[] }>('GET', `/accounts/${account}/r2/buckets`)
  console.log(`bucket ${BUCKET}: ${buckets.buckets.some((b) => b.name === BUCKET) ? 'yes' : 'no'}`)
  const scripts = await cf.json<{ id: string }[]>('GET', `/accounts/${account}/workers/scripts`)
  console.log(`worker ${WORKER}: ${scripts.some((s) => s.id === WORKER) ? 'yes' : 'no'}`)
  const domains = await cf.json<{ hostname: string; service: string }[]>('GET', `/accounts/${account}/workers/domains`)
  const d = domains.find((x) => x.hostname === HOST)
  console.log(`custom domain ${HOST}: ${d ? `-> ${d.service}` : 'no'}`)
  try {
    const r = await fetch(`https://${HOST}/`, { signal: AbortSignal.timeout(10_000) })
    console.log(`https://${HOST}/: HTTP ${r.status} ${(await r.text()).trim().slice(0, 60)}`)
  } catch (e) { console.log(`https://${HOST}/: ${(e as Error).message}`) }
}

if (cmd === 'setup') {
  const buckets = await cf.json<{ buckets: { name: string }[] }>('GET', `/accounts/${account}/r2/buckets`)
  if (!buckets.buckets.some((b) => b.name === BUCKET)) {
    await cf.json('POST', `/accounts/${account}/r2/buckets`, { name: BUCKET })
    console.log(`bucket ${BUCKET} created`)
  }
  const code = workerCode(fs.readFileSync(path.join(import.meta.dir, 'worker.js'), 'utf8'))
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.js', compatibility_date: '2026-10-01', bindings: [{ type: 'r2_bucket', name: 'BUCKET', bucket_name: BUCKET }] })], { type: 'application/json' }))
  form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js')
  const r = await cf.raw('PUT', `/accounts/${account}/workers/scripts/${WORKER}`, form)
  const j = (await r.json()) as { success: boolean; errors: { message: string }[] }
  if (!j.success) throw new Error(`worker upload: ${j.errors.map((e) => e.message).join('; ')}`)
  console.log(`worker ${WORKER} deployed`)
  // only the custom domain: no <name>.<account>.workers.dev address
  await cf.json('POST', `/accounts/${account}/workers/scripts/${WORKER}/subdomain`, { enabled: false, previews_enabled: false }).catch((e) => console.log(`workers.dev: ${(e as Error).message}`))
  await cf.json('PUT', `/accounts/${account}/workers/domains`, { environment: 'production', hostname: HOST, service: WORKER, zone_id: zone })
  console.log(`custom domain ${HOST} -> ${WORKER}`)
  await status()
} else if (cmd === 'status') {
  await status()
} else {
  console.error('usage: bun scripts/release/hosting.ts setup | status')
  process.exit(2)
}
