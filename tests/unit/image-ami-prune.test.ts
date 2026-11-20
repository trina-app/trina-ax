// scripts/image/ami-prune-select.ts (which team images the release CI may remove) and scripts/image/ami-prune.sh with
// a stub `aws` on PATH. The 2026-11-20 case: the 0.5.21 run removed the 0.5.16 AMIs while the control plane still
// made new teams from them (its 0.5.21 rollout was still baking).
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type ImageFact, type PruneInput, releaseOf, selectPrune } from '../../scripts/image/ami-prune-select'

const REPO = path.resolve(import.meta.dir, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'image', 'ami-prune.sh')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-ami-prune-'))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const NOW = new Date('2026-11-20T08:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const img = (id: string, template: string, ageDays: number, extra: Record<string, string> = {}): ImageFact => ({
  id, created: daysAgo(ageDays), snaps: [`snap-${id.slice(4)}`],
  tags: [{ Key: 'ax:managed', Value: 'ami' }, { Key: 'ax:built-by', Value: 'release-ci' }, { Key: 'ax:template', Value: template },
    ...Object.entries(extra).map(([Key, Value]) => ({ Key, Value }))],
})
const base = (images: ImageFact[], more: Partial<PruneInput> = {}): PruneInput => ({
  images, launchTemplateImages: [], instances: [], volumes: [], keepReleases: 5, minAgeDays: 14, protectTemplates: [], now: NOW, ...more,
})
const action = (p: PruneInput) => Object.fromEntries(selectPrune(p).map((d) => [d.id, d.action]))
const reasons = (p: PruneInput, id: string) => selectPrune(p).find((d) => d.id === id)!.reasons.join('; ')

// the releases of 11-2026, one image each, ages as on 11-20
const INCIDENT = [
  img('ami-0510', '0.5.10-d13-20261101', 19), img('ami-0511', '0.5.11-d13-20261103', 17), img('ami-0512', '0.5.12-d13-20261104', 16),
  img('ami-0513', '0.5.13-d13-20261105', 15), img('ami-0515', '0.5.15-d13-20261110', 10), img('ami-0516', '0.5.16-d13-20261118', 2),
  img('ami-0518', '0.5.18-d13-20261119', 1), img('ami-0519', '0.5.19-d13-20261119', 1), img('ami-0520', '0.5.20-d13-20261120', 0.5),
  img('ami-0521', '0.5.21-d13-20261120', 0.1),
]

