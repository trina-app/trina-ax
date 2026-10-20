// Text lines from a byte stream that arrives in arbitrary pieces (launcher stdout chunks, socket reads).
// The pieces are cut wherever the pipe read stopped, so a multi-byte UTF-8 character (every Hangul syllable is
// three bytes) can be split between two of them; decoding each piece on its own turns both halves into U+FFFD.
// A streaming TextDecoder keeps the unfinished bytes until the rest arrives.

export class Utf8Lines {
  private dec = new TextDecoder('utf-8')
  private buf = ''

  /** Feed bytes; returns the complete lines (without the newline) they finish. */
  push(bytes: Uint8Array): string[] {
    this.buf += this.dec.decode(bytes, { stream: true })
    return this.take()
  }

  /** End of input: whatever is left (an unterminated last line), or nothing. */
  end(): string[] {
    this.buf += this.dec.decode()
    const rest = this.buf
    this.buf = ''
    return rest ? [rest] : []
  }

  /** characters waiting for a newline */
  get pending(): number { return this.buf.length }

  private take(): string[] {
    const out: string[] = []
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) { out.push(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1) }
    return out
  }
}

/** Accumulates a byte stream as text up to `max` characters (stderr tails for logs), keeping split characters whole. */
export class Utf8Text {
  private dec = new TextDecoder('utf-8')
  text = ''
  constructor(private max: number) {}
  push(bytes: Uint8Array) { if (this.text.length < this.max) this.text += this.dec.decode(bytes, { stream: true }) }
}
