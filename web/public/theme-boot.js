// The first paint in the look the person chose (web/index.html loads this in <head>, before the app's bundle): without
// it the page is drawn in the phone's or the browser's look until the bundle has loaded, a white flash for someone who
// chose Dark (on the iPhone app also behind a swipe back). It does what lib/theme.ts applyTheme does with the saved choice
// (storedTheme, key THEME_KEY), and applyTheme takes over once the app runs. A file, not an inline script: the app's
// Content-Security-Policy allows no inline scripts (server/src/routes/web-static.ts appCsp).
(function () {
  var theme = 'system'
  try {
    var saved = window.localStorage.getItem('mycel.theme')
    if (saved === 'light' || saved === 'dark') theme = saved
  } catch (e) { /* storage blocked: the phone's look */ }
  var dark = theme === 'dark' || (theme === 'system' && !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches))
  var root = document.documentElement
  if (dark) root.classList.add('dark')
  else root.classList.remove('dark')
  root.style.colorScheme = dark ? 'dark' : 'light'
})()
