import { z } from 'zod'

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
export const HWP_LIMITS = {
  inputBytes: 20 * 1024 ** 2, expandedBytes: 64 * 1024 ** 2, entries: 1000,
  pages: 200, cells: 10000, rows: 256, cols: 256, edge: 2048,
  timeoutMs: 20000, rssMiB: 768, outputBytes: 32 * 1024 ** 2,
  perPerson: 1, perServer: 1, cacheBytes: 128 * 1024 ** 2,
} as const
