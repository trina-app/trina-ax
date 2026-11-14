// The new-team server image on the feed (scripts/release/publish-ami.ts) and the workflows that build it
// (.github/workflows/team-image.yml, release.yml build-ami; docs/RELEASE-CI.md 10장).
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkManifest, POINTER, publishAmi, verifyTemplateSig } from '../../scripts/release/publish-ami'
import { dirStore } from '../../scripts/release/publish-server'

const ROOT = path.resolve(import.meta.dir, '../..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-ami-test-'))
afterAll(() => fs.rmSync(T, { recursive: true, force: true }))

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const PUB = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64')
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex')
let n = 0

/** a manifest as ami-manifest-v2.sh writes it: the file, its .sha256 and its .sig */
function manifest(o: { version?: string; template?: string; kit?: string; sign?: crypto.KeyObject; sums?: string; built?: string } = {}): string {
  const version = o.version ?? '0.5.3'
  const tv = o.template ?? `${version}-d13-20261114`
  const dir = path.join(T, `m${++n}`)
  fs.mkdirSync(dir)
  const name = `teamax-${tv}.v2.ami.json`
  const f = path.join(dir, name)
  const body = JSON.stringify({ v: 2, kind: 'ami', templateVersion: tv, architecture: 'x86_64', images: { 'ap-northeast-2': { imageId: 'ami-0123abcd', rootSnapshotId: 'snap-0123abcd' }, 'ap-southeast-1': { imageId: 'ami-0456abcd', rootSnapshotId: 'snap-0456abcd' } }, kitVersion: o.kit ?? version, builtAt: o.built ?? '2026-11-14T00:00:00Z' }) + '\n'
  fs.writeFileSync(f, body)
  fs.writeFileSync(`${f}.sha256`, o.sums ?? `${sha(body)}  ${name}\n`)
  fs.writeFileSync(`${f}.sig`, crypto.sign(null, Buffer.from(`ax-template-v1\n${tv}\n${sha(body)}`), o.sign ?? privateKey).toString('base64'))
  return f
}

