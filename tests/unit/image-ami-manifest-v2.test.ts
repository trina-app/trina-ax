// scripts/image/ami-manifest-v2.sh (the v2 AMI manifest: one AMI per AWS region, one signature) without AWS: a stub
// `aws` on PATH writes each call to a log and answers per region from fixture ids. The tests check the manifest that
// ax-hostd installTemplate (trina-cloud hostd/hostd/src/drivers/ec2.ts) takes, its signature checked the way hostd
// checks it (verifyText in hostd/contracts/canonical.ts: raw 32-byte Ed25519 key, WebCrypto), the region checks, and
// the copy to another region.
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'image', 'ami-manifest-v2.sh')
const BUILD_AMI = path.join(REPO, 'scripts', 'image', 'build-ami.sh')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-ami-v2-'))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

// an OpenSSL that signs Ed25519 with -rawin (not the macOS LibreSSL)
const OPENSSL = ['/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/usr/bin/openssl'].find((p) => {
  if (!fs.existsSync(p)) return false
  const r = Bun.spawnSync([p, 'version'], { stdout: 'pipe' })
  return /^OpenSSL [3-9]/.test(r.stdout.toString())
})

const VER = '0.4.0-beta.8-d13-20261105'
const KR = { region: 'ap-northeast-2', ami: 'ami-0aaa111', snap: 'snap-0aaa111' }
const SG = { region: 'ap-southeast-1', ami: 'ami-0bbb222', snap: 'snap-0bbb222' }

// fixture state per region: AMI_<region>="ami snap state managed template", SNAP_<region>="state encrypted managed template"
const STUB_AWS = `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_LOG"
a=" $* "
region="$(sed -n 's/.* --region \\([^ ]*\\) .*/\\1/p' <<<"$a")"
key="$(tr '-' '_' <<<"$region")"
ami_var="AMI_$key"; snap_var="SNAP_$key"
read -r ami snap ast amg atp <<<"\${!ami_var:-}"
read -r sst senc smg stp <<<"\${!snap_var:-}"
case "$a" in
  *" --version "*) echo "aws-cli/2.31.0 Python/3.13 Darwin/27 source/arm64" ;;
  *" sts get-caller-identity "*) echo 111122223333 ;;
  *" copy-image "*) echo "\${COPY_ANSWER:-ami-0ccc333}" ;;
  *" create-tags "*) : ;;
  *" describe-images "*"--filters "*) echo "\${EXISTING_IN_DEST:-}" ;;
  *" describe-images "*"Tags[].[Key,Value]"*) printf 'Name\\tteamax-${VER}\\nax:managed\\tami\\nax:template\\t${VER}\\nowner\\tops\\n' ;;
  *" describe-images "*"[Name,State]"*) printf 'teamax-${VER}\\tavailable\\n' ;;
  *" describe-images "*"ami-0ccc333"*"[0].State "*) echo available ;;
  *" describe-images "*"ami-0ccc333"*"SnapshotId "*) echo snap-0ccc333 ;;
  *" describe-images "*"ami-0ccc333"*) printf 'available\\tx86_64\\tTrue\\tsnap-0ccc333\\tami\\t${VER}\\n' ;;
  *" describe-snapshots "*"snap-0ccc333"*) printf 'completed\\tTrue\\tami\\t${VER}\\n' ;;
  *" describe-images "*)
    if [[ -n "$ami" && "$a" == *" $ami "* ]]; then printf '%s\\tx86_64\\tTrue\\t%s\\t%s\\t%s\\n' "$ast" "$snap" "$amg" "$atp"
    else echo "An error occurred (InvalidAMIID.NotFound)" >&2; exit 254; fi ;;
  *" describe-snapshots "*)
    if [[ -n "$snap" && "$a" == *" $snap "* ]]; then printf '%s\\t%s\\t%s\\t%s\\n' "$sst" "$senc" "$smg" "$stp"
    else echo "An error occurred (InvalidSnapshot.NotFound)" >&2; exit 254; fi ;;
  *) : ;;
esac
`

const good = (x: typeof KR) => ({
  [`AMI_${x.region.replaceAll('-', '_')}`]: `${x.ami} ${x.snap} available ami ${VER}`,
  [`SNAP_${x.region.replaceAll('-', '_')}`]: `completed True ami ${VER}`,
})

let n = 0
function setup() {
  const dir = path.join(ROOT, `run-${++n}`)
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'aws'), STUB_AWS, { mode: 0o755 })
  return { dir, bin, out: path.join(dir, 'out'), log: path.join(dir, 'calls.log') }
}