describe('ami-prune-select', () => {
  test('release of a template', () => {
    expect(releaseOf('0.5.16-d13-20261118')).toBe('0.5.16')
    expect(releaseOf('0.6.0-beta.2-d13-20261201')).toBe('0.6.0-beta.2')
  })

  test('the 11-20 case: 0.5.16 (two days old, five releases back) stays', () => {
    const a = action(base(INCIDENT, { protectTemplates: ['0.5.21-d13-20261120'] }))
    expect(a['ami-0516']).toBe('keep')
    // the old rule (3 images) would keep only 0.5.21, 0.5.20, 0.5.19; even 3 releases by age alone keeps it
    expect(action(base(INCIDENT, { keepReleases: 3 }))['ami-0516']).toBe('keep')
    expect(reasons(base(INCIDENT, { keepReleases: 3 }), 'ami-0516')).toContain('younger than 14 days')
    // old enough and outside the newest 5 releases: removed
    expect(a['ami-0510']).toBe('remove')
    expect(a['ami-0513']).toBe('remove')
    expect(a['ami-0515']).toBe('keep')
  })

  test('the newest releases count versions, not images: every image of a kept release stays', () => {
    const imgs = [
      img('ami-a1', '0.5.21-d13-20261101', 30), img('ami-a2', '0.5.21-d13-20261102', 30), img('ami-a3', '0.5.21-d13-20261103', 30),
      img('ami-b1', '0.5.20-d13-20261101', 30), img('ami-c1', '0.5.19-d13-20261101', 30),
    ]
    const a = action(base(imgs, { keepReleases: 2, minAgeDays: 0 }))
    expect(a).toEqual({ 'ami-a1': 'keep', 'ami-a2': 'keep', 'ami-a3': 'keep', 'ami-b1': 'keep', 'ami-c1': 'remove' })
  })

  test('version order, not text order or creation date (a backfill of an old release ranks by its release)', () => {
    const imgs = [img('ami-10', '0.5.10-d13-20261101', 30), img('ami-9', '0.5.9-d13-20261130', 30), img('ami-11', '0.5.11-d13-20261101', 30)]
    expect(action(base(imgs, { keepReleases: 2, minAgeDays: 0 }))).toEqual({ 'ami-10': 'keep', 'ami-11': 'keep', 'ami-9': 'remove' })
    expect(selectPrune(base(imgs, { keepReleases: 2, minAgeDays: 0 })).map((d) => d.release)).toEqual(['0.5.11', '0.5.10', '0.5.9'])
  })

  test('tags: ax:keep=true and ax:in-use always keep; ax:in-use=false does not', () => {
    const imgs = [...INCIDENT, img('ami-0400', '0.4.0-d13-20261001', 50, { 'ax:keep': 'true' }),
      img('ami-0401', '0.4.1-d13-20261002', 50, { 'ax:in-use': 'ec2-kr1' }), img('ami-0402', '0.4.2-d13-20261003', 50, { 'ax:in-use': 'false' }),
      img('ami-0403', '0.4.3-d13-20261003', 50, { 'ax:keep': 'false' })]
    const a = action(base(imgs))
    expect([a['ami-0400'], a['ami-0401'], a['ami-0402'], a['ami-0403']]).toEqual(['keep', 'keep', 'remove', 'remove'])
    expect(reasons(base(imgs), 'ami-0400')).toBe('ax:keep=true')
    expect(reasons(base(imgs), 'ami-0401')).toBe('ax:in-use=ec2-kr1')
  })

  test('in use: instances, launch templates, and tenants tagged with the template (instance or volume)', () => {
    const p = base(INCIDENT, {
      keepReleases: 1, minAgeDays: 0,
      instances: [{ id: 'i-0run', image: 'ami-0510', template: null }, { id: 'i-0tenant', image: 'ami-0other', template: '0.5.11-d13-20261103' }],
      launchTemplateImages: ['ami-0512'],
      volumes: [{ id: 'vol-0root', template: '0.5.13-d13-20261105' }],
      protectTemplates: ['0.5.15-d13-20261110'],
    })
    const a = action(p)
    expect([a['ami-0510'], a['ami-0511'], a['ami-0512'], a['ami-0513'], a['ami-0515']]).toEqual(['keep', 'keep', 'keep', 'keep', 'keep'])
    expect(reasons(p, 'ami-0510')).toBe('instances run from it (i-0run)')
    expect(reasons(p, 'ami-0511')).toBe('ax:template=0.5.11-d13-20261103 is on i-0tenant')
    expect(reasons(p, 'ami-0512')).toBe('a launch template uses it')
    expect(reasons(p, 'ami-0513')).toBe('ax:template=0.5.13-d13-20261105 is on vol-0root')
    expect(reasons(p, 'ami-0515')).toBe('just published')
    expect(a['ami-0516']).toBe('remove')
    expect(a['ami-0521']).toBe('keep')
  })

  test('unknown facts keep: no template, a template that is not a version, no creation date', () => {
    const odd: ImageFact[] = [
      { id: 'ami-0c01', created: daysAgo(90), tags: [{ Key: 'ax:managed', Value: 'ami' }] },
      { ...img('ami-0c02', 'manual-d13-1', 90) },
      { ...img('ami-0c03', '0.1.0-d13-20250101', 90), created: null },
    ]
    expect(action(base([...INCIDENT, ...odd]))).toMatchObject({ 'ami-0c01': 'keep', 'ami-0c02': 'keep', 'ami-0c03': 'keep' })
  })

  test('remove lists only well-formed root snapshot ids', () => {
    const p = base([{ ...img('ami-0a1d', '0.1.0-d13-20250101', 90), snaps: ['snap-0aa', null, 'bogus'] }, img('ami-0b2e', '0.2.0-d13-20250101', 90)], { keepReleases: 1 })
    expect(selectPrune(p).find((d) => d.id === 'ami-0a1d')).toMatchObject({ action: 'remove', snapshots: ['snap-0aa'] })
  })
})

