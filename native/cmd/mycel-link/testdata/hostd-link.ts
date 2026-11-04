// Test helper for hostd_test.go: runs the REAL ax-link server of hostd (trina-cloud hostd/hostd/src/link.ts) on
// 127.0.0.1 with a ledger in memory, so the Go agent is tested against the server code itself.
//   MYCEL_LINK_HOSTD_DIR=<trina-cloud>/hostd bun testdata/hostd-link.ts <stateDir>
// stdout: one JSON line per event. First {ready, port, pin, token, tenantId}; then one answer per stdin line.
// stdin: JSON lines {ref, op: exec | state | waitOnline | reimage, ...}
import { createInterface } from 'node:readline'

const dir = process.env.MYCEL_LINK_HOSTD_DIR
if (!dir) throw new Error('MYCEL_LINK_HOSTD_DIR is not set')
const stateDir = process.argv[2]!
const { LinkServer, hashLinkToken } = await import(`${dir}/hostd/src/link.ts`)
const { realExec } = await import(`${dir}/hostd/src/util.ts`)

const TENANT = '01JTESTTENANT0000000000000'
const ec2: { linkPubkey: string | null; linkTokenHash: string | null } = { linkPubkey: null, linkTokenHash: null }
const journal = {
  tenant: (id: string) => (id === TENANT ? { tenantId: TENANT, ip: '127.0.0.1' } : null),
  ec2Tenant: (id: string) => (id === TENANT ? { ...ec2 } : null),
  putEc2Tenant: (id: string, p: Partial<typeof ec2>) => { if (id === TENANT) Object.assign(ec2, p) },
}
// hostd log lines go to stderr: the Go test checks them for secrets too
const log = {
  info: (m: string, f?: unknown) => process.stderr.write(`hostd info ${m} ${JSON.stringify(f ?? {})}\n`),
  warn: (m: string, f?: unknown) => process.stderr.write(`hostd warn ${m} ${JSON.stringify(f ?? {})}\n`),
  error: (m: string, f?: unknown) => process.stderr.write(`hostd error ${m} ${JSON.stringify(f ?? {})}\n`),
}
const link = new LinkServer({ journal, log, exec: realExec(), stateDir, listen: '127.0.0.1:0', pollWaitMs: Number(process.env.POLL_WAIT_MS ?? 2000), graceMs: 2000 })
await link.start()
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
const token = link.tokenFor(TENANT, 'op-1')
ec2.linkTokenHash = hashLinkToken(token)
out({ ready: true, port: link.port, pin: link.pin(), token, tenantId: TENANT })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line)
  try {
    switch (m.op) {
      case 'exec': {
        const r = await link.exec(TENANT, m.argv, m.stdin ?? null, m.timeoutSec)
        return out({ ref: m.ref, ok: true, result: r })
      }
      case 'state':
        return out({ ref: m.ref, ok: true, online: link.online(TENANT), bootId: link.bootId(TENANT), lastSeen: link.lastSeen(TENANT), ...ec2 })
      case 'waitOnline': {
        // like Ec2Driver.waitLink: online, a poll newer than `since`, and not the boot id `notBoot`
        const end = Date.now() + (m.timeoutMs ?? 15000)
        while (Date.now() < end) {
          if (link.online(TENANT) && (link.lastSeen(TENANT) ?? 0) > (m.since ?? 0) && (!m.notBoot || link.bootId(TENANT) !== m.notBoot)) return out({ ref: m.ref, ok: true, bootId: link.bootId(TENANT) })
          await sleep(50)
        }
        return out({ ref: m.ref, ok: false, code: 'timeout' })
      }
      case 'reimage': {
        // the reimage rule: a new token, the old key forgotten
        const t = link.tokenFor(TENANT, m.opId)
        Object.assign(ec2, { linkPubkey: null, linkTokenHash: hashLinkToken(t) })
        return out({ ref: m.ref, ok: true, token: t })
      }
      default: return out({ ref: m.ref, ok: false, code: 'bad op' })
    }
  } catch (e) {
    out({ ref: m.ref, ok: false, code: (e as { code?: string }).code ?? 'error', message: String((e as Error).message) })
  }
})
