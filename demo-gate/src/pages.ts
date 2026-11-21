// The gate's own pages (landing with Turnstile + Start, busy, session ended, start refusals), in the six languages. Static HTML,
// no script of our own: the only script is Cloudflare Turnstile's widget on the landing page.
import { LOCALES, isLocale, type Locale } from './config.ts'

export type PageKind = 'landing' | 'busy' | 'ended' | 'limit' | 'check' | 'error'

interface Words {
  title: string; lead: string; landingH: string; landingP: string; note: string; practice: string; start: string
  busyH: string; busyP: string; guided: string; plans: string; retry: string
  endedH: string; endedP: string; again: string
  limitH: string; limitP: string; limitLaterP: string; checkH: string; checkP: string; errorH: string; errorP: string
}

/** Why a start was refused for this address: `hour` = the starts per hour (clears in about an hour); `day` = the starts
 * per day; `ip_live` = the live copies per address (copies live 24 hours). Only `hour` may promise "about an hour". */
export type LimitReason = 'hour' | 'day' | 'ip_live'

/** Screen text (the only place with words other than English in this service). `note`'s "about 8 questions" is the demo limit (300k)
 * over shared/src/api/demo.ts DEMO_QUESTION_TOKENS (35k): change both together. Questions, never tokens. */
export const WORDS: Record<Locale, Words> = {
  en: {
    title: 'Try it yourself',
    lead: 'Trina AX is an AI workspace for your team: one place for files, chats and an AI that does the work.',
    landingH: 'Now try it yourself',
    landingP: "You get your own copy of the demo team. You're Mina, the new hire: ask the AI anything, open the files and rooms, and look around. Nothing you do here reaches real people.",
    note: 'You can ask Trina about 8 questions (bigger tasks count a little more). Your copy stays for 24 hours.',
    practice: 'Gmail, Google Drive and Higgsfield here are practice copies: mail is never really sent, and new pictures come from a prepared set.',
    start: 'Start',
    busyH: 'The live demo is busy right now',
    busyP: 'Every demo copy is in use. Watch the guided demo, or see the plans.',
    guided: 'Watch the guided demo',
    plans: 'See plans',
    retry: 'Try again',
    endedH: 'Your demo session ended',
    endedP: 'Demo copies are kept for 24 hours. You can start a new one any time.',
    again: 'Start again',
    limitH: "You've started the demo a few times already",
    limitP: 'You can start again in about an hour. Meanwhile, you can watch the guided demo.',
    limitLaterP: 'You can start again tomorrow. Meanwhile, you can watch the guided demo.',
    checkH: "We couldn't finish the browser check",
    checkP: 'Wait for the check to finish, then press Start.',
    errorH: "The demo couldn't start",
    errorP: 'Try again in a bit.',
  },
  ko: {
    title: '직접 써 보기',
    lead: '트리나 AX는 팀을 위한 AI 업무 공간이에요. 파일, 대화, 일을 대신해 주는 AI가 한곳에 있어요.',
    landingH: '이제 직접 써 보세요',
    landingP: '데모 팀을 나만의 사본으로 드려요. 새로 들어온 미나가 되어 AI에게 무엇이든 물어보고, 파일과 대화방을 둘러보세요. 여기서 한 일은 실제 사람에게 가지 않아요.',
    note: '트리나에게 8번 정도 물어볼 수 있어요(큰 작업은 질문 여러 번으로 칠 수 있어요). 사본은 24시간 동안 남아 있어요.',
    practice: '여기 Gmail·Google Drive·Higgsfield는 연습용이에요. 메일은 실제로 보내지 않고, 새 사진은 준비된 사진 중에서 골라요.',
    start: '시작하기',
    busyH: '지금은 체험 데모가 꽉 찼어요',
    busyP: '모든 데모 사본을 누군가 쓰고 있어요. 안내 데모를 보거나 요금제를 살펴보세요.',
    guided: '안내 데모 보기',
    plans: '요금제 보기',
    retry: '다시 해 보기',
    endedH: '데모 시간이 끝났어요',
    endedP: '데모 사본은 24시간 동안만 남아요. 언제든 새로 시작할 수 있어요.',
    again: '다시 시작하기',
    limitH: '데모를 이미 여러 번 시작했어요',
    limitP: '한 시간쯤 뒤에 다시 시작할 수 있어요. 그동안 안내 데모를 볼 수 있어요.',
    limitLaterP: '내일 다시 시작할 수 있어요. 그동안 안내 데모를 볼 수 있어요.',
    checkH: '브라우저 확인을 마치지 못했어요',
    checkP: '확인이 끝날 때까지 기다린 뒤 시작하기를 눌러 주세요.',
    errorH: '데모를 시작하지 못했어요',
    errorP: '잠시 뒤 다시 해 주세요.',
  },
  ja: {
    title: '実際に使ってみる',
    lead: 'トリナ AXは、チームのためのAIワークスペースです。ファイル、チャット、仕事をこなすAIがひとつの場所にそろっています。',
    landingH: 'さあ、実際に使ってみましょう',
    landingP: 'デモチームのあなた専用のコピーをお渡しします。新しく入社したミナになって、AIになんでも聞いたり、ファイルやルームを開いたりして、自由に見て回ってください。ここでの操作が実在の人に届くことはありません。',
    note: 'トリナには8回ほど質問できます（大きな作業は少し多めに数えます）。コピーは24時間残ります。',
    practice: 'ここのGmail・Googleドライブ・Higgsfieldは練習用です。メールは実際には送信されず、新しい画像は用意された画像の中から選ばれます。',
    start: 'はじめる',
    busyH: 'ただいまライブデモが混み合っています',
    busyP: 'デモのコピーはすべて使用中です。ガイド付きデモを見るか、料金プランをご覧ください。',
    guided: 'ガイド付きデモを見る',
    plans: '料金プランを見る',
    retry: 'もう一度試す',
    endedH: 'デモの時間が終わりました',
    endedP: 'デモのコピーは24時間だけ残ります。いつでも新しく始められます。',
    again: 'もう一度はじめる',
    limitH: 'デモをすでに何度か始めています',
    limitP: '1時間ほどで、もう一度始められます。それまでガイド付きデモをご覧いただけます。',
    limitLaterP: '明日また始められます。それまでガイド付きデモをご覧いただけます。',
    checkH: 'ブラウザの確認が完了しませんでした',
    checkP: '確認が終わるまで待ってから、「はじめる」を押してください。',
    errorH: 'デモを開始できませんでした',
    errorP: '少し時間をおいてから、もう一度お試しください。',
  },
  zh: {
    title: '亲自试试',
    lead: 'Trina AX 是为团队打造的 AI 工作空间：文件、聊天和能替你干活的 AI 都在同一个地方。',
    landingH: '现在亲自试试吧',
    landingP: '我们会为你准备一份专属的演示团队。你是新入职的 Mina：可以向 AI 提任何问题，打开文件和聊天室，随便看看。你在这里做的任何操作都不会发给真实的人。',
    note: '你可以向 Trina 提大约 8 个问题（较大的任务会多算一些）。副本会保留 24 小时。',
    practice: '这里的 Gmail、Google 云端硬盘和 Higgsfield 是练习用的：邮件不会真的发出，新图片从准备好的一组图片中挑选。',
    start: '开始',
    busyH: '在线演示现在人有点多',
    busyP: '所有演示副本都在使用中。你可以先看引导演示，或者看看价格方案。',
    guided: '看引导演示',
    plans: '查看价格方案',
    retry: '再试一次',
    endedH: '你的演示已结束',
    endedP: '演示副本只保留 24 小时。你随时可以重新开始。',
    again: '重新开始',
    limitH: '你已经开始过好几次演示了',
    limitP: '大约一小时后可以重新开始。在此期间，你可以先看引导演示。',
    limitLaterP: '明天可以重新开始。在此期间，你可以先看引导演示。',
    checkH: '浏览器验证没有完成',
    checkP: '请等验证完成后，再点击“开始”。',
    errorH: '演示没能启动',
    errorP: '请稍后再试。',
  },
  es: {
    title: 'Pruébelo usted mismo',
    lead: 'Trina AX es un espacio de trabajo con IA para su equipo: un solo lugar para archivos, chats y una IA que hace el trabajo.',
    landingH: 'Ahora pruébelo usted mismo',
    landingP: 'Recibe su propia copia del equipo de la demostración. Usted es Mina, la nueva incorporación: pregúntele lo que quiera a la IA, abra los archivos y las salas, y eche un vistazo. Nada de lo que haga aquí llega a personas reales.',
    note: 'Puede hacerle a Trina unas 8 preguntas (las tareas más grandes cuentan un poco más). Su copia se guarda durante 24 horas.',
    practice: 'Gmail, Google Drive y Higgsfield aquí son de práctica: el correo nunca se envía de verdad y las imágenes nuevas salen de un conjunto preparado.',
    start: 'Empezar',
    busyH: 'La demostración en vivo está ocupada ahora mismo',
    busyP: 'Todas las copias de la demostración están en uso. Vea la demostración guiada o consulte los planes.',
    guided: 'Ver la demostración guiada',
    plans: 'Ver planes',
    retry: 'Volver a intentarlo',
    endedH: 'Su sesión de demostración ha terminado',
    endedP: 'Las copias de la demostración se guardan durante 24 horas. Puede empezar una nueva cuando quiera.',
    again: 'Empezar de nuevo',
    limitH: 'Ya ha empezado la demostración varias veces',
    limitP: 'Podrá empezar de nuevo en aproximadamente una hora. Mientras tanto, puede ver la demostración guiada.',
    limitLaterP: 'Podrá empezar de nuevo mañana. Mientras tanto, puede ver la demostración guiada.',
    checkH: 'No pudimos completar la verificación del navegador',
    checkP: 'Espere a que termine la verificación y pulse Empezar.',
    errorH: 'No se pudo iniciar la demostración',
    errorP: 'Vuelva a intentarlo dentro de un rato.',
  },
  id: {
    title: 'Coba sendiri',
    lead: 'Trina AX adalah ruang kerja AI untuk tim Anda: satu tempat untuk file, obrolan, dan AI yang menyelesaikan pekerjaan.',
    landingH: 'Sekarang coba sendiri',
    landingP: 'Anda mendapat salinan tim demo milik Anda sendiri. Anda adalah Mina, karyawan baru: tanyakan apa saja ke AI, buka file dan ruang obrolan, lalu lihat-lihat. Apa pun yang Anda lakukan di sini tidak sampai ke orang sungguhan.',
    note: 'Anda bisa bertanya ke Trina sekitar 8 kali (tugas yang lebih besar dihitung sedikit lebih banyak). Salinan Anda disimpan selama 24 jam.',
    practice: 'Gmail, Google Drive, dan Higgsfield di sini hanya untuk latihan: email tidak pernah benar-benar terkirim, dan gambar baru diambil dari kumpulan yang sudah disiapkan.',
    start: 'Mulai',
    busyH: 'Demo langsung sedang penuh',
    busyP: 'Semua salinan demo sedang dipakai. Tonton demo terpandu, atau lihat paket harga.',
    guided: 'Tonton demo terpandu',
    plans: 'Lihat paket',
    retry: 'Coba lagi',
    endedH: 'Sesi demo Anda sudah berakhir',
    endedP: 'Salinan demo disimpan selama 24 jam. Anda bisa memulai yang baru kapan saja.',
    again: 'Mulai lagi',
    limitH: 'Anda sudah beberapa kali memulai demo',
    limitP: 'Anda bisa memulai lagi sekitar satu jam lagi. Sementara itu, Anda bisa menonton demo terpandu.',
    limitLaterP: 'Anda bisa memulai lagi besok. Sementara itu, Anda bisa menonton demo terpandu.',
    checkH: 'Pemeriksaan browser belum selesai',
    checkP: 'Tunggu sampai pemeriksaan selesai, lalu tekan Mulai.',
    errorH: 'Demo tidak bisa dimulai',
    errorP: 'Coba lagi sebentar lagi.',
  },
}

