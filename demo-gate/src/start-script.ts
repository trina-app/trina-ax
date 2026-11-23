// The gate's own two scripts, both allowed by hash in PAGE_CSP. START_SCRIPT: Start waits for Turnstile, so a visitor who
// presses early never sees a refusal. It only decides WHEN the form is sent; the server still checks every token.
// LANGUAGE_MENU_SCRIPT: how the language menu closes. The menu itself is details/summary and works without it.
import crypto from 'node:crypto'

/** How long a press waits for a Turnstile that says nothing (its script blocked or never loaded). An interactive
 * challenge turns this off: the visitor is answering it, and Turnstile reports its own timeout. */
export const CHECK_WAIT_MS = 45_000

/** How long a sent form may take before Start offers Try again (a stopped or hung load fires no event in the page). The
 * server's slowest normal start is Turnstile's check (10 s limit) plus the demo sign-in (15 s limit). */
export const START_WAIT_MS = 60_000

/** Turnstile retries a failed check by itself (`retry=auto`, every 8 s). The error shows on this many failures in a row,
 * or at once for a configuration error (code 110xxx), which a retry cannot fix. Cloudflare marks two 110xxx codes as
 * retryable, both timeouts (CHECK_RETRYABLE_110): they count like any other brief error. */
export const CHECK_MAX_ERRORS = 3
export const CHECK_RETRYABLE_110 = ['110600', '110620']

/** How long after a press a late token may still start the demo by itself. Later, the visitor presses Start again: a tab
 * left on Try again must not open a demo (and use a copy) long after anyone asked for it. */
export const WANTED_MS = 180_000

export const START_SCRIPT = `(function () {
  var proof = '', pending = false, sent = false, stalled = false, failed = false, recovering = false, interactive = false;
  var errors = 0, leavingTo = '', timer = 0, wantedUntil = 0;
  function wanted() { return Date.now() < wantedUntil; }
  function form() { return document.querySelector('form[data-start]'); }
  function stopTimer() { if (timer) clearTimeout(timer); timer = 0; }
  function armTimer() { stopTimer(); if (!interactive) timer = setTimeout(fail, ${CHECK_WAIT_MS}); }
  function paint() {
    var f = form(); if (!f) return;
    var b = f.querySelector('button'), busy = pending || sent;
    b.textContent = busy ? f.getAttribute('data-checking') : failed || stalled ? f.getAttribute('data-retry') : f.getAttribute('data-label');
    if (busy) { b.setAttribute('aria-busy', 'true'); b.setAttribute('aria-disabled', 'true'); }
    else { b.removeAttribute('aria-busy'); b.removeAttribute('aria-disabled'); }
    f.querySelector('.check-error').textContent = stalled ? f.getAttribute('data-stalled') : failed ? f.getAttribute('data-failed') : '';
    f.querySelector('.check-wait').textContent = pending ? f.getAttribute('data-checking') : '';
  }
  function freshPage() { location.replace(form().getAttribute('data-home')); }
  function stall() { timer = 0; sent = false; proof = ''; stalled = true; paint(); }
  function send() {
    if (sent || !proof) return;
    var f = form(), input = f.querySelector('input[name="cf-turnstile-response"]');
    if (!input) { input = document.createElement('input'); input.type = 'hidden'; input.name = 'cf-turnstile-response'; f.appendChild(input); }
    input.value = proof; sent = true; pending = false; wantedUntil = 0; stopTimer(); timer = setTimeout(stall, ${START_WAIT_MS}); paint(); f.submit();
  }
  function resetWidget() {
    try { window.turnstile.reset(); return true; } catch (e) { return false; }
  }
  function fail() {
    if (sent || stalled) return true;
    stopTimer(); proof = ''; pending = false; recovering = false; interactive = false; failed = true; paint();
    return true;
  }
  window.demoCheckDone = function (t) {
    if (sent || stalled) return;
    proof = t; failed = false; recovering = false; interactive = false; errors = 0; stopTimer();
    if ((pending || wanted()) && !leavingTo) send(); else paint();
  };
  window.demoCheckFailed = function (code) {
    if (sent || stalled) return true;
    proof = ''; errors++;
    var c = String(code || '');
    if (errors >= ${CHECK_MAX_ERRORS} || (c.indexOf('110') === 0 && ${JSON.stringify(CHECK_RETRYABLE_110)}.indexOf(c) < 0)) return fail();
    if (interactive) { interactive = false; if (pending) armTimer(); }
    return true;
  };
  window.demoCheckStopped = fail;
  window.demoCheckExpired = function () {
    if (sent || stalled) return;
    proof = ''; errors = 0;
    if (resetWidget()) { recovering = true; paint(); } else fail();
  };
  window.demoCheckInteractive = function () { if (sent || stalled) return; interactive = true; stopTimer(); };
  document.addEventListener('submit', function (e) {
    if (e.target !== form()) return;
    e.preventDefault();
    if (sent || pending) return;
    if (leavingTo) { location.assign(leavingTo); return; }
    if (stalled) { freshPage(); return; }
    if (proof) return send();
    var retry = failed;
    if (retry) errors = 0;
    failed = false; pending = true; wantedUntil = Date.now() + ${WANTED_MS}; paint(); armTimer();
    if (retry && !recovering) { if (resetWidget()) recovering = true; else freshPage(); }
  }, true);
  document.addEventListener('click', function (e) {
    var link = e.target && e.target.closest ? e.target.closest('a[data-lang-link]') : null;
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (sent) { e.preventDefault(); return; }
    leavingTo = link.href; pending = false; wantedUntil = 0; stopTimer(); paint();
  }, true);
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    stopTimer(); proof = ''; pending = false; wantedUntil = 0; sent = false; stalled = false; failed = false; interactive = false; errors = 0; leavingTo = '';
    recovering = resetWidget(); paint();
  });
})();`

export const LANGUAGE_MENU_SCRIPT = `(function () {
  function menu() { return document.querySelector('details.lang[open]'); }
  document.addEventListener('click', function (e) {
    var m = menu();
    if (m && !m.contains(e.target)) m.open = false;
  }, true);
  document.addEventListener('keydown', function (e) {
    var m = menu();
    if (e.key !== 'Escape' || !m) return;
    m.open = false; m.querySelector('summary').focus();
  });
  document.addEventListener('focusout', function (e) {
    var m = menu();
    if (m && e.relatedTarget && m.contains(e.target) && !m.contains(e.relatedTarget)) m.open = false;
  });
})();`

const hashOf = (script: string) => `sha256-${crypto.createHash('sha256').update(script, 'utf8').digest('base64')}`
export const START_SCRIPT_HASH = hashOf(START_SCRIPT)
export const LANGUAGE_MENU_SCRIPT_HASH = hashOf(LANGUAGE_MENU_SCRIPT)
