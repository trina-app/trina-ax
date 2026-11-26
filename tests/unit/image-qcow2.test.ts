// The Proxmox twin of the new-team AMI (trina-cloud FS-11): the AMI's root snapshot as a qcow2
// (scripts/image/snapshot-to-qcow2.ts), its manifest and its upload (scripts/release/publish-qcow2.ts, r2-s3.ts), SigV4
// (scripts/release/sigv4.ts) and the workflow job (.github/workflows/team-image.yml qcow2).
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ebsReader, snapshotToRaw, type SnapshotReader } from '../../scripts/image/snapshot-to-qcow2'
import { dirStore } from '../../scripts/release/publish-server'
import { checkQcowManifest, publishQcow, writeManifest } from '../../scripts/release/publish-qcow2'
import { putLarge } from '../../scripts/release/r2-s3'
import { signV4 } from '../../scripts/release/sigv4'

const ROOT = path.resolve(import.meta.dir, '../..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'image-qcow2-test-'))
afterAll(() => fs.rmSync(T, { recursive: true, force: true }))

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const PUB = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64')
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex')
let n = 0

describe('sigv4', () => {
  test('the AWS test vector get-vanilla', () => {
    const h = signV4({ method: 'GET', url: 'https://example.amazonaws.com/', region: 'us-east-1', service: 'service',
      creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }, now: new Date('2015-08-30T12:36:00Z') })
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
    expect(h['x-amz-date']).toBe('20150830T123600Z')
  })
  test('a session token is signed; s3 sends its payload hash', () => {
    const h = signV4({ method: 'PUT', url: 'https://a.r2.cloudflarestorage.com/b/k?partNumber=1&uploadId=x', region: 'auto', service: 's3', creds: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'TOK' }, payloadHash: 'UNSIGNED-PAYLOAD' })
    expect(h['x-amz-security-token']).toBe('TOK')
    expect(h['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD')
    expect(h.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token')
  })
})

describe('snapshot-to-qcow2: the snapshot as a sparse raw file', () => {
  const BS = 512 * 1024
  const blockOf = (i: number) => Buffer.alloc(BS, i % 251 + 1)
  const reader = (o: { bad?: number } = {}): SnapshotReader => ({
    async list(token) {
      return token ? { Blocks: [{ BlockIndex: 2047, BlockToken: 't2047' }], BlockSize: BS, VolumeSize: 1 }
        : { Blocks: [{ BlockIndex: 0, BlockToken: 't0' }, { BlockIndex: 5, BlockToken: 't5' }], BlockSize: BS, VolumeSize: 1, NextToken: 'next' }
    },
    async block(i) { if (i === o.bad) return Buffer.alloc(10); return blockOf(i) },
  })
  test('every listed block at its offset (all pages), the rest holes', async () => {
    const raw = path.join(T, `r${++n}.raw`)
    const r = await snapshotToRaw(reader(), raw, { parallel: 3, log: () => {} })
    expect(r).toEqual({ bytes: 1024 ** 3, blocks: 3 })
    expect(fs.statSync(raw).size).toBe(1024 ** 3)
    const fd = fs.openSync(raw, 'r')
    const at = (i: number) => { const b = Buffer.alloc(BS); fs.readSync(fd, b, 0, BS, i * BS); return b }
    expect(at(0).equals(blockOf(0))).toBe(true)
    expect(at(5).equals(blockOf(5))).toBe(true)
    expect(at(2047).equals(blockOf(2047))).toBe(true)
    expect(at(1).equals(Buffer.alloc(BS))).toBe(true)
    fs.closeSync(fd)
  })
  test('a block of the wrong size stops it', async () => {
    await expect(snapshotToRaw(reader({ bad: 5 }), path.join(T, `r${++n}.raw`), { log: () => {} })).rejects.toThrow('block 5: 10 bytes')
  })
  test('ebsReader: signed GETs, the block checked against x-amz-Checksum', async () => {
    const data = Buffer.from('block bytes')
    const seen: { url: string; auth: string }[] = []
    let wrong = true
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u)
      seen.push({ url, auth: (init?.headers as Record<string, string>).authorization })
      if (url.includes('/blocks?')) return Response.json({ Blocks: [], BlockSize: 524288, VolumeSize: 20 })
      // the first answer is damaged: it is read again
      const sum = wrong ? 'AAAA' : crypto.createHash('sha256').update(data).digest('base64')
      wrong = false
      return new Response(data, { headers: { 'x-amz-checksum': sum, 'x-amz-checksum-algorithm': 'SHA256' } })
    }) as typeof fetch
    const r = ebsReader('ap-northeast-2', 'snap-0abc', { creds: { accessKeyId: 'A', secretAccessKey: 'S' }, fetch: f })
    expect((await r.list()).VolumeSize).toBe(20)
    await expect(r.block(7, 'tok/+=')).rejects.toThrow('checksum')
    expect(Buffer.from(await r.block(7, 'tok/+=')).toString()).toBe('block bytes')
    expect(seen[0]!.url).toBe('https://ebs.ap-northeast-2.amazonaws.com/snapshots/snap-0abc/blocks?maxResults=10000')
    expect(seen[1]!.url).toContain('/snapshots/snap-0abc/blocks/7?blockToken=tok%2F%2B%3D')
    expect(seen.every((s) => s.auth.includes('/ap-northeast-2/ebs/aws4_request'))).toBe(true)
  })
})

