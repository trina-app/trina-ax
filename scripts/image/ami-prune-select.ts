// Which of the release CI's team images ami-prune.sh may remove in one region (docs/RELEASE-CI.md "새 팀 서버 이미지").
// Pure: the shell script reads AWS and passes the answers in as JSON files; this decides and prints one line per image:
//
//   keep<TAB><ami><TAB><template><TAB><every reason, "; "-joined>
//   remove<TAB><ami><TAB><template><TAB><root snapshot ids, space-separated>
//
// An image stays when ANY rule says so. Removing an image that is in use stops new teams (2026-11-20: the 0.5.21 run
// removed 0.5.16 while the control plane still made new teams from it), keeping one too many costs a snapshot.
//
//   bun scripts/image/ami-prune-select.ts --images F --launch-templates F --instances F --volumes F
//       [--keep 5] [--min-age-days 14] [--protect-template T …] [--now ISO]

import fs from 'node:fs'

export interface AwsTag { Key: string; Value: string }
export interface ImageFact { id: string; created?: string | null; tags?: AwsTag[] | null; snaps?: (string | null)[] | null }
export interface InstanceFact { id: string; image?: string | null; template?: string | null }
export interface VolumeFact { id: string; template?: string | null }
export interface PruneInput {
  images: ImageFact[]
  /** image ids the latest and default versions of the region's launch templates name */
  launchTemplateImages: string[]
  /** instances that are not terminated (any owner tag: production lives in the same account) */
  instances: InstanceFact[]
  /** EBS volumes with an ax:template tag. ax:template on tenant instances and root volumes, and ax:in-use on images,
   *  are set outside this repo (trina-cloud hostd / control plane): only what they actually tag is matched here, and an
   *  image without such a tag is protected by the image-id matches (instances, launch templates) alone */
  volumes: VolumeFact[]
  /** the newest this many releases (versions, not images) keep all their images */
  keepReleases: number
  /** an image younger than this stays (the hosted rollout lag, which the CI cannot read) */
  minAgeDays: number
  protectTemplates: string[]
  now: Date
  /** the ids that can be decided (default: AMI ids). The Lightsail images (lightsail-feed.ts) are snapshot names */
  idRe?: RegExp
}
export interface PruneDecision { id: string; template: string; release: string; action: 'keep' | 'remove'; reasons: string[]; snapshots: string[] }

const tag = (i: ImageFact, k: string) => i.tags?.find((t) => t.Key === k)?.Value
/** the release of a template: 0.5.16-d13-20261118 → 0.5.16 */
export function releaseOf(template: string): string {
  return template.replace(/-d\d+-\d+.*$/, '')
}
const isSemver = (v: string) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(v)

