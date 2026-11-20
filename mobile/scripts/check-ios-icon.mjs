// The iPhone app's icon as built: `xcrun assetutil --info <app>/Assets.car` on stdin (scripts/ios-release.sh).
// iOS 18+ draws the Dark and Tinted home screen styles, Notification Center, the lock screen and every notification banner
// from the icon's dark and tinted appearances; a build without them gets a darkened icon, the black tile of 1.0.8
// (QA TC-5234..5238, TC-5587). The edition gives all three the one light tile (app.config.ts), so the compiled catalog
// must hold an opaque AppIcon in each appearance and the dark and tinted ones must be that same picture (actool stores one
// picture once; a different size on disk is a different picture). No transparency: iOS fills it with black.
// Exit 0 when the icon is right; otherwise it says what is wrong and exits 1.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

/** @param {unknown} info the parsed assetutil output @returns {string[]} problems, none when the icon is right */
export function iconProblems(info) {
  if (!Array.isArray(info)) return ['assetutil output is not a list']
  const icons = info.filter((r) => r && r.Name === 'AppIcon' && r.AssetType === 'Icon Image')
  const by = (appearance) => icons.find((r) => (r.Appearance ?? null) === appearance)
  const slots = { light: by(null), dark: by('UIAppearanceDark'), tinted: by('ISAppearanceTintable') }
  const problems = []
  for (const [slot, r] of Object.entries(slots)) {
    if (!r) { problems.push(`no ${slot} AppIcon in Assets.car`); continue }
    if (r.Opaque !== true) problems.push(`the ${slot} AppIcon has transparency (iOS fills it with black)`)
  }
  if (slots.light) for (const slot of ['dark', 'tinted']) {
    const r = slots[slot]
    if (r && r.SizeOnDisk !== slots.light.SizeOnDisk) problems.push(`the ${slot} AppIcon is not the light tile`)
  }
  return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = iconProblems(JSON.parse(fs.readFileSync(0, 'utf8')))
  for (const p of problems) console.error(`app icon: ${p}`)
  process.exit(problems.length ? 1 : 0)
}
