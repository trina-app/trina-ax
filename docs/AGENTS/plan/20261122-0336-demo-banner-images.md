# Demo banner: the chat shows the saved pictures itself; the gate's practice note pushes Start down

- Date (UTC): 2026-11-22 03:36
- Branch: `fix/demo-banner-images`
- Status: done
- Where: server (registered tools' step pictures, change_banner_text, save_connector_file, the Higgsfield demo fake),
  web (Steps, answer Markdown) and demo-gate (landing page CSS). Why: live replay failures of 11-22
- Version impact: patch, demo fixes (the step pictures also help any picture saved from a connection)

## Goal

1. After a banner change the AI's third picture linked the 1080x1080 file again instead of the story size ("위 그림에는
   1080x1080 파일이 한 번 더 들어갔을 수 있어요"). The AI retyped each picture's Markdown from the tool result. After
   this change the chat shows the saved pictures itself, once each, labelled with their size; the AI writes no paths.
2. At 390 px the opened ⓘ practice note on the gate landing page lay over the Turnstile box until closed. After this
   change it opens in the flow and pushes Turnstile and Start down.

## Scope

In:
- A registered tool's result may name pictures for its step (`stepImages`: path, alt, label). A chat turn puts them on
  the tool's step (Step.images, shown under the steps even when the list is folded, like shared browser screenshots),
  only for the main AI's call (patchToolStep is first in, first out per tool).
- change_banner_text gives every saved size (label "1200x628" …). save_connector_file gives the saved file when it is a
  picture (the Higgsfield demo picture saved after generate_image).
- The result texts (demo-banner.ts, demo/fakes/higgsfield.ts, save-connector-file.ts) say the pictures are shown in the
  chat already and must not be repeated as Markdown images.
- The answer hides a Markdown team picture that one of its steps shows already (a retyped or mistyped repeat).
- Gate: `.practice p` is no longer absolute; its fact takes a line of its own when open.

Out: server/src/chat/prompt.ts (another agent owns it; its DEMO_BANNER_NOTE still says "show it with the Markdown
images its result gives" and should be changed there to match). The hosted demo.

## Steps

1. shared Step.images gets an optional `label`.
2. registry ToolResult / TurnToolResult `stepImages`; tools/index.ts passes it; chat/tools.ts wrapRegistered patches
   the step.
3. demo-banner.ts and save-connector-file.ts return stepImages; result texts changed; Higgsfield fake SAVE_NEXT.
4. web: Steps shows every step's pictures when folded, with their label; Messages hides repeats in the answer.
5. demo-gate pages.ts CSS; unit test.
6. Tests: demo-banner (three files with sizes, stepImages, text), web Steps test (each rendered once, labelled, the
   answer's repeat hidden), demo-gate unit.

## Decisions

none

## Risks

- A tool that patches its own step and returns stepImages too: none today (only change_banner_text and
  save_connector_file return them).