describe('publish-ami: the signed v2 manifest beside its release', () => {
  test('the signature is hostd\'s: base64 Ed25519 over "ax-template-v1\\n<template>\\n<sha256>"', () => {
    const sig = crypto.sign(null, Buffer.from('ax-template-v1\n0.5.3-d13-20261114\nabc'), privateKey).toString('base64')
    expect(verifyTemplateSig('0.5.3-d13-20261114', 'abc', sig, [PUB])).toBe(true)
    expect(verifyTemplateSig('0.5.3-d13-20261115', 'abc', sig, [PUB])).toBe(false)
    expect(verifyTemplateSig('0.5.3-d13-20261114', 'abc', 'bm90IGEgc2ln', [PUB])).toBe(false)
  })

  test('uploads the manifest, .sha256, .sig, then team-image.json; a second run uploads nothing', async () => {
    const feed = path.join(T, 'feed1')
    const store = dirStore(feed, 'https://127.0.0.1:1')
    const m = manifest()
    const lines: string[] = []
    const r = await publishAmi({ version: '0.5.3', manifest: m, store, keys: [PUB], log: (l) => lines.push(l) })
    const name = 'teamax-0.5.3-d13-20261114.v2.ami.json'
    expect(r.uploaded).toEqual([`server/0.5.3/${name}`, `server/0.5.3/${name}.sha256`, `server/0.5.3/${name}.sig`, `server/0.5.3/${POINTER}`])
    expect(fs.readFileSync(path.join(feed, 'server/0.5.3', name))).toEqual(fs.readFileSync(m))
    expect(JSON.parse(fs.readFileSync(path.join(feed, 'server/0.5.3', POINTER), 'utf8'))).toEqual({ v: 1, templateVersion: '0.5.3-d13-20261114', manifest: name, sha256: sha(fs.readFileSync(m)) })
    expect((await publishAmi({ version: '0.5.3', manifest: m, store, keys: [PUB], log: () => {} })).status).toBe('there')
  })

  test('the pointer goes up last: a store that fails on the third file leaves no team-image.json', async () => {
    const feed = path.join(T, 'feed2')
    const base = dirStore(feed, 'https://127.0.0.1:1')
    let puts = 0
    const store = { ...base, put: async (k: string, f: string, t: string) => { if (++puts === 3) throw new Error('HTTP 502'); return base.put(k, f, t) } }
    await expect(publishAmi({ version: '0.5.3', manifest: manifest(), store, keys: [PUB], log: () => {} })).rejects.toThrow(/502/)
    expect(fs.existsSync(path.join(feed, 'server/0.5.3', POINTER))).toBe(false)
  })

  test('never replaces: other bytes on the feed, or a release that has another image, stop the run', async () => {
    const feed = path.join(T, 'feed3')
    const store = dirStore(feed, 'https://127.0.0.1:1')
    await publishAmi({ version: '0.5.3', manifest: manifest(), store, keys: [PUB], log: () => {} })
    // the same name, other bytes (another build of the same day)
    await expect(publishAmi({ version: '0.5.3', manifest: manifest({ built: '2026-11-14T01:00:00Z' }), store, keys: [PUB], log: () => {} })).rejects.toThrow(/names another image already/)
    await expect(publishAmi({ version: '0.5.3', manifest: manifest({ template: '0.5.3-d13-20261115' }), store, keys: [PUB], log: () => {} })).rejects.toThrow(/names another image already/)
    // the same template on the feed already without its pointer: a file with other bytes is never replaced
    fs.rmSync(path.join(feed, 'server/0.5.3', POINTER))
    await expect(publishAmi({ version: '0.5.3', manifest: manifest({ built: '2026-11-14T01:00:00Z' }), store, keys: [PUB], log: () => {} })).rejects.toThrow(/never replaced/)
  })

  test('refused before anything goes up: wrong key, wrong sums, another release\'s template or kit, not a v2 name', () => {
    expect(() => checkManifest('0.5.3', manifest({ sign: crypto.generateKeyPairSync('ed25519').privateKey }), [PUB])).toThrow(/not a signature/)
    expect(() => checkManifest('0.5.3', manifest(), [])).toThrow(/not a signature/)
    expect(() => checkManifest('0.5.3', manifest({ sums: `${'0'.repeat(64)}  x\n` }), [PUB])).toThrow(/\.sha256/)
    expect(() => checkManifest('0.5.3', manifest({ version: '0.5.2' }), [PUB])).toThrow(/not one of release 0\.5\.3/)
    expect(() => checkManifest('0.5.3', manifest({ kit: '0.5.2' }), [PUB])).toThrow(/kit 0\.5\.2/)
    const v1 = path.join(T, 'teamax-0.5.3-d13-20261114.ami.json')
    fs.writeFileSync(v1, '{}')
    expect(() => checkManifest('0.5.3', v1, [PUB])).toThrow(/not a v2 AMI manifest name/)
    expect(checkManifest('0.5.3', manifest(), [PUB]).templateVersion).toBe('0.5.3-d13-20261114')
  })
})

