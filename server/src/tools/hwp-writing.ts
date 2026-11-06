// Writing and filling Hangul documents (make_file with format hwpx or a .hwpx template, and edit_hwp) come with the HWP
// plugin: only a team that installed it and turned it on has them (docs/DECISIONS.md "Hangul writing and filling come
// with the HWP plugin"). The writer and the editors stay core code: a plugin carries data and binaries for drivers
// core knows, never TypeScript, and neither of them runs rhwp. So the gate is "installed and on for the company", not
// "its renderer can run here": a damaged store, a build core no longer accepts or missing isolation turn the preview
// off, and a declined page-image permission hwp_render, but not writing. Reading .hwp/.hwpx text, search, the original
// download and the refusal of plaintext writes to them stay on for every team.
import { MakeFileInput } from '@mycel/shared'
import { DEFAULT_LOCALE, Locale } from '@mycel/shared/api'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../context'
import { tr } from '../chat/i18n'
import { pluginsOf } from '../plugins/manager'

/** Hangul writing is on now. Read at every turn, listing and call, so turning the plugin on or off, updating, rolling
 * it back or removing it takes effect at once, without a restart. */
export function hwpWritingOn(ctx: AppContext): boolean {
  try { return pluginsOf(ctx).hwpWriting() } catch { return false }
}

/** This call writes a Hangul document: every edit_hwp, and make_file with format hwpx or a .hwpx template. */
export function writesHangul(tool: string, args: unknown): boolean {
  if (tool === 'edit_hwp') return true
  if (tool !== 'make_file' || !args || typeof args !== 'object') return false
  const a = args as { format?: unknown; template?: unknown }
  return a.format === 'hwpx' || (typeof a.template === 'string' && /\.hwpx$/i.test(a.template.trim().replace(/\/+$/, '')))
}

/** The refusal of a Hangul write while the plugin is off, in the person's language (the AI passes it on). */
export function hwpWritingOffText(locale: Locale): string { return tr('hwpWritingOff', locale) }
export function hwpWritingOffTextFor(db: Database, userId: string): string {
  const v = Locale.safeParse((db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale?: string } | null)?.locale)
  return hwpWritingOffText(v.success ? v.data : DEFAULT_LOCALE)
}

/** make_file's input as the AI is shown it while Hangul writing is off: no hwpx format and no .hwpx template. Calls are
 * still parsed with MakeFileInput (the contract), and make_file refuses a Hangul one (tools/index.ts). */
export const MakeFileInputWithoutHwpx = z.strictObject({
  ...MakeFileInput.shape,
  format: MakeFileInput.shape.format.exclude(['hwpx']),
  template: MakeFileInput.shape.template.describe('Template file under skills/ (.docx or .pptx, the same format as the output)'),
})
