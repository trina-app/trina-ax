// Native drivers core implements (docs/PLUGINS.md "네이티브 도구"). A native package only supplies bytes for a driver
// core already knows; core keeps the adapter, argv, isolation profile, limits and pins. rhwp-v1 (HWP preview) accepts
// exactly the rhwp executables and the font pinned in resources/hwp/manifest.json, so even a correctly signed package
// cannot swap in another renderer build: that needs a reviewed core update.
import type { PluginManifest } from '@mycel/shared/plugins'
import hwpPins from '../../../resources/hwp/manifest.json'
import type { PluginUnsupported } from '@mycel/shared/api'

export interface DriverSpec {
  /** the tool names this driver serves (contributes.tools[].name) */
  tools: readonly string[]
  /** file extensions it may preview */
  previewExtensions: readonly string[]
}

export const DRIVERS: Record<string, DriverSpec> = {
  'rhwp-v1': { tools: ['hwp_render'], previewExtensions: ['hwp', 'hwpx'] },
}

/** The plugin id whose rhwp-v1 package drives HWP preview and hwp_render. */
export const HWP_PLUGIN_ID = 'app.trina.hwp-preview'

/** null when the package is a build this driver accepts; otherwise why not. `sha` maps payload paths to SHA-256. */
export function driverMismatch(m: PluginManifest, sha: (path: string) => string | undefined): PluginUnsupported | null {
  // the HWP id belongs to the rhwp-v1 native package only (a skill pack or other kind under it could switch HWP on)
  if (m.id === HWP_PLUGIN_ID && m.runtime?.driver !== 'rhwp-v1') return 'driver'
  if (!m.runtime) return null
  const spec = DRIVERS[m.runtime.driver]
  if (!spec) return 'driver'
  for (const t of m.contributes.tools ?? []) if (t.driver !== m.runtime.driver || !spec.tools.includes(t.name)) return 'driver'
  for (const p of m.contributes.previews ?? []) if (p.extensions.some((e) => !spec.previewExtensions.includes(e))) return 'driver'
  if (m.runtime.driver === 'rhwp-v1') {
    if (m.id !== HWP_PLUGIN_ID) return 'driver'
    const platform = m.platforms?.[0]
    const pin = platform ? (hwpPins.targets as Record<string, { binary: string } | undefined>)[`${platform.os}-${platform.arch}`] : undefined
    if (!pin || sha(m.runtime.executable) !== pin.binary) return 'driver'
    const fonts = m.runtime.fonts.map((f) => sha(f))
    if (fonts.length !== hwpPins.fonts.length || hwpPins.fonts.some((f) => !fonts.includes(f.sha256))) return 'driver'
    if (!m.components.some((c) => c.name === 'rhwp' && c.version === hwpPins.version)) return 'driver'
  }
  return null
}
