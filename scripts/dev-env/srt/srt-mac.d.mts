// Types of srt-mac.mjs for the unit test (tests/unit/dev-env-srt-mac.test.ts).
export const MARK: string
export const OPEN_LOCALHOST: string
export const END_RULES: string
export function extraRules(port: number | null): string
export function portOf(v: string | undefined): number | null
export function words(s: string): string[]
export function patch(wrapped: string, port: number | null): string
