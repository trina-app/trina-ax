// Phones: keep the composer above the on-screen keyboard. iOS Safari does not resize the layout viewport when the
// keyboard opens (interactive-widget=resizes-content only works in Chromium), so the app height follows
// visualViewport through the --app-h variable (tab 5 PWA: 입력창은 visualViewport로 키보드 위에 붙인다).
export function followVisualViewport() {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement
  const apply = () => {
    root.style.setProperty('--app-h', `${Math.round(vv.height)}px`)
    // iOS scrolls the page up when focusing a field near the bottom; keep the app pinned to the top
    if (vv.offsetTop > 0 && window.scrollY !== 0) window.scrollTo(0, 0)
  }
  vv.addEventListener('resize', apply)
  vv.addEventListener('scroll', apply)
  apply()
}
