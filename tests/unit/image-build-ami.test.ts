// scripts/image/build-ami.sh (the EC2 team image, trina-cloud docs/research/ec2-per-team.md §10.2) without AWS: stub
// `aws`, `ssh` and `scp` programs on PATH write each call to a log and give canned answers. The tests check the call
// order, the tags, the signed manifest, and that a failure removes only what the run made (by the ids in its state file).
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'image', 'build-ami.sh')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-build-ami-'))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

// an OpenSSL that signs Ed25519 with -rawin (not the macOS LibreSSL)
const OPENSSL = ['/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/usr/bin/openssl'].find((p) => {
  if (!fs.existsSync(p)) return false
  const r = Bun.spawnSync([p, 'version'], { stdout: 'pipe' })
  return /^OpenSSL [3-9]/.test(r.stdout.toString())
})

const STUB_AWS = `#!/bin/bash
# stub aws: log the call, answer like the real CLI with --output text
printf '%s\\n' "$*" >> "$STUB_LOG"
a=" $* "
if [[ -n "\${FAIL_AT:-}" && "$a" == *" $FAIL_AT "* ]]; then echo "An error occurred (UnauthorizedOperation) when calling $FAIL_AT" >&2; exit 254; fi
case "$a" in
  *" --version "*) echo "aws-cli/2.31.0 Python/3.13 Darwin/27 source/arm64" ;;
  *" sts get-caller-identity "*) echo 111122223333 ;;
  *" ssm get-parameter "*) echo ami-0source ;;
  *" describe-images "*"--image-ids ami-0source "*) printf 'x86_64\\t/dev/xvda\\t/dev/xvda\\tsnap-0source\\tdebian-13-amd64-20261101-1\\n' ;;
  *" describe-images "*"--filters "*) echo "\${EXISTING_AMI:-}" ;;
  *" describe-images "*"--image-ids ami-0new "*) printf 'available\\tsnap-0new\\tTrue\\n' ;;
  *" describe-subnets "*) printf 'vpc-0test\\tap-northeast-2a\\tapne2-az1\\n' ;;
  *" create-security-group "*) echo sg-0build ;;
  *" run-instances "*) echo i-0build ;;
  *" create-volume "*) echo vol-0work ;;
  *" describe-instances "*) echo 198.51.100.7 ;;
  *" create-snapshot "*) echo snap-0new ;;
  *" describe-snapshots "*) echo completed ;;
  *" register-image "*) echo ami-0new ;;
  *" describe-tags "*)
    id="$(sed -n 's/.*Name=resource-id,Values=\\([^ ]*\\).*/\\1/p' <<<"$a")"
    if [[ -n "\${TAG_OVERRIDE:-}" ]]; then echo "$TAG_OVERRIDE"
    else case "$id" in snap-*|ami-*) echo ami ;; *) echo ami-build ;; esac; fi ;;
  *) : ;;
esac
`
const STUB_SSH = `#!/bin/bash
printf 'ssh %s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  *" true") exit 0 ;;
  *ami-chroot.sh*) echo "customize: done: template x, kit present, changed=42"; echo "ami-chroot: done"; exit "\${SSH_CHROOT_RC:-0}" ;;
  *ax-template.json*) echo "{\\"format\\":1,\\"templateVersion\\":\\"$STUB_TEMPLATE\\"}" ;;
esac
`
const STUB_SCP = `#!/bin/bash
printf 'scp %s\\n' "$*" >> "$STUB_LOG"
`

/** a file whose ELF header says 64-bit x86-64 (machine 0x3e) or aarch64 (0xb7) */
function elf(p: string, machine: number) {
  const b = Buffer.alloc(64)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(b, 0)
  b[16] = 2; b[18] = machine
  fs.writeFileSync(p, b, { mode: 0o755 })
}