describe('the workflows', () => {
  type Step = { name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }
  type Job = { if?: string; needs?: string[]; environment?: string; permissions?: Record<string, string>; 'continue-on-error'?: boolean; steps: Step[] }
  const rel = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')) as { concurrency: { group: string }; jobs: Record<string, Job> }
  const img = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/team-image.yml'), 'utf8')) as { on: Record<string, unknown>; concurrency: { group: string }; jobs: Record<string, Job> }

  test('release.yml only starts the image: stable, after the feed, never failing the release, a notice without AWS', () => {
    const j = rel.jobs['build-ami']!
    expect(j.needs).toEqual(['prepare', 'publish'])
    for (const c of ["needs.publish.result == 'success'", "needs.prepare.outputs.channel == 'stable'", "needs.prepare.outputs.feed == 'true'", '!inputs.office_only']) expect(j.if).toContain(c)
    expect(j['continue-on-error']).toBe(true)
    expect(j.permissions).toEqual({ actions: 'write' })
    const run = j.steps.map((s) => s.run ?? '').join('\n')
    expect(run).toContain('if [ -z "$AWS_ROLE_ARN" ]; then echo "::notice::')
    expect(run).toContain('gh workflow run team-image.yml --repo "$GITHUB_REPOSITORY" --ref "$TAG" -f tag="$TAG"')
    // no secret and no AWS in the release run
    expect(JSON.stringify(j)).not.toMatch(/secrets\.|configure-aws-credentials/)
  })

  test('team-image.yml: its own concurrency group, environment release, OIDC by a pinned action, the key only while signing', () => {
    expect(Object.keys(img.on)).toEqual(['workflow_dispatch'])
    expect(img.concurrency.group).not.toBe(rel.concurrency.group)
    const j = img.jobs['build-ami']!
    expect(j.environment).toBe('release')
    expect(j.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
    const aws = j.steps.find((s) => s.uses?.startsWith('aws-actions/configure-aws-credentials@'))!
    expect(aws.uses).toMatch(/@[0-9a-f]{40}$/)
    expect(fs.readFileSync(path.join(ROOT, '.github/workflows/team-image.yml'), 'utf8')).toMatch(/configure-aws-credentials@[0-9a-f]{40} # v\d+\.\d+\.\d+/)
    expect(aws.with).toMatchObject({ 'role-to-assume': '${{ vars.AWS_ROLE_ARN }}', 'aws-region': '${{ env.AMI_REGION }}' })
    for (const s of j.steps) if (s.uses) expect(s.uses, s.uses).toMatch(/@[0-9a-f]{40}$/)
    // the release key: one step writes it (600) and removes it, and an always() step removes it again
    const withKey = j.steps.filter((s) => JSON.stringify(s).includes('secrets.RELEASE_SIGNING_KEY }}'))
    expect(withKey.length).toBe(1)
    expect(withKey[0]!.run).toContain('umask 077')
    expect(withKey[0]!.run).toContain('trap \'rm -f "$key"\' EXIT')
    expect(j.steps.find((s) => s.name === 'Remove the release key')).toMatchObject({ if: 'always()', run: 'rm -f "$RUNNER_TEMP/release-key.pem"' })
    // without settings: a notice and no failure
    expect(j.steps[0]!.run).toContain('::notice::no team image')
    // the inputs reach the shell only through env
    for (const s of j.steps) expect(s.run ?? '', s.name).not.toMatch(/\$\{\{\s*inputs\./)
    const run = j.steps.map((s) => s.run ?? '').join('\n')
    expect(run).toContain('--tag ax:built-by=release-ci')
    expect(run).toContain('--manifest-v2 --yes')
    expect(run).toContain('scripts/image/ami-prune.sh --account "$ACCOUNT" --keep "$AMI_KEEP"')
  })

  test('the IAM policy docs are JSON and scope deletes to the CI\'s tag', () => {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/runbooks/team-image-iam-policy.json'), 'utf8')) as { Statement: { Sid: string; Effect: string; Action: string | string[]; Condition?: Record<string, Record<string, unknown>> }[] }
    const trust = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/runbooks/team-image-trust-policy.json'), 'utf8')) as { Statement: { Condition: { StringEquals: Record<string, string> } }[] }
    expect(trust.Statement[0]!.Condition.StringEquals['token.actions.githubusercontent.com:sub']).toBe('repo:trina-app/trina-ax:environment:release')
    const acts = (s: { Action: string | string[] }) => ([] as string[]).concat(s.Action)
    for (const s of p.Statement.filter((s) => s.Effect === 'Allow')) {
      expect(acts(s).some((a) => a.startsWith('iam:')), s.Sid).toBe(false)
      if (acts(s).some((a) => /^ec2:(Deregister|Delete|Terminate)/.test(a))) expect(s.Condition, s.Sid).toBeDefined()
    }
  })
})
