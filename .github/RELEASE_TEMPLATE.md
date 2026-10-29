# Release notes template / 릴리스 안내 양식

Use this to write the annotated tag message before the release workflow runs. Replace every placeholder with reviewed changes; a title-only tag is not useful release guidance. Publishing/backfilling GitHub releases is a separate maintainer action.

## Who benefits / 누구에게 도움이 되나요?

One sentence describing an observable benefit. / 실제 사용자가 체감할 변화 한 문장.

## For your team / 팀원이 달라지는 점

Two to five reviewed changes with a concrete before/after task. / 검토된 변화 2–5개와 업무 예시.

## For the administrator / 관리자 확인 사항

Required actions, migrations, changed defaults and backup requirements. If none, say none known from the reviewed changes. / 조치·마이그레이션·기본값 변경·백업. 없으면 검토 범위에서 없다고 명시.

## Known limits / 알려진 한계

Relevant client/converter/deployment limits. Do not describe pending branches as released. / 클라이언트·변환·설치 방식의 한계. 미병합 기능은 출시로 표현하지 않기.

## Downloads and verification / 다운로드·확인

Use the actual artifacts attached to this release: `TrinaAX-server-<version>-linux-<arch>.tar.gz`, `TrinaAX-office-<version>-mac.zip`, `Trina-AX-Setup-<version>-win-x64.exe`, `SHA256SUMS` and its signature. Include version-specific source, the changelog at that tag and the full comparison. Do not promise a Mac DMG or bundled PDF unless that release actually includes it.

해당 릴리스에 실제 첨부된 파일·체크섬·서명·정확한 태그의 소스·변경 기록·전체 비교를 연결하세요. Mac DMG와 PDF는 실제 포함 여부를 확인하세요.