let n = 0
function setup() {
  const dir = path.join(ROOT, `run-${++n}`)
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const [name, body] of [['aws', STUB_AWS], ['ssh', STUB_SSH], ['scp', STUB_SCP]] as const) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 })
  const kit = path.join(dir, 'kit')
  fs.mkdirSync(kit)
  fs.writeFileSync(path.join(kit, 'VERSION'), '0.3.0\n')
  fs.writeFileSync(path.join(kit, 'install-linux.sh'), '#!/bin/bash\n')
  elf(path.join(dir, 'mycel-enroll'), 0x3e)
  elf(path.join(dir, 'mycel-link'), 0x3e)
  const out = path.join(dir, 'out')
  return { dir, bin, kit, out, log: path.join(dir, 'calls.log') }
}

function run(s: ReturnType<typeof setup>, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(['/bin/bash', SCRIPT, '--kit', s.kit, '--enroll-bin', path.join(s.dir, 'mycel-enroll'),
    '--link-bin', path.join(s.dir, 'mycel-link'), '--subnet-id', 'subnet-0abc', '--ssh-cidr', '198.51.100.1/32',
    '--date', '20261105', '--out', s.out, '--yes', '--account', '111122223333', ...args], {
    env: { PATH: `${s.bin}:${path.dirname(OPENSSL ?? '/usr/bin/openssl')}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: s.dir,
      TMPDIR: s.dir, STUB_LOG: s.log, STUB_TEMPLATE: '0.3.0-d13-20261105', ...env },
    stdout: 'pipe', stderr: 'pipe',
  })
  // `aws --version` is a local check, not a call to AWS
  const calls = fs.existsSync(s.log) ? fs.readFileSync(s.log, 'utf8').trim().split('\n').filter((c) => c !== '--version') : []
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), calls }
}
const at = (calls: string[], needle: string) => calls.findIndex((c) => c.includes(needle))
const call = (calls: string[], needle: string) => calls.find((c) => c.includes(needle)) ?? ''

describe('build-ami.sh', () => {
  test('syntax (bash 3.2 on a Mac runs it too)', () => {
    for (const f of ['build-ami.sh', 'ami-chroot.sh', 'customize.sh']) {
      const p = Bun.spawnSync(['/bin/bash', '-n', path.join(REPO, 'scripts', 'image', f)], { stderr: 'pipe' })
      expect(`${f}: ${p.exitCode} ${p.stderr.toString()}`).toBe(`${f}: 0 `)
    }
  })

  test.skipIf(!OPENSSL)('a full build: order of calls, tags, and a manifest whose signature checks', () => {
    const s = setup()
    const key = path.join(s.dir, 'release.pem')
    Bun.spawnSync([OPENSSL!, 'genpkey', '-algorithm', 'ed25519', '-out', key])
    const r = run(s, ['--sign-key', key, '--test', '--tag', 'owner=ops'])
    expect(r.out).toContain('build-ami: done: AMI ami-0new')
    expect(r.code).toBe(0)
    const c = r.calls
    // order: the build resources, the chroot, then snapshot, image, and the removal of the build resources
    const order = ['create-security-group', 'authorize-security-group-ingress', 'run-instances', 'create-volume', 'wait instance-running',
      'ssh -i', 'attach-volume', 'ami-chroot.sh', 'detach-volume', 'create-snapshot', 'register-image', 'wait image-available', 'terminate-instances',
      'delete-volume', 'delete-security-group'].map((x) => at(c, x))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // the source AMI only from Debian's account
    expect(call(c, 'describe-images --image-ids ami-0source')).toContain('--owners 136693071363')
    // tags: build resources ax:managed=ami-build, the kept snapshot and AMI ax:managed=ami + ax:template; test tags on all
    for (const x of ['create-security-group', 'run-instances', 'create-volume']) {
      expect(call(c, x)).toContain('{Key=ax:managed,Value=ami-build}')
      expect(call(c, x)).toContain('{Key=trina-test,Value=ec2-driver}')
      expect(call(c, x)).toContain('{Key=owner,Value=ops}')
      expect(call(c, x)).toContain('{Key=Name,Value=trina-test-')
    }
    expect(call(c, 'run-instances')).toContain('ResourceType=volume,') // the builder's root volume is tagged too
    for (const x of ['create-snapshot', 'register-image']) {
      expect(call(c, x)).toContain('{Key=ax:managed,Value=ami},{Key=ax:template,Value=0.3.0-d13-20261105}')
      expect(call(c, x)).toContain('{Key=trina-test,Value=ec2-driver}')
    }
    // builder and work volume settings
    expect(call(c, 'run-instances')).toContain('HttpTokens=required')
    expect(call(c, 'run-instances')).toContain('--instance-initiated-shutdown-behavior terminate')
    expect(call(c, 'create-volume')).toContain('--snapshot-id snap-0source')
    expect(call(c, 'create-volume')).toContain('--encrypted')
    expect(call(c, 'authorize-security-group-ingress')).toContain('--port 22 --cidr 198.51.100.1/32')
    expect(call(c, 'ami-chroot.sh')).toContain('--volume-id vol-0work')
    expect(call(c, 'ssh')).toContain('StrictHostKeyChecking=yes')
    const reg = call(c, 'register-image')
    for (const x of ['--name trina-test-teamax-0.3.0-d13-20261105', '--architecture x86_64', '--ena-support', '--boot-mode uefi-preferred',
      '--imds-support v2.0', '--root-device-name /dev/xvda', '"SnapshotId":"snap-0new"', '"VolumeSize":20']) expect(reg).toContain(x)
    // nothing is deleted that this run did not make
    expect(c.filter((x) => / (terminate-instances|delete-volume|delete-security-group|delete-snapshot|deregister-image) /.test(` ${x} `)))
      .toEqual([expect.stringContaining('i-0build'), expect.stringContaining('vol-0work'), expect.stringContaining('sg-0build')])
    // the manifest: the fields of §10.2, its sha256 file, and the release-key signature over the version and that hash
    const mf = path.join(s.out, 'teamax-0.3.0-d13-20261105.ami.json')
    const bytes = fs.readFileSync(mf)
    const m = JSON.parse(bytes.toString())
    expect(m).toMatchObject({ v: 1, kind: 'ami', templateVersion: '0.3.0-d13-20261105', region: 'ap-northeast-2', imageId: 'ami-0new',
      rootSnapshotId: 'snap-0new', architecture: 'x86_64', sourceImageId: 'ami-0source', kitVersion: '0.3.0' })
    expect(m.builtAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    const sha = crypto.createHash('sha256').update(bytes).digest('hex')
    expect(fs.readFileSync(`${mf}.sha256`, 'utf8')).toBe(`${sha}  teamax-0.3.0-d13-20261105.ami.json\n`)
    const pub = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(key)))
    const sig = Buffer.from(fs.readFileSync(`${mf}.sig`, 'utf8'), 'base64')
    expect(crypto.verify(null, Buffer.from(`ax-template-v1\n0.3.0-d13-20261105\n${sha}`), pub, sig)).toBe(true)
    expect(fs.existsSync(path.join(s.out, 'ami-build-0.3.0-d13-20261105.state'))).toBe(false)
  })

  test('the chroot step fails: the builder, the work volume and the security group are removed, nothing is kept', () => {
    const s = setup()
    const r = run(s, [], { SSH_CHROOT_RC: '1' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('customize on the builder failed')
    const c = r.calls
    expect(at(c, 'create-snapshot')).toBe(-1)
    expect(call(c, 'terminate-instances')).toContain('--instance-ids i-0build')
    expect(call(c, 'delete-volume')).toContain('--volume-id vol-0work')
    expect(call(c, 'delete-security-group')).toContain('--group-id sg-0build')
    expect(at(c, 'delete-security-group')).toBeGreaterThan(at(c, 'wait instance-terminated'))
    expect(fs.existsSync(path.join(s.out, 'teamax-0.3.0-d13-20261105.ami.json'))).toBe(false)
    expect(fs.readFileSync(path.join(s.out, 'ami-build-0.3.0-d13-20261105.state'), 'utf8')).toBe('')
  })

  test('RegisterImage fails: the unregistered snapshot is deleted too', () => {
    const s = setup()
    const r = run(s, [], { FAIL_AT: 'register-image' })
    expect(r.code).not.toBe(0)
    expect(call(r.calls, 'delete-snapshot')).toContain('--snapshot-id snap-0new')
    expect(at(r.calls, 'terminate-instances')).toBeGreaterThan(at(r.calls, 'register-image'))
  })

  test('cleanup leaves alone an id whose ax:managed tag is not ours', () => {
    const s = setup()
    const r = run(s, [], { SSH_CHROOT_RC: '1', TAG_OVERRIDE: 'ec2-kr1' })
    expect(r.code).not.toBe(0)
    for (const x of ['terminate-instances', 'delete-volume', 'delete-security-group']) expect(at(r.calls, x)).toBe(-1)
    expect(r.out).toContain('left alone')
    expect(r.out).toContain('NOT removed')
    // the state file still names them, for --cleanup after a look by hand
    expect(fs.readFileSync(path.join(s.out, 'ami-build-0.3.0-d13-20261105.state'), 'utf8')).toBe('sg sg-0build\ninstance i-0build\nvolume vol-0work\n')
  })

  test('an AMI for the template version exists already: stop before any create call', () => {
    const s = setup()
    const r = run(s, [], { EXISTING_AMI: 'ami-0old' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('exists already: ami-0old')
    expect(r.calls.filter((c) => / (create|run|register)-/.test(` ${c}`))).toEqual([])
  })

  test('--account: another account stops before any change, also for --cleanup', () => {
    const s = setup()
    let r = run(s, ['--account', '999988887777'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('the AWS session is account 111122223333, not --account 999988887777')
    expect(r.calls).toEqual(['sts get-caller-identity --query Account --output text'].map((c) => `--region ap-northeast-2 ${c}`))
    r = run(s, ['--account', '111122223333'])
    expect(r.code).toBe(0)
    // without --account: stop before any call
    fs.rmSync(s.log, { force: true })
    const p = Bun.spawnSync(['/bin/bash', SCRIPT, '--subnet-id', 'subnet-0abc', '--yes'], {
      env: { PATH: `${s.bin}:/usr/bin:/bin`, HOME: s.dir, TMPDIR: s.dir, STUB_LOG: s.log }, stdout: 'pipe', stderr: 'pipe' })
    expect(p.exitCode).not.toBe(0)
    expect(p.stderr.toString()).toContain('--account <12-digit id> is required')
    expect(fs.existsSync(s.log) ? fs.readFileSync(s.log, 'utf8').trim() : '').toBe('')
    const state = path.join(s.dir, 'left.state')
    fs.writeFileSync(state, 'instance i-0left\n')
    fs.rmSync(s.log, { force: true })
    r = run(s, ['--account', '999988887777', '--cleanup', state])
    expect(r.code).not.toBe(0)
    expect(r.calls.filter((c) => / (terminate|delete)-/.test(` ${c}`))).toEqual([])
  })

  test('--dry-run prints the aws commands and calls nothing', () => {
    const s = setup()
    const r = run(s, ['--dry-run'])
    expect(r.code).toBe(0)
    expect(r.calls).toEqual([])
    expect(r.out).toContain('+ aws --region ap-northeast-2 ec2 run-instances')
    expect(r.out).toContain('dry run: would write')
  })

  test('refuses a binary that is not linux amd64, and a missing mycel-link', () => {
    const s = setup()
    elf(path.join(s.dir, 'mycel-link'), 0xb7)
    let r = run(s, [])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('is not an x86-64 Linux ELF')
    expect(r.calls).toEqual([])
    r = run(s, ['--link-bin', ''])
    expect(r.out).toContain('--link-bin is required')
    expect(r.calls).toEqual([])
    // a signed manifest is installable: never for a kitless image
    fs.writeFileSync(path.join(s.dir, 'k.pem'), 'x')
    r = run(s, ['--allow-missing-kit', '--sign-key', path.join(s.dir, 'k.pem')])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('--sign-key and --allow-missing-kit exclude each other')
    expect(r.calls).toEqual([])
  })
})
