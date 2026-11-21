// The gate's own pages (landing with Turnstile + Start, busy, session ended, start refusals), en and ko. Static HTML,
// no script of our own: the only script is Cloudflare Turnstile's widget on the landing page.
import type { Locale } from './config.ts'

export type PageKind = 'landing' | 'busy' | 'ended' | 'limit' | 'check' | 'error'

interface Words {
  title: string; landingH: string; landingP: string; note: string; start: string
  busyH: string; busyP: string; guided: string; plans: string
  endedH: string; endedP: string; again: string
  limitH: string; limitP: string; checkH: string; checkP: string; errorH: string; errorP: string
}

/** Screen text (the only place with Korean in this service). `note`'s "about 8 questions" is the demo limit (300k)
 * over shared/src/api/demo.ts DEMO_QUESTION_TOKENS (35k): change both together. Questions, never tokens. */
export const WORDS: Record<Locale, Words> = {
  en: {
    title: 'Try it yourself',
    landingH: 'Now try it yourself',
    landingP: "You get your own copy of the demo team. You're Mina, the new hire: ask the AI anything, open the files and rooms, and look around. Nothing you do here reaches real people.",
    note: 'You can ask Trina about 8 questions. Your copy stays for 24 hours.',
    start: 'Start',
    busyH: 'The live demo is busy right now',
    busyP: 'Every demo copy is in use. Watch the guided demo, or see the plans.',
    guided: 'Watch the guided demo',
    plans: 'See plans',
    endedH: 'Your demo session ended',
    endedP: 'Demo copies are kept for 24 hours. You can start a new one any time.',
    again: 'Start again',
    limitH: "You've started the demo a few times already",
    limitP: 'Try again later, or see the plans.',
    checkH: "We couldn't finish the browser check",
    checkP: 'Wait for the check to finish, then press Start.',
    errorH: "The demo couldn't start",
    errorP: 'Try again in a bit.',
  },
  ko: {
    title: '직접 써 보기',
    landingH: '이제 직접 써 보세요',
    landingP: '데모 팀을 나만의 사본으로 드려요. 새로 들어온 미나가 되어 AI에게 무엇이든 물어보고, 파일과 대화방을 둘러보세요. 여기서 한 일은 실제 사람에게 가지 않아요.',
    note: '트리나에게 8번 정도 물어볼 수 있어요. 사본은 24시간 동안 남아 있어요.',
    start: '시작하기',
    busyH: '지금은 체험 데모가 꽉 찼어요',
    busyP: '모든 데모 사본을 누군가 쓰고 있어요. 안내 데모를 보거나 요금제를 살펴보세요.',
    guided: '안내 데모 보기',
    plans: '요금제 보기',
    endedH: '데모 시간이 끝났어요',
    endedP: '데모 사본은 24시간 동안만 남아요. 언제든 새로 시작할 수 있어요.',
    again: '다시 시작하기',
    limitH: '데모를 이미 여러 번 시작했어요',
    limitP: '조금 뒤에 다시 해 보거나 요금제를 살펴보세요.',
    checkH: '브라우저 확인을 마치지 못했어요',
    checkP: '확인이 끝날 때까지 기다린 뒤 시작하기를 눌러 주세요.',
    errorH: '데모를 시작하지 못했어요',
    errorP: '잠시 뒤 다시 해 주세요.',
  },
}

/** ?lang= wins; else the browser's first language that is ko or en; else en */
export function localeOf(query: string | null, acceptLanguage: string | undefined): Locale {
  if (query === 'ko' || query === 'en') return query
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.trim().split(';')[0]!.toLowerCase()
    if (tag.startsWith('ko')) return 'ko'
    if (tag.startsWith('en')) return 'en'
  }
  return 'en'
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
export const PAGE_CSP = "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

export interface PageLinks { scriptedDemo: string; pricing: string }

export function renderPage(kind: PageKind, locale: Locale, o: { siteKey: string; links: PageLinks }): string {
  const w = WORDS[locale]
  const startForm = (label: string, turnstile: boolean) => `
    <form method="post" action="/__demo/start">
      <input type="hidden" name="lang" value="${locale}">
      ${turnstile ? `<div class="cf-turnstile" data-sitekey="${esc(o.siteKey)}" data-language="${locale}"></div>` : ''}
      <button type="submit" class="primary">${esc(label)}</button>
    </form>`
  const away = `
    <div class="row">
      <a class="primary" href="${esc(o.links.scriptedDemo)}">${esc(w.guided)}</a>
      <a class="secondary" href="${esc(o.links.pricing)}">${esc(w.plans)}</a>
    </div>`
  let h = '', p = '', body = '', turnstile = false
  switch (kind) {
    case 'landing': h = w.landingH; p = w.landingP; body = startForm(w.start, true) + `<p class="note">${esc(w.note)}</p>`; turnstile = true; break
    case 'check': h = w.checkH; p = w.checkP; body = startForm(w.start, true); turnstile = true; break
    case 'ended': h = w.endedH; p = w.endedP; body = startForm(w.again, true); turnstile = true; break
    case 'busy': h = w.busyH; p = w.busyP; body = away; break
    case 'limit': h = w.limitH; p = w.limitP; body = away; break
    case 'error': h = w.errorH; p = w.errorP; body = away; break
  }
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(w.title)}</title>
${turnstile ? `<script src="${TURNSTILE_SCRIPT}" async defer></script>` : ''}
<style>
  :root { --bg:#f7f7f5; --card:#fff; --text:#1c1c1a; --dim:#5f5f5a; --line:#e4e4df; --accent:#1c1c1a; --on-accent:#fff; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121211; --card:#1c1c1a; --text:#ecece8; --dim:#a3a39c; --line:#2e2e2b; --accent:#ecece8; --on-accent:#121211; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--text);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; padding: 24px 16px; }
  main { width:100%; max-width:440px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:32px 28px; }
  h1 { font-size:24px; line-height:1.3; margin:0 0 12px; letter-spacing:-.01em; }
  p { margin:0 0 20px; color:var(--dim); }
  .note { font-size:14px; margin:16px 0 0; text-wrap:balance; word-break:keep-all; }
  form { display:flex; flex-direction:column; gap:16px; align-items:stretch; }
  .row { display:flex; gap:12px; flex-wrap:wrap; }
  .primary, .secondary { display:inline-flex; justify-content:center; align-items:center; min-height:44px; padding:0 20px; border-radius:10px;
    font:inherit; font-weight:600; text-decoration:none; cursor:pointer; }
  .primary { background:var(--accent); color:var(--on-accent); border:0; }
  .secondary { background:transparent; color:var(--text); border:1px solid var(--line); }
  .row a { flex:1 1 160px; }
</style>
</head>
<body>
<main>
  <h1>${esc(h)}</h1>
  <p>${esc(p)}</p>
  ${body}
</main>
</body>
</html>`
}
