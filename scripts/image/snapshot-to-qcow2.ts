// The Proxmox twin of a new-team AMI: its root snapshot as a qcow2, so a Proxmox host (the free host, trina-cloud FS-11)
// runs the same template version as the EC2 hosts. The same bytes as the AMI, not a second build: build.sh would give
// another build date (-d13-<yyyymmdd>) and other package versions. The image is platform-neutral (README "What is in
// the image": cloud-init NoCloud first, chrony with both platform sources, mycel-link only with /etc/ax/link.json).
//
//   bun scripts/image/snapshot-to-qcow2.ts --region ap-northeast-2 --snapshot snap-… --template-version <tv> --out DIR
//       [--work DIR] [--parallel 16]
//
// 1. EBS direct APIs (ListSnapshotBlocks, GetSnapshotBlock; IAM docs/runbooks/team-image-iam-policy.json
//    "QcowFromCiSnapshots"): every written block of the snapshot into a sparse raw file, each block checked against
//    its SHA256 checksum. Blocks that were never written are not listed and stay holes (zeros).
// 2. qemu-img convert -c -O qcow2 (compressed), the raw file removed.
// 3. <out>/teamax-<tv>.qcow2 and teamax-<tv>.qcow2.sha256 ("<hex>  <name>"). Unsigned: the workflow signs it in a short
//    step of its own (.github/workflows/team-image.yml), and publish-qcow2.ts writes the manifest.
// The AWS credentials come from the environment (configure-aws-credentials); nothing is printed of them.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { hashFile } from '../release/sign'
import { envCreds, signV4, type AwsCreds } from '../release/sigv4'

export const TEMPLATE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-d13-\d{8}$/
export const qcowName = (tv: string) => `teamax-${tv}.qcow2`

interface Block { BlockIndex: number; BlockToken: string }
interface ListAnswer { Blocks?: Block[]; BlockSize?: number; VolumeSize?: number; NextToken?: string }

export interface SnapshotReader {
  list(pageToken?: string): Promise<ListAnswer>
  block(index: number, token: string): Promise<Uint8Array>
}

class Retry extends Error {}
const transient = (s: number) => s === 429 || s >= 500

/** the EBS direct APIs of one region, signed with SigV4 (service "ebs") */
export function ebsReader(region: string, snapshot: string, o: { creds?: AwsCreds; fetch?: typeof fetch; endpoint?: string } = {}): SnapshotReader {
  const creds = o.creds ?? envCreds()
  const f = o.fetch ?? fetch
  const base = o.endpoint ?? `https://ebs.${region}.amazonaws.com`
  async function call(url: string): Promise<Response> {
    for (let n = 1; ; n++) {
      let r: Response | null = null
      try { r = await f(url, { headers: signV4({ method: 'GET', url, region, service: 'ebs', creds }), signal: AbortSignal.timeout(120_000) }) } catch (e) { if (n >= 6) throw e }
      if (r && r.ok) return r
      if (r && !transient(r.status)) throw new Error(`${new URL(url).pathname}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`)
      if (n >= 6) throw new Error(`${new URL(url).pathname}: ${r ? `HTTP ${r.status}` : 'no answer'} after ${n} tries`)
      await Bun.sleep(1000 * 2 ** (n - 1))
    }
  }
  return {
    async list(pageToken) {
      const q = new URLSearchParams({ maxResults: '10000' })
      if (pageToken) q.set('pageToken', pageToken)
      return (await call(`${base}/snapshots/${snapshot}/blocks?${q}`)).json() as Promise<ListAnswer>
    },
    async block(index, token) {
      const r = await call(`${base}/snapshots/${snapshot}/blocks/${index}?${new URLSearchParams({ blockToken: token })}`)
      const bytes = new Uint8Array(await r.arrayBuffer())
      const want = r.headers.get('x-amz-checksum'), alg = r.headers.get('x-amz-checksum-algorithm')
      if (!want || (alg && alg.toUpperCase() !== 'SHA256')) throw new Error(`block ${index}: no SHA256 checksum in the answer`)
      const got = crypto.createHash('sha256').update(bytes).digest('base64')
      if (got !== want) throw new Retry(`block ${index}: checksum ${got} is not ${want}`)
      return bytes
    },
  }
}

