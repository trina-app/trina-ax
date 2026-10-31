# Trina AX design system

The look of Trina AX, written down from the code so that every Trina screen (the web app, the desktop app's own screens, and server-rendered admin pages outside this repository) uses one design.

The web app is the reference: `web/src/index.css`, `web/src/theme.edition.css`, `web/src/components/ui.tsx` and the components named below. When this page and the code disagree, the code wins; update this page in the same change.

## Quick start: a new screen

The web app is React with Tailwind CSS 4. There is no `tailwind.config` file: the theme is the `@theme` block in `web/src/index.css`, which maps every `--c-*` token to a Tailwind colour of the same name.

1. **Colour only through tokens.** Use the token utilities (`bg-canvas`, `bg-surface`, `bg-subtle`, `hover:bg-hover`, `border-line`, `border-field-border` (the edge of a text field), `text-ink`, `text-muted`, `text-faint`, `text-accent-text`, `bg-accent text-accent-ink`, `bg-warn-soft text-warn`, …) in markup and `var(--c-…)` in CSS. They switch with the theme by themselves, so a screen needs no `dark:` variants and no hex values. Pick text-on-background pairs from [Contrast](#contrast).
2. **Start from the shell and the shared blocks.** Add the page as a route inside `<Route element={<Layout />}>` in `web/src/App.tsx`; the layout brings the sidebar, banners, side panel and phone top bar. Build the page from `web/src/components/ui.tsx` (`PageHeader`, `Button`, `IconButton`, `Field` with `inputCls`, `Badge`, `Tabs`, `Switch`, `Modal` and `confirmDialog`, `EmptyState`, `ErrorNote`, `Spinner`; `toast` from `web/src/store/ui.ts`) and `Card` from `web/src/pages/admin/common.tsx`. Do not recolour them with `className` (see Button under [Components](#components)).
3. **Write every string in five locales.** Add the key to `web/src/i18n/ko.ts` (the key type comes from it) and to `en.ts`, `id.ts`, `ja.ts` and `es.ts`, following [Copy and languages](#copy-and-languages), then run `bun run check:i18n`.
4. **Check it** in light and dark (Settings > Profile > Theme), below 640px and 768px wide, with the keyboard only, and against [Accessibility](#accessibility).

A settings-style page (the `reports.*` keys are placeholders; add your own first):

```tsx
import { Plus } from 'lucide-react'
import { useT } from '../i18n'
import { Button, EmptyState, PageHeader } from '../components/ui'
import { Card } from './admin/common'

export default function Reports() {
  const t = useT()
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        title={t('reports.title')}
        desc={t('reports.desc')}
        actions={<Button variant="primary"><Plus size={14} aria-hidden /> {t('reports.new')}</Button>}
      />
      <div className="p-4 sm:p-6">
        <Card title={t('reports.recent')} desc={t('reports.recentDesc')}>
          <EmptyState title={t('reports.empty')} />
        </Card>
      </div>
    </div>
  )
}
```

For a page that is not part of the React app, see [Using this outside the React app](#using-this-outside-the-react-app).

## Principles

- **One shell everywhere.** Start any screen from the app shell: a 16rem sidebar on `--c-subtle` on the left, the page on `--c-canvas`, an optional panel on the right. Operator and admin screens use the same shell and the admin page pattern (PageHeader, section nav, Cards), not a separate look.
- **Claude parity by default.** Match how Claude and Claude Code behave and look (sidebar with recent chats, centred composer, steps folded under the answer, artifacts in a side panel). The deliberate difference is per-person permissions and the team server's safety checks.
- **Content first, quiet chrome.** Separate things with 1px `--c-line` borders and `--c-subtle` fills, not shadows. Colour carries meaning: `--c-accent` for the one primary action and live state, status colours for status, nothing decorative.
- **Say it in words.** Every state that matters (paused, stopped, needs your answer, read-only) is written out, not shown by colour or icon alone.

## Colour tokens

CSS variables `--c-<name>`; Tailwind colours of the same name (`bg-surface`, `text-muted`, `border-line`; `web/src/index.css` `@theme`). Values are the Trina edition (`web/src/theme.edition.css`), which overrides the neutral core defaults in `web/src/index.css` (listed at the end). Dark applies when `<html>` has the `dark` class (`web/src/lib/theme.ts`: light, dark or follow the system; saved in the person's preferences and in `localStorage` key `mycel.theme`).

| Token | Light | Dark | Usage |
| --- | --- | --- | --- |
| `--c-canvas` | `#fcfbf8` | `#0e0c0b` | Page background: body, the main column, the sign-in page. Text on it: c-ink, c-muted, c-faint, c-accent-text and the status inks (all at least 4.5:1 in both themes). |
| `--c-surface` | `#ffffff` | `#171412` | Raised things: cards (admin Card, project cards), dialogs, menus, toasts, inputs, the side panel, the composer, secondary buttons. Same text tokens as c-canvas. |
| `--c-subtle` | `#f6f2ea` | `#1d1916` | Quiet fills: the sidebar background, the user message bubble, the neutral badge, skeleton bars, table and card sub-headers, the ask-card header. c-faint on it is 5.2:1 (light) and 5.3:1 (dark). |
| `--c-hover` | `#eee8dd` | `#26211d` | Hover fill for rows, nav items, ghost, secondary and icon buttons; also the ACTIVE sidebar and section-nav item (with font-medium). c-faint on it is the tightest text pair: 4.78:1 / 4.82:1. |
| `--c-line` | `#e9e3d8` | `#2c2723` | Every 1px hairline: dividers, card and dialog borders, secondary-button borders at rest, table row rules. Decorative only: 1.28:1 on c-surface and 1.23:1 on c-canvas (light), 1.24:1 / 1.32:1 (dark). Not for the edge of a text field: use c-field-border. |
| `--c-line-strong` | `#8c8378` | `#6f665d` | Borders that must be seen: the switch track when off (at 60 %), the dashed link chip in answers (Markdown.tsx) and the dashed queued message, the total row in Admin > Usage. 3.73:1 / 3.26:1 on c-surface, 3.60:1 / 3.47:1 on c-canvas. |
| `--c-field-border` | `#8c8378` | `#776e64` | The edge of a text field at rest (`border-field-border`): `inputCls` (inputs, selects and text areas), the chat composer, the edit-message and queued-message forms, the file panel's text editor, the Files search box, the sign-in language select. At least 3:1 on c-canvas, c-surface and c-subtle: 3.60 / 3.73 / 3.34 (light), 3.90 / 3.67 / 3.49 (dark). Only for fields; cards and dividers keep c-line. In light it has the same value as c-line-strong. |
| `--c-ink` | `#14110f` | `#f6f2ea` | Primary text and headings on c-canvas, c-surface, c-subtle and c-hover (15.4–18.8:1 light, 14.3–17.5:1 dark). As a FILL with c-canvas text: the selected tab and the stop button. |
| `--c-muted` | `#514b45` | `#b3aaa0` | Secondary text: descriptions, inactive chat titles in the sidebar, ghost-button and icon-button labels at rest, table meta. 7.0–8.6:1 on every ground, both themes. |
| `--c-faint` | `#6b645d` | `#958c82` | Tertiary text: hints, timestamps, placeholders, section headings in the sidebar, shortcut hints (kbd), decorative icons. At least 4.78:1 on c-canvas, c-surface, c-subtle and c-hover in both themes. |
| `--c-accent` | `#e8521a` | `#ff6a33` | Signal Orange. Fills: the primary button, the account avatar, the skills-pending count, the switch when on, the running dot, the selected answer option border, the focus ring (outline 2px, 3.33–3.71:1 light, 6.1–6.8:1 dark) and a focused field's 2px edge. Text on it is c-accent-ink. Not for small text on c-accent-soft in light (3.33:1): the office-update and info notice banners do that today (flagged). |
| `--c-accent-hover` | `#ff5b1f` | `#ff8352` | Hover fill of the primary button and the round send button. Text on it: c-accent-ink (6.06:1 / 7.72:1). |
| `--c-accent-ink` | `#14110f` | `#14110f` | Text and icons on a c-accent or c-accent-hover fill (primary button label, avatar initial, send arrow): 5.06:1 light, 6.59:1 dark. The same warm black in both themes. |
| `--c-accent-soft` | `#fdf0e8` | `#2b1a11` | Tint behind accent text: the accent badge, the assistant avatar, the artifact icon tile, a picked answer option, a team-file attachment chip, a selected file row (at 60 %), text selection (::selection), info banners. |
| `--c-accent-text` | `#b8380a` | `#ff8a5c` | The accent as text: links, folder icons, the new-chat icon, "Ask AI", the accent badge. 5.2–5.8:1 on c-canvas, c-surface, c-subtle and c-accent-soft (light), 7.2–8.4:1 (dark). |
| `--c-danger` | `#b42318` | `#ff8b7e` | Errors and destructive actions: field errors (role=alert), ErrorNote, error toasts, the danger button label (border at 40 %), failed-step icons, "Delete" menu items. 5.75:1 on c-danger-soft and 6.57:1 on c-surface (light); 7.16:1 / 8.07:1 (dark). |
| `--c-danger-soft` | `#fdecea` | `#34190f` | Background of error notes, error toasts, the danger badge, the offline banner, critical notices, removed diff lines. |
| `--c-warn` | `#8a5300` | `#f0b45a` | Warnings and "needs you": the dev-mode and reconnecting banners, the needs-answer label and dot, the warn badge, the header of a server safety-check card, marked secrets in confirm details. 5.76:1 on c-warn-soft (light), 8.34:1 (dark). |
| `--c-warn-soft` | `#fdf3e2` | `#2e2312` | Background of warning banners, the warn badge, the server safety-check card header, the trash notice. |
| `--c-ok` | `#2f7a4f` | `#7fcf9a` | Success: the done-step check, the ok badge, success toasts, the copied check, added diff lines. 4.60:1 on c-ok-soft (light, the narrowest status pair), 8.42:1 (dark). Always paired with a word or a check icon, never colour alone. |
| `--c-ok-soft` | `#e8f3ec` | `#16271c` | Background of success toasts, the ok badge, added diff lines. |
| `--c-code-bg` | `#14110f` | `#0a0908` | Code blocks in answers: dark in both themes. Syntax colours are literals in web/src/index.css (no tokens). |
| `--c-code-ink` | `#f6f2ea` | `#f6f2ea` | Code text on c-code-bg (16.8:1 light, 17.8:1 dark). |

Elevation token:

| Token | Light | Dark | Usage |
| --- | --- | --- | --- |
| `--c-shadow` | `0 1px 2px rgb(20 17 15 / 0.04), 0 10px 30px -10px rgb(20 17 15 / 0.14)` | `0 1px 2px rgb(0 0 0 / 0.4), 0 10px 30px -10px rgb(0 0 0 / 0.6)` | The app's own elevation token (--c-shadow): the composer, the sign-in card, Word pages in the preview. |

Literal colours with no token: the dialog and drawer scrim `bg-black/40`; the switch knob `white`; the code-block header text `#b9b3a8` with `white/10` rules and hovers; the team-logo preview frames in Admin > Team settings; syntax colours in `index.css` (`.hljs-*`: comment `#8b8579`, keyword `#e8a87c`, string `#a6d189`, number `#ef9f76`, title `#8caaee`, built-in `#e5c890`, variable `#eebebe`, tag `#81c8be`, deletion `#e78284`, meta `#99d1db`; each at least 5.1:1 on `--c-code-bg`).

### Contrast

Measured with the WCAG 2 formula on the values above.

| Pair | Where | Light | Dark |
| --- | --- | --- | --- |
| `ink` on `canvas` | Body text on the page | 18.17 | 17.48 |
| `ink` on `surface` | Text on cards, dialogs, panels | 18.80 | 16.42 |
| `ink` on `subtle` | Sidebar, user bubble | 16.84 | 15.64 |
| `ink` on `hover` | Active nav item | 15.42 | 14.27 |
| `muted` on `canvas` | Secondary text | 8.31 | 8.53 |
| `muted` on `surface` | Secondary text on cards | 8.60 | 8.01 |
| `muted` on `subtle` | Inactive chat titles | 7.70 | 7.63 |
| `muted` on `hover` | Hovered row | 7.05 | 6.96 |
| `faint` on `canvas` | Hints, timestamps | 5.63 | 5.90 |
| `faint` on `surface` | Hints, placeholders | 5.82 | 5.55 |
| `faint` on `subtle` | Sidebar headings, kbd | 5.22 | 5.28 |
| `faint` on `hover` | Hovered row meta | 4.78 | 4.82 |
| `accent-text` on `canvas` | Links | 5.62 | 8.40 |
| `accent-text` on `surface` | Links, Ask AI | 5.82 | 7.90 |
| `accent-text` on `subtle` | New-chat icon | 5.21 | 7.52 |
| `accent-text` on `accent-soft` | Accent badge, assistant avatar | 5.21 | 7.18 |
| `accent-ink` on `accent` | Primary button, avatar | 5.06 | 6.59 |
| `accent-ink` on `accent-hover` | Primary button hover | 6.06 | 7.72 |
| `accent` on `accent-soft` | Office update and info banners (text-accent) | 3.33 **below** | 5.85 |
| `danger` on `danger-soft` | Error note, toast, badge | 5.75 | 7.16 |
| `danger` on `surface` | Danger button, field error | 6.57 | 8.07 |
| `warn` on `warn-soft` | Warning banner, badge | 5.76 | 8.34 |
| `warn` on `subtle` | Needs-answer label in the sidebar | 5.67 | 9.46 |
| `ok` on `ok-soft` | Success toast, badge | 4.60 | 8.42 |
| `ok` on `surface` | Done check | 5.23 | 9.86 |
| `canvas` on `ink` | Selected tab, stop button | 18.17 | 17.48 |
| `code-ink` on `code-bg` | Code blocks | 16.84 | 17.82 |
| `accent` on `canvas` | Focus ring (3:1) | 3.59 | 6.84 |
| `accent` on `surface` | Focus ring; a focused field's 2px edge (3:1) | 3.71 | 6.43 |
| `accent` on `subtle` | Focus ring in the sidebar (3:1) | 3.33 | 6.12 |
| `field-border` on `canvas` | Text field edge at rest (3:1) | 3.60 | 3.90 |
| `field-border` on `surface` | Text field edge at rest, against its own fill (3:1) | 3.73 | 3.67 |
| `field-border` on `subtle` | Text field edge in the sidebar or a sub-header (3:1) | 3.34 | 3.49 |
| `line-strong` on `surface` | Switch track, dashed link chip (3:1) | 3.73 | 3.26 |
| `line` on `surface` | Secondary button border, card edge (decorative) | 1.28 | 1.24 |
| `line` on `canvas` | Hairline divider (decorative, no floor) | 1.23 | 1.32 |

Pairs below the floor, kept as the source has them (fix in a separate change):

- `text-accent` on `bg-accent-soft`, light theme: **3.33:1** for 12px text (`OfficeUpdateBanner.tsx`, info notices in `ManagedNoticesBanner.tsx`). `text-accent-text` on `bg-accent-soft` is 5.21:1.
- `--c-line` borders: 1.23–1.32:1 against `--c-canvas` and `--c-surface` in both themes. Decorative hairlines are fine; secondary-button borders are below the 3:1 non-text floor, so those buttons rely on their label and fill. (Text fields no longer use it: their edge is `--c-field-border`.)
- Switch (`ui.tsx`): the off track (`--c-line-strong` at 60 %) is about 2.0:1 against `--c-surface`; the white knob on the dark accent is 2.85:1.
- Danger button border (`--c-danger` at 40 %): 2.05:1 (light), 2.30:1 (dark); the label carries the meaning.

## Typography

- Sans: `Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", Roboto, system-ui, sans-serif`. Pretendard is not bundled; it is used where installed, otherwise the system face draws the UI.
- Mono: `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`.
- Weights 400, 500 (`font-medium`), 600 (`font-semibold`). No 700.
- Arbitrary sizes (`text-[13px]`) set no line height and inherit 1.5 from the page.

| Style | Size / line | Weight | Classes | Where |
| --- | --- | --- | --- | --- |
| greeting | 28px / 1.5 | 600 -0.025em | `text-[26px] sm:text-[28px] font-semibold tracking-tight` | The home greeting (text-[26px] below 640px, sm:text-[28px]), centred. |
| page-title | 20px / 28px | 600 -0.025em | `text-xl font-semibold tracking-tight` | PageHeader h1 (text-xl font-semibold tracking-tight); the product name above the sign-in card. |
| auth-title | 18px / 28px | 600 | `text-lg font-semibold` | The sign-in card title (text-lg font-semibold). |
| brand | 17px / 1.5 | 600 -0.025em | `text-[17px] font-semibold tracking-tight` | The product name beside the 24px mark at the top of the sidebar (text-[17px] font-semibold tracking-tight). |
| dialog-title | 16px / 24px | 600 | `font-semibold` | Modal title (font-semibold at the inherited 1rem). |
| section-title | 14px / 20px | 600 | `text-sm font-semibold` | Admin Card title, ask-card header, home cards (text-sm font-semibold). |
| reading | 15px / 28px | 400 | `text-[15px] leading-7` | Answers (.answer prose text-[15px] leading-7) and the user message bubble; the composer text (15px). |
| body | 14px / 20px | 400 | `text-sm` | Default UI text (text-sm): nav items, inputs, table cells, card text, dialog body (in c-muted). |
| body-strong | 14px / 20px | 500 | `text-sm font-medium` | Medium button labels, the active nav item, names in tables, field values that matter (font-medium). |
| label | 13px / 1.5 | 500 | `text-[13px] font-medium` | Field labels and small button labels (text-[13px] font-medium). |
| step | 13px / 1.5 | 400 | `text-[13px]` | Step rows under an answer and the folded "작업 N단계" line (text-[13px]). |
| caption | 12px / 16px | 400 | `text-xs` | Hints under fields, meta lines, timestamps, table headers (text-xs). |
| caption-strong | 12px / 16px | 500 | `text-xs font-medium` | Banners, tabs and selected tab labels (text-xs font-medium). |
| micro | 11px / 1.5 | 500 | `text-[11px] font-medium` | Badges, date-bucket headings, kbd hints, count pills (text-[11px] font-medium). At 400 for the chat footer line. |
| nano | 10px / 1.25 | 400 | `text-[10px] leading-tight` | The folder line under a team-file attachment chip (text-[10px] leading-tight). The smallest size in the app. |
| code-block | 13px / 20px | 400 | `text-[13px] leading-5 font-mono` | Code blocks in answers (pre text-[13px] leading-5) on c-code-bg. |
| code-file | 12.5px / 20px | 400 | `text-[12.5px] leading-5 font-mono` | Plain-text file preview in the side panel (text-[12.5px] leading-5). |
| code-detail | 12px / 20px | 400 | `text-[12px] leading-5 font-mono` | Skill diffs and confirm-card details (text-[12px] leading-5), secret boxes (text-sm). |
| code-inline | 0.85em / inherit | 400 | `prose-code:text-[0.85em]` | Inline code in answers: 0.85em on c-subtle, rounded, px-1 py-0.5. |

## Spacing, radius, shadow, layers

Spacing is Tailwind 4's single step (`--spacing: 0.25rem`) used in multiples. The steps the app uses:

| Step | Value | Typical use |
| --- | --- | --- |
| `spacing` | 0.25rem | Tailwind's one spacing step (4px). Every p-*, m-*, gap-* and space-* class is a multiple: p-2.5 = 2.5 × 0.25rem = 10px. The app has no spacing tokens of its own; the rows below are the steps it actually uses. |
| `spacing-0.5` | 0.125rem | 2px. Badge vertical padding (py-0.5), sidebar item stacks (space-y-0.5), tight icon gaps. |
| `spacing-1` | 0.25rem | 4px. Icon-to-label gap in badges and copy buttons, tab strips (gap-1), small offsets. |
| `spacing-1.5` | 0.375rem | 6px. Button icon-to-label gap (gap-1.5), Field label margin (mb-1.5), sidebar chat rows (py-1.5), menu items. |
| `spacing-2` | 0.5rem | 8px. Default small gap (gap-2), nav item vertical padding (py-2), toast and error-note padding. |
| `spacing-2.5` | 0.625rem | 10px. Nav item horizontal padding (px-2.5), sidebar item gap (gap-2.5), ask-card header (py-2.5), small button padding. |
| `spacing-3` | 0.75rem | 12px. Card header and table cell padding (px-3, py-3), section-nav item padding (px-3), common gap. |
| `spacing-3.5` | 0.875rem | 14px. Medium button horizontal padding (px-3.5), example prompt buttons. |
| `spacing-4` | 1rem | 16px. Card body padding (p-4), page gutter on phones (px-4), ask-card body. |
| `spacing-5` | 1.25rem | 20px. Modal body and footer padding (p-5, px-5), page header vertical padding (sm:py-5). |
| `spacing-6` | 1.5rem | 24px. Page gutter from 640px (sm:px-6, sm:p-6), space between messages (space-y-6), card stack (mb-6). |
| `spacing-8` | 2rem | 32px. Chat column top and bottom padding (py-8), owner checklist spacing (mb-8). |
| `spacing-10` | 2.5rem | 40px. Home page vertical padding (py-10), sign-in page (py-10). |
| `spacing-12` | 3rem | 48px. Empty-state vertical padding (py-12). |

| Radius | Value | Use |
| --- | --- | --- |
| `radius-sm` | 0.25rem | 4px. Tailwind rounded and rounded-sm: step rows, menu items inside a menu, the skip link, inline code, image thumbnails. |
| `radius-md` | 0.375rem | 6px. rounded-md: icon buttons, badges, tabs, the sidebar mark (size-6), copy buttons. |
| `radius-lg` | 0.5rem | 8px. rounded-lg (the most used): buttons, inputs, nav items, menus in the sidebar, error notes, answer options, code blocks. |
| `radius-xl` | 0.75rem | 12px. rounded-xl: toasts, attachment chips, account and composer menus, the artifact card, answer error and paused notes. |
| `radius-2xl` | 1rem | 16px. rounded-2xl: admin cards, project cards, dialogs, the sign-in card, ask and confirm cards, the search dialog; rounded-t-2xl for the phone bottom sheet. |
| `radius-3xl` | 1.5rem | 24px. rounded-3xl: the composer and the user message bubble. |
| `radius-full` | 2147483647px | rounded-full (compiled from calc(infinity * 1px)): avatars, the send, stop and mic buttons, the switch, status dots, count pills. |

| Shadow | Value | Use |
| --- | --- | --- |
| `shadow-sm` | `0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)` | Tailwind shadow-sm (and plain shadow): the artifact card, the file chip in answers, image previews, the skip link. |
| `shadow-lg` | `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)` | Tailwind shadow-lg: menus (role=menu, listbox), toasts. |
| `shadow-xl` | `0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)` | Tailwind shadow-xl: dialogs (Modal) and the phone drawer. |
| `shadow-2xl` | `0 25px 50px -12px rgb(0 0 0 / 0.25)` | Tailwind shadow-2xl: the search dialog (Cmd/Ctrl+K). |

| Layer | z-index | Use |
| --- | --- | --- |
| z-menu | 30 | z-30: dropdown menus and listboxes (chat item menu, account menu, file menu, composer menus). Admin > AI connections uses z-10 for one menu. |
| z-overlay | 40 | z-40: the phone sidebar drawer and the phone full-screen side panel. |
| z-dialog | 50 | z-50: Modal (and confirm/prompt dialogs) and the search dialog, each over a bg-black/40 scrim. |
| z-toast | 60 | z-[60]: the toast stack, bottom right (full width on phones). |
| z-skip | 70 | z-[70]: the "Skip to content" link when focused. |

| Breakpoint | Value | What changes |
| --- | --- | --- |
| `sm` | 40rem | 640px. sm: page gutters grow to 24px, dialogs centre instead of a bottom sheet, touch-size controls (max-sm:min-h-10) end. |
| `md` | 48rem | 768px. md: the sidebar becomes a fixed 16rem column (a drawer below), the side panel sits beside the page (a full-screen sheet below), the phone top bar goes. |
| `lg` | 64rem | 1024px. lg: the admin section nav turns from a horizontal strip into a 12rem column; shortcut hints (kbd) show in the sidebar. |

Also `@media (hover: none) and (pointer: coarse)`: inputs, textareas and selects are 16px so iOS does not zoom.

| Size | Value | Use |
| --- | --- | --- |
| sidebar-width | 16rem | w-64 (256px): the left sidebar column from md. |
| drawer-width | 84vw | w-[84vw] max-w-xs (20rem): the sidebar as a drawer below md. |
| section-nav-width | 12rem | w-48: the Admin section nav from lg, the Settings nav from md. |
| chat-column | 780px | max-w-[780px]: the chat messages and the composer, centred. |
| home-column | 720px | max-w-[720px]: the home page (greeting, composer, first-run cards). |
| content-max | 56rem | max-w-4xl: Team skills page body. Settings content uses max-w-2xl (42rem). |
| side-panel-width | 46% | md:w-[46%] with min-w-[360px] and max-w-[880px]: the artifact / file / browser panel on the right. |
| topbar-height | 3rem | h-12: the phone top bar, the chat title bar, the search input. |
| control-height | 2.25rem | h-9 (36px): medium Button and inputs (inputCls); the round send/stop/mic buttons from sm. |
| control-height-sm | 2rem | h-8 (32px): small Button. |
| touch-target | 2.5rem | Below 640px controls grow: max-sm:min-h-10 (40px) for medium buttons and inputs, min-h-9 for small ones, h-10 w-10 round buttons; nav rows get py-2.5. |
| modal-width | 480px | Modal default max width (the width prop). Search dialog: max-w-xl (36rem). Sign-in card: max-w-sm (24rem). Toasts: sm:w-96 (24rem). |

Motion: colour and background changes use Tailwind `transition` (150ms, `cubic-bezier(0.4, 0, 0.2, 1)`); `animate-spin` (1s) for Loader2, `animate-pulse` (2s) for the running dot and skeletons, `.dot` blink (1.2s, staggered 0.2s) for the AI's thinking dots, `animate-ping` for recording. `prefers-reduced-motion: reduce` stops all of it (`index.css`).

## Layout patterns

- **App shell** (`web/src/components/Layout.tsx`): banners stacked on top (dev mode, connection, office update, managed notices, schedule review); then the sidebar column (`w-64 border-r border-line`, hidden below 768px), `main#main` (`flex min-w-0 flex-1 flex-col`), and the side panel (`md:w-[46%] md:min-w-[360px] md:max-w-[880px] border-l border-line bg-surface`; a full-screen sheet below 768px). A skip link comes first.
- **Sidebar** (`web/src/components/Sidebar.tsx`): `bg-subtle`; the 24px mark and the product name (17px semibold); nav rows `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink hover:bg-hover`, active `bg-hover font-medium`, 17px icons (New chat, Search, Projects, Files, Team skills with a count, Admin); recent chats by date bucket (11px `text-faint` headings, 14px rows, active `bg-hover font-medium text-ink`, others `text-muted`, a pulsing accent dot while answering, a warn dot and "Needs your answer" when waiting); Deleted chats; the account button at the foot (32px accent avatar, name, team).
- **Admin and settings pages** (`web/src/pages/admin/AdminLayout.tsx`, `web/src/pages/Settings.tsx`): `PageHeader`, then `flex flex-col gap-4 p-4 sm:p-6 lg:flex-row` with the section nav (`lg:w-48 lg:flex-col`, a sideways strip below; Settings switches at `md`) and the content as `Card`s (`web/src/pages/admin/common.tsx`).
- **Chat** (`web/src/pages/Chat.tsx`, `web/src/components/chat/`): 48px title bar; messages in `mx-auto max-w-[780px] space-y-6 px-4 py-8`; the composer in the same 780px column; the 11px footer line. Home (`web/src/pages/Home.tsx`) uses a 720px column under the greeting.
- **Side panel** (`FilePanel.tsx`, `ArtifactPanel.tsx`, `BrowserPanel.tsx`): header `border-b border-line px-3 py-2` with a 16px type icon, the name (14px semibold), and 16px IconButtons; body on `bg-subtle/50` around a `bg-surface` page.
- **Phones** (below 768px): a 48px top bar (Menu, product name, New chat) replaces the sidebar, which opens as a drawer (`w-[84vw] max-w-xs`, scrim `bg-black/40`, `shadow-xl`); the side panel is a full-screen sheet. Below 640px dialogs are bottom sheets (`rounded-t-2xl`), controls grow to 40px (`max-sm:min-h-10`), hover-only actions are always visible, and bottom padding uses `max(0.75rem, env(safe-area-inset-bottom))`.

## Components

Shared building blocks are in `web/src/components/ui.tsx`; use them rather than re-styling. Class strings below are copied from the code; long ones are cut down to the classes that carry the look (helpers such as `transition`, `whitespace-nowrap` or `min-w-0` are left out).

| Component | Implementation | Guideline |
| --- | --- | --- |
| Button | `ui.tsx` `Button` | Variants `primary` (`bg-accent text-accent-ink hover:bg-accent-hover`), `secondary` default (`border border-line bg-surface text-ink hover:bg-hover`), `ghost` (`text-muted hover:bg-hover hover:text-ink`), `danger` (`border border-danger/40 bg-surface text-danger hover:bg-danger-soft`); base `inline-flex items-center justify-center gap-1.5 rounded-lg font-medium`; `md` `h-9 px-3.5 text-sm max-sm:min-h-10`, `sm` `h-8 px-2.5 text-[13px] max-sm:min-h-9`; `busy` shows Loader2 and sets `disabled` + `aria-busy`; disabled 50 %. One primary per view; dialog footers: ghost Cancel, then primary or danger. Do not recolour a variant with `className`: classes are not merged and `.text-muted` is emitted after `.text-danger`, so `variant="ghost" className="text-danger"` (AskCard's Deny) renders muted. |
| IconButton | `ui.tsx` | `inline-flex items-center justify-center rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink disabled:opacity-40 max-sm:p-2`; `label` is required (aria-label + title). CopyButton: 12px `text-faint`, Check in `text-ok` + "Copied" for 1.5s. |
| Input, select, textarea | `ui.tsx` `inputCls` | `h-9 w-full rounded-lg border border-field-border bg-surface px-3 text-sm text-ink outline-none placeholder:text-faint focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-60 max-sm:min-h-10`; textarea adds `h-auto min-h-16 resize-y py-2`. A field framed by its form (edit-message and queued-message forms) puts the edge and focus on the form (`border-field-border`, `has-[textarea:focus]:border-accent has-[textarea:focus]:ring-1 has-[textarea:focus]:ring-accent`) and the text area inside takes `border-0 focus:ring-0!` (`!`: the input's own ring is emitted later and would win). |
| Field | `ui.tsx` | Label 13px medium above (`mb-1.5`); hint 12px `text-faint`; error 12px `text-danger` with `role="alert"`, `aria-invalid`, `aria-describedby`. |
| Switch | `ui.tsx` | A real checkbox (`peer sr-only`) and a 36×20 track: off `bg-line-strong/60`, on `bg-accent`, white 16px knob; focus outlines the track. For settings that apply at once. |
| Checkbox, answer options | `pages/Files.tsx` `CheckBox`, `chat/AskCard.tsx` | Native inputs with `accent-[var(--c-accent)]`; options are rows `rounded-lg border px-3 py-2 text-sm`, picked `border-accent bg-accent-soft`. |
| Tabs | `ui.tsx` `Tabs` | `role="tablist"`; tab `rounded-md px-2.5 py-1 text-xs font-medium`; selected `bg-ink text-canvas`, others `text-muted hover:bg-hover`. |
| Badge | `ui.tsx` | `inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium`; tones neutral (`bg-subtle text-muted`), accent, warn, danger, ok (ink on its soft fill). Mappings: integration connected/needs_auth/error = ok/warn/danger (`lib/integrations.ts`), owner and admin = accent, member = neutral. The word is the status. |
| PageHeader | `ui.tsx` | `border-b border-line px-4 py-4 sm:px-6 sm:py-5`; title `text-xl font-semibold tracking-tight`; description 14px `text-muted`; actions right. |
| Card, SecretBox | `pages/admin/common.tsx` | `mb-6 rounded-2xl border border-line bg-surface`; header `border-b border-line px-4 py-3` (14px semibold title, 12px `text-muted` description, actions); body `p-4`. No shadow. SecretBox: `rounded-lg border border-line bg-subtle px-3 py-2`, mono, a `text-warn` note. |
| Table | `pages/admin/Members.tsx`, `Usage.tsx`, `Folders.tsx` | `w-full text-sm`; header row `text-left text-xs text-faint` with cells `py-2 pr-3 font-medium`; body cells `py-2 pr-3`, body `divide-y divide-line`; secondary columns `hidden md:table-cell` in 12px `text-muted`; empty values "—"; ghost sm buttons for row actions. |
| File row | `pages/Files.tsx` `FileRow` | Checkbox, 17px type icon (folders `text-accent-text`, files `text-muted`), name truncating in the free width, 12px date and size from 640px, a menu button shown on hover; selected `bg-accent-soft/60`; read-only Lock 12px; badges Conflict copy (warn), Download only (neutral). |
| Modal, confirm and prompt dialogs | `ui.tsx` `Modal`, `DialogHost`, `confirmDialog`, `promptDialog`, `useFocusTrap` | Scrim `bg-black/40`, `z-50`; panel `bg-surface rounded-2xl shadow-xl`, 480px by default, a bottom sheet below 640px; header (16px semibold, close X 18px), body `p-5`, footer `border-t px-5 py-3`. Focus is trapped and returned; Esc closes the top dialog. |
| Menu | `Sidebar.tsx`, `pages/Files.tsx`, `chat/Composer.tsx` | `role="menu"`, `rounded-lg` or `rounded-xl border border-line bg-surface p-1 shadow-lg z-30`; items `flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-hover`, destructive last in `text-danger hover:bg-danger-soft`; unavailable items disabled at 40 % with the reason. |
| Toast | `ui.tsx` `Toaster`, `store/ui.ts` | Bottom right (`sm:w-96`), `rounded-xl border px-3 py-2.5 text-sm shadow-lg`; info on `bg-surface`, success/warn/error as ink on soft fill with a 30 % border; optional underlined action (Undo); errors `role="alert"`. |
| Banners | `Layout.tsx`, `OfficeUpdateBanner.tsx`, `ManagedNoticesBanner.tsx`, `ScheduleReviewBanner.tsx` | Full width, centred, `px-3 py-1`/`py-1.5`, 12px medium, 14px icon; warn for dev mode, reconnecting, schedule review and warning notices; danger for offline and critical notices; accent for the office update and info notices (see Contrast). A note inside a page is not a banner: `SkillIssues.tsx` uses `rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn`. |
| Loading | `ui.tsx` `Spinner`, `Skeleton`; `chat/Messages.tsx` | Spinner: 16px Loader2 + words in `text-faint`, `role="status"`. Skeleton: `h-4 rounded bg-subtle animate-pulse`. Thinking: three 6px `.dot`s and "Thinking…". |
| Empty state | `ui.tsx` `EmptyState` | Centred, `px-6 py-12`; a 26–28px icon in `text-faint` (22px in the Team skills lists); medium title; 14px `text-muted` body or a small button. |
| Error note | `ui.tsx` `ErrorNote` | `role="alert"`, `rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger` with a secondary sm "Try again". |
| Avatar | `Sidebar.tsx`, `chat/Messages.tsx` | Account: 32px `rounded-full bg-accent text-accent-ink`, initial 14px semibold. Assistant: 28px `bg-accent-soft text-accent-text` with Sparkles 15px. Artifact tile: 36px `rounded-lg bg-accent-soft`. |
| User message | `chat/Messages.tsx` `UserMessage` | Right-aligned `max-w-[85%] rounded-3xl bg-subtle px-4 py-2.5 text-[15px] leading-7`; attachment chips above (`rounded-xl border`; team files `border-accent/30 bg-accent-soft`); actions on hover. |
| Assistant message | `chat/Messages.tsx`, `Markdown.tsx` | 28px avatar; `.answer prose` 15/28; code blocks dark (`bg-code-bg text-code-ink`, 13/20 mono); artifact cards `rounded-xl border bg-surface px-3 py-2.5 shadow-sm`; paused, stopped, error and memory notes; actions on hover with the model name. |
| Steps (tool steps, sub-tasks) | `chat/Steps.tsx`, `shared/src/step-labels.ts` | Rows `text-[13px] text-muted`: status icon (Loader2, Check `text-ok`, CircleAlert `text-danger`, CirclePause, CircleStop, Info), kind icon `text-faint`, label, counts in 12px `text-faint`; paused and stopped are also written out. Live: last four steps; done: folded to "N steps". A sub-task is one row with "N tool uses · time" that opens its own steps under `ml-6 border-l border-line pl-3`; while running, its latest step shows beneath it. |
| Ask card | `chat/AskCard.tsx` | `rounded-2xl border border-line`; header `bg-subtle px-4 py-2.5 text-sm font-semibold` with MessageCircleQuestion in `text-accent-text`; options, own-answer textarea, the no-secrets line; footer Skip (ghost) and Answer (primary). |
| Confirmation cards | `chat/AskCard.tsx` (`origin: 'server'`, `browser_site`, `SkillPreview`, `Details`); `server/src/chat/turn.ts`, `server/src/integrations/connections/tools.ts`, `server/src/skills/text.ts`, `server/src/chat/schedule-review.ts` | Warn-framed (`border-warn/40`, header `bg-warn-soft text-warn` with ShieldAlert, or Globe for an address). Address: Allow once / Always allow / Deny. Connection: what the AI wants to do at which service, "Check everything it sends, and where it goes, below", a Details box with every character (fields, full text, long random-looking parts marked `bg-warn-soft text-warn`), Send / Don't send. Wider audience: what was read, where it goes, how many can see it, Save / Don't save. Team skill: the diff (added `bg-ok-soft text-ok`, removed `bg-danger-soft text-danger`). Schedule review: a task made without its card stays paused until checked. Only the card's own options count. |
| Composer | `chat/Composer.tsx` | `rounded-3xl border border-field-border bg-surface shadow-[var(--c-shadow)]`, focus-within `border-accent ring-1 ring-accent` (the 2px accent edge of every field), a file dragged over it `border-accent ring-2 ring-accent/30`; 15px text; chips; attach (Paperclip 18px) and engine picker; round 36px (40px on phones) mic and send (`bg-accent text-accent-ink`, or `bg-subtle text-faint` disabled) or stop (`bg-ink text-canvas`). |
| Search dialog | `SearchDialog.tsx` | Top-aligned at 12vh, `max-w-xl rounded-2xl bg-surface shadow-2xl`, 48px borderless field, results as a listbox with the selected row `bg-hover`. |

## Iconography and logo

- Icons: Lucide (`lucide-react` 1.54.0), 2px stroke on a 24px grid, colour from the element's text token (`text-muted` default, `text-faint` decorative, `text-accent-text` for folders, team files and New chat, status inks for status). Sizes: 13px step rows and answer actions, 14px buttons and menus, 15px admin nav, 16px panel headers, 17px sidebar, 18px dialogs and composer, 20px phone top bar, 26–28px empty states. Icons next to text are `aria-hidden`; icon-only controls need a translated label. No emoji, no other icon set.
- Mark: `web/public/favicon.svg` (Signal Orange spark `#ff6a33` over cream facets `#f6f2ea` on a warm-black tile `#14110f`). In the app: 24px `rounded-md` beside the 17px semibold name in the sidebar, 28px `rounded-lg` beside the 20px name on the sign-in page. No wordmark file; the name is set in type. PNGs in `web/public/icons/` are rendered from the SVG by `web/scripts/make-icons.ts`; the desktop icon is `desktop/build-resources/icon.png`. A team's own logo replaces the tab and home-screen icons only.

## Copy and languages

- Korean in 해요체: polite, plain, from the person's side ("채팅을 삭제했어요.", "첫 대화를 시작해 보세요."). Not 합니다체.
- The person's words, not the system's: team folder, my folder, team skills, owner / admin / member, AI engine, external service. No internal names (mycel, turn, tool ids) in UI copy.
- Errors say what happened and how to fix it: "Couldn't reach the team server. Check your connection and try again." / "팀 서버에 연결하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요." Show server errors through `errorText(e, locale, t('error.network'))` (`web/src/lib/api.ts`; the third argument is the text for when the server can't be reached).
- Confirmations ask a question and state the consequence ("Delete this chat?" + what happens).
- English in sentence case; an ellipsis character "…" for in-progress text; " · " between meta parts; no emoji, no exclamation marks.
- Never ask for secrets in chat; free-text answers to the AI always carry "Don't give the AI passwords or verification codes."
- The product name comes from `PRODUCT` (`{product}` in strings).
- Five locales for every app-owned string (en, ko, id, ja, es): `web/src/i18n/*.ts` and the server's `t(ko, en, id, ja, es)` tables; `bun run check:i18n` must report 0 issues. Plurals: ICU in en, ja and es; a plain `{n}` in ko and id. Korean wraps between words (`:lang(ko) body { word-break: keep-all }`).

## Accessibility

- Focus: `:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px }` everywhere (base layer). Framed fields show focus on the frame instead: a 2px accent edge (`focus:border-accent focus:ring-1 focus:ring-accent`, the 1px border plus a 1px ring; at least 3:1, see Contrast). The composer and Files search use `focus-within`, the edit forms `has-[textarea:focus]`. Do not use a translucent glow (`ring-accent/25` was about 1.4:1).
- Fields: the edge of every text field, select and text area at rest is `--c-field-border` (at least 3:1), never `--c-line`; it is thinner and a different colour from the focused edge. In the Trina light theme `--c-field-border` and `--c-accent` have the same luminance, so focus there is told by the colour and the 2px width, not by lightness.
- Keyboard: Cmd/Ctrl+K search, Cmd/Ctrl+Shift+O new chat, Esc closes the top dialog, else the drawer, else the side panel. Dialogs trap Tab and return focus to their opener (`useFocusTrap`). A skip link is the first focusable element.
- Screen readers: labels on icon-only controls; `role="alert"` for errors, `role="status"` for live status; toasts and the answer status line are polite live regions (`AnnounceProvider`); step states are written out.
- Touch: 40px controls below 640px; 16px inputs on touch screens; row actions visible without hover.
- Reduced motion is honoured globally.
- Contrast: see the table above; do not introduce text lighter than `--c-faint` or accent text in `--c-accent` on tints.

## Using this outside the React app

Server-rendered pages without React (for example the hosting operators' console, which is server-rendered HTML outside this repository) port the look with plain CSS:

1. Declare the variables. Use the `.dark` class when the page has a theme switch, or the media query to follow the system:

```css
:root {
  --c-canvas: #fcfbf8;
  --c-surface: #ffffff;
  --c-subtle: #f6f2ea;
  --c-hover: #eee8dd;
  --c-line: #e9e3d8;
  --c-line-strong: #8c8378;
  --c-field-border: #8c8378;
  --c-ink: #14110f;
  --c-muted: #514b45;
  --c-faint: #6b645d;
  --c-accent: #e8521a;
  --c-accent-hover: #ff5b1f;
  --c-accent-ink: #14110f;
  --c-accent-soft: #fdf0e8;
  --c-accent-text: #b8380a;
  --c-danger: #b42318;
  --c-danger-soft: #fdecea;
  --c-warn: #8a5300;
  --c-warn-soft: #fdf3e2;
  --c-ok: #2f7a4f;
  --c-ok-soft: #e8f3ec;
  --c-code-bg: #14110f;
  --c-code-ink: #f6f2ea;
  --c-shadow: 0 1px 2px rgb(20 17 15 / 0.04), 0 10px 30px -10px rgb(20 17 15 / 0.14);
}

/* dark: on <html class="dark">, or put the same block in @media (prefers-color-scheme: dark) { :root { … } } */
.dark {
  --c-canvas: #0e0c0b;
  --c-surface: #171412;
  --c-subtle: #1d1916;
  --c-hover: #26211d;
  --c-line: #2c2723;
  --c-line-strong: #6f665d;
  --c-field-border: #776e64;
  --c-ink: #f6f2ea;
  --c-muted: #b3aaa0;
  --c-faint: #958c82;
  --c-accent: #ff6a33;
  --c-accent-hover: #ff8352;
  --c-accent-ink: #14110f;
  --c-accent-soft: #2b1a11;
  --c-accent-text: #ff8a5c;
  --c-danger: #ff8b7e;
  --c-danger-soft: #34190f;
  --c-warn: #f0b45a;
  --c-warn-soft: #2e2312;
  --c-ok: #7fcf9a;
  --c-ok-soft: #16271c;
  --c-code-bg: #0a0908;
  --c-code-ink: #f6f2ea;
  --c-shadow: 0 1px 2px rgb(0 0 0 / 0.4), 0 10px 30px -10px rgb(0 0 0 / 0.6);
}
```

2. Set the type: `body { font-family: Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", Roboto, system-ui, sans-serif; background: var(--c-canvas); color: var(--c-ink); -webkit-font-smoothing: antialiased }`, 14px/20px UI text, weights 400/500/600, and the focus rule from Accessibility.

3. Build the shell. A minimal version of the sidebar pattern:

```html
<div class="shell">
  <nav class="side" aria-label="Sidebar">
    <a class="brand" href="/"><img src="/favicon.svg" alt="" width="24" height="24"> Trina AX</a>
    <a class="nav active" href="/customers" aria-current="page">Customers</a>
    <a class="nav" href="/servers">Servers</a>
  </nav>
  <main class="page">
    <header class="page-header"><h1>Customers</h1><p>One line on what this page is for.</p></header>
    <section class="card"><header><h2>Active</h2></header><div class="card-body">…</div></section>
  </main>
</div>
```

```css
.shell { display: flex; min-height: 100vh }
.side { width: 16rem; flex-shrink: 0; background: var(--c-subtle); border-right: 1px solid var(--c-line); padding: 1rem 0.5rem; display: flex; flex-direction: column; gap: 0.125rem }
.brand { display: flex; align-items: center; gap: 0.5rem; padding: 0 0.5rem 0.5rem; font-size: 17px; font-weight: 600; letter-spacing: -0.025em; color: var(--c-ink); text-decoration: none }
.brand img { border-radius: 0.375rem }
.nav { display: flex; align-items: center; gap: 0.625rem; border-radius: 0.5rem; padding: 0.5rem 0.625rem; font-size: 14px; line-height: 20px; color: var(--c-ink); text-decoration: none }
.nav:hover, .nav.active { background: var(--c-hover) }
.nav.active { font-weight: 500 }
.page { flex: 1; min-width: 0 }
.page-header { border-bottom: 1px solid var(--c-line); padding: 1.25rem 1.5rem }
.page-header h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -0.025em }
.page-header p { margin: 0.25rem 0 0; font-size: 14px; color: var(--c-muted) }
.card { margin: 1.5rem; border: 1px solid var(--c-line); border-radius: 1rem; background: var(--c-surface) }
.card > header { border-bottom: 1px solid var(--c-line); padding: 0.75rem 1rem }
.card > header h2 { margin: 0; font-size: 14px; font-weight: 600 }
.card-body { padding: 1rem }
.btn { display: inline-flex; align-items: center; gap: 0.375rem; height: 2.25rem; padding: 0 0.875rem; border-radius: 0.5rem; font-size: 14px; font-weight: 500; border: 1px solid var(--c-line); background: var(--c-surface); color: var(--c-ink) }
.btn:hover { background: var(--c-hover) }
.btn-primary { background: var(--c-accent); border-color: transparent; color: var(--c-accent-ink) }
.btn-primary:hover { background: var(--c-accent-hover) }
.input { height: 2.25rem; width: 100%; border-radius: 0.5rem; border: 1px solid var(--c-field-border); background: var(--c-surface); padding: 0 0.75rem; font-size: 14px; color: var(--c-ink) }
.input:focus { outline: none; border-color: var(--c-accent); box-shadow: 0 0 0 1px var(--c-accent) }
@media (max-width: 767px) { .side { display: none } }
```

Below 768px add the 48px top bar with a menu button that opens the sidebar as a drawer (see Layout patterns). Use Lucide icons (any Lucide distribution; 2px stroke) and the five-locale copy rules above. The desktop app's welcome screens (`desktop/src/ui/ui.css`) are an existing plain-CSS port with their own variable names (`--bg`, `--panel`, `--text`, …); note it differs in places (focus ring `#c43d0a` / `#ff8a5c`, dark danger `#ff8a7a`, no `--c-line-strong`).

## Core neutral theme (overridden)

`web/src/index.css` holds the core product's neutral green theme; `web/src/theme.edition.css` is imported after it and replaces every `--c-*` value for Trina. Do not edit the core values to change Trina's look; edit the edition file.

| Token | Core light | Core dark |
| --- | --- | --- |
| `--c-canvas` | `#faf9f6` | `#1b1a18` |
| `--c-surface` | `#ffffff` | `#232220` |
| `--c-subtle` | `#f3f1ec` | `#2b2a27` |
| `--c-hover` | `#ebe8e1` | `#34322e` |
| `--c-line` | `#e2ded5` | `#3b3934` |
| `--c-line-strong` | `#8f887c` | `#8a8478` |
| `--c-field-border` | `#8b8478` | `#7b766b` |
| `--c-ink` | `#1f1d1a` | `#ece9e3` |
| `--c-muted` | `#57524a` | `#c2bcb1` |
| `--c-faint` | `#6e685e` | `#a39d92` |
| `--c-accent` | `#2c6a59` | `#6fc3a7` |
| `--c-accent-hover` | `#23574a` | `#8dd3bb` |
| `--c-accent-ink` | `#ffffff` | `#0f201a` |
| `--c-accent-soft` | `#e3efe9` | `#213a31` |
| `--c-accent-text` | `#245a4b` | `#8dd3bb` |
| `--c-danger` | `#b42318` | `#ff8a7a` |
| `--c-danger-soft` | `#fdecea` | `#3d1f1b` |
| `--c-warn` | `#8a5a00` | `#f2c66d` |
| `--c-warn-soft` | `#fdf3dc` | `#3a2f17` |
| `--c-ok` | `#1d6b3a` | `#7fd69c` |
| `--c-ok-soft` | `#e5f3e9` | `#1d3324` |
| `--c-code-bg` | `#1e1d1b` | `#141311` |
| `--c-code-ink` | `#ece9e3` | `#ece9e3` |

In the core theme `--c-field-border` is 3.52 / 3.70 / 3.28:1 on canvas / surface / subtle (light) and 3.85 / 3.52 / 3.18:1 (dark); the focused edge (`--c-accent`) is 6.02 / 6.34 / 5.62:1 and 8.31 / 7.60 / 6.86:1. `web/test/unit/field-contrast.test.ts` checks both tokens at 3:1 or more in all four looks.

## Known gaps

- Fonts: Pretendard is named first in the stack but not shipped, so the app renders in the system face unless Pretendard is installed.
- `web/src/lib/theme.ts` sets `<meta name="theme-color">` to the core values (`#faf9f6` light, `#1b1a18` dark), not the Trina canvas (`#fcfbf8` light, which `web/index.html` starts with; `#0e0c0b` dark).
- `web/scripts/make-icons.ts` paints the maskable and Apple touch icons on the core green `#2c6a59`; the committed PNGs are warm black. Re-running the script would change them.
- The mobile shell's accent comes from the edition config (`extra.teamAxEdition.accent`); none is in this repository, so it falls back to the core green `#176b55`.
- `chat/Messages.tsx` uses `text-muted-foreground`, which is not a token (the text inherits its colour).
- One menu (Admin > AI connections) uses `z-10`; the others use `z-30`.
- Korean register: several server and API texts that reach the screen use 합니다체 (`shared/src/api/errors.ts`, `server/src/chat/i18n.ts`, `server/src/auth/messages.ts` and others).
- The contrast pairs listed under Contrast.
