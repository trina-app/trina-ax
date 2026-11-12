# Phones: the 트리나 tab's star in Trina's orange

Owner 2026-11-12, after #596 put Trina's star on the phone's 트리나 tab in the tab colours (ink / faint):
'AI 아이콘은 색넣는게 좋지 않을까?' The room header's ✦, the AI's face and the Home mark are the orange star; the tab's
grey one reads as something else.

## Plan
- `BottomTabs.tsx` `AiTabIcon`: the star in its own orange gradient (TrinaStar without `mono`) on every tab; on the
  others it is dimmed (opacity) so the tab on show still reads from the bar, the label keeps the tab colours. The core
  edition's sparkle is unchanged.
- `phone-nav.test.tsx`: the icon has the gradient (not `mono`), dimmed when its tab is not on show.

## Result
`phone-nav.test.tsx` 28/28; `phone-projects-tab` e2e 11/11 (Chromium); typecheck passes.