/** every listed block into a sparse raw file of the volume's size; returns the size and the number of blocks */
export async function snapshotToRaw(reader: SnapshotReader, raw: string, o: { parallel?: number; log?: (l: string) => void } = {}): Promise<{ bytes: number; blocks: number }> {
  const log = o.log ?? console.log
  const blocks: Block[] = []
  let blockSize = 0, volumeGiB = 0, token: string | undefined
  do {
    const a = await reader.list(token)
    blockSize ||= a.BlockSize ?? 0
    volumeGiB ||= a.VolumeSize ?? 0
    blocks.push(...(a.Blocks ?? []))
    token = a.NextToken || undefined
  } while (token)
  if (!(blockSize > 0) || !(volumeGiB > 0)) throw new Error('the snapshot list has no BlockSize or VolumeSize')
  const bytes = volumeGiB * 1024 ** 3
  const fd = fs.openSync(raw, 'w')
  try {
    fs.ftruncateSync(fd, bytes)
    let next = 0, done = 0
    const worker = async () => {
      for (;;) {
        const b = blocks[next++]
        if (!b) return
        if (b.BlockIndex < 0 || (b.BlockIndex + 1) * blockSize > bytes) throw new Error(`block ${b.BlockIndex} is outside the ${volumeGiB} GiB volume`)
        let data: Uint8Array | null = null
        for (let n = 1; !data; n++) {
          try { data = await reader.block(b.BlockIndex, b.BlockToken) } catch (e) { if (!(e instanceof Retry) || n >= 3) throw e }
        }
        if (data.length !== blockSize) throw new Error(`block ${b.BlockIndex}: ${data.length} bytes, not ${blockSize}`)
        fs.writeSync(fd, data, 0, data.length, b.BlockIndex * blockSize)
        if (++done % 2000 === 0) log(`${done} of ${blocks.length} blocks`)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, o.parallel ?? 16) }, worker))
  } finally { fs.closeSync(fd) }
  log(`raw image: ${volumeGiB} GiB, ${blocks.length} blocks of ${blockSize} bytes`)
  return { bytes, blocks: blocks.length }
}

export async function main(argv: string[]): Promise<string> {
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const region = arg('--region'), snapshot = arg('--snapshot'), tv = arg('--template-version'), out = arg('--out')
  if (!region || !snapshot || !tv || !out) throw new Error('usage: snapshot-to-qcow2.ts --region R --snapshot snap-… --template-version <tv> --out DIR [--work DIR] [--parallel N]')
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error(`--region ${region} is not an AWS region`)
  if (!/^snap-[0-9a-f]+$/.test(snapshot)) throw new Error(`--snapshot ${snapshot} is not a snapshot id`)
  if (!TEMPLATE_RE.test(tv)) throw new Error(`--template-version ${tv} is not <kit>-d13-<yyyymmdd>`)
  const work = arg('--work') ?? out
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(work, { recursive: true })
  const raw = path.join(work, `teamax-${tv}.raw`)
  const q = path.join(out, qcowName(tv))
  try {
    await snapshotToRaw(ebsReader(region, snapshot), raw, { parallel: Number(arg('--parallel') ?? 16) })
    fs.rmSync(`${q}.part`, { force: true })
    const r = spawnSync('qemu-img', ['convert', '-p', '-c', '-f', 'raw', '-O', 'qcow2', raw, `${q}.part`], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`qemu-img convert failed (${r.status ?? r.signal ?? r.error?.message})`)
    fs.renameSync(`${q}.part`, q)
  } finally { fs.rmSync(raw, { force: true }) }
  const sum = hashFile(q)
  fs.writeFileSync(`${q}.sha256`, `${sum}  ${path.basename(q)}\n`)
  console.log(`${q}: ${fs.statSync(q).size} bytes, sha256 ${sum}`)
  return q
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => { console.error(`snapshot-to-qcow2: ${(e as Error).message}`); process.exit(1) })
}
