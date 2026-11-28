// Single-use download tickets for file_upload (docs/decisions/20261126-browser-file-upload.md). The AI names team files
// (or files sent in the chat); the server reads and checks them as the person, keeps the exact bytes it checked here
// and gives the desktop app one ticket per file instead of the path. The app fetches each ticket once through the team
// page's own session (GET /api/browser/uploads/:ticket), checks its size and sha256 and sets the file on the page.
//   - a ticket is 32 random bytes (base64url), bound to the person (and the window the call went to, for the record);
//   - it serves the bytes that were checked, once, after the file is checked again (access, unchanged);
//   - it ends at the call's deadline, when the call is over (revokeCall), or on first use; nothing is written to disk;
//   - all tickets waiting on this server hold at most MAX_PENDING_BYTES: a call over that is refused, not queued.
import { randomBytes } from 'node:crypto'
import { isChromeWindow } from './call-relay'

/** bytes waiting in tickets on the whole server at most (each call is at most 100 MB: three such calls at once) */
export const MAX_PENDING_BYTES = 300_000_000

export interface UploadTicketInput {
  userId: string
  windowId: string
  callId: string
  name: string
  bytes: Buffer
  sha256: string
  /** epoch ms: the ticket is gone after this (the call's deadline) */
  expiresAt: number
  /** checked right before the bytes are served: throws (or returns false) when the person may no longer send the file
   * (access removed, the file changed or is held by the safety check now) */
  recheck: () => boolean | void
}

interface Ticket extends UploadTicketInput { id: string }

export class BrowserUploads {
  private tickets = new Map<string, Ticket>()
  private pending = 0

  constructor(private now: () => number = Date.now) {}

  /** Bytes waiting now (tests and the refusal). */
  get pendingBytes(): number { this.sweep(); return this.pending }

  /** Can `bytes` more wait now? */
  fits(bytes: number): boolean { this.sweep(); return this.pending + bytes <= MAX_PENDING_BYTES }

  /** Tickets for one call's files, all or none (null: over MAX_PENDING_BYTES). */
  issue(files: UploadTicketInput[]): string[] | null {
    const total = files.reduce((n, f) => n + f.bytes.length, 0)
    if (!this.fits(total)) return null
    return files.map((f) => {
      const id = randomBytes(32).toString('base64url')
      this.tickets.set(id, { ...f, id })
      this.pending += f.bytes.length
      return id
    })
  }

  /**
   * The bytes behind a ticket for this person, once. null (the route answers 404 for every case alike): no such
   * ticket, another person's or another window kind's (it stays usable), expired, or the recheck failed (the ticket is
   * gone then). `from`: the linked Chrome's window that asks (chrome:<linkId>); absent: the desktop app's page session.
   */
  take(id: string, userId: string, from?: string): { name: string; bytes: Buffer; sha256: string } | null {
    this.sweep()
    const t = this.tickets.get(id)
    if (!t || t.userId !== userId) return null
    // a ticket made for the person's linked Chrome is taken only with that link's token, and the desktop's only through
    // the team page's session (docs/decisions/20261128-trina-in-chrome.md)
    if (isChromeWindow(t.windowId) ? from !== t.windowId : from !== undefined) return null
    this.drop(t)
    let ok = false
    try { ok = t.recheck() !== false } catch { ok = false }
    return ok ? { name: t.name, bytes: t.bytes, sha256: t.sha256 } : null
  }

  /** The call is over (its result came, it failed or was stopped): the tickets it did not use go. */
  revokeCall(callId: string): void {
    for (const t of [...this.tickets.values()]) if (t.callId === callId) this.drop(t)
  }

  private drop(t: Ticket) {
    if (this.tickets.delete(t.id)) this.pending -= t.bytes.length
  }

  private sweep() {
    const now = this.now()
    for (const t of [...this.tickets.values()]) if (t.expiresAt <= now) this.drop(t)
  }
}