// --- the shell script, with a stub aws ---
const STUB_AWS = `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_LOG"
a=" $* "
if [[ -n "\${FAIL_AT:-}" && "$a" == *" $FAIL_AT "* ]]; then echo "An error occurred (UnauthorizedOperation)" >&2; exit 254; fi
case "$a" in
  *" sts get-caller-identity "*) echo 111122223333 ;;
  *" describe-launch-template-versions "*) echo "" ;;
  *" describe-instances "*) cat "$STUB_DIR/instances.json" ;;
  *" describe-volumes "*) cat "$STUB_DIR/volumes.json" ;;
  *" describe-images "*) cat "$STUB_DIR/images.json" ;;
  *" describe-tags "*) echo release-ci ;;
  *" deregister-image "*|*" delete-snapshot "*) ;;
  *) echo "stub aws: unexpected $*" >&2; exit 1 ;;
esac
`
function stage(name: string, images: ImageFact[], instances: unknown[] = [], volumes: unknown[] = []) {
  const dir = path.join(ROOT, name)
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'aws'), STUB_AWS, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'images.json'), JSON.stringify(images))
  fs.writeFileSync(path.join(dir, 'instances.json'), JSON.stringify(instances))
  fs.writeFileSync(path.join(dir, 'volumes.json'), JSON.stringify(volumes))
  const log = path.join(dir, 'aws.log')
  const run = (args: string[], env: Record<string, string> = {}) => {
    fs.writeFileSync(log, '')
    const r = Bun.spawnSync(['bash', SCRIPT, '--account', '111122223333', '--region', 'ap-northeast-2', ...args], {
      env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, TMPDIR: dir, STUB_LOG: log, STUB_DIR: dir, ...env },
      stdout: 'pipe', stderr: 'pipe',
    })
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), calls: fs.readFileSync(log, 'utf8') }
  }
  return run
}

describe('ami-prune.sh', () => {
  // the script compares with the wall clock: the same ages, moved to now
  const live = INCIDENT.map((i) => ({ ...i, created: new Date(Date.parse(i.created!) + Date.now() - NOW.getTime()).toISOString() }))

  test('the 11-20 case: 0.5.16 stays, only images older than 14 days and outside the newest 5 releases go', () => {
    const run = stage('incident', live)
    const r = run(['--keep', '5', '--min-age-days', '14', '--protect-template', '0.5.21-d13-20261120'])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toMatch(/keep ami-0516 \(0\.5\.16-d13-20261118\): .*younger than 14 days/)
    expect(r.out).toMatch(/keep ami-0521 \(0\.5\.21-d13-20261120\): just published; release 0\.5\.21 is one of the newest 5/)
    expect(r.out).toContain('remove ami-0510 (0.5.10-d13-20261101) and its snapshot(s) snap-0510')
    const dereg = r.calls.split('\n').filter((l) => l.includes('deregister-image')).map((l) => l.split(' ').at(-1)).sort()
    expect(dereg).toEqual(['ami-0510', 'ami-0511', 'ami-0512', 'ami-0513'])
    expect(r.calls).toContain('delete-snapshot --snapshot-id snap-0510')
  })

  test('--dry-run changes nothing and prints what it would do', () => {
    const run = stage('dry', live)
    const r = run(['--dry-run'])
    expect(r.code, r.err).toBe(0)
    expect(r.calls).not.toMatch(/deregister-image|delete-snapshot/)
    expect(r.out).toContain('+ aws --region ap-northeast-2 ec2 deregister-image --image-id ami-0510')
    expect(r.out).toContain('(dry run: nothing changed)')
  })

  test('a tenant instance tagged with the template keeps its image', () => {
    const run = stage('tenant', live, [{ id: 'i-0t', image: 'ami-0gone', template: '0.5.10-d13-20261101' }])
    const r = run([])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain('keep ami-0510 (0.5.10-d13-20261101): ax:template=0.5.10-d13-20261101 is on i-0t')
    expect(r.calls).not.toContain('--image-id ami-0510')
  })

  for (const op of ['describe-instances', 'describe-volumes', 'describe-launch-template-versions', 'describe-images']) {
    test(`${op} fails: nothing removed in that region`, () => {
      const run = stage(`fail-${op}`, live)
      const r = run([], { FAIL_AT: op })
      expect(r.code, r.err).toBe(0)
      expect(r.out).toContain('nothing removed in ap-northeast-2')
      expect(r.calls).not.toMatch(/deregister-image|delete-snapshot/)
    })
  }
})