/** a qcow2 as the workflow leaves it: the file, its .sha256 and its .sig */
function image(o: { version?: string; template?: string; sign?: crypto.KeyObject; body?: string } = {}): string {
  const version = o.version ?? '0.18.1'
  const tv = o.template ?? `${version}-d13-20261125`
  const dir = path.join(T, `i${++n}`)
  fs.mkdirSync(dir)
  const name = `teamax-${tv}.qcow2`
  const f = path.join(dir, name)
  const body = o.body ?? `QFI\xfb image ${n}`
  fs.writeFileSync(f, body)
  fs.writeFileSync(`${f}.sha256`, `${sha(body)}  ${name}\n`)
  fs.writeFileSync(`${f}.sig`, crypto.sign(null, Buffer.from(`ax-template-v1\n${tv}\n${sha(body)}`), o.sign ?? privateKey).toString('base64'))
  return f
}

describe('publish-qcow2: the image and its manifest beside the AMI', () => {
  test('the manifest names the image, its sha256, size and signature', () => {
    const q = image()
    const m = writeManifest({ version: '0.18.1', qcow2: q, snapshot: 'ap-northeast-2=snap-0f90220140e238cbc', keys: [PUB], now: new Date('2026-11-26T01:02:03.456Z') })
    expect(path.basename(m)).toBe('teamax-0.18.1-d13-20261125.qcow2.json')
    const j = JSON.parse(fs.readFileSync(m, 'utf8'))
    expect(j).toEqual({ v: 1, kind: 'qcow2', templateVersion: '0.18.1-d13-20261125', kitVersion: '0.18.1', architecture: 'x86_64', file: 'teamax-0.18.1-d13-20261125.qcow2',
      size: fs.statSync(q).size, sha256: sha(fs.readFileSync(q)), sig: fs.readFileSync(`${q}.sig`, 'utf8'), source: { region: 'ap-northeast-2', snapshotId: 'snap-0f90220140e238cbc' }, builtAt: '2026-11-26T01:02:03Z' })
    expect(checkQcowManifest('0.18.1', m, [PUB]).sha256).toBe(j.sha256)
  })
  test('refused: another key, another release, a changed image', () => {
    expect(() => writeManifest({ version: '0.18.1', qcow2: image({ sign: crypto.generateKeyPairSync('ed25519').privateKey }), snapshot: 'ap-northeast-2=snap-0a', keys: [PUB] })).toThrow('release key')
    expect(() => writeManifest({ version: '0.18.2', qcow2: image(), snapshot: 'ap-northeast-2=snap-0a', keys: [PUB] })).toThrow('not one of release 0.18.2')
    const q = image()
    const m = writeManifest({ version: '0.18.1', qcow2: q, snapshot: 'ap-northeast-2=snap-0a', keys: [PUB] })
    fs.appendFileSync(q, 'x')
    expect(() => checkQcowManifest('0.18.1', m, [PUB])).toThrow('.sha256 does not name')
  })
  test('uploads the image (large path), .sha256, .sig, then the manifest; a second run uploads nothing', async () => {
    const feed = path.join(T, 'feed1')
    const base = dirStore(feed, 'https://127.0.0.1:1')
    const order: string[] = []
    const store = { ...base, put: async (k: string, f: string, t: string) => { order.push(k); return base.put(k, f, t) }, putLarge: async (k: string, f: string, t: string) => { order.push(`large:${k}`); return base.put(k, f, t) } }
    const m = writeManifest({ version: '0.18.1', qcow2: image(), snapshot: 'ap-northeast-2=snap-0a', keys: [PUB] })
    const r = await publishQcow({ version: '0.18.1', manifest: m, store, keys: [PUB], log: () => {} })
    const d = 'server/0.18.1/teamax-0.18.1-d13-20261125.qcow2'
    expect(order).toEqual([`large:${d}`, `${d}.sha256`, `${d}.sig`, `${d}.json`])
    expect(r.status).toBe('published')
    expect((await publishQcow({ version: '0.18.1', manifest: m, store, keys: [PUB], log: () => {} })).status).toBe('there')
  })
  test('a manifest of another image on the feed stops the run; an image of other bytes too', async () => {
    const feed = path.join(T, 'feed2')
    const store = dirStore(feed, 'https://127.0.0.1:1')
    const m1 = writeManifest({ version: '0.18.1', qcow2: image(), snapshot: 'ap-northeast-2=snap-0a', keys: [PUB] })
    await publishQcow({ version: '0.18.1', manifest: m1, store, keys: [PUB], log: () => {} })
    const m2 = writeManifest({ version: '0.18.1', qcow2: image(), snapshot: 'ap-northeast-2=snap-0a', keys: [PUB] })
    await expect(publishQcow({ version: '0.18.1', manifest: m2, store, keys: [PUB], log: () => {} })).rejects.toThrow('one qcow2 per template')
    fs.rmSync(path.join(feed, 'server/0.18.1/teamax-0.18.1-d13-20261125.qcow2.json'))
    await expect(publishQcow({ version: '0.18.1', manifest: m2, store, keys: [PUB], log: () => {} })).rejects.toThrow('never replaced')
  })
  test('a failed image upload leaves no manifest (the CP never sees one without its image)', async () => {
    const feed = path.join(T, 'feed3')
    const base = dirStore(feed, 'https://127.0.0.1:1')
    const store = { ...base, putLarge: async () => { throw new Error('HTTP 502') } }
    const m = writeManifest({ version: '0.18.1', qcow2: image(), snapshot: 'ap-northeast-2=snap-0a', keys: [PUB] })
    await expect(publishQcow({ version: '0.18.1', manifest: m, store, keys: [PUB], log: () => {} })).rejects.toThrow('502')
    expect(fs.existsSync(path.join(feed, 'server/0.18.1/teamax-0.18.1-d13-20261125.qcow2.json'))).toBe(false)
  })
})