/** ?lang= (or the Start form's lang) wins; then the `mycel_locale` cookie (the language the visitor used in the app: the
 * web app writes it, and a start sets it); then the browser's first language that is one of ours; else en. Only `allowed`
 * (the live pool.locales): a language the gate has no snapshot for falls back to en (or the first allowed one). The
 * cookie passes the same check as the query, so nothing else ever reaches `<html lang>` or a Set-Cookie. */
export function localeOf(query: string | null, acceptLanguage: string | undefined, allowed: readonly Locale[] = LOCALES, cookieLocale?: string | null): Locale {
  const ok = (l: string | null | undefined): l is Locale => isLocale(l) && allowed.includes(l)
  if (ok(query)) return query
  if (ok(cookieLocale)) return cookieLocale
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.trim().split(';')[0]!.toLowerCase().split('-')[0]
    // a browser tag the gate does not serve is skipped: the next one may be
    if (ok(tag)) return tag
  }
  return allowed.includes('en') || !allowed.length ? 'en' : allowed[0]!
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
export const PAGE_CSP = "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

export interface PageLinks { scriptedDemo: string; pricing: string }

export function renderPage(kind: PageKind, locale: Locale, o: { siteKey: string; links: PageLinks; limit?: LimitReason }): string {
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
  // busy and error: one more way, back to the landing page (a new Start there passes Turnstile again)
  const awayOrRetry = `
    <div class="row">
      <a class="primary" href="${esc(o.links.scriptedDemo)}">${esc(w.guided)}</a>
      <a class="secondary" href="${esc(o.links.pricing)}">${esc(w.plans)}</a>
      <a class="secondary" href="/">${esc(w.retry)}</a>
    </div>`
  let h = '', p = '', body = '', lead = '', turnstile = false
  switch (kind) {
    case 'landing': lead = w.lead; h = w.landingH; p = w.landingP; body = startForm(w.start, true) + `<p class="note">${esc(w.note)}</p><p class="note practice">${esc(w.practice)}</p>`; turnstile = true; break
    case 'check': h = w.checkH; p = w.checkP; body = startForm(w.start, true); turnstile = true; break
    case 'ended': h = w.endedH; p = w.endedP; body = startForm(w.again, true); turnstile = true; break
    case 'busy': h = w.busyH; p = w.busyP; body = awayOrRetry; break
    // no retry link: it would be refused again. "About an hour" only when that is the reason
    case 'limit': h = w.limitH; p = o.limit === 'hour' ? w.limitP : w.limitLaterP; body = away; break
    case 'error': h = w.errorH; p = w.errorP; body = awayOrRetry; break
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
  .lead { font-size:14px; margin:0 0 8px; }
  .note { font-size:14px; margin:16px 0 0; text-wrap:balance; }
  /* keep-all only for Korean: Japanese and Chinese have no spaces and would break only at punctuation */
  html[lang="ko"] .note, html[lang="ko"] .lead { word-break:keep-all; }
  .note.practice { margin-top:6px; }
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
  ${lead ? `<p class="lead">${esc(lead)}</p>` : ''}
  <h1>${esc(h)}</h1>
  <p>${esc(p)}</p>
  ${body}
</main>
</body>
</html>`
}
