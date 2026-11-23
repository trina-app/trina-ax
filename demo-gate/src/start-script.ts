// The one script of our own on the gate's pages: Start waits for Turnstile, so a visitor who presses early never sees a
// refusal. It only decides WHEN the form is sent; the server still checks every token. PAGE_CSP allows it by hash.
import crypto from 'node:crypto'

/** How long a press waits for a Turnstile that says nothing (its script blocked or never loaded). An interactive
 * challenge turns this off: the visitor is answering it, and Turnstile reports its own timeout. */
export const CHECK_WAIT_MS = 45_000

export const START_SCRIPT = `(function () {
  var proof = '', pending = false, sent = false, failed = false, recovering = false, interactive = false, leaving = false, timer = 0;
  function form() { return document.querySelector('form[data-start]'); }
  function stopTimer() { if (timer) clearTimeout(timer); timer = 0; }
  function armTimer() { stopTimer(); if (!interactive) timer = setTimeout(fail, ${CHECK_WAIT_MS}); }
  function paint() {
    var f = form(); if (!f) return;
    var b = f.querySelector('button'), busy = pending || sent;
    b.textContent = busy ? f.getAttribute('data-checking') : failed ? f.getAttribute('data-retry') : f.getAttribute('data-label');
    if (busy) { b.setAttribute('aria-busy', 'true'); b.setAttribute('aria-disabled', 'true'); }
    else { b.removeAttribute('aria-busy'); b.removeAttribute('aria-disabled'); }
    f.querySelector('.check-error').textContent = failed ? f.getAttribute('data-failed') : '';
    f.querySelector('.check-wait').textContent = pending ? f.getAttribute('data-checking') : '';
  }
  function send() {
    if (sent || !proof) return;
    var f = form(), input = f.querySelector('input[name="cf-turnstile-response"]');
    if (!input) { input = document.createElement('input'); input.type = 'hidden'; input.name = 'cf-turnstile-response'; f.appendChild(input); }
    input.value = proof; sent = true; pending = false; stopTimer(); paint(); f.submit();
  }
  function resetWidget() {
    try { window.turnstile.reset(); return true; } catch (e) { return false; }
  }
  function fail() {
    if (sent) return true;
    stopTimer(); proof = ''; pending = false; recovering = false; interactive = false; failed = true; paint();
    return true;
  }
  window.demoCheckDone = function (t) {
    if (sent) return;
    proof = t; failed = false; recovering = false; interactive = false; stopTimer();
    if (pending) send(); else paint();
  };
  window.demoCheckFailed = fail;
  window.demoCheckExpired = function () {
    if (sent) return;
    fail(); recovering = resetWidget();
  };
  window.demoCheckInteractive = function () { interactive = true; stopTimer(); };
  document.addEventListener('submit', function (e) {
    if (e.target !== form()) return;
    e.preventDefault();
    if (sent || pending || leaving) return;
    if (proof) return send();
    var retry = failed;
    failed = false; pending = true; paint(); armTimer();
    if (retry && !recovering) { if (resetWidget()) recovering = true; else location.reload(); }
  }, true);
  document.addEventListener('click', function (e) {
    var t = e.target, menu = document.querySelector('details.lang[open]');
    var link = t && t.closest ? t.closest('a[data-lang-link]') : null;
    if (menu && !(t && t.closest && t.closest('details.lang'))) menu.open = false;
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (sent) { e.preventDefault(); return; }
    leaving = true; pending = false; stopTimer(); paint();
    setTimeout(function () { leaving = false; }, 4000);
  }, true);
  document.addEventListener('keydown', function (e) {
    var menu = document.querySelector('details.lang[open]');
    if (e.key !== 'Escape' || !menu) return;
    menu.open = false; menu.querySelector('summary').focus();
  });
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    stopTimer(); proof = ''; pending = false; sent = false; failed = false; interactive = false; leaving = false;
    recovering = resetWidget(); paint();
  });
})();`

export const START_SCRIPT_HASH = `sha256-${crypto.createHash('sha256').update(START_SCRIPT, 'utf8').digest('base64')}`