describe('r2-s3: multipart upload', () => {
  const file = path.join(T, 'big.bin')
  fs.writeFileSync(file, Buffer.alloc(25, 7))
  test('init, equal parts, complete with the ETags in order', async () => {
    const calls: string[] = []
    const parts: number[] = []
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(u)), m = init?.method ?? 'GET'
      calls.push(`${m} ${url.pathname}${url.search}`)
      if (m === 'POST' && url.searchParams.has('uploads')) return new Response('<InitiateMultipartUploadResult><UploadId>U1</UploadId></InitiateMultipartUploadResult>')
      if (m === 'PUT') { parts.push((await new Response(init!.body as Blob).arrayBuffer()).byteLength); return new Response('', { headers: { etag: `"e${url.searchParams.get('partNumber')}"` } }) }
      if (m === 'POST') { expect(String(init!.body)).toBe('<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"e1"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"e2"</ETag></Part><Part><PartNumber>3</PartNumber><ETag>"e3"</ETag></Part></CompleteMultipartUpload>'); return new Response('<CompleteMultipartUploadResult/>') }
      return new Response('', { status: 500 })
    }) as typeof fetch
    await putLarge({ endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'b', creds: { accessKeyId: 'A', secretAccessKey: 'S' }, fetch: f, partBytes: 10, log: () => {} }, 'server/0.18.1/teamax-x.qcow2', file, 'application/octet-stream')
    expect(parts).toEqual([10, 10, 5])
    expect(calls[0]).toBe('POST /b/server/0.18.1/teamax-x.qcow2?uploads=')
    expect(calls.at(-1)).toBe('POST /b/server/0.18.1/teamax-x.qcow2?uploadId=U1')
  })
  test('a refused part aborts the upload', async () => {
    const methods: string[] = []
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      if (init?.method === 'POST') return new Response('<UploadId>U2</UploadId>')
      if (init?.method === 'PUT') return new Response('<Error>AccessDenied</Error>', { status: 403 })
      return new Response('')
    }) as typeof fetch
    await expect(putLarge({ endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'b', creds: { accessKeyId: 'A', secretAccessKey: 'S' }, fetch: f, partBytes: 10, log: () => {} }, 'k', file, 'application/octet-stream')).rejects.toThrow('HTTP 403')
    expect(methods).toEqual(['POST', 'PUT', 'DELETE'])
  })
})

