// A system sheet the page opens over itself (the photo picker, photo-pick-v1; the share sheet, share-text-v1). Pure: no
// native imports, so the tests run it without Expo.

/** How long after a sheet closed the page may open the next one. */
export const SHEET_COOLDOWN_MS = 1500

/** One system sheet at a time, and none again within `ms` after the last one closed, so a page cannot keep a sheet on
 * screen (or open one sheet after another) without the person tapping anything. One gate for both sheets. */
export class SheetGate {
  private open = false
  private closed = -Infinity
  constructor(private ms = SHEET_COOLDOWN_MS, private now: () => number = Date.now) {}
  /** A sheet could open now. */
  get ready(): boolean { return !this.open && this.now() - this.closed >= this.ms }
  async run<T>(show: () => Promise<T>): Promise<T> {
    if (!this.ready) throw new Error('sheet_busy')
    this.open = true
    try { return await show() } finally { this.open = false; this.closed = this.now() }
  }
}