function run(s: ReturnType<typeof setup>, args: string[], env: Record<string, string> = {}, script = SCRIPT) {
  const p = Bun.spawnSync(['/bin/bash', script, ...args], {
    env: { PATH: `${s.bin}:${path.dirname(OPENSSL ?? '/usr/bin/openssl')}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: s.dir,
      TMPDIR: s.dir, STUB_LOG: s.log, ...good(KR), ...good(SG), ...env },
    stdout: 'pipe', stderr: 'pipe',
  })
  const calls = fs.existsSync(s.log) ? fs.readFileSync(s.log, 'utf8').trim().split('\n').filter((c) => c && c !== '--version') : []
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), calls }
}
const base = ['--template-version', VER, '--account', '111122223333', '--yes']
const img = (x: typeof KR, snap = true) => ['--image', `${x.region}=${x.ami}${snap ? `:${x.snap}` : ''}`]
const MF = (s: { out: string }) => path.join(s.out, `teamax-${VER}.v2.ami.json`)

/** hostd/contracts/canonical.ts verifyText, the same algorithm: raw 32-byte public key, Ed25519 in WebCrypto */
async function hostdVerifyText(publicKeyB64: string, text: string, sigB64: string): Promise<boolean> {
  try {
    const raw = Buffer.from(publicKeyB64, 'base64')
    const sig = Buffer.from(sigB64, 'base64')
    if (raw.length !== 32 || sig.length !== 64) return false
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, new TextEncoder().encode(text))
  } catch { return false }
}

/** the manifest checks of hostd installTemplate (download step) for a host that serves these AWS regions */
function hostdParse(buf: Buffer, version: string, awsRegions: string[]): Record<string, { imageId: string; rootSnapshotId: string }> {
  const m = JSON.parse(buf.toString('utf8'))
  if ((m.v !== 1 && m.v !== 2) || m.kind !== 'ami' || m.templateVersion !== version) throw new Error('not an AMI manifest of this version')
  if (m.architecture !== 'x86_64') throw new Error('bad architecture')
  if (m.v === 1 && awsRegions.length !== 1) throw new Error('v1 has one region')
  const images = m.v === 1 ? { [m.region]: { imageId: m.imageId, rootSnapshotId: m.rootSnapshotId } } : m.images
  if (!images || typeof images !== 'object') throw new Error('no images')
  const missing = awsRegions.filter((r) => !images[r])
  if (missing.length) throw new Error(`no image for ${missing.join(', ')}`)
  for (const r of awsRegions) if (!/^ami-[0-9a-f]+$/.test(images[r].imageId ?? '') || !/^snap-[0-9a-f]+$/.test(images[r].rootSnapshotId ?? '')) throw new Error(`bad ids for ${r}`)
  return images
}

describe('ami-manifest-v2.sh', () => {
  test('syntax (bash 3.2 on a Mac runs it too)', () => {
    for (const f of [SCRIPT, BUILD_AMI]) {
      const p = Bun.spawnSync(['/bin/bash', '-n', f], { stderr: 'pipe' })
      expect(`${f}: ${p.exitCode} ${p.stderr.toString()}`).toBe(`${f}: 0 `)
    }
  })

  test.skipIf(!OPENSSL)('two regions from fixture ids: a v2 manifest that hostd takes, signed like v1', async () => {
    const s = setup()
    const key = path.join(s.dir, 'throwaway.pem')
    Bun.spawnSync([OPENSSL!, 'genpkey', '-algorithm', 'ed25519', '-out', key])
    // a v1 manifest of the same version is there already: v2 is written beside it, the v1 file is not touched
    fs.mkdirSync(s.out, { recursive: true })
    const v1 = path.join(s.out, `teamax-${VER}.ami.json`)
    fs.writeFileSync(v1, '{"v":1}\n')
    // through build-ami.sh --manifest-v2, the entry the operator uses; the SG image without a snapshot id (read from AWS)
    const r = run(s, ['--manifest-v2', ...base, ...img(SG, false), ...img(KR), '--sign-key', key, '--out', s.out], {}, BUILD_AMI)
    expect(r.out).toContain('ami-manifest-v2: done')
    expect(r.code).toBe(0)
    expect(fs.readFileSync(v1, 'utf8')).toBe('{"v":1}\n')
    // read only: no call that changes anything in AWS
    expect(r.calls.filter((c) => / (copy|create|delete|deregister|modify|register)-/.test(` ${c}`))).toEqual([])
    for (const x of [KR, SG]) {
      expect(r.calls.find((c) => c.includes(`--region ${x.region} ec2 describe-images --image-ids ${x.ami} --owners self`))).toBeTruthy()
      expect(r.calls.find((c) => c.includes(`--region ${x.region} ec2 describe-snapshots --snapshot-ids ${x.snap} --owner-ids self`))).toBeTruthy()
    }
    // the file name ends in .ami.json (CP templateUrlProblem and hostd take only that)
    expect(MF(s).endsWith('.ami.json')).toBe(true)
    const bytes = fs.readFileSync(MF(s))
    const m = JSON.parse(bytes.toString())
    expect(m).toMatchObject({ v: 2, kind: 'ami', templateVersion: VER, architecture: 'x86_64', kitVersion: '0.4.0-beta.8' })
    expect(Object.keys(m.images)).toEqual(['ap-northeast-2', 'ap-southeast-1']) // sorted: the same bytes for the same input
    expect(hostdParse(bytes, VER, [KR.region, SG.region])).toEqual({
      [KR.region]: { imageId: KR.ami, rootSnapshotId: KR.snap },
      [SG.region]: { imageId: SG.ami, rootSnapshotId: SG.snap },
    })
    // a host with one region (the default region only) takes it too
    expect(Object.keys(hostdParse(bytes, VER, [KR.region]))).toContain(KR.region)
    expect(() => hostdParse(bytes, VER, [KR.region, 'eu-west-1'])).toThrow('no image for eu-west-1')
    // sha256 file, and the signature: message "ax-template-v1\n<ver>\n<sha256>", checked as hostd checks it
    const sha = crypto.createHash('sha256').update(bytes).digest('hex')
    expect(fs.readFileSync(`${MF(s)}.sha256`, 'utf8')).toBe(`${sha}  teamax-${VER}.v2.ami.json\n`)
    const pubRaw = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(key))).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
    const sig = fs.readFileSync(`${MF(s)}.sig`, 'utf8')
    expect(sig).not.toContain('\n')
    expect(await hostdVerifyText(pubRaw, `ax-template-v1\n${VER}\n${sha}`, sig)).toBe(true)
    expect(r.out).toContain(`release public key ${pubRaw}`)
    // a changed manifest, another version or a trailing newline in the message: no
    expect(await hostdVerifyText(pubRaw, `ax-template-v1\n${VER}\n${sha}\n`, sig)).toBe(false)
    expect(await hostdVerifyText(pubRaw, `ax-template-v1\n0.4.0-beta.7-d13-20261105\n${sha}`, sig)).toBe(false)
    // the v2 file exists now: a second run stops
    const again = run(s, [...base, ...img(KR), ...img(SG), '--out', s.out])
    expect(again.code).not.toBe(0)
    expect(again.out).toContain('exists already: one v2 manifest per template version')
  })

  test('an AMI or snapshot that hostd or its IAM policy would refuse: nothing is written', () => {
    const cases: [Record<string, string>, string][] = [
      [{ AMI_ap_southeast_1: `${SG.ami} ${SG.snap} available ec2-kr1 ${VER}` }, 'tag ax:managed=ec2-kr1'],
      [{ AMI_ap_southeast_1: `${SG.ami} ${SG.snap} available ami 0.4.0-beta.7-d13-20261101` }, 'tag ax:template=0.4.0-beta.7-d13-20261101'],
      [{ AMI_ap_southeast_1: `${SG.ami} ${SG.snap} pending ami ${VER}` }, 'state pending'],
      [{ AMI_ap_southeast_1: `${SG.ami} snap-0other available ami ${VER}` }, `root snapshot snap-0other, not ${SG.snap}`],
      [{ SNAP_ap_southeast_1: `completed True None ${VER}` }, 'tag ax:managed=None (the hostd IAM policy needs ami)'],
      [{ SNAP_ap_southeast_1: `completed False ami ${VER}` }, 'not encrypted'],
      [{ AMI_ap_southeast_1: '' }, `AMI ${SG.ami} not found`],
    ]
    for (const [env, msg] of cases) {
      const s = setup()
      const r = run(s, [...base, ...img(KR), ...img(SG), '--out', s.out], env)
      expect(`${r.code} ${r.out}`).toContain(msg)
      expect(r.code).not.toBe(0)
      expect(fs.existsSync(MF(s))).toBe(false)
    }
  })

  test('input checks stop before any AWS call', () => {
    const cases: [string[], string][] = [
      [['--account', '111122223333', ...img(KR)], '--template-version is required'],
      [['--template-version', VER, ...img(KR)], '--account <12-digit id> is required'],
      [['--template-version', '0.4.0', '--account', '111122223333', ...img(KR)], 'must be <kit x.y.z[-pre]>-d13-<yyyymmdd>'],
      [[...base], 'give at least one --image'],
      [[...base, '--image', 'sg-singapore-1=ami-0bbb222'], 'not an AWS region name'],
      [[...base, ...img(KR), '--copy-to', 'kr-seoul-1'], 'not an AWS region name'],
      [[...base, '--image', 'ap-southeast-1=vol-0bbb222'], '--image takes REGION=ami-'],
      [[...base, ...img(KR), ...img(KR)], 'region given twice'],
      [[...base, ...img(KR), ...img(SG), '--copy-to', 'eu-west-1'], 'give only one --image with --copy-to'],
    ]
    for (const [args, msg] of cases) {
      const s = setup()
      const r = run(s, [...args, '--out', s.out])
      expect(r.out).toContain(msg)
      expect(r.code).not.toBe(0)
      expect(r.calls).toEqual([])
    }
  })

  test('another account: stop after the identity call', () => {
    const s = setup()
    const r = run(s, ['--template-version', VER, '--account', '999988887777', ...img(KR), '--out', s.out])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('the AWS session is account 111122223333, not --account 999988887777')
    expect(r.calls).toEqual([`--region ${KR.region} sts get-caller-identity --query Account --output text`])
  })

  test('--copy-to: CopyImage encrypted with a client token, tags on the copy and its snapshot, then the manifest', () => {
    const s = setup()
    const r = run(s, [...base, ...img(KR), '--copy-to', 'eu-west-1', '--profile', 'trina', '--out', s.out])
    expect(r.out).toContain('ami-manifest-v2: done')
    expect(r.code).toBe(0)
    const copy = r.calls.find((c) => c.includes(' copy-image ')) ?? ''
    for (const x of ['--region eu-west-1 --profile trina ec2 copy-image', `--source-region ${KR.region}`, `--source-image-id ${KR.ami}`,
      '--encrypted', `--client-token ax-${VER}-eu-west-1`, `--name teamax-${VER}`,
      `ResourceType=image,Tags=[{Key=ax:managed,Value=ami},{Key=ax:template,Value=${VER}},{Key=Name,Value=teamax-${VER}},{Key=owner,Value=ops}]`,
      'ResourceType=snapshot,Tags=[{Key=ax:managed,Value=ami},']) expect(copy).toContain(x)
    const tags = r.calls.find((c) => c.includes(' create-tags ')) ?? ''
    expect(tags).toContain('--region eu-west-1')
    expect(tags).toContain('--resources ami-0ccc333 snap-0ccc333')
    expect(tags).toContain(`Key=ax:managed,Value=ami Key=ax:template,Value=${VER}`)
    // the existing-AMI look-up comes before the copy, the checks after the tags
    const at = (x: string) => r.calls.findIndex((c) => c.includes(x))
    expect(at('--filters Name=tag:ax:template')).toBeLessThan(at(' copy-image '))
    expect(at(' create-tags ')).toBeLessThan(at('describe-snapshots --snapshot-ids snap-0ccc333'))
    const m = JSON.parse(fs.readFileSync(MF(s), 'utf8'))
    expect(m.images).toEqual({ [KR.region]: { imageId: KR.ami, rootSnapshotId: KR.snap }, 'eu-west-1': { imageId: 'ami-0ccc333', rootSnapshotId: 'snap-0ccc333' } })
  })

  test('--copy-to a region that has the AMI already: no second copy', () => {
    const s = setup()
    const r = run(s, [...base, ...img(KR), '--copy-to', 'eu-west-1', '--out', s.out], { EXISTING_IN_DEST: 'ami-0ccc333' })
    expect(r.code).toBe(0)
    expect(r.calls.find((c) => c.includes(' copy-image '))).toBeUndefined()
    expect(r.out).toContain('eu-west-1: AMI ami-0ccc333 has ax:template=')
  })

  test('--dry-run prints the aws commands and calls nothing', () => {
    const s = setup()
    const r = run(s, [...base, ...img(KR), '--copy-to', SG.region, '--dry-run', '--out', s.out])
    expect(r.code).toBe(0)
    expect(r.calls).toEqual([])
    expect(r.out).toContain(`+ aws --region ${SG.region} ec2 copy-image`)
    expect(r.out).toContain('--encrypted')
    expect(r.out).toContain('dry run: would write')
    expect(fs.existsSync(MF(s))).toBe(false)
  })
})
