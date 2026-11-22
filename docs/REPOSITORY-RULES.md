# 저장소 규칙

기능을 만들기 전에 보고 첫 줄에 `넣을 곳: <레포/폴더>, 이유: <한 문장>`을 쓴다.

코드를 쓰기 전에 `docs/AGENTS/plan/<timestamp>-<feature>.md`에 계획을 먼저 쓰고 브랜치의 첫 커밋으로 올린다. 형식과 템플릿은 [AGENTS/README.md](AGENTS/README.md).

PR은 `CHANGELOG.md`를 고치지 않는다. 사용자에게 보이는 변경은 새 파일 `changes/<topic>.md`에 적는다(규칙: [changes/README.md](../changes/README.md)). `## Unreleased`에 줄을 더한 PR은 CI의 `bun run check:docs`에서 실패한다.

새 설계 결정은 `docs/DECISIONS.md`에 덧붙이지 않고 새 파일 `docs/decisions/<YYYYMMDD>-<topic>.md`에 적는다(머리말: 제목·날짜·상태·대체하는 결정, 규칙: [decisions/README.md](decisions/README.md)). `docs/DECISIONS.md`는 2026-11-16 전 결정의 보관본이다. 절이나 줄을 더한 PR은 `bun run check:docs`에서 실패한다(옛 항목의 오타 고치기는 된다).
연결 방식(팀 연결, 개인 연결, 팀 추천)이나 그것을 보여 주는 화면을 바꾸는 PR은 같은 PR에서 [CONNECTIONS.md](CONNECTIONS.md)를 고친다.
사람에게 묻는 것(AI 카드, 확인 창, 앱의 시스템 권한 요청)을 더하거나 바꾸는 PR은 같은 PR에서 [ASKS.md](ASKS.md)에 항목을 적는다: 항상 허용 범위, 설정에서 거두는 길(없으면 이유), Rule A 상태. `tests/unit/ask-registry.test.ts`가 확인한다(결정: [decisions/20261122-ask-registry.md](decisions/20261122-ask-registry.md)).

- 채팅·권한·파일·스킬·휴대폰·AI 연결·사용량·Linux 실행 기반은 Team AX 코어에 먼저 넣는다.
- 트리나 브랜드는 `editions/trina/branding/`에 둔다. Payple/Paddle·요금제·AWS 리전 선택과 고객 서버 운영·고객 주소·사이트는 비공개 `trina-ax-core`의 `editions/trina/`에 둔다(공개 레포에 넣지 않는다).
- 의료 전용 코드는 메디컬 포크의 `editions/medical/`에 둔다. 운영 중인 메디컬 작업을 수정하지 않는다.
- 코어 파일에 필요한 변경은 설정·훅 같은 공통 확장 지점을 코어에 먼저 만든다.
- 코어는 고객 정보를 제거한 거울을 통해서만 받아 오고, `UPSTREAM.md`에 원본/필터 SHA와 충돌 해결을 기록한다.
- 시스템 패키지나 내려받는 프로그램(apt 패키지, 글꼴, 브라우저, node 등)이 필요한 기능은 한 목록 `scripts/system/packages.json`에 넣는다. 설치 스크립트 하나(이미지, `install-linux.sh`, 개발 환경, 사무실 맥)에만 넣지 않는다. 내려받는 프로그램은 버전과 플랫폼별 sha256을 함께 적는다. `tests/unit/system-packages.test.ts`가 확인하고, 목록이 바뀐 릴리스는 root 업데이트가 된다.
- 비밀값은 팀/개인 폴더·프롬프트·로그·커밋에 두지 않는다.
- GitHub 이름 변경·생성·공개, 기록 재작성·force push, 코어 main 병합·푸시, 고객 서버 접속, 결제·AWS·Cloudflare 계정 변경은 대표 승인 뒤에 한다.
- 코어에서 받아 올 때 다음 경로는 가져오지 않는다(비공개 코어에만 둔다): 코어의 `CLAUDE.md`, `docs/OWNER-TODO.md`, `docs/TODO.md`, `docs/TEST-ENV.md`, `docs/PUBLIC-MIRROR.md`, `docs/SECURITY-AUDIT.md`, `scripts/public-mirror/`, `scripts/check-public-mirror.sh`, `scripts/sync-public-mirror.sh`, `tests/public-mirror/`, `ee/`, `editions/trina/`(단 `branding/` 제외).

## PR을 올리기 전에