export function selectPrune(p: PruneInput): PruneDecision[] {
  const releases = [...new Set(p.images.map((i) => releaseOf(tag(i, 'ax:template') ?? '')).filter(isSemver))]
    .sort((a, b) => Bun.semver.order(b, a))
  const newest = new Set(releases.slice(0, Math.max(1, p.keepReleases)))
  const lt = new Set(p.launchTemplateImages)
  const runFrom = new Map<string, string[]>()
  const usedTemplates = new Map<string, string[]>()
  const add = (m: Map<string, string[]>, k: string | null | undefined, v: string) => { if (k && k !== 'None') m.set(k, [...(m.get(k) ?? []), v]) }
  for (const i of p.instances) { add(runFrom, i.image, i.id); add(usedTemplates, i.template, i.id) }
  for (const v of p.volumes) add(usedTemplates, v.template, v.id)
  const minAgeMs = p.minAgeDays * 86_400_000
  const createdOf = (i: ImageFact) => (i.created ? Date.parse(i.created) : NaN)
  // the age counts from the build, not from when the control plane switched to it: after many releases inside the
  // floor, the release the control plane may still use is the newest one already past it. Its images always stay.
  const pastFloor = [...new Set(p.images.filter((i) => { const c = createdOf(i); return Number.isFinite(c) && p.now.getTime() - c >= minAgeMs })
    .map((i) => releaseOf(tag(i, 'ax:template') ?? '')).filter(isSemver))].sort((a, b) => Bun.semver.order(b, a))[0]

  return p.images
    .map((img) => {
      const template = tag(img, 'ax:template') ?? ''
      const release = releaseOf(template)
      const reasons: string[] = []
      if (!template) reasons.push('no ax:template tag')
      else if (!isSemver(release)) reasons.push(`release "${release}" is not a version`)
      if (template && p.protectTemplates.includes(template)) reasons.push('just published')
      if (tag(img, 'ax:keep')?.toLowerCase() === 'true') reasons.push('ax:keep=true')
      const inUse = tag(img, 'ax:in-use')
      if (inUse && inUse.toLowerCase() !== 'false') reasons.push(`ax:in-use=${inUse}`)
      if (newest.has(release)) reasons.push(`release ${release} is one of the newest ${newest.size}`)
      const created = createdOf(img)
      if (!Number.isFinite(created)) reasons.push('creation date unknown')
      else if (p.now.getTime() - created < minAgeMs) reasons.push(`younger than ${p.minAgeDays} days (${img.created})`)
      else if (release === pastFloor) reasons.push(`release ${release} is the newest one older than ${p.minAgeDays} days`)
      if (lt.has(img.id)) reasons.push('a launch template uses it')
      const r = runFrom.get(img.id)
      if (r) reasons.push(`instances run from it (${r.join(' ')})`)
      const u = template ? usedTemplates.get(template) : undefined
      if (u) reasons.push(`ax:template=${template} is on ${u.join(' ')}`)
      const snapshots = (img.snaps ?? []).filter((s): s is string => !!s && /^snap-[0-9a-f]+$/.test(s))
      return { id: img.id, template, release, action: reasons.length ? 'keep' : 'remove', reasons, snapshots } satisfies PruneDecision
    })
    .filter((d) => (p.idRe ?? /^ami-[0-9a-f]+$/).test(d.id))
    .sort((a, b) => (isSemver(a.release) && isSemver(b.release) ? Bun.semver.order(b.release, a.release) : 0) || a.template.localeCompare(b.template))
}

function readJson<T>(file: string): T {
  const t = fs.readFileSync(file, 'utf8').trim()
  return (t && t !== 'null' ? JSON.parse(t) : []) as T
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const one = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
  const need = (k: string) => one(k) ?? (console.error(`ami-prune-select: ${k} is required`), process.exit(2))
  const protect: string[] = []
  args.forEach((a, i) => { if (a === '--protect-template' && args[i + 1]) protect.push(args[i + 1]!) })
  const keep = Number(one('--keep') ?? 5)
  const minAge = Number(one('--min-age-days') ?? 14)
  if (!Number.isInteger(keep) || keep < 1 || !Number.isFinite(minAge) || minAge < 0) { console.error('ami-prune-select: bad --keep or --min-age-days'); process.exit(2) }
  const now = one('--now') ? new Date(one('--now')!) : new Date()
  // only literal AMI ids: a launch template that names its image as resolve:ssm:… is not matched
  const lt = fs.readFileSync(need('--launch-templates'), 'utf8').split(/\s+/).filter((s: string) => /^ami-[0-9a-f]+$/.test(s))
  const out = selectPrune({
    images: readJson<ImageFact[]>(need('--images')), launchTemplateImages: lt,
    instances: readJson<InstanceFact[]>(need('--instances')), volumes: readJson<VolumeFact[]>(need('--volumes')),
    keepReleases: keep, minAgeDays: minAge, protectTemplates: protect, now,
  })
  for (const d of out) console.log([d.action, d.id, d.template || '-', d.action === 'keep' ? d.reasons.join('; ') : d.snapshots.join(' ')].join('\t'))
}
