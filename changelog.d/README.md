# Changelog entries / 변경 기록 항목

A pull request with a user-visible change adds **one new file here**, `changelog.d/<slug>.md`, and does not edit
[CHANGELOG.md](../CHANGELOG.md). Two pull requests never touch the same file, so the changelog no longer makes open
pull requests conflict.

- **Name:** a short slug of the change: lowercase letters, digits and `-`, ending in `.md`, such as
  `room-drop-anywhere.md`. The branch name without its prefix works.
- **Content:** the entry exactly as it would have been written under `## Unreleased`: a Markdown bullet,
  `- What changed, for whom, and what it means for them.` One change may have more than one bullet. A paragraph
  without `- ` is for a note above the list, such as an upgrade note.
- **Not allowed:** an empty file, a heading (`#`, `---`), an unclosed code block, merge-conflict markers. `bun run
  check:docs` checks this, and fails when a new line appears under `## Unreleased` in CHANGELOG.md.
- **Later changes:** fix your entry by editing your file before the release. A later pull request about the same
  feature adds its own file.

**Release:** `bun run changelog:collect` (in the release commit, after the version bump) moves every file here into
CHANGELOG.md under `## <version> — <date>` and deletes it. Paragraphs come first, then the bullets; within each, the
order is the file name. This README stays. Steps: [docs/RELEASE-CI.md](../docs/RELEASE-CI.md) section 1.

사용자에게 보이는 변경이 있는 PR은 여기에 새 파일 `changelog.d/<slug>.md` 하나를 더하고, CHANGELOG.md는 고치지
않는다. 내용은 `## Unreleased` 아래에 쓰던 그대로(`- `로 시작하는 한 줄). 릴리스 때 `bun run changelog:collect`가
CHANGELOG.md의 새 버전 아래로 옮기고 파일을 지운다.