- PR을 푸시하기 전에 `bun run check:prepush`를 돌린다. origin/dev를 가져와 CI의 "typecheck, docs, native, relay" 중 빠른 검사(typecheck·docs·변경 기록·마이그레이션 번호, native 빌드는 제외)와 i18n·제품 이름·한글 리터럴·도구 목록 테스트를 dev 기준으로 돌린다. 브랜치가 dev보다 뒤처졌으면 "origin/dev를 먼저 병합하라"고 알려 준다.
- 서버 테스트는 CI와 같은 Bun 1.3.12로 돌린다(`bun:sqlite` 동작이 버전마다 다르다).
- 도구를 추가하는 PR은 테스트의 정확한 도구 목록(`c-tools`, `i-wiring`, `b-browser`)도 함께 고친다.
- 주석과 코드에 제품 이름을 쓰지 않고 `<app>`이라고 쓴다.
- 서버 코드에 한글 리터럴을 넣지 않는다. 화면 글은 i18n 표에서 가져온다(인도네시아어는 "kamu"가 아니라 "Anda").
- dev를 병합한 뒤에는 다시 돌린다. 병합이 새 i18n 키·도구·마이그레이션 번호를 가져온다. 다른 열린 PR이 쓰는 마이그레이션 번호는 `gh`가 있을 때 경고로 알려 준다(Bun 버전이 다를 때도 경고).

## PR이 dev에 들어가는 길 (merge queue)

dev에는 merge queue가 있다(결정: [decisions/20261117-merge-queue.md](decisions/20261117-merge-queue.md)). 저장소 변수 `MERGE_QUEUE`가 `on`일 때:

1. PR을 연다. PR에서는 빠른 검사만 돈다: "what changed", "typecheck, docs, native, relay"(relay는 큐에서만), "Mobile app typecheck", 필수 검사 "typecheck, native, unit, fast fuzz, web, relay"(unit 6개와 fuzz/web, relay는 건너뛴 채 통과).
2. 독립 리뷰를 받는다.
3. `bun scripts/ci/enqueue.ts <번호> <리뷰한 head SHA>`(또는 `bun run queue <번호> <SHA>`)로 큐에 넣는다. 병합이 아니라 큐 등록이다. 스크립트는 PR(dev 대상, 열림, 초안 아님)과 head SHA(7자 이상 앞부분이면 된다)를 확인하고, 필수 검사가 아직 돌고 있거나 실패했으면 큐에 넣지 않고 알려 준다. `gh pr merge <번호> --merge --match-head-commit <SHA>`는 **쓰지 않는다**: gh가 자동 병합을 켜려 하는데 이 저장소는 자동 병합이 꺼져 있어 "Auto merge is not allowed for this repository"로 실패한다(검사가 이미 초록이어도). 스크립트가 쓰는 것은 GraphQL `enqueuePullRequest`(`expectedHeadOid`)이고, 스크립트가 안 될 때의 대안으로 결정 문서에 원문 명령이 있다. `--admin`과 `--delete-branch`는 쓰지 않는다. 관리자는 핫픽스·릴리스 PR에만 `--jump`를 붙인다.
4. 큐가 dev 최신 위에 PR을 얹은 커밋(`merge_group`)에서 전체 검사를 돌린다. 통과하면 dev에 들어가고, 실패하면 실패한 검사와 함께 큐에서 빠진다.
5. 빠졌으면 `merge_group` 실행(Actions, 브랜치 `gh-readonly-queue/dev/pr-<번호>-…`)에서 원인을 보고 브랜치에 고쳐 푸시한 뒤 3의 같은 명령을 다시 한다. 앞 항목 탓이면 고칠 것 없이 다시 넣는다.

- CI를 다시 돌리려고 dev를 브랜치에 병합하지 않는다. dev 병합은 충돌을 풀 때만 한다.
- 전체 검사는 PR마다 큐에서 한 번 돈다(묶음마다 한 번이 아니다). 작고 관련된 변경은 한 PR로 묶어서 큐에 넣는다.
- 위험한 PR은 큐에 넣기 전에 `gh workflow run ci.yml --ref <브랜치>`로 전체 검사를 돌린다(라벨은 쓰지 않는다). 핫픽스·릴리스 PR은 관리자가 큐 맨 앞으로 넣을 수 있다(진행 중인 항목이 모두 다시 돈다, `bun scripts/ci/enqueue.ts <번호> <SHA> --jump`).
- Desktop 워크플로의 PR 작업(Desktop e2e, Mac dmg 검사, Windows 설치 프로그램)은 `desktop/` 등 `desktop.yml`의 경로를 건드린 PR에서 그대로 돈다. 참고용이고 큐에는 절대 들어가지 않는다. 그런 PR은 큐에 넣기 **전에** 이 세 결과를 확인한다.
- 호스팅 macOS 러너가 모자라면 Mac 작업을 로컬에서 돌리고 결과를 PR에 남긴다(Bun 1.3.12, `CI=true`, 서명 없음):
  - `bun install --frozen-lockfile && bun run build:web && bun run prepare:hwp`
  - `cd desktop && bun build.ts && bunx playwright test -c e2e/ci.config.ts`
  - `CSC_IDENTITY_AUTO_DISCOVERY=false bun run --cwd desktop dist:mac && bun scripts/ci/dmg-check.ts desktop/release`

## 공개 기여 / Public contributions

외부 기여자는 이 공개 저장소에 이슈·PR을 제출하면 됩니다. 비공개 코어 접근은 필요하지 않으며 유지보수자가 코어 반영 경로를 처리합니다. External contributors submit here; maintainers handle upstream routing. [개발·검증](DEVELOPMENT.md).
