// Strings that look like secrets, hidden whatever anyone stored (a step's record, a service's refusal words). A leaf
// module: it imports nothing, so any part of the server can use it without an import cycle (chat/step-record.ts,
// integrations/connections/refusal.ts).

/** Strings that look like secrets in what a call took or gave back (a token, a key, a cookie, a password field),
 * hidden whatever the person stored: the record must never let the AI repeat one. */
export function scrubSecrets(s: string): string {
  return s
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g, '[hidden]')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '[hidden]')
    .replace(/\b(ghp|gho|ghs|ghu|github_pat|xox[abpsr]|AKIA|ASIA|AIza|ya29)[A-Za-z0-9_.-]{8,}/g, '[hidden]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [hidden]')
    .replace(/(["']?\b(?:password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|apikey|session(?:id)?|cookie|set-cookie|authorization|auth|otp|pin)\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[hidden]')
}
