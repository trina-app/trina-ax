/** L25 is not implemented. Never reinterpret an installed-mode request as the developer's local login. */
export function requireDeveloperEngineMode() {
  if (process.env.MYCEL_LOCKDOWN_INSTALLED !== undefined) {
    throw new Error('MYCEL_LOCKDOWN_INSTALLED is not implemented (L25); refusing to use developer local logins')
  }
}

// engines.ts imports this first, before loading dependencies that can discover developer paths.
requireDeveloperEngineMode()
