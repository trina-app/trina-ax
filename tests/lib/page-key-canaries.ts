// Fake keys of many shapes on a fake API key page, for the browser key guard's tests (tests/unit/page-keys.test.ts,
// tests/unit/b-browser-key-guard.test.ts).
// Made-up values in the shapes of real ones (none is a working key). Provider prefixes are joined at run time so that
// secret scanners (GitHub push protection) do not take this file for a leak.
const k = (...parts: string[]) => parts.join('')
const BODY = 'Qz7wK2mN9pR4tV6xB1cD3fG5hJ8kL0aS' // 32 letters and digits, mixed
/** a value of each shape a key page shows, and the label the page puts before it (a label only where it needs one) */
export const CANARIES: Record<string, { value: string; label?: string }> = {
  'OpenAI project': { value: k('sk-', 'proj-', BODY, 'Xy9') },
  'Anthropic': { value: k('sk-', 'ant-', 'api03-', BODY, '-Wq3') },
  'GitHub classic': { value: k('gh', 'p_', BODY, 'Mn4r') },
  'GitHub fine-grained': { value: k('github', '_pat_', '11AB2CD3E0', BODY) },
  'Google API': { value: k('AI', 'za', 'Sy', BODY.slice(0, 33)) },
  'Slack bot': { value: k('xo', 'xb-', '2047113390-7712340987123-', BODY.slice(0, 24)) },
  'Stripe live': { value: k('sk', '_live_', '51Hq', BODY) },
  'Stripe webhook': { value: k('wh', 'sec_', BODY) },
  'Toss secret': { value: k('test', '_sk_', BODY.slice(0, 24)) },
  'Google client secret': { value: k('GOC', 'SPX-', BODY.slice(0, 28)) },
  'SendGrid': { value: k('S', 'G.', BODY.slice(0, 22), '.', BODY.slice(4, 30)) },
  'JWT (Supabase service role)': { value: k('ey', 'JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJyb2xlIjoic2VydmljZV9yb2xlIn0', '.', BODY) },
  'Telegram bot': { value: k('6123456789', ':AA', BODY, 'x') },
  'Kakao REST API key (32 hex)': { value: '7f3a9c2e1b8d4f6a0c5e9b2d7a1f4c8e', label: 'REST API 키' },
  'Naver client secret (10)': { value: 'Xy3Kp9QwZe', label: 'Client Secret' },
  'AWS secret access key': { value: 'wJa9rXUtnF3MI/K7MDENG/bPxRfiCY4zQ2mN8kLp', label: 'Secret access key' },
  'Twilio auth token': { value: '9c2e7f3a1b8d4f6a0c5e9b2d7a1f4c8e', label: 'Auth Token' },
  'data.go.kr key (encoded)': { value: 'Qz7wK2mN9pR4tV6xB1cD3fG5hJ8kL0aS%2BxY7zW3vU5tR1qP9oN%2FmL4kJ2iH6gF8eD0cB%3D%3D', label: '일반 인증키(Encoding)' },
  'TOTP secret (base32)': { value: 'JBSWY3DPEHPK3PXP7Q2M', label: 'Secret key' },
}

/** a fake API key page as read_page shows it: every canary in its own element, a label where it needs one */
export function keyPageOutline(): string {
  const lines = ['https://console.example.test/settings/keys — API keys', '- heading "API keys" level=1 [ref_1]', '- paragraph "Copy your new key now. You won\'t be able to see it again." [ref_2]']
  let n = 3
  for (const [name, c] of Object.entries(CANARIES)) {
    lines.push(`- generic "${name}" [ref_${n++}]`)
    if (c.label) lines.push(`  - generic "${c.label}" [ref_${n++}]`)
    lines.push(`  - textbox [ref_${n++}] type=text value="${c.value}"`)
  }
  return lines.join('\n')
}

/** the middle of a value: a part of it that must not come through either (a mask that only took the start) */
export const middleOf = (v: string) => v.slice(Math.floor(v.length / 2) - 5, Math.floor(v.length / 2) + 5)
