// A memorable temporary password for the admin's "add member" / "reset password" forms (shared/src/temp-password.ts:
// an easy word + digits, e.g. "tiger427"). Made in the browser from crypto.getRandomValues; the server checks it
// like any new password and hashes it.
import { memorablePassword } from '@mycel/shared'

/** Uniform integer in [0, n) from the browser's CSPRNG (rejection sampling, no modulo bias). */
function randomInt(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0]! < limit) return buf[0]! % n
  }
}

export const newTemporaryPassword = (): string => memorablePassword(randomInt)