describe('team-image.yml: the qcow2 job', () => {
  type Step = { name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }
  type Job = { if?: string; needs?: string | string[]; environment?: string; permissions?: Record<string, string>; 'timeout-minutes'?: number; steps: Step[] }
  const wf = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/team-image.yml'), 'utf8')) as { jobs: Record<string, Job> }
  const j = wf.jobs.qcow2!
  const run = j.steps.map((s) => s.run ?? '').join('\n')
  test('its own job after the AMI job, never failing the AMI; the AMI job is unchanged', () => {
    expect(j.needs).toBe('build-ami')
    expect(j.if).toContain("needs.build-ami.result == 'success'")
    expect(j.environment).toBe('release')
    expect(j.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
    expect(JSON.stringify(wf.jobs['build-ami'])).not.toMatch(/qcow2/)
    for (const s of j.steps) if (s.uses) expect(s.uses, s.uses).toMatch(/@[0-9a-f]{40}$/)
    for (const s of j.steps) expect(s.run ?? '', s.name).not.toMatch(/\$\{\{\s*inputs\./)
  })
  test('the release key only in its signing step, removed whatever happens', () => {
    const withKey = j.steps.filter((s) => JSON.stringify(s).includes('secrets.RELEASE_SIGNING_KEY }}'))
    expect(withKey.map((s) => s.name)).toEqual(['Sign the qcow2'])
    expect(withKey[0]!.run).toContain('umask 077')
    expect(withKey[0]!.run).toContain('trap \'rm -f "$key"\' EXIT')
    expect(withKey[0]!.run).toContain("printf 'ax-template-v1\\n%s\\n%s' \"$TEMPLATE\" \"$sha\"")
    expect(j.steps.find((s) => s.name === 'Remove the release key')).toMatchObject({ if: 'always()', run: 'rm -f "$RUNNER_TEMP/release-key.pem"' })
  })
  test('its AWS session is cut down to the snapshot reads (inline session policy)', () => {
    const aws = j.steps.find((s) => s.uses?.startsWith('aws-actions/configure-aws-credentials@'))!
    const pol = JSON.parse(String(aws.with!['inline-session-policy'])) as { Statement: { Effect: string; Action: string | string[]; Resource: string }[] }
    const acts = pol.Statement.flatMap((s) => ([] as string[]).concat(s.Action))
    expect(acts.sort()).toEqual(['ebs:GetSnapshotBlock', 'ebs:ListSnapshotBlocks', 'kms:Decrypt'])
    expect(pol.Statement.every((s) => s.Effect === 'Allow')).toBe(true)
    expect(pol.Statement[0]!.Resource).toBe('arn:aws:ec2:ap-northeast-2::snapshot/*')
  })
  test('it reads the feed itself (a re-run after a failed qcow2 makes it), the AMI manifest checked first', () => {
    expect(run).toContain('teamax-$tv.qcow2.json')
    expect(run).not.toContain('steps.release.outputs.build')
    expect(JSON.stringify(j)).not.toContain('steps.ami.outputs')
    expect(run).toContain('checkManifest(process.env.V!, process.env.M!)')
    expect(run).toContain('scripts/image/snapshot-to-qcow2.ts --region "$AMI_REGION"')
    expect(run).toContain('scripts/release/publish-qcow2.ts publish')
  })
})
