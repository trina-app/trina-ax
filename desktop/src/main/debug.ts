// MYCEL_DESKTOP_DEBUG=1: short lifecycle lines on stdout (no page content, no tool inputs). Off by default.
export const debug: (...a: unknown[]) => void = process.env.MYCEL_DESKTOP_DEBUG === '1' ? (...a) => console.log('[desktop]', ...a) : () => {}
