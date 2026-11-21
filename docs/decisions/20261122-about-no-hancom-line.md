# Settings → About no longer shows Hancom's HWP attribution sentence

- Date: 2026-11-22
- Status: accepted
- Supersedes: the "Settings → About carries it" part of the HWP stage 3 entry in [DECISIONS.md](../DECISIONS.md)
- Branch: fix/about-no-hancom-line

- **Decision:** the owner removed Hancom's attribution sentence ("본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를
  참고하여 개발하였습니다" and its translations) from the Settings → About screen on 2026-11-22 ("완전 삭제"), after being
  told that Hancom's page asks for the sentence in the user interface. It is the owner's call.
- **Changed:** the `about.hwp` text and its `about-hwp` line are gone from the screen and from all locale files.
- **Unchanged:** the AGPL licence line and the source-code link on the same screen; the sentence in NOTICE, the source
  comments and the guide.
- The archive (DECISIONS.md) is not edited; this file is the current rule.
