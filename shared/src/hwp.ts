import { z } from 'zod'

/** The HWP Preview plugin (resources/plugins/catalog.json): the server's renderer driver and the web's "turn it on" hint */
export const HWP_PLUGIN_ID = 'app.trina.hwp-preview'
/** Stable diagnostics; clients translate codes, never display parser stderr or document-controlled text. */
export const HwpReason = z.enum(['disabled', 'locked', 'distribution', 'damaged', 'unsupported', 'limit', 'timeout', 'cancelled', 'busy', 'engine', 'isolation', 'changed', 'loss'])
export type HwpReason = z.infer<typeof HwpReason>
export const HwpWarning = z.enum(['font_substitution', 'layout_approximation', 'memory_watchdog'])
export type HwpWarning = z.infer<typeof HwpWarning>
export const HwpPage = z.object({
  page: z.number().int().min(1), pageCount: z.number().int().min(1).max(200),
  width: z.number().int().positive().max(2048), height: z.number().int().positive().max(2048),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), engine: z.string(), fonts: z.string(),
  warnings: z.array(HwpWarning),
})
export type HwpPage = z.infer<typeof HwpPage>
/** What a preview request asks for (a team file's adds its path): a 1-based page, and the id of the page shown before
 * (a cache hit only; never a capability) */
export const HwpPreviewQuery = z.object({ page: z.coerce.number().int().min(1).max(200), cacheId: z.string().uuid().optional() })
/** One rendered page: the server's PNG (base64) with its facts; the id names it in the server's cache */
export const HwpPreviewPage = HwpPage.extend({ id: z.string().uuid(), png: z.string().max(45 * 1024 * 1024) })
export type HwpPreviewPage = z.infer<typeof HwpPreviewPage>
export const HWP_LIMITS = {
  inputBytes: 20 * 1024 ** 2, expandedBytes: 64 * 1024 ** 2, entries: 1000,
  pages: 200, cells: 10000, rows: 256, cols: 256, edge: 2048,
  timeoutMs: 20000, rssMiB: 768, outputBytes: 32 * 1024 ** 2,
  perPerson: 1, perServer: 1, cacheBytes: 128 * 1024 ** 2,
} as const
