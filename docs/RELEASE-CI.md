# 태그 하나로 배포하기 (자동 배포)

**현재 Trina 상태:** 최신 버전은 [최신 릴리스](https://github.com/trina-app/trina-ax/releases/latest)에서 확인합니다. `https://updates.trina.app` 피드는 Linux 서버와 사무실 Mac에 업데이트를 제공합니다. 아래는 유지보수자용 배포 절차입니다.
아래 피드 업로드 설명은 별도 피드 게시 설정을 켠 경우에만 적용됩니다. 현재 워크플로의 조건을 먼저 확인하세요.

버전 태그를 push하면 GitHub Actions가 시험, 빌드, 서명과 GitHub Release 게시를 한다.
`CLOUDFLARE_API_TOKEN`이 있는 경우에만 업데이트 피드에도 게시한다. 없으면 GitHub Releases만 사용한다.

- 워크플로: `.github/workflows/release.yml`
- 시험: `.github/workflows/ci.yml`(push·PR 때와 같은 job 전부)
- 스크립트: `scripts/release/release-ci.ts`(태그, 키 확인, 리눅스 서명, SHA256SUMS), `publish.ts`(사무실 피드), `publish-server.ts`(리눅스 서버 피드), `worker.js`(업데이트 주소)
- 제품마다 다른 값(업데이트 주소, 서명 키, Cloudflare 이름)은 배포 채널 `shared/src/release-channel.ts`에서 읽는다(`docs/EDITION-RELEASE.md`). 워크플로와 스크립트에는 제품 이름이나 주소가 없다.

## 버전 번호 / Version numbers

버전은 [Semantic Versioning 2.0.0](https://semver.org/)을 따른다: `MAJOR.MINOR.PATCH`. 사람이든 AI 에이전트든 버전을 올리거나 태그를 달기 전에 아래 표로 자리를 고른다.

**공개 API**(SemVer 규칙 1). 아래가 바뀌면 설치된 팀이 영향을 받는다.
- HTTP API(`/api/…`, `shared/src/api`). 데스크톱 앱·휴대폰 앱·MCP 커넥터가 서버에 기대는 것도 포함한다. 옛 앱은 새 서버와 계속 동작해야 한다.
- 명령: 리눅스 `mycel-ctl`, 사무실 맥 `teamax`
- 플러그인, 스킬(`SKILL.md`), 연결(MCP) 형식
- 사람이 정한 설정: 팀 설정, `server.json`, `MYCEL_*` 환경 변수
- 디스크와 데이터베이스의 데이터(`server/migrations`), 팀 폴더 구조
- 업데이트 피드 형식(`release.json`, manifest)

| 무엇이 바뀌었나 | 올리는 자리 | 예 |
|---|---|---|
| 하위 호환 버그 수정만. 잘못 동작하던 것이 의도대로 동작한다. 새 기능도, 눈에 보이는 모양·동작 변화도 없다 | PATCH | 0.2.21 → 0.2.22 |
| 하위 호환 새 기능, 또는 눈에 보이는 UI/UX 변화. 무엇을 deprecated로 표시할 때도 | MINOR(PATCH는 0) | 0.2.22 → 0.3.0 |
| 설치된 팀이 무언가 하지 않으면 되던 것이 안 된다. 설정·API 삭제, 옛 앱이 못 읽는 형식, 손으로 해야 하는 업데이트 | MAJOR(MINOR·PATCH는 0) | 1.4.2 → 2.0.0 |

- **배포 번호**는 지난 태그 뒤 병합된 변경 중 가장 높은 자리로 정한다. PATCH 여럿과 MINOR 하나면 MINOR다.
- **PR마다 버전 영향을 적는다**: `patch`, `minor`, `major` 중 하나와 이유 한 줄(PR 양식). 문서·시험만 바꾸면 `none`.
- **0.x 동안**: SemVer 규칙 4에 따라 0.y.z는 초기 개발이라, 깨지는 변경도 MINOR로 낼 수 있다. 그때는 릴리스 노트의 관리자 확인 사항에 무엇이 깨지고 무엇을 해야 하는지 분명히 쓴다. 1.0.0부터는 반드시 MAJOR다. 1.0.0으로 갈 시점은 대표가 정한다. SemVer FAQ: "If your software is being used in production, it should probably already be 1.0.0."
- **베타**: `X.Y.Z-beta.N`, `X.Y.Z-rc.N`(beta 채널). 같은 `X.Y.Z`에서 pre-release는 정식보다 낮다: `1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0`. 숫자 부분은 숫자로 비교한다. 숫자 앞에 0을 붙이지 않는다(`0.3.0`이지 `0.03.0`이 아니다).
- **낸 버전은 바꾸지 않는다**(SemVer 규칙 3). 고치면 새 번호다. 태그를 옮기거나 다시 달지 않는다(6장). 깨지는 변경이 MINOR로 나갔다면 호환을 되돌린 새 MINOR를 내고, 노트에 문제 버전과 그 사실을 쓴다(SemVer FAQ).
- 형식(`v` + `server/package.json`의 version, `1.2.3` 또는 `1.2.3-beta.1`)은 `release-ci.ts`의 `RELEASE_VERSION_RE`가 확인한다. 어느 자리를 올릴지는 확인하지 않는다. 그건 사람과 에이전트가 이 표로 정한다.

## 1. 배포하는 법

```sh
# 0) PR이 changes/에 남긴 변경 기록 조각을 CHANGELOG.md의 "## Unreleased"로 옮긴다(changes/README.md).
#    Fold the changelog fragments into CHANGELOG.md, then name the section for the version.
bun run changelog:fold

# 1) 버전을 올린다: server/package.json과 desktop/package.json의 version. 자리는 위 "버전 번호"로 고른다 (예: 0.3.0-beta.1)
#    main은 리뷰된 PR로만 바뀐다(ruleset "main protection"): dev → main PR을 열고 승인받아 병합한다.
git commit -am "0.3.0-beta.1"

# 2) main에 들어간 그 커밋에 태그를 단다. 태그 메시지가 릴리스 노트가 된다(설치의 "새 버전" 안내, GitHub Release).
git tag -a v0.3.0-beta.1 -m "새 기능: …"
git push origin v0.3.0-beta.1

# 3) 태그를 단 바로 뒤, dev의 버전을 다음 PATCH로 올린다(server·desktop·web package.json, 예: 0.3.0 → 0.3.1). 작은 PR 하나.
#    Right after tagging, bump dev to the next patch version (one small PR to dev).
```

- 3)의 이유: dev 빌드의 버전은 `<package version>-dev.<UTC 시각>`이다(dev-build.yml). SemVer에서 `0.5.5-dev.N`은
  pre-release라 `0.5.5`보다 **낮다**. 그래서 dev가 방금 낸 버전에 머물면 dev 빌드가 정식 릴리스보다 옛 것으로 정렬되고,
  그 릴리스를 받은 서버는 뒤의 dev 빌드를 옛 버전으로 본다. dev-build.yml은 dev 빌드가 그 버전의 릴리스보다 새롭다고
  여기므로, 태그 뒤 dev를 `0.5.6`으로 올려 `0.5.6-dev.N`이 `0.5.5` 뒤에 오게 한다. Docker 예시(docker/env.example 등)는
  공개된 최신 릴리스를 가리키므로 이때 올리지 않는다(릴리스 PR에서 올린다). 휴대폰 앱 버전은 따로 간다.
  Why: a dev build is `X.Y.Z-dev.N`, which sorts before `X.Y.Z`; dev-build.yml assumes dev builds are newer than the
  release, which holds only once dev is on the next version. The Docker examples stay on the latest published kit.

- 태그는 `v` + `server/package.json`의 version과 정확히 같아야 한다. 다르면 아무것도 하지 않고 실패한다.
- 태그의 커밋은 main에 있어야 한다(리뷰된 커밋만 나간다). 아니면 prepare가 비밀값을 읽기 전에 멈춘다(`is not on main`). 손으로 다시 돌릴 때는 "Use workflow from"이 그 태그여야 한다(브랜치면 멈춘다).
  - 이 검사는 워크플로 파일 안에 있어 실수를 막는 난간이다. 쓰기 권한이 있는 사람이 검사를 뺀 워크플로로 태그를 다는 것까지 막으려면 4장 5(태그 보호)와 6(environment `release`, 비밀값을 그 environment로)을 설정해야 한다.
- 태그에 `-`가 있으면 beta 채널(`v0.3.0-beta.1`, `v0.3.0-rc.1`), 없으면 stable 채널(`v0.3.0`)이다.
- stable 릴리스는 사흘에 걸쳐 나간다(아래 "단계적 배포"). 모든 서버에 한 번에 내려면 태그 메시지에 `Rollout: all` 한 줄을 넣는다.
- 주석 없는 태그(`git tag v0.3.0`)도 된다. 그때 피드의 노트는 비고, GitHub Release는 노트를 자동으로 만든다.
- 진행은 GitHub의 Actions 탭 → Release에서 본다. 한 번에 하나만 돈다(다음 태그는 앞의 것이 끝날 때까지 기다린다).

## 2. 흐름

| 순서 | job | 하는 일 | 비밀값 |
|---|---|---|---|
| 1 | prepare | 태그 = 버전 확인, 태그의 커밋이 main에 있는지, 채널 결정, 필수 서명 키와 선택적인 Cloudflare 토큰이 있는지, **서명 키의 공개키가 `RELEASE_CHANNEL.keys`에 있는지**(다른 제품 키면 여기서 바로 실패), 태그 메시지 → 릴리스 노트, 단계적 배포(`Rollout:` 줄, `release-ci.ts rollout`) | 키 확인 단계만 |
| 2 | test | `ci.yml` 전체: typecheck, native, 단위, fuzz, 웹, 중계, 리눅스 T1(amd64·arm64), 리눅스 묶음 L19 + verify-bundle, 설치 T2 | 없음 |
| 2 | build-linux | 리눅스 kit amd64(ubuntu-24.04)·arm64(ubuntu-24.04-arm): whisper, native, 웹, `build-bundle.ts --os linux --strict`(서명 없이) | 없음 |
| 2 | build-mac-whisper | Apple 실리콘 사무실 맥의 whisper-cli(`mac-whisper.yml`, build-office와 같은 러너): 고정한 whisper.cpp를 Metal·OpenMP 없이 빌드, 말한 문장을 받아쓰는지 확인, Developer ID 서명(hardened runtime), Apple 공증(아래 "whisper-cli for the office Mac") | 맥 서명 비밀값 5개 |
| 2→3 | build-office | 사무실 zip(macos-15, 또는 `mac_runner` 입력·레포 변수 `RELEASE_MAC_RUNNER`, self-hosted 릴리스 맥은 13장; 두 맥 프로세서 universal, `bun run build:office -- --whisper …`). build-mac-whisper를 기다려 그 whisper-cli를 `app/bin/darwin-arm64/`에 넣는다 | 없음 |
| 2 | build-windows | 윈도우 설치 파일 + `latest.yml`(windows-2025, `desktop dist:win`, 버전은 태그 것). 레포 변수 `WINDOWS_SIGNING_PROVIDER`가 `sslcom`이면 SSL.com eSigner(CodeSignTool)로 서명하고 `signtool verify /pa`로 확인한다(11장), 비어 있으면 서명 없이 | environment `release`의 `SSLCOM_*` 넷(빌드 단계에만) |
| 2 | build-mac-app | 맥 앱(`mac-app.yml`, build-office와 같은 러너): dmg + 업데이트 zip + `latest-mac.yml`. Developer ID로 서명, hardened runtime, Apple 공증, staple, Gatekeeper 확인(아래 "Mac app") | 맥 서명 비밀값 5개 |
| 2 | build-linux-desktop | 리눅스 데스크톱 앱(ubuntu-24.04, `desktop dist:linux`, 버전은 태그 것): x64·arm64의 `.deb`와 AppImage, `latest-linux.yml`·`latest-linux-arm64.yml`. 서명 없음. office_only에서도 돈다. 실패해도 릴리스를 막지 않는다(`docs/decisions/20261119-linux-desktop-app.md`) | 없음 |
| 3 | publish | 리눅스 묶음 서명(manifest.sig) → 사무실 피드(`publish.ts`, 맥 앱이 있으면 `--mac`, 리눅스 데스크톱 앱이 있으면 `--linux`) → 서버 피드(`publish-server.ts`) → `SHA256SUMS` + `.sig` | 키 + Cloudflare 토큰 |
| 4 | github-release | 태그 이름으로 Release. 자산: 리눅스 kit 2개, 사무실 zip, 윈도우 설치 파일, 맥 dmg, 리눅스 `.deb`·AppImage 4개, `SHA256SUMS`, `SHA256SUMS.sig`. beta는 prerelease | 없음(`contents: write`만) |
| 5 | build-ami | stable만, publish와 github-release 뒤: 새 팀 서버 이미지(AMI)를 만드는 `team-image.yml`을 그 태그로 시작한다(10장). 레포 변수 `AWS_ROLE_ARN`이 없으면 notice만 남기고 끝난다. 실패해도 릴리스는 실패로 치지 않는다 | 없음(`actions: write`만) |

2의 job은 동시에 돈다(build-office만 build-mac-whisper 뒤). publish는 시험과 리눅스 빌드가 통과해야 시작한다(사무실·윈도우 빌드가 실패하면 6장 "Desktop builds missing").

- **맥 데스크톱 앱(dmg)은 0.5.6부터 서명·공증되어 들어간다.** build-mac-app이 실패해도 사무실 피드는 `mac` 없이 나가고, "Re-run failed jobs"가 통과하면 같은 버전의 목록에 맥 앱이 더해진다. Mac App Store판은 따로다(`editions/trina/mac-app-store`).
- **dev에서 T1이 빨개지면 이슈가 열린다.** 리눅스 job(T1·L19·T2)은 dev에 push할 때만 돌아서(PR·머지 큐에는 없음) 빨간 채로 아무도 모르고 릴리스를 막은 적이 있다(2026-11-18/19, 약 4시간, 0.5.17). `t1-alert.yml`이 CI가 끝난 뒤(`workflow_run`, dev push만) 그 실행의 T1 job 두 개(amd64·arm64)를 API로 읽어, 하나라도 실패하면 `T1 attack suite red on dev` 이슈 하나를 열거나(이미 열려 있으면 댓글), 커밋·실패한 FAIL 줄·실행 링크를 적고 자기 job도 빨갛게 만든다. 뒤의 dev push에서 T1이 둘 다 통과하면 그 이슈를 스스로 닫는다. 기본 토큰만 쓴다(`issues: write`, 로그를 읽는 `actions: read`, 이 워크플로에만). 취소된 실행(더 새 push)과 T1이 끝까지 돌지 않은 실행은 건너뛴다.
  - **`ci.yml`에 넣지 않는다.** release.yml·msstore.yml이 `ci.yml`을 `contents: read`로만 부르고, 불린 워크플로는 부른 쪽보다 많은 권한을 받을 수 없다. 0.5.19 릴리스가 ci.yml 안의 `t1-alert` job(`issues: write`) 때문에 `startup_failure`로 시작조차 못 했다. `ci.yml`은 `contents: read`만 쓴다. `tests/unit/workflow-permissions.test.ts`가 `uses: ./.github/workflows/…`로 불리는 모든 워크플로의 job 권한이 부른 job의 권한 안에 드는지 본다.
  - **`workflow_run`은 기본 브랜치(main)에 있는 파일로 돈다.** 그래서 `t1-alert.yml`을 바꾸면 다음 릴리스로 main에 들어가야 효과가 있다(그 전까지 dev의 T1 알림은 main에 있는 판으로 돈다; main에 아직 없으면 알림이 없다). `branches: [dev]`는 CI 실행의 브랜치로 거르고, 여기서 `github.ref`는 늘 main이라 dev인지 판단에 쓰지 않는다. job은 `github.event.workflow_run`의 `event == push`·`head_branch == dev`·같은 레포인지를 본다(포크의 dev 브랜치 PR, 머지 큐 `gh-readonly-queue/dev/…`는 제외).
  Why: T1 is not in the merge queue or PRs, so a red T1 on dev is invisible until a release; the issue (opened/commented on red, closed on the next green dev push) is the alarm. It is a separate `workflow_run` workflow because a job asking for `issues: write` inside the reusable ci.yml made the `contents: read` release call fail at start-up (v0.5.19, run 44517924801). It uses no secret; the Discord webhook of `ci-notify.yml` is main-only and optional.
- 시험·빌드·배포는 모두 태그가 가리키는 같은 커밋으로 한다. publish와 github-release는 시작할 때 태그가 아직 그 커밋인지 다시 보고, 태그가 옮겨졌으면 멈춘다.

### 업데이트 주소의 파일

| 경로 | 무엇 | 캐시 |
|---|---|---|
| `<officeDir>/<channel>.json` | 사무실 맥의 서명된 목록(사무실 zip, 윈도우 설치 파일, 맥 앱 `mac`, 리눅스 데스크톱 앱 `linux`) | 안 함 |
| `<officeDir>/<version>/…` | 사무실 zip, 윈도우 설치 파일, `latest.yml`, 맥 dmg, 맥 업데이트 zip, `latest-mac.yml`, 리눅스 `.deb`·AppImage(x64·arm64), `latest-linux.yml`, `latest-linux-arm64.yml` | 영구 |
| `server/<channel>.json` + `.sig` | 리눅스 서버의 채널 머리. 아래 `release.json`과 같은 바이트 | 안 함 |
| `server/<version>/release.json` + `.sig` | 그 버전의 릴리스 정보(`mycel-ctl update --version`) | 안 함 |
| `server/<version>/manifest-linux-<arch>.json` + `.sig` | 묶음의 서명된 파일 목록(다음 릴리스가 root 파일 변경을 판단) | 안 함 |
| `server/<version>/<version>-linux-<arch>.tar.zst` | 설치된 서버가 받는 업데이트 묶음 | 영구 |
| `server/<version>/<kit>-<version>-linux-<arch>.tar.gz` | 새 설치용 kit(`docs/INSTALL-LINUX.md` 3장) | 영구 |
| `server/<version>/teamax-<templateVersion>.v2.ami.json` + `.sha256`, `.sig` | stable 릴리스의 새 팀 서버 이미지(AMI) 목록, 지역별 AMI 하나씩(10장) | json·sig 안 함, sha256 영구 |
| `server/<version>/team-image.json` | 그 릴리스의 이미지가 어느 목록인지(`templateVersion`, `manifest`, `sha256`). 컨트롤 플레인이 버전으로 찾는 곳 | 안 함 |

Worker(`scripts/release/worker.js`)는 이 경로만 읽기 전용으로 내준다. 나머지는 404다.

### 설치에 닿는 방법

- 사무실 맥: 매일 밤 `<feed>/<officeDir>/<channel>.json`을 본다(`docs/OFFICE.md` 6장).
- 데스크톱 앱(윈도우, 그리고 0.5.6부터 서명된 맥 dmg): 피드를 직접 보지 않는다. 팀 서버(리눅스·호스팅은 `system/windows-app.ts`, 사무실 맥은 업데이트 6단계)가 서명된 목록을 확인한 뒤 설치 파일(맥은 업데이트 zip)과 `latest.yml`/`latest-mac.yml`, 그 목록을 `/downloads/`에 둔다. 앱은 4시간마다 `/downloads/`를 보고, 받은 파일이 서명된 목록에 있는 것과 같을 때만 설치한다(맥은 그다음 Squirrel.Mac이 같은 Developer ID 팀의 서명인지 한 번 더 본다).
- 리눅스 서버: `<feed>/server/<channel>.json`과 `.sig`를 본다.
  - 앱만 바뀐 릴리스는 서버가 업데이트 창(기본 03:00–05:00) 안에서 스스로 적용한다. stable은 그 서버의 차례가 온 뒤다(아래 "단계적 배포"; root 타이머·사무실 맥도 같다).
  - root 부분(실행기·샌드박스·유닛, root가 따로 두는 1A 프로그램 `mycel-safeops`·`pandoc`)이 바뀐 릴리스는 `mycel-update.timer`(15분마다 확인, 팀의 업데이트 시간 안에서)가 적용한다.
  - 시스템 패키지와 프로그램의 한 목록(`scripts/system/packages.json`과 `packages.sh`)도 묶음의 `root/`에 들어간다. 그래서 목록이 바뀐 릴리스(새 패키지, 고정한 브라우저의 새 버전)는 따로 손대지 않아도 root 릴리스가 되고(`rootSince`), `mycel-ctl update`가 root 파일과 앱을 넣은 뒤 `root/packages.sh sync`를 따로 된 유닛(`<id>-packages-sync.service`)으로 시작하고 바로 끝난다. 맞춤은 빠진 패키지를 설치하고 브라우저를 고정 버전으로 바꾼다(받기, SHA-256 확인, 실행 확인 뒤 `current` 전환, 바로 앞 버전은 다음 전환까지 둠). 고정한 브라우저는 CI가 Chrome for Testing Stable과 비교한다(같은 주 버전 안에서 뒤처지거나 한 주 버전 뒤처지면 경고, 두 주 버전 이상이면 실패). 올리는 사람은 trina-ax 유지보수자다. 잘못 고정한 버전은 `"revoked"`로 되돌린다(docs/DECISIONS.md "Browser pin"). 결과는 `root/packages.synced`이고, 그 기록이 `root/`의 목록과 다르면(옛 `mycel-ctl`이 root 파일을 바꾼 서버) 새 `mycel-ctl`의 다음 실행(업데이트 타이머, `sudo mycel-ctl update`)이 맞춘다. 내려받는 릴리스는 없다.
  - `publish-server.ts`가 새 묶음의 `root/` 파일과 `native/mycel-safeops`·`bin/pandoc`(`build-bundle.ts` `LINUX_ROOT_COPIES`)을 두 채널 머리 버전의 `manifest-linux-<arch>.json`과 비교하고(비교할 수 없으면 "바뀜"), 그 결과로 `rootSince`(같은 root 부분을 가진 가장 오래된 릴리스)를 정한다. 0.2.19 이상 서버는 `root/VERSION`과 `rootSince`만 비교한다.
  - **`needsRoot`는 0.2.18 이하 서버용이다.** 0.2.14–0.2.18 서버는 `rootSince`를 모르고 `needsRoot`만 본다. 그래서 `--needs-root auto`는 `rootSince`가 0.2.18보다 새로우면 root 부분이 안 바뀌어도 `needsRoot`를 켠다(`NEEDS_ROOT_ONLY_UNTIL`, 0.2.19 리뷰 S3). 꺼 두면 0.2.18 서버의 앱이 0.2.20 같은 앱만 바뀐 릴리스를 스스로 받아 0.2.18 root 부분 위에서 돌고, 그 뒤 모든 릴리스를 거절한다(옛 타이머는 `needsRoot`만 보므로 root 부분도 설치하지 않는다). 0.2.19부터 root 부분이 바뀌었으니 앞으로의 릴리스는 사실상 모두 `needsRoot: true`다. 0.2.18 이하 서버의 앱은 그런 릴리스를 받지 않고, root 타이머가 root 부분과 앱을 같이 설치한다. 0.2.19 이상 서버는 `rootSince`로 판단하므로 앱만 바뀐 릴리스를 그대로 스스로 받는다(앱이 0.2.18 이하로 되돌려진 서버는 root 타이머가 받는다).
  - 배포 전 확인: `publish-server.ts --dry-run`(또는 로그)의 `needsRoot true for servers on 0.2.18 or older` 줄과 `rootSince`. `--needs-root no`는 이 규칙도 끈다(경고를 남긴다). 0.2.18 이하 서버가 하나도 남지 않았을 때만 쓴다.

### 단계적 배포 (staged roll-out)

새 stable 릴리스가 같은 밤 모든 서버에 가지 않게 한다. 나쁜 릴리스가 닿는 팀이 적다. 사람이 할 일은 없다.

- 피드의 `rollout`: `{ percent: 100, salt, ramp: [{ afterHours: 0, percent: 10 }, { afterHours: 24, percent: 50 }, { afterHours: 48, percent: 100 }] }`.
  `publish-server.ts`(`release.json`)와 `publish.ts`(사무실 stable 목록)가 stable 릴리스에 쓰고, `salt`는 릴리스마다 새로 고른다(16바이트 무작위, hex).
- 각 설치가 스스로 판단한다(`server/src/system/rollout.ts`, Go는 `native/cmd/mycel-ctl/rollout.go`, 두 쪽이 `testdata/rollout.json`을 같이 시험한다):
  차례 = sha256(salt + 설치 id)의 앞 2바이트(big-endian) % 100. 차례 < 지금 percent면 자동 업데이트가 받는다. percent는 ramp가 시작된
  때(`since`, 없으면 피드의 서명된 `publishedAt`)부터 지난 시간의 단계다(지난 단계 중 `afterHours`가 가장 큰 것). 다시 게시할 필요가 없다.
  - **연달아 낸 릴리스**: 앞 stable 릴리스의 ramp가 아직 끝나지 않았을 때(시작 뒤 48시간 안) 낸 릴리스는 그 릴리스의 salt·ramp·시작을
    이어받는다(`rollout.since`, `inheritRollout`, 두 배포 스크립트가 채널 머리를 읽어 정한다). 그래서 몇 시간 간격으로 여러 번 내도 첫
    릴리스 뒤 48시간 안에 모든 서버에 닿는다. 매번 10%부터 다시 시작하면 20시간 간격의 배포에서 서버의 절반쯤이 며칠씩 늦고 일부는
    두 주 동안 받지 못한다(시험의 모의 실험). 서버는 `since`가 `publishedAt`보다 늦거나 지금보다 늦으면 `publishedAt`을 쓴다.
  - **너그럽게 읽는다**: 읽을 수 없는 `rollout`(객체가 아님, `null`, percent가 0–100의 수가 아님, salt가 100자 이하 문자열이 아님)은
    단계적 배포가 없는 것으로, 읽을 수 없는 `ramp`·`since`는 빠진 것으로 읽는다. 형식이 나중에 바뀌어도 피드 전체를 거부해 "지금 업데이트"까지
    막히는 일이 없다. TS와 Go가 같게 읽는지 `testdata/rollout.json`의 `reads`로 시험한다.
  - 설치 id: 앱은 `MYCEL_INSTALL_ID`, 없으면 설정 표의 `system.installId`. root 타이머는 `/etc/default/<id>`의 `MYCEL_INSTALL_ID`, 없으면
    `admin.js update-window`의 `installId`. 읽을 수 없으면 마지막 차례(99, 100% 단계)다. 영원히 빠지는 서버는 없다.
  - 기다리지 않는 것: beta 채널의 설치(stable 릴리스가 beta 머리도 되므로 같은 바이트를 보지만 `ramp`를 무시), 피드의 `urgent: true`,
    관리자가 직접 하는 업데이트(관리자 › 시스템 › 업데이트, `sudo mycel-ctl update`, 사무실 "지금 업데이트"·`teamax update now`).
  - 보이는 곳: 관리자 › 홈("새 버전 … · 이 서버 차례인 내일 새벽 03:00–05:00에 자동으로 설치돼요", 지금 설치 버튼), `sudo mycel-ctl status`
    ("this server's turn comes at …", `--detail --json`의 `updates.rollout`), 앱의 `GET /api/admin/update` `hold: 'rollout'`과 `turnAt`,
    사무실 `teamax update status`.
  - root 타이머는 창 안에서 조용한 때를 기다리는 동안(최대 1시간) 피드에 새 릴리스가 올라와도 그 회차에는 설치하지 않는다. 처음
    판단한 버전만 설치하고, 새 릴리스는 다음 확인이 차례를 보고 판단한다.
- **옛 설치(0.4.0-beta.2 이하)**: `rollout`을 zod `z.object`(엄격하지 않음)로 읽어 `ramp`를 버리고 `percent`(100)만 본다. Go `mycel-ctl`도
  모르는 필드를 무시한다. 그래서 예전처럼 바로 받는다(시험: `tests/unit/g-rollout.test.ts` "older servers", `TestOldTimerReadsARampedFeed`).
  서명은 바이트 그대로 검증하고, `minReaderRequired`·reader 수준과는 관계없다.
- **모두에게 한 번에** (나쁜 릴리스를 고치는 릴리스, 보안 수정): 태그 메시지에 한 줄 `Rollout: all`. prepare가 그 줄을 노트에서 빼고
  (`release-ci.ts rollout`) 두 피드에 `--rollout all`을 넘긴다. 그러면 `rollout`이 아예 없다. 손으로 다시 돌릴 때는 Run workflow의
  `rollout` 입력(`tag`=태그 메시지대로, `staged`, `all`). 표시는 그 말만 있는 한 줄이어야 한다. `rollout:`(전각 콜론 `：`도)이 들어간 다른
  줄(목록·인용·제목·굵게·코드·HTML·문장 안, 뒤에 다른 말)이나 `all`·`staged`가 아닌 값이 있으면 prepare가 멈춘다(오타나 꾸밈이 배포 속도를
  정하지 않게). 코드 블록(```, ~~~) 안의 줄은 표시로 보지 않고 노트에 그대로 둔다.
  - 나쁜 릴리스를 고친 릴리스는 `Rollout: all`로 내거나 `urgent`로 낸다. salt를 릴리스마다 새로 고르므로(같은 팀이 매번 먼저 받지 않게),
    ramp가 끝난 뒤 낸 고친 릴리스는 나쁜 릴리스를 먼저 받은 서버에 마지막 차례로 갈 수 있다. ramp가 도는 중에 낸 릴리스는 같은 salt를
    이어받으므로 나쁜 릴리스를 받은 서버가 먼저 받는다.
- 결정은 처음 올린 `release.json`에 남는다. 다시 돌리면(같은 버전, 다른 채널) 그 `release.json`을 그대로 쓴다(요청한 `--rollout`과 다르면
  어느 쪽이든 경고를 남긴다). 사무실 목록도 다시 돌리면 처음 올린 `<dir>/<version>/<channel>.json`을 머리에 다시 둔다(`publishedAt`과 salt가 그대로). 처음에
  윈도우 설치 파일 없이 올린 버전에 다시 돌려 그 파일을 더해도 처음의 `publishedAt`과 `rollout`으로 다시 서명한다.
- 로컬에서: `publish-server.ts --rollout staged|all`, `publish.ts --rollout staged|all`(기본 staged, beta 채널은 늘 없음).
- 나쁜 릴리스의 roll-out을 멈추고 다시 잇기: 6장 "배포 멈추기"(`hosting.ts hold|resume <channel>`, `rollout.hold`).

## 3. 지키는 것

- **되돌아가기 금지**: 채널 머리보다 오래된 버전은 올리지 않는다.
- **같은 이름, 다른 내용 금지**: 이미 올라간 파일은 내용(sha256)을 비교한다. 다르면 멈춘다. 같은 버전을 다시 올릴 때는 같은 파일만 건너뛴다.
  - 피드 읽기는 모두 한 길로 간다(`sign.ts` `feedReader`). 네트워크 오류, 5xx, 408, 429, Content-Length와 다른 길이의 응답은 결론이 아니다. 매번 새 `?t=`로 5번까지 읽고, 그래도 안 되면 아무것도 올리지 않고 멈춘다. 업로드도 5번까지 보낸다(`cloudflare.ts` `putObject`). 거부 응답과 로컬 파일 오류는 바로 멈춘다.
  - **404는 버킷에 묻는다.** 피드의 404 한 번으로는 파일을 올리지도, 되돌아가기 검사를 건너뛰지도 않는다. 버킷의 List Objects(`cloudflare.ts` `hasObject`)도 없다고 할 때만 없다. 버킷에 있으면 다시 읽고, 5번 뒤에도 피드가 404면 멈춘다. 목록을 못 읽으면(권한, 없는 버킷) 역시 멈춘다.
  - 확인과 업로드 사이는 원자적이지 않다. R2의 조건부 쓰기는 S3 API에만 있다. 같은 키에 동시에 쓰는 일은 워크플로의 `concurrency`가 막는다.
  - 다른 내용으로 읽혀도 5초 간격으로 세 번까지 읽은 뒤에 판단한다(`compareRemote`). 처음에 있던 파일이 다시 읽을 때 없다고 나와도 "없음"이 아니다.
  - 아무것도 올리지 않는 `publish.ts --dry-run`은 토큰 없이도 돈다. 그때는 404를 몇 초 간격으로 세 번 보고 없다고 판단한다.
- **같은 빌드는 같은 바이트**(리눅스에서 서명할 때): `sign-linux`를 다시 돌려도 업데이트 묶음과 kit의 바이트가 같다. 모든 항목의 시각이 `manifest.json`의 `createdAt`이고(`bundle.ts` `packTimeMs`), 순서는 이름순, 소유자는 0이고, Ed25519 서명은 결정적이고, 압축 스트림은 소스가 끝나는 시점과 무관하다(`streams.ts` `through`). 그래서 중간에 끊긴 publish를 다시 돌리면 이어서 올라간다.
  - 빌드를 다시 하면 `createdAt`부터 달라지므로 다른 파일이고, 위 규칙대로 거부된다.
  - 보장은 같은 OS, 같은 Bun에서다. kit의 gzip 헤더에는 OS 바이트가 있어 맥에서 다시 서명한 kit은 리눅스 것과 다르고, 위 규칙대로 거부된다.
- **머리는 마지막**: 버전 파일 → 파일 목록 → `release.json` → 채널 머리 순서로 올린다. 중간에 끊겨도 설치는 옛 머리를 계속 본다. 머리와 `.sig` 사이에서 끊긴 상태는 다음 실행이 알아보고 다시 올린다.
- **다시 읽어 검증**: 올린 뒤 업데이트 주소로 머리를 읽는다. 설치된 서버의 `UpdateManager.checkFeed`와 같은 코드로 확인하고, 묶음과 kit도 내려받아 sha256을 비교한다. 사무실 피드(`publish.ts`)는 더 가볍다. 올린 파일마다 HEAD로 길이만 보고, 머리는 다시 읽어 서명과 버전을 확인한다. 파일을 내려받아 sha256을 비교하지는 않는다.
- **리눅스 묶음은 서명 전에 검증**: 모든 파일이 manifest와 맞고, `mycel-ctl`이 그 아키텍처 것이고, kit 안의 manifest가 업데이트 묶음과 같은 서명본이고, kit의 `product.env`가 이 제품의 업데이트 주소를 가리켜야 한다.
- **stable은 beta도 올린다**: stable 배포는 beta 채널이 더 새 버전이 아니면 beta 머리도 이 버전으로 옮긴다(beta를 받는 설치도 정식판을 받는다).
- **비밀값**
  - 두 job(prepare의 키 확인 단계, publish)에만, 쓰는 단계에만 준다. 빌드 job은 비밀값을 보지 않는다.
  - 서명 키는 `umask 077`로 `$RUNNER_TEMP/release-key.pem`(600)에 쓰고, 실패해도 지운다. 로그에는 key id만 나온다.
  - publish job은 `bun install --ignore-scripts`로 패키지 설치 스크립트를 돌리지 않는다.
  - `pull_request`로는 release.yml이 돌지 않는다. ci.yml은 비밀값을 쓰지 않는다(호출할 때도 넘기지 않는다).
- **권한**: 최상위 `contents: read`. `contents: write`는 github-release job에만.
- **외부 action**: 모두 커밋 SHA로 고정했다(ci.yml 포함). 올릴 때는 새 태그의 SHA를 확인해 바꾼다.
- **Go 버전**: 두 워크플로의 `env`에 `GO_VERSION: 1.27.3`(0.2.15를 빌드한 버전)과 `GOTOOLCHAIN: local`을 두고, 모든
  `actions/setup-go`가 `go-version: ${{ env.GO_VERSION }}`을 쓴다. `native/go.mod`의 `go 1.27`만 보면 setup-go가 그날의 최신
  1.27.x를 깔아, Go 패치가 나오거나 러너 이미지가 바뀔 때 root 프로그램(`mycel-ctl`·실행기·샌드박스·bootstrap·`mycel-safeops`)의
  바이트가 달라지고, 그 릴리스가 `needsRoot`가 되어 모든 리눅스 서버에 root 업데이트를 요구한다.
  - 올리는 법: 새 Go를 정한 뒤 한 커밋에서 `versions.json`의 `"go"`, 두 워크플로의 `GO_VERSION`을 같이 바꾼다(`tests/unit/release-ci.test.ts`가
    셋이 같은지 본다). 필요하면 `native/go.mod`의 `go` 줄도. 그 커밋이 들어간 첫 릴리스는 root 프로그램이 바뀌므로 `needsRoot`가 되고,
    서버는 `mycel-update.timer`나 `sudo mycel-ctl update`로 한 번 root 업데이트를 받는다. 보안 패치가 아니면 다른 root 변경과 묶어 올린다.
- **워크플로를 고친 뒤**: `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/release.yml .github/workflows/ci.yml .github/workflows/msstore.yml`
  (shellcheck가 있으면 `-shellcheck $(command -v shellcheck)`도). 스크립트 시험은 `bun test tests/unit/release-ci.test.ts tests/unit/publish-server.test.ts`.

## 4. 처음 한 번 할 일 (계정, 대표 확인 뒤)

1. **GitHub Actions 결제 확인.** 이 레포는 private이라 Actions가 결제 계정의 분을 쓴다. 결제가 막혀 있거나(카드 실패, 지출 한도 0) 분이 바닥나면 **job이 시작되지 않는다.** 태그를 달아도 아무것도 빌드·배포되지 않고, run의 모든 job이 몇 초 만에 실패하며 이 안내만 남는다.
   > The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings

   2026-10-27 현재 이 레포의 CI가 이 상태다(적어도 10-22부터 모든 run이 시작 전에 실패). Settings → Billing and plans에서 결제 수단과 Actions 지출 한도를 고친 뒤 첫 태그를 단다.
2. **Cloudflare 토큰을 CI 전용으로 새로 만든다**(업데이트 피드를 쓸 때만. `CLOUDFLARE_API_TOKEN`이 없으면 release.yml은 피드를 건너뛰고 GitHub Release만 만든다, 2026-10-28). 권한은 최소로 한다.
   - Zone → Zone → Read: 업데이트 주소의 zone 하나(`RELEASE_CHANNEL.hosting.zone`)
   - Account → Workers R2 Storage → Edit
   - CI는 `hosting.ts setup`을 하지 않으므로 Workers Scripts·Routes 권한은 필요 없다.
3. **비밀값을 넣는다.** 레포의 Settings → Secrets and variables → Actions, 또는:
   ```sh
   gh secret set RELEASE_SIGNING_KEY --repo potenlab/team-ax < ~/.config/teamax-release/release-key.pem
   gh secret set CLOUDFLARE_API_TOKEN --repo potenlab/team-ax      # 물으면 토큰을 붙여 넣는다
   ```
   키 폴더는 `RELEASE_CHANNEL.keyDir`이다(Team AX: `teamax-release`). 파일을 화면에 출력하지 말고 리다이렉트로만 넣는다.
4. **Worker를 다시 배포한다.** 새 `worker.js`만 `server/`를 내준다. 그 전에는 `publish-server.ts`가 업로드 전에 멈춘다("does not serve server/ yet").
   ```sh
   bun scripts/release/hosting.ts setup     # 개발 맥, 기존 토큰(~/.config/treesoop/secrets.env)
   bun scripts/release/hosting.ts status    # 끝에 "Updates: office/, server/". "bucket objects can be listed: yes"도 본다(이게 안 되면 publish가 멈춘다)
   ```
5. (권장) **태그 보호**: 쓰기 권한이 있는 사람은 누구나 `v*` 태그로 배포를 시작할 수 있다. GitHub 요금제가 rulesets를 지원하면 `v*` 태그 만들기·옮기기·지우기를 관리자만 하게 한다.
6. **environment `release`**: release.yml의 prepare와 publish job은 `environment: release`를 쓴다(2026-10-28). 공개 레포는 요금제와 관계없이 environment 보호 규칙을 쓸 수 있다. Settings → Environments → `release`에서 (1) 배포 허용 대상을 `v*` 태그와 `main`(feed.yml)으로 제한하고, (2) 두 비밀값을 레포 비밀값에서 이 environment로 옮긴다(권장). 승인자는 두지 않는다: 태그 push가 승인이다(대표 결정 2026-11-14). environment가 없으면 GitHub이 보호 없이 새로 만든다(레포 비밀값은 그대로 쓰인다). 2026-11-14 설정됨(10장 "처음 한 번").

### whisper-cli for the office Mac

Apple 실리콘(M1 이상) 사무실 맥은 키 없이 음성 입력과 녹음·영상 읽기를 맥 안에서 한다(`docs/decisions/20261116-mac-local-speech.md`). 그 whisper-cli는 사무실 zip에만 들어간다(`app/bin/darwin-arm64/whisper-cli`; 설치하면 `app/bin/`). 데스크톱 dmg, 인텔 맥, 리눅스 kit에는 넣지 않는다.

1. `scripts/macos/build-whisper.sh --out dist/mac-whisper`: 리눅스와 같은 whisper.cpp 태그와 sha256(`scripts/linux/downloads.ts`), Metal 켬(셰이더는 프로그램 안: `GGML_METAL_EMBED_LIBRARY`), OpenMP·BLAS 끔, arm64만, macOS 13 이상, 시스템 라이브러리만 링크(otool로 확인).
2. `bun scripts/release/mac-whisper.ts smoke`: `say`로 만든 영어 문장을 tiny 모델(sha256 고정)로 받아쓰는지 본다.
3. `sign`(맥 앱과 같은 Developer ID Application, 서명 id `app.trina.ax.whisper-cli`, hardened runtime, timestamp), `notarize`(`notarytool submit --wait`, Accepted가 아니면 실패; 맨 프로그램은 staple할 수 없어 Gatekeeper가 티켓을 온라인으로 찾는다), `check`.
4. 아티팩트 `mac-whisper`(tar, 파일 모드 유지). build-office가 받아 `build-office.ts --whisper`로 넣고, 넣기 전에 서명·팀·hardened runtime·arm64·시스템 라이브러리를 다시 검사한다. 그 sha256은 zip의 `app/licenses/manifest.json`(다른 프로그램과 같이)에, zip 전체의 sha256은 서명된 사무실 피드 목록에 들어간다.

- 사무실 zip 자체는 공증하지 않는다(설치 스크립트가 격리 속성을 지운다). whisper-cli는 따로 공증되어 있다.
- PR에서 `scripts/macos/build-whisper.sh`, `scripts/release/mac-whisper.ts`, 이 워크플로를 바꾸면 서명 없이 빌드와 받아쓰기만 한다(비밀값은 PR에 가지 않는다).
- 실패하면 build-office도 돌지 않는다(사무실 zip이 이 릴리스에 없다, 6장 "Desktop builds missing"). 리눅스 릴리스는 기다리지 않는다.
- whisper.cpp 버전을 올릴 때: `downloads.ts`의 태그와 sha256, 두 build-whisper.sh의 `VER`, `versions.json`.

### 맥 앱 (Mac app)

다운로드용 맥 앱(dmg)은 Developer ID Application 인증서(Trina Inc., 팀 `YWW96288YY`)로 서명하고 Apple이 공증한다. 처음 열 때 "확인되지 않은 개발자" 경고가 없다. 만드는 곳: `.github/workflows/mac-app.yml`(release.yml의 build-mac-app이 부른다; Actions → Mac app → Run workflow는 아무 브랜치·태그로 같은 파일을 만들고 검사만 하며 아무것도 올리지 않는다).

1. 이 job만의 키체인에 인증서를 넣는다(electron-builder의 `CSC_LINK` 임시 키체인은 지금 macOS에서 `set-key-partition-list`가 실패한다).
2. `bun run --cwd desktop dist:mac:release`: `desktop/electron-builder.devid.config.ts`. hardened runtime, `build-resources/entitlements.mac*.plist`(JIT, 마이크), 샌드박스 없음. electron-builder가 앱을 공증하고 staple한 뒤 dmg(서명)와 업데이트 zip, `latest-mac.yml`을 만든다. appId는 기본 `com.treesoop.mycel`(Mac App Store판 `app.trina.ax`와 다르다).
3. `bun scripts/release/mac-app.ts desktop/release`: 앱과 zip 안의 앱을 검사(codesign --strict, 팀, hardened runtime, 샌드박스 아님, `spctl -a -vv`, `stapler validate`, 같은 cdhash), dmg를 `notarytool submit --wait`로 공증하고 staple, `spctl -a -vvv -t install`, `stapler validate`, 그리고 staple로 바뀐 dmg의 sha512·크기를 `latest-mac.yml`에 다시 쓴다.

비밀값(레포 비밀값, build-mac-app과 build-mac-whisper만 본다). 값은 화면에 내지 않고 파일에서 바로 넣는다:

| 이름 | 무엇 |
|---|---|
| `MAC_DEVELOPER_ID_P12_BASE64` | Developer ID Application 인증서와 키(.p12)의 base64 |
| `MAC_DEVELOPER_ID_P12_PASSWORD` | 그 .p12의 암호 |
| `APPLE_API_KEY_ID` | App Store Connect API 키 id(notarytool) |
| `APPLE_API_ISSUER_ID` | 그 키의 issuer id |
| `APPLE_API_KEY_P8` | 그 키의 `.p8` 내용 |

```sh
base64 -i ~/.config/trina/devid/devid.p12 | gh secret set MAC_DEVELOPER_ID_P12_BASE64 --repo trina-app/trina-ax
gh secret set MAC_DEVELOPER_ID_P12_PASSWORD --repo trina-app/trina-ax < ~/.config/trina/devid/p12.pw
gh secret set APPLE_API_KEY_P8 --repo trina-app/trina-ax < ~/.config/trina/asc/AuthKey_<id>.p8
gh secret set APPLE_API_KEY_ID --repo trina-app/trina-ax       # 물으면 붙여 넣는다
gh secret set APPLE_API_ISSUER_ID --repo trina-app/trina-ax
```

- 인증서는 2027-12-15에 끝난다(ASC id `YY28J76938`). 새 인증서는 Account Holder만 만들 수 있다(API는 403). 개발 맥의 키와 CSR은 `~/.config/trina/devid/`(600). 이미 서명·공증된 앱은 인증서가 끝나도 계속 열린다.
- 맥 앱 업데이트: 팀 서버가 업데이트 zip과 `latest-mac.yml`을 `/downloads/`에 둔다(위 "설치에 닿는 방법"). 0.5.5보다 오래된 팀 서버에서는 앱이 예전처럼 "새 버전이 있어요" 안내만 한다. 서명 전 dmg로 설치한 앱(0.5.4까지)은 스스로 바뀌지 않는다: 새 dmg를 한 번 받아 Applications에 덮어쓴다.

## 5. beta → stable

1. `0.3.0-beta.1`로 올리고 `v0.3.0-beta.1`을 단다. beta 채널을 보는 설치만 받는다.
   - 사무실 맥: `~/TeamAX/teamax update channel beta`
   - 리눅스 서버: `server.json`의 `update.channel`
2. 문제가 있으면 고쳐서 `0.3.0-beta.2`.
3. 괜찮으면 버전을 `0.3.0`으로 올린 커밋에 `v0.3.0`을 단다. stable 설치가 받는다. beta 채널도 `0.3.0`으로 옮겨진다.
   - 버전 문자열이 파일 안에 들어가므로 beta 파일을 그대로 승격하지 않고 다시 빌드한다. 시험도 다시 돈다.

## 6. 실패했을 때

| 어디서 | 상태 | 할 일 |
|---|---|---|
| prepare: 태그 ≠ 버전 | 아무것도 안 함 | 태그를 지운다(`git push --delete origin vX && git tag -d vX`). 버전을 고친 커밋에 다시 단다. |
| prepare: `is not on main` | 아무것도 안 함(비밀값을 읽기 전) | 태그를 지우고, 그 커밋을 리뷰된 PR로 main에 넣은 뒤 main의 커밋에 다시 단다. |
| prepare: 비밀값 없음, 키 불일치 | 아무것도 안 함 | 비밀값을 고친 뒤 그 run에서 "Re-run all jobs" |
| test·build-linux (사무실·윈도우 빌드는 아래 "Desktop builds missing") | 아무것도 안 올라감 | 고친 커밋에 **새 버전**으로 태그(예: `0.3.1`, `0.3.0-beta.2`). 태그를 옮기지 않는다. |
| publish 중간 | 버전 파일 일부만 올라갔을 수 있다. 머리는 그대로라 설치는 영향 없음 | 그 run에서 **"Re-run failed jobs"**. 같은 run의 빌드 결과(7일 보관)를 다시 서명해도 바이트가 같으므로 이어서 올라간다. 올라간 파일을 지우지 않는다. |
| publish: `release.json`이 `.sig` 없이 있다고 멈춤 | 둘 사이에서 끊겼다. 피드의 파일에 서명해 줄 수는 없어 사람이 본다 | 내용을 확인한 뒤 버킷에서 그 `release.json`만 지우고 "Re-run failed jobs" |
| publish: `.sig`가 `release.json` 없이 있다고 멈춤 | `.sig`만 남았다. 새 `release.json`과 맞지 않는다 | 버킷에서 그 `.sig`만 지우고 "Re-run failed jobs" |
| publish: `.sig`가 `release.json`을 검증하지 못한다고 멈춤 | 끊겨서 생기는 상태가 아니다. 둘 중 하나가 바뀌었다 | 지우지 않는다. 누가 왜 바꿨는지 먼저 본다. 고친 뒤 새 버전으로 낸다 |
| publish: `HTTP 5xx`, 네트워크 오류로 멈춤 | 5번 해도 실패했다. 올리기 전 확인이나 업로드에서 멈췄으면 머리는 그대로다. 올린 뒤 재확인에서 멈췄으면 그 파일이나 머리까지 이미 올라갔을 수 있다(로그의 `↑` 줄로 구분한다) | 잠시 뒤 "Re-run failed jobs". 이미 올라간 파일은 같은 바이트라 건너뛴다 |
| publish: `HTTP 404, but the file is there`로 멈춤 | 피드는 404인데 버킷에는 있다. 아무것도 덮어쓰지 않았다 | Worker 배포를 본다(`hosting.ts status`) |
| publish: `list <key>: HTTP …`로 멈춤 | 버킷 목록을 못 읽어 404를 확인할 수 없다. 아무것도 올리지 않았다 | 토큰 권한을 본다(`hosting.ts status`) |
| "Re-run all jobs"나 workflow_dispatch로 다시 | 새로 빌드한 파일은 이미 올라간 것과 내용이 달라 거부된다 | 새 버전으로 태그 |
| build-office가 맥 러너를 못 받아 데스크톱만 빠짐(2026-11-12 v0.5.2, 11-13 v0.5.3), 그 run을 더는 다시 돌릴 수 없음 | 서버 피드는 나갔고 사무실 피드(윈도우·맥 zip)는 이전 릴리스에 남는다 | Actions → Release → Run workflow, "Use workflow from"과 tag는 그 태그, **office_only** 체크. 테스트·리눅스 빌드·서버 피드는 건너뛰고 사무실 zip과 윈도우 설치 파일만 빌드해 사무실 피드에 올린다(리눅스 파일은 GitHub Release에서 받아 SHA256SUMS에만 넣는다). 맥 러너가 또 없으면 **mac_runner**에 `macos-15-intel`(다른 러너 풀; Go·swiftc가 두 프로세서를 같이 빌드해 같은 universal zip). 기본값은 레포 변수 `RELEASE_MAC_RUNNER`, 없으면 macos-15. 이 입력은 이 변경이 들어간 뒤의 태그부터 있다 |
| build-mac-app 실패(맥 러너 없음, 공증 거절, 비밀값 없음) | 사무실 피드는 `mac` 없이 나간다. 맥 앱은 이전 버전 그대로 | 로그를 본다: 공증 거절이면 `notarytool log <id>`가 로그에 있다. 고친 뒤 그 run에서 "Re-run failed jobs": publish가 같은 버전의 목록에 `mac`을 더한다(`versionManifestAction`) |
| build-linux-desktop 실패 | 사무실 피드는 `linux` 없이 나가고 GitHub Release의 "Downloads not in this release yet" 줄에 "Linux (desktop app)"가 붙는다. 리눅스 데스크톱 앱은 이전 버전 그대로 | 로그를 본다. 고친 뒤 그 run에서 "Re-run failed jobs": publish가 같은 버전의 목록에 `linux`를 더하고(`versionManifestAction`), 모든 다운로드가 있으면 그 줄을 지운다 |
| github-release | 피드는 이미 끝남 | "Re-run failed jobs" |
| 맥 파일이 이미 피드에 올라간 릴리스를 "Re-run all jobs" | 맥 빌드는 할 때마다 다시 서명·공증해서 dmg·zip 바이트가 달라진다. publish.ts가 거부한다 | 이런 릴리스는 **"Re-run failed jobs"만** 쓴다. 맥만 다시 만들어야 하면 새 버전으로 태그 |
| 잘못된 버전이 나감 | 설치는 뒤로 가지 않는다. stable이면 단계적 배포로 첫날은 약 10%만 받았다 | **먼저 멈춘다: `bun scripts/release/hosting.ts hold stable --reason "…"`** (아래 "배포 멈추기"). 아직 받지 않은 서버·사무실은 지금 버전에 머문다. 그다음 고친 새 버전을 태그 메시지 `Rollout: all`로 낸다(2장 "단계적 배포"). 리눅스 서버는 새 버전이 켜지지 않으면 이전 버전으로 스스로 돌아가고 7일간 다시 시도하지 않는다. 사무실 맥도 되돌린다(`docs/OFFICE.md`). |

### 배포 멈추기 (hold a bad release)

나쁜 stable 릴리스가 더 많은 서버에 닿지 않게 하는 한 단계. 새 버전을 낼 필요가 없다. 주인의 맥에서(배포 키와 Cloudflare 토큰이
있는 곳):

```sh
bun scripts/release/hosting.ts hold stable --reason "0.5.2 crashes on start"   # 멈춘다
bun scripts/release/hosting.ts held stable                                      # 지금 머리가 무엇을 말하는지(읽기만)
bun scripts/release/hosting.ts resume stable                                    # 다시 이어 간다
```

- 먼저 `--dry-run`을 붙여 무엇을 올릴지 본다. `--version 0.5.2`를 붙이면 머리가 그 버전일 때만 바꾼다(다른 릴리스를 멈추지 않게).
- 하는 일(`scripts/release/hold.ts`): 채널 머리 `server/<channel>.json`(+ `.sig`)과, 같은 버전이면 사무실 목록 `<officeDir>/<channel>.json`만
  같은 릴리스 키로 다시 서명해 올린다. 버전의 파일(`server/<version>/release.json`, `<officeDir>/<version>/<channel>.json`, 묶음)은
  건드리지 않고, 머리를 다른 버전으로 옮기지 않고, 아무것도 지우지 않는다. 올리기 직전에 머리를 다시 읽어 그사이 배포가 있었으면 멈춘다.
- 멈춘 머리의 `rollout`: `percent: 0`, ramp는 0% 한 단계, `hold: { at, reason }`, `changedAt`. 서버 머리는 `minFrom`도 그 버전 자신이
  된다. 그래서 모든 업데이트가 멈춘다: 앱의 자동 업데이트(`why: 'paused'`, 로그 "automatic update: the publisher paused this release"),
  root 타이머("the publisher paused release …"), 사무실 맥, `hold`를 모르는 서버(ramp만 아는 0.4.0-beta.3 이후는 0% 단계, percent만
  아는 0.4.0-beta.2 이하는 percent 0, rollout을 모르는 옛 root 타이머는 `minFrom`), urgent 릴리스와 beta 채널(percent만 본다)도.
  관리자의 "지금 업데이트"(관리자 › 시스템, `sudo mycel-ctl update`, `teamax update now`)도 설치하지 않는다. 관리자 › 홈은
  "Updates are paused by {product}"(제품 이름)라고만 말한다(이유는 로그와 `mycel-ctl status`에만).
- 이미 그 버전인 서버는 그대로 돈다(설치는 뒤로 가지 않는다). 되돌리기는 위 표대로 고친 새 버전으로 한다.
- `resume`: 멈추기 전의 roll-out(멈춘 머리의 `rollout.before`)과 `minFrom`(`hold.minFrom`)을 돌려준다. 아직 오지 않은 단계는 멈춘 시간만큼
  늦춰지므로 ramp는 멈춘 곳에서 이어진다(예: 30시간째 50%에서 멈추고 72시간 뒤 다시 이으면 바로 50%, 100%는 120시간째). roll-out 없이
  낸 릴리스(`Rollout: all`)는 percent 100(모두)으로 돌아간다.
- **다시 보낸 옛 머리**: 서버·root 타이머·사무실은 그 피드 주소(사무실은 채널)에서 본, 멈춤·이어 감이 바꾼 가장 새 머리의 버전과
  `changedAt`을 따로 기억한다(앱 `data/update-seen-head.json`, root `root/feed-seen.json`, 사무실 `update/state.json` `seenHead`). 같은 버전인데
  그보다 이른(또는 없는) 머리는 옛 사본으로 보고 받지 않는다("지금 업데이트"도). 그 사이 더 옛 버전의 머리가 와도 기록은 그대로다. 그래서
  멈추기 전의 서명된 머리를 누가 다시 내보내도 멈춤이 풀리지 않는다. 처음 보는 서버는 이 보호가 없다(머리는 캐시하지 않는다).
- 멈춘 머리 위에 **새 버전**을 내면 보통처럼 그 버전이 머리가 된다(새 ramp, 멈춘 릴리스의 salt·시작을 이어받지 않는다). 고친 릴리스는
  `Rollout: all`로 낸다. 멈추거나 이어 간 버전을 **다시 돌리면**(Re-run failed jobs) 버전 파일은 올라가도 머리는 그대로다(`publish-server.ts`,
  `publish.ts`가 "holds … left as it is" / "was resumed … left as it is"를 남긴다). 풀려면 `resume`. 서버 머리가 새 버전으로 갔는데 사무실
  목록만 멈춘 채 남았으면(사무실 배포 실패) `resume <channel> --office-version <그 버전>`으로 그 목록을 돌려준다(이름을 댈 때만:
  서버 머리를 위한 `resume`이 다른 나쁜 릴리스를 풀지 않게).
- beta 채널은 따로다: stable 릴리스는 beta 머리도 되므로 beta 서버까지 멈추려면 `hold beta`도 한다.
- `hold`가 머리와 `.sig` 사이에서 끊기면 다음 `hold`·`resume`이 "does not verify"로 멈춘다(설치는 마지막으로 확인한 머리를 쓰니 안전하다).
  로그의 `↑` 줄로 어디까지 올라갔는지 보고, 같은 명령을 다시 돌리기 전에 버킷의 `server/<channel>.json`을 `server/<version>/release.json`과
  같게 되돌린다(그 `.sig`는 버전 파일의 것과 같다). 그러면 다시 멈출 수 있다.
- 지키지 못하는 것: rollout을 모르는 사무실(0.4.0-beta.2 이하)은 사무실 목록의 `minFrom`을 바꾸지 않으므로 멈추지 않는다. 호스팅 클라우드는
  rollout을 보지 않는다(제어판이 고른다); 멈춘 머리의 `minFrom`을 제어판이 어떻게 읽는지는 그쪽 레포에서 확인한다.
- 시험: `tests/unit/release-hold.test.ts`(계산, 업데이트, 임시 키·임시 피드로 스크립트), `TestScheduledUpdateHeld`(root 타이머).

### 지금 모두에게 (promote a good release)

좋은 stable 릴리스의 단계적 배포를 앞당겨 끝낸다: 모든 서버·사무실이 지금 스스로 받는다(처음부터 `Rollout: all`로 낸 것처럼). 새 버전을
낼 필요가 없다.

- 키와 토큰이 이 맥에 없으면 GitHub에서: Actions → **Feed** → Run workflow(main에서), action `promote`, channel `stable`, version(머리가
  지금 말하는 버전, 예: `0.5.3`). 먼저 dry_run 그대로 돌려 무엇을 올릴지 보고, 다시 dry_run을 끄고 돌린다. 끝에 `held`가 두 머리를 보여 준다.
  같은 워크플로로 `hold`(reason 필수)·`resume`·`held`도 된다. release.yml과 같은 concurrency 그룹이라 릴리스가 올라가는 동안에는 기다린다.
  다만 GitHub은 그룹마다 기다리는 run을 하나만 두므로, 릴리스 run이 기다리는 중에 Feed를 돌리면 그 릴리스 run이 취소된다: 그때는 돌리지
  않는다(`held`는 읽기만 해서 다른 그룹). main에서 도므로 `release` environment에 "v* 태그만" 규칙을 넣게 되면 main도 허용해야 한다.
- 키가 있는 곳에서는 `bun scripts/release/hosting.ts promote stable --version 0.5.3 [--dry-run]`.
- 하는 일(`promoteRollout`): 두 머리의 rollout을 percent 100, ramp 없음, salt 그대로, 새 `changedAt`으로 다시 서명한다. `minFrom`과 버전 파일은
  그대로다. ramp를 모르는 서버(percent만), hold를 모르는 서버, urgent·beta 모두 100%로 읽는다. 앞의 머리를 본 서버는 `changedAt`이 더
  나중이라 이것을 받는다(newerHeadSeen). 이미 모두에게 가는 머리는 그대로 둔다.
- 멈춘 머리는 promote하지 않는다(먼저 `resume`: 멈춤은 사람이 내린 결정이라 promote가 덩달아 풀지 않게). 사무실 목록이 다른 버전이면 그대로 둔다.

- 같은 태그를 다시 돌리려면 Actions → Release → Run workflow에서 tag를 넣는다. "Use workflow from"도 같은 태그로 고른다(그 태그의 release.yml·ci.yml로 돈다).
- 로컬에서 같은 일을 하려면 `publish.ts`(사무실)와 `publish-server.ts --dir <서명된 묶음 폴더>`(리눅스)를 쓴다. 리눅스 묶음은 리눅스(같은 아키텍처)에서만 빌드된다.
- GitHub Release 파일 확인: 받은 폴더에서 `bun scripts/release/release-ci.ts verify-sums SHA256SUMS`(이 빌드의 공개키로 `.sig`를 확인한 뒤 옆의 파일 sha256을 본다).

**Desktop builds missing.** The Linux server release does not wait for the desktop builds. When `build-office` or `build-windows` fails or gets no hosted runner (macOS on 2026-11-02, 03 and 04), `publish` still signs and publishes the Linux builds to the server feed. It does not change the office feed (the offices keep the previous release) and logs a `::warning::`. `SHA256SUMS` lists only the files that are in the release, and the GitHub Release body starts with a line that names the missing downloads. To add them, use "Re-run failed jobs" in the same run (artifacts stay 7 days): `publish` runs again, uploads the same server files again (they are skipped), publishes the office feed and adds the files to the GitHub Release. The GitHub Release job removes the "not in this release yet" line once both desktop files are there. A person who cancels the run still stops `publish`. When the run can no longer be re-run (artifacts gone, or GitHub lost its jobs), run the workflow by hand from the same tag with **office_only**: it skips the tests, the Linux builds and the server feed, builds only the office zip and the Windows installer, and publishes the office feed (the Linux files are taken from the GitHub Release for `SHA256SUMS` only). The office zip runs on **mac_runner**, else the repository variable `RELEASE_MAC_RUNNER`, else `macos-15`; `macos-15-intel` draws from another pool and builds the same universal zip. Both inputs exist only in tags made after they were added.

## 7. 키를 바꿀 때

설치는 빌드에 들어 있는 공개키(`RELEASE_CHANNEL.keys`)만 믿는다. 순서를 지키지 않으면 설치가 업데이트를 받지 못한다.

1. 새 키를 만든다: `TEAMAX_RELEASE_KEY=~/.config/<keyDir>/release-key-2.pem bun scripts/release/keygen.ts`
2. 새 공개키를 채널에 **추가**한다(`editions/<name>/branding/release-channel.json` → `edition-release.ts --apply`, 코어는 `shared/src/release-channel.ts`를 도구로). 옛 키는 남긴다.
3. 그 빌드를 **옛 키로** 배포한다(비밀값은 아직 옛 키). 모든 설치가 그 버전을 받을 때까지 기다린다.
4. 비밀값을 새 키로 바꾼다: `gh secret set RELEASE_SIGNING_KEY --repo <repo> < ~/.config/<keyDir>/release-key-2.pem`
5. 다음 태그부터 새 키로 서명된다. 모든 설치가 새 키로 서명된 빌드를 받은 뒤 옛 키를 목록에서 뺀 빌드를 낸다.

prepare는 비밀값의 키가 목록에 없으면 멈춘다. 그래서 2를 건너뛰고 4를 하면 배포가 시작되지 않는다.
키가 새었다면 같은 순서로 바꾸되 서두른다. 옛 키를 뺀 빌드가 퍼지기 전까지는 그 키로 서명된 가짜 업데이트를 설치가 믿는다.

## 8. 비용 (private 레포)

- GitHub가 호스팅하는 runner는 결제 계정의 Actions 분을 쓴다. 무료 분과 단가는 요금제마다 다르니 Billing 페이지에서 확인한다.
- 무료 분을 셀 때 리눅스 1분 = 1분, 윈도우 1분 = 2분, **macOS 1분 = 10분**으로 센다. 무료 분을 넘으면 macOS 단가가 리눅스의 약 10배다.
- 한 번 배포의 시간은 아직 재지 않았다. 대략 추정:
  - 시험(ci.yml) 리눅스 약 2시간어치(7개 job 합)
  - 리눅스 빌드 2개 약 1시간
  - 맥 빌드 약 20–30분(무료 분 기준 200–300분)
  - 윈도우 약 15–20분(무료 분 기준 30–40분)
  - publish 약 15분
  - 맥 job 하나가 한 번 배포의 절반쯤을 차지한다. 첫 배포 뒤 실제 시간을 여기에 적는다.
- arm64 리눅스 runner(`ubuntu-24.04-arm`)는 ci.yml이 이미 쓰고 있다. private 레포에서의 단가도 Billing에서 확인한다.
- 레포가 공개되면(트리나 AX) 표준 runner는 무료다.

## 9. 판매판(트리나 AX·의료판) 레포에서 할 일

워크플로와 스크립트는 코어 병합으로 받는다. 고칠 것은 없다. 제품 값은 각 레포의 배포 채널에서 읽는다.

1. 판매판 채널을 적용한다(`docs/EDITION-RELEASE.md`): 그 제품의 서명 키, `editions/<name>/branding/release-channel.json`, `edition-release.ts --apply`.
2. 그 레포에 비밀값 두 개를 넣는다. 키는 그 제품의 `keyDir`, 토큰은 그 제품 zone·bucket이 있는 Cloudflare 계정 것이다.
   ```sh
   gh secret set RELEASE_SIGNING_KEY --repo trina-app/trina-ax < ~/.config/<트리나 keyDir>/release-key.pem
   gh secret set CLOUDFLARE_API_TOKEN --repo trina-app/trina-ax
   ```
   다른 제품 키를 넣으면 prepare가 멈춘다(key id만 보여 준다).
3. 그 제품의 업데이트 주소를 만든다: `bun scripts/release/hosting.ts setup`(그 레포 작업본에서, 그 계정 토큰으로).
4. 위 4장의 결제 확인과 태그 보호를 그 레포에서도 한다.
5. **의료판 버전 규칙**: 지금 의료판 버전은 `0.2.1-medical.N`이다. `-`가 있어 이 워크플로는 beta로 낸다. stable로 내려면 버전 규칙을 정해야 한다(예: `0.2.3`처럼 `-` 없이). 정하기 전에는 의료판 태그를 달지 않는다.
6. 트리나 AX는 공개 레포다.
   - 공개 레포에서도 fork PR은 비밀값을 받지 않고, release.yml은 PR로 돌지 않는다.
   - 공개 전에 `gh secret list`로 필요한 비밀값만 있는지 본다.

## 10. 새 팀 서버 이미지 (AMI)

새 팀의 서버(EC2)가 시작하는 이미지는 stable 릴리스마다 CI가 만든다(대표 결정 2026-11-14). 사람이 할 일은 처음 한 번의 설정뿐이다.

### 흐름

1. release.yml의 `build-ami` job: stable 릴리스가 피드에 오르고 GitHub Release가 생기면(publish·github-release 성공) `team-image.yml`을 그 태그로 시작한다(`gh workflow run`). release.yml 안에서 직접 만들지 않는 이유: 이미지는 최대 3시간 걸리고, release.yml의 concurrency 그룹은 feed.yml(배포 멈추기·promote)과 같다. 멈추기가 이미지를 기다리면 안 된다. GitHub은 한 concurrency 그룹에 대기 run을 하나만 두므로, stable 릴리스 둘이 잇달아 나가면 앞의 것의 run이 빠질 수 있다. 그때는 손으로 다시 돌린다.
2. `team-image.yml`(environment `release`, Actions → Team image에서 손으로도 돌릴 수 있다: "Use workflow from"과 tag 모두 그 태그):
   1. 설정 확인. 태그가 아직 이 run의 커밋인지 보고(태그가 옮겨졌으면 멈춘다), 그 커밋(`github.sha`)을 받는다. `AWS_ROLE_ARN`, `AMI_SUBNET_ID`, 두 비밀값 중 하나라도 없으면 notice만 남기고 성공으로 끝난다. 피드에 `server/<version>/team-image.json`이 이미 있으면 할 일이 없다.
   2. GitHub Release의 서명된 `*-linux-amd64.tar.gz` kit를 받아 `SHA256SUMS.sig`로 확인한다. `mycel-enroll`·`mycel-link`는 같은 태그에서 빌드한다(`native/build.sh`, 고정 Go).
   3. AWS 로그인: GitHub OIDC(`aws-actions/configure-aws-credentials`, SHA 고정). 저장된 AWS 키는 어디에도 없다. 세션은 4시간.
   4. `scripts/image/build-ami.sh`로 ap-northeast-2에서 AMI를 만든다(`--tag ax:built-by=release-ci`). 같은 릴리스의 앞선 시도가 만든 AMI가 있으면 그것을 쓴다.
   5. `build-ami.sh --manifest-v2 --copy-to ap-southeast-1 --copy-to us-east-1`(키 없이, `AMI_COPY_TO`): 싱가포르와 버지니아로 차례로 복사하고 v2 목록을 쓴다. 그다음 짧은 서명 단계가 목록에 릴리스 키로 서명한다(`ax-template-v1\n<templateVersion>\n<sha256>`, 스크립트·hostd와 같은 메시지). 키는 그 단계의 몇 초 동안만 `$RUNNER_TEMP`의 600 파일로 있고 바로 지운다. 이 템플릿의 서명된 목록이 피드에 이미 있으면(앞선 시도가 목록까지 올리고 멈춤) 새로 만들지 않고 그것을 받아 쓴다. 새로 만들면 `builtAt`이 달라 피드가 받지 않는다.
   6. `scripts/release/publish-ami.ts`: 목록, `.sha256`, `.sig`를 `server/<version>/`에 올리고 마지막에 `team-image.json`을 올린다. 올리기 전에 서명을 이 제품의 키로 확인하고, 피드에 다른 바이트가 있으면 덮어쓰지 않고 멈춘다.
   7. `scripts/image/ami-prune.sh`: 지역마다 CI가 만든 이미지(`ax:managed=ami` + `ax:built-by=release-ci`) 중 필요 없는 것만 등록 해제 + 스냅샷 삭제. 무엇을 남길지는 `scripts/image/ami-prune-select.ts`가 정하고(단위 시험 `tests/unit/image-ami-prune.test.ts`), 이미지마다 남기는 이유를 모두 로그에 쓴다. 다음 중 하나라도 맞으면 남긴다: 방금 올린 이미지, `ax:keep=true` 태그, `ax:in-use` 태그(`false`가 아닌 값), 최근 5개 **릴리스**(`AMI_KEEP`, 이미지 수가 아니라 `ax:template`의 버전 순서, 그 릴리스의 이미지는 모두), 만든 지 14일이 안 된 이미지(`AMI_MIN_AGE_DAYS`, 호스팅 롤아웃이 도는 동안 컨트롤 플레인은 앞 릴리스로 새 팀을 만든다), 14일이 지난 이미지 중 가장 새 릴리스(나이는 빌드부터 세므로, 14일 안에 릴리스가 많이 나와도 컨트롤 플레인이 아직 쓸 수 있는 판), 아직 인스턴스가 쓰는 이미지, EC2 launch template(최신·기본 버전)이 쓰는 이미지, 지워지지 않은 인스턴스나 EBS 볼륨에 그 `ax:template` 태그가 있는 이미지(hostd가 팀 인스턴스와 루트 볼륨에 단다. `ax:template`·`ax:in-use`는 이 저장소 밖(trina-cloud)에서 다는 태그라, 없으면 이미지 id로 찾은 것만 보호된다. `resolve:ssm:`으로 이미지를 적은 launch template은 맞추지 못한다). launch template·인스턴스·볼륨·이미지를 읽지 못하면 그 지역에서는 아무것도 지우지 않는다. 2026-11-20: 0.5.21 run이 그때 규칙(최근 3개 이미지)으로 0.5.16 이미지(서울·버지니아)를 지웠는데, 컨트롤 플레인이 아직 그 템플릿으로 새 팀을 만들고 있어 새 팀 만들기가 `InvalidAMIID.NotFound`로 실패했다.
   8. 취소·실패하면 마지막 단계가 상태 파일로 `build-ami.sh --cleanup`을 돌려 빌더·작업 볼륨·보안 그룹을 지운다. 상태 파일은 `ami-build-state` 아티팩트로도 남긴다(7일).

컨트롤 플레인은 `<feed>/server/<version>/team-image.json`을 읽어 목록 URL을 알고, 목록의 `.sig`를 `TRINA_RELEASE_KEYS`로 확인한다(trina-cloud F1c).

**네트워크.** 빌더는 러너에서 SSH로 다룬다. 빌드마다 보안 그룹을 새로 만들어 그 러너의 주소(/32)에서만 22번을 열고, 끝나면 지운다. 로그인 키·호스트 키도 빌드마다 새로 만든다. 그래서 `AMI_SUBNET_ID`의 서브넷은 인터넷 게이트웨이로 가는 경로가 있고 NACL이 22번 인바운드를 모든 곳(0.0.0.0/0, GitHub 러너 주소는 매번 다르다)에서, 응답 포트를 허용해야 한다. 기본 VPC의 서브넷이면 그대로 된다. 팀 서브넷은 안 된다(NACL이 SSH를 막는다). `AMI_SUBNET_ID`에 같은 VPC의 다른 영역 서브넷을 쉼표로 이어 적으면(`subnet-…(2a),subnet-…(2c),subnet-…(2b)`) 그 순서로 시도한다: 한 영역에 빌더 용량이 없으면(`InsufficientInstanceCapacity`, 2026-11-17 v0.5.11) 같은 보안 그룹으로 다음 서브넷에서 빌더를 띄우고 작업 볼륨도 그 영역에 만든다. 거절된 `RunInstances`는 아무것도 만들지 않으며, 보안 그룹은 전처럼 끝에, 실패하면 정리 단계가 지운다. 권한 정책의 `BuilderLaunchIntoTheBuildSubnet`에도 그 서브넷들을 넣어야 한다. SSM으로 바꾸지 않은 이유: Debian AMI에는 SSM 에이전트가 없고, 빌더에 인스턴스 프로필을 주려면 역할에 `iam:PassRole`과 상시 프로필이 필요하다. SSH 방식은 상시로 열린 것이 없다.

### 처음 한 번 (대표)

**1–3을 마치기 전에는 `AWS_ROLE_ARN`을 넣지 않는다.** (2026-11-14 대표가 1–6을 마쳤다.) 보호가 없으면 push 권한이 있는 누구나 아무 브랜치에서 `environment: release`를 쓰는 workflow로 OIDC 토큰을 받을 수 있다. 보호는 세 겹이다: (1) `v*` 태그 ruleset(태그를 만들고 옮길 수 있는 사람을 제한), (2) environment의 배포 대상(`v*` 태그와 `main`만), (3) AWS 역할의 OIDC subject(`team-image.yml`의 `v*` 태그 run만). 승인자는 두지 않는다. 이 레포 설정은 대표만 바꾼다.

1. **environment `release` 보호**: Settings → Environments → `release`.
   - Deployment branches and tags → **Selected branches and tags** → 태그 규칙 `v*`와 브랜치 `main`. `main`이 필요한 이유: feed.yml(배포 멈추기·promote)이 main에서 돌고 이 environment를 쓴다. 이미지 역할은 신뢰 정책이 `team-image.yml`의 `v*` 태그 run만 받으므로 `main`을 허용해도 main의 run은 역할을 받지 못한다.
   - **Required reviewers는 두지 않는다**(대표 결정 2026-11-14): 태그 push가 곧 승인이다. 그래서 release.yml·이미지 run은 승인을 기다리지 않는다.
   - (권장) 레포 비밀값 `RELEASE_SIGNING_KEY`·`CLOUDFLARE_API_TOKEN`을 이 environment의 비밀값으로 옮긴다. 지금은 레포 비밀값이라 environment 보호가 키를 지키지 못한다.
2. **`v*` 태그 ruleset**: Settings → Rules → Rulesets → New tag ruleset, 대상 `v*`, Restrict creations·updates·deletions. 우회 목록에는 admin과 maintain 역할을 넣는다(릴리스 태그는 maintain 계정이 push한다).
3. **OIDC subject에 workflow를 넣는다**(레포 설정, 한 번). 기본 subject `repo:…:environment:release`는 release.yml·feed.yml도 받는다. subject에 `job_workflow_ref`를 넣으면 역할이 `team-image.yml`의 `v*` 태그 run만 믿을 수 있다:
   ```sh
   gh api -X PUT repos/trina-app/trina-ax/actions/oidc/customization/sub \
     -F use_default=false -f 'include_claim_keys[]=repo' -f 'include_claim_keys[]=context' -f 'include_claim_keys[]=job_workflow_ref'
   gh api repos/trina-app/trina-ax/actions/oidc/customization/sub     # 확인
   ```
   그 뒤 subject는 `repo:trina-app/trina-ax:environment:release:job_workflow_ref:trina-app/trina-ax/.github/workflows/team-image.yml@refs/tags/v0.5.3` 꼴이다. **이 레포는 `use_immutable_subject=true`**라 실제 subject의 앞부분은 이름 대신 owner·repo id가 붙은 `repo:trina-app@349611973/trina-ax@1436599521:…`이다(레포나 조직 이름이 바뀌어도, 같은 이름의 다른 레포가 생겨도 subject가 바뀌지 않는다). `job_workflow_ref` 부분은 그대로 이름이다. 신뢰 정책은 두 꼴을 모두 받는다. 이 레포에서 OIDC를 쓰는 다른 곳은 dev-build.yml의 cosign 서명뿐이고, 그 인증서는 subject가 아니라 workflow 경로(`--certificate-identity`)로 확인하므로 영향이 없을 것이다. 바꾼 뒤 dev 빌드 한 번이 서명·확인되는지 본다. 이 설정을 안 하면 아래 신뢰 정책이 맞지 않아 역할을 받을 수 없다.
4. **GitHub OIDC 공급자**(계정에 아직 없으면): IAM → Identity providers → OpenID Connect, URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
5. **역할을 만든다**(예: `trina-team-image-ci`).
   - 신뢰 정책: [`docs/runbooks/team-image-trust-policy.json`](runbooks/team-image-trust-policy.json). `<ACCOUNT_ID>`를 바꾼다. subject가 `repo:trina-app/trina-ax:environment:release:job_workflow_ref:trina-app/trina-ax/.github/workflows/team-image.yml@refs/tags/v*` 또는 immutable 꼴 `repo:trina-app@349611973/trina-ax@1436599521:environment:release:job_workflow_ref:trina-app/trina-ax/.github/workflows/team-image.yml@refs/tags/v*`인 토큰만 받는다(`StringLike`에 두 값의 목록, 3이 필요). 즉 environment `release`의 `team-image.yml`이 `v*` 태그에서 돌 때만이다. fork PR은 OIDC 토큰을 받지 못한다. 이 조건은 1·2(태그 대상 제한, 태그 ruleset)와 함께여야 뜻이 있다: `v*` 태그를 만들 수 있는 사람은 그 태그의 `team-image.yml`을 바꿀 수 있다.
   - 권한 정책: [`docs/runbooks/team-image-iam-policy.json`](runbooks/team-image-iam-policy.json). `<ACCOUNT_ID>`, `<AMI_SUBNET_ID>`, 그 서브넷의 `<AMI_VPC_ID>`를 바꾼다. `<AMI_SUBNET_ID_2C>`, `<AMI_SUBNET_ID_2B>`는 같은 VPC의 2c·2b 서브넷이다(2026-11-17부터 운영 역할 `trina-team-image-ci`에 세 서브넷이 다 들어 있다). 다른 영역 서브넷을 쓰지 않으면 그 줄들은 지운다. 세 지역(ap-northeast-2, ap-southeast-1, us-east-1) 밖은 모두 거부. `AMI_COPY_TO`에 지역을 더하기 전에 운영 역할 `trina-team-image-ci`의 이 목록에 먼저 더한다(아니면 복사가 거부되고 run 전체가 실패한다). 만드는 것은 `ax:managed=ami-build`(빌더·작업 볼륨·보안 그룹) 또는 `ax:managed=ami` + `ax:built-by=release-ci`(AMI·스냅샷) 태그를 달아야만 되고, 지우기·종료·등록 해제는 그 태그가 있는 것만 된다. 빌더는 아마존 목록의 공개 이미지(`ec2:Owner` `amazon` + `ec2:Public` `true`)로만, 작업 볼륨은 Debian 계정(136693071363)의 스냅샷으로만 만든다(다른 스냅샷으로 볼륨을 만들어 읽을 수 없다). 조건이 둘로 나뉜 이유: Debian 공개 AMI 같은 아마존 목록 이미지는 요청의 `ec2:Owner`가 계정 번호가 아니라 `"amazon"`이고, 그 루트 스냅샷은 `ec2:Owner`가 소유 계정 번호(136693071363)이며 `ec2:Public`이 없다(v0.5.5 첫 실행이 `RunInstances`, 다음 실행이 `CreateVolume`에서 거부됨). Debian 이미지 고르기는 `build-ami.sh`가 소유자 136693071363으로 한다. IAM 권한(`iam:*`, `PassRole`)은 없다.
   - 최대 세션 시간(MaxSessionDuration)을 **4시간**(14400초)으로 올린다. 워크플로가 4시간을 요청한다.
   - 계정의 EBS 기본 암호화 키가 고객 관리 키(CMK)면 그 키의 `kms:CreateGrant`, `kms:Decrypt`, `kms:GenerateDataKeyWithoutPlaintext`, `kms:ReEncrypt*`, `kms:DescribeKey`를 더한다(AWS 관리 키 `aws/ebs`면 필요 없다).
6. **레포 변수**(Settings → Secrets and variables → Actions → Variables, 비밀값이 아니다):
   ```sh
   gh variable set AWS_ROLE_ARN  --repo trina-app/trina-ax --body 'arn:aws:iam::<ACCOUNT_ID>:role/trina-team-image-ci'
   gh variable set AMI_SUBNET_ID --repo trina-app/trina-ax --body 'subnet-…'     # ap-northeast-2, 위 "네트워크"
   ```
   계정 번호는 `AWS_ROLE_ARN`에서 읽는다(`build-ami.sh --account`). 비밀값 `RELEASE_SIGNING_KEY`·`CLOUDFLARE_API_TOKEN`은 이미 있는 것을 쓴다.
7. **첫 확인**: 다음 stable 릴리스 뒤 Actions → Team image run을 본다. 또는 이미 나간 stable 태그로 손으로 돌린다(그 태그에 `team-image.yml`이 있어야 한다). 성공하면 `<feed>/server/<version>/team-image.json`이 열린다. `UnauthorizedOperation`으로 멈추면 메시지의 인코딩된 부분을 `aws sts decode-authorization-message`로 풀어 빠진 권한을 본다.

### 실패했을 때

| 어디서 | 상태 | 할 일 |
|---|---|---|
| 설정 확인: notice "not set up" | 아무것도 안 함 | 위 "처음 한 번" |
| build-ami.sh 중간 | 스크립트가 만든 것(빌더, 작업 볼륨, 보안 그룹)을 스스로 지운다 | 다시 실행(Re-run failed jobs) |
| 취소·시간 초과 | 마지막 단계가 상태 파일로 `--cleanup`을 돌린다 | 그 단계가 경고를 남겼으면 `ami-build-state` 아티팩트의 상태 파일로 `scripts/image/build-ami.sh --cleanup <파일> --account <id>`. 상태 파일이 없으면 태그 `ax:managed=ami-build`로 찾아 손으로 지운다 |
| 복사·서명·올리기 | AMI는 남아 있다 | Re-run failed jobs. 같은 릴리스의 AMI를 다시 쓰고(아직 `pending`이면 기다린다), 복사는 client token으로 두 번 생기지 않는다. 목록이 이미 피드에 있으면 그것을 받아 쓰고 `team-image.json`만 올린다 |
| publish-ami: `names another image already` | 그 릴리스에 다른 이미지가 이미 올라가 있다 | 덮어쓰지 않는다. 다음 릴리스를 기다리거나 사람이 본다 |

**정리(최근 5개 릴리스, 14일)**: 컨트롤 플레인이 새 팀에 쓰는 템플릿은 최근 5개 릴리스 안에 있거나 만든 지 14일이 안 됐어야 한다(자동 템플릿, F1c). CI는 컨트롤 플레인의 설정을 읽지 못한다. 컨트롤 플레인이나 hostd가 쓰는 템플릿의 AMI에 `ax:in-use=<쓰는 곳>`을 달면 CI가 남긴다(아직 아무도 달지 않는다). 무엇을 지울지 미리 보려면 `scripts/image/ami-prune.sh --dry-run --account <id> --region …`. 오래된 이미지를 남기려면 `aws ec2 create-tags --resources ami-… <snap-…> --tags Key=ax:keep,Value=true`(모든 지역).

### 비용 (한 번 빌드)

- 빌더 t3a.medium 약 30–45분 ≈ $0.04, 작업·루트 볼륨 gp3 20 GiB × 2 약 1시간 ≈ $0.01, 공인 IPv4 1시간 ≈ $0.005.
- 싱가포르·버지니아 복사: 지역 간 전송 약 $0.08/GB(서울에서 나가는 쪽) × 실제 쓴 블록(이미지 약 4–6 GB) × 2지역 ≈ $0.6–1.0.
- 합 **≈ $0.7–1.1 / 빌드**. GitHub 러너는 공개 레포라 무료.
- 보관: 스냅샷 약 $0.05/GB-월 × 4–6 GB × 3지역 × 최근 5개 릴리스(14일 안에 더 나왔으면 그만큼 더) ≈ **월 $3–4.5**(정리가 그 이상 쌓이지 않게 한다).

## 11. 윈도우 코드 서명 (SSL.com eSigner)

Windows installer signing. With a valid Authenticode signature the installer names the publisher (the company's
validated legal name) instead of "Unknown publisher", Smart App Control stops blocking it, and SmartScreen's "Windows
protected your PC" stops once the signed files have built up download reputation (reputation is earned per file over
its downloads; a new certificate does not skip it).

### 무엇을 쓰나

- **SSL.com OV 코드 서명 인증서**(1년, 2026-11-26 발급, 2027-11-26까지; 주문 ref는 SSL.com 계정의 Orders에 있다), **eSigner** 클라우드 서명. 개인 키는 SSL.com의 HSM에 있고 받지 않는다: 잃어버리거나 샐 키 파일이 없다. 서명은 SSL.com 계정(사용자 이름·비밀번호) + eSigner 자격(credential id) + eSigner 일회용 코드(TOTP)로 한다.
- 도구: SSL.com **CodeSignTool**(Java, https://github.com/SSLcom/CodeSignTool, 문서 https://www.ssl.com/guide/esigner-codesigntool-command-guide/). 서명마다 RFC 3161 타임스탬프(`http://ts.ssl.com`, 도구의 `conf/code_sign_tool.properties`)를 붙여 인증서가 끝난 뒤에도 서명은 유효하다.
- **비용**(https://www.ssl.com/guide/esigner-pricing-for-code-signing/, 2026-03-25 갱신판): 인증서를 받은 뒤 **처음 30일은 서명 무제한 무료**. 그 뒤 eSigner 서명 요금제가 필요하다. OV 등급 1: 월 $20(한 달 20번) 또는 연 $180(한 해 240번), 넘으면 한 번에 $1. 등급 2: 월 $85(100번)/연 $765(1,200번), 넘으면 $0.85. 안 쓴 횟수는 구독이 이어지는 동안 다음 달로 넘어가고, 구독이 끊기면 사라진다. 한 릴리스는 파일 서너 개(앱 exe, 제거 프로그램, 설치 파일)를 서명한다. **요금제는 대표가 고른다**(결제).
- Microsoft Artifact Signing은 2026-11-15부터 시도했지만(조직 확인이 끝나지 않았다) 2026-11-26 대표가 해지했다. release.yml에서 그 길은 지웠다.

### 흐름

1. release.yml `build-windows`(job 환경 `release`, 권한 `contents: read`만; 서명을 켜지 않아도 이 job에 environment의 배포 대상 규칙이 걸린다. 릴리스 run은 늘 태그에서 돈다)가 레포 변수 `WINDOWS_SIGNING_PROVIDER`를 `MYCEL_WIN_SIGN_PROVIDER`로 넘긴다. 비어 있으면 서명 단계는 모두 건너뛰고 지금처럼 서명 없는 설치 파일을 만든다. `sslcom`이 아닌 값이거나, `sslcom`인데 비밀값 하나라도 없으면 빌드가 실패한다(실수로 서명 없이 나가지 않게).
2. `actions/setup-java`(커밋 고정, Temurin 17)와 CodeSignTool(`CODESIGNTOOL_VERSION`, zip의 sha256을 `CODESIGNTOOL_SHA256`과 맞춰 본다)을 받아 `$RUNNER_TEMP/codesigntool`에 푼다. JDK가 든 `-windows` zip(200 MB)이 아닌 보통 zip을 쓴다.
3. electron-builder가 `win.signtoolOptions.sign`(`desktop/scripts/win-sign.ts`)으로 앱 exe, 제거 프로그램, NSIS 설치 파일마다 `java -jar code_sign_tool-<v>.jar sign … -override`를 부른다(셸이나 .bat을 거치지 않는다: 비밀번호의 특수 문자가 그대로 간다). 비밀값 넷은 이 빌드 단계에만 환경 변수로 들어간다. CodeSignTool은 오류를 찍고도 0으로 끝날 수 있어서, 서명마다 `Get-AuthenticodeSignature`가 Valid이고 타임스탬프가 있는지 본다. 실패하면 두 번 더 해 본다(15초, 30초 뒤). `latest.yml`의 sha512는 서명된 파일의 것이다.
4. 마지막 단계가 설치 파일과 `win-unpacked/*.exe`를 `signtool verify /pa /tw`로 다시 확인하고 서명자 이름을 로그에 남긴다.

`publisherName`은 넣지 않았다: electron-updater는 지금처럼 윈도우 서명을 따로 요구하지 않고, 업데이트는 Ed25519로 서명된 릴리스와 맞는지로 확인한다(`desktop/src/common/update.ts`). 서명된 판이 퍼진 뒤 넣으면 그 뒤 업데이트는 서명자 이름이 맞아야만 설치된다(인증서를 갱신하거나 바꿀 때 이름이 같아야 한다).

### 처음 한 번

1. **eSigner 등록**: secure.ssl.com → Orders → 그 코드 서명 주문 → eSigner PIN을 정하고 QR 코드(=TOTP 비밀값)를 받는다. 사람이 쓰는 인증 앱에 이미 등록했다면 같은 비밀값을 CI에도 넣는다. **QR을 다시 만들면(reset) 예전 인증 앱의 코드는 더 이상 맞지 않는다.**
2. **credential id**: `CodeSignTool get_credential_ids -username=… -password=…`(또는 주문 화면의 signing credential).
3. **GitHub에 넣는다**(environment `release`의 비밀값 넷; 값은 파이프로 넣고 화면·파일에 남기지 않는다):
   ```sh
   for n in SSLCOM_USERNAME SSLCOM_PASSWORD SSLCOM_CREDENTIAL_ID SSLCOM_TOTP_SECRET; do
     <값을 내보내는 명령> | GH_TOKEN=$(gh auth token -u trina-app-admin) gh secret set "$n" --repo trina-app/trina-ax --env release
   done
   ```
4. **켠다**(이 변경이 dev와 main에 들어간 뒤, 그리고 30일 무료가 끝나기 전에는 요금제를 정한 뒤):
   ```sh
   GH_TOKEN=$(gh auth token -u trina-app-admin) gh variable set WINDOWS_SIGNING_PROVIDER --repo trina-app/trina-ax --body sslcom
   ```
   넣는 순간부터 모든 릴리스가 서명을 시도하고, 서명이 안 되면 윈도우 설치 파일이 빠진다(6장 "Desktop builds missing"). 끄려면 `gh variable delete WINDOWS_SIGNING_PROVIDER --repo trina-app/trina-ax`.
5. **첫 확인**: 다음 태그의 Windows installer job 로그에서 "signed: … (CN=…)"와 `signtool verify` 성공을 본다. 받은 설치 파일을 깨끗한 윈도우에서 열어 게시자 이름을 본다(QA 행).

### 실패했을 때

| 어디서 | 뜻 | 할 일 |
|---|---|---|
| `Windows signing is switched on but half set up` | 변수는 `sslcom`인데 비밀값이 빠졌다 | 처음 한 번 3을 다시 하거나 변수를 지운다 |
| `not a known signing provider` | 변수 값이 `sslcom`이 아니다 | 값을 고치거나 지운다 |
| `Error: invalid otp` | TOTP 비밀값이 틀리거나 QR이 다시 만들어졌다 | 주문 화면의 비밀값으로 `SSLCOM_TOTP_SECRET`을 다시 넣는다 |
| `invalid_grant` / 로그인 실패 | 사용자 이름·비밀번호가 틀리거나 비밀번호가 바뀌었다 | `SSLCOM_USERNAME`·`SSLCOM_PASSWORD`를 다시 넣는다 |
| 서명 거절, 횟수·구독 관련 오류 | 30일 무료가 끝났고 요금제가 없거나 횟수를 다 썼다 | 대표가 요금제를 고른다. 그동안은 변수를 지워 서명 없이 낸다 |
| 서명 후 Status가 Valid가 아님 / 타임스탬프 없음 | 체인이나 `ts.ssl.com` 문제 | 다시 돌려 본다(Re-run failed jobs) |

서명 job이 실패해도 리눅스 서버 릴리스는 나간다. 고친 뒤 같은 run에서 "Re-run failed jobs"(6장).

### 갱신

인증서는 2027-11-26에 끝난다. 이미 타임스탬프가 붙은 서명은 그 뒤에도 유효하다. 갱신하면 credential id가 바뀔 수 있다(`get_credential_ids`로 보고 `SSLCOM_CREDENTIAL_ID`를 바꾼다).

## 12. 데스크톱 검사 (PR, desktop.yml)

Desktop checks on pull requests: `.github/workflows/desktop.yml`. ci.yml은 리눅스만 돌므로, 데스크톱 앱이 바뀔 수 있는 PR
(`desktop/**`, `shared/**`, `editions/trina/branding/**`, `scripts/release-notices.ts`, `scripts/ci/dmg-check.ts`,
`scripts/ci/windows-install-check.ps1`, `scripts/ci/linux-install-check.sh`, `scripts/ci/appimage-runtime-check.sh`, offline·hwp spec이 쓰는 `web/test/mock/**`·`web/test/e2e/offline-server.ts`, `package.json`, `bun.lock`, 이 워크플로)에만 아래 여섯 job이 돈다. 비밀값은 쓰지 않는다
(서명 없음). 필수 검사가 아니다: 필수 검사는 ci.yml의 것 그대로다. 빨간 데스크톱 job은 병합 전에 읽는다.
결정: `docs/decisions/20261116-desktop-checks.md`.

| job | runner | 하는 일 | 실패 때 artifact |
|---|---|---|---|
| Desktop e2e (macOS) | macos-15-intel (레포 변수 `DESKTOP_MAC_RUNNER`로 바꾼다) | `desktop/e2e/ci.config.ts`: 데스크톱 Playwright 전부(desktop.spec, work-files, work-files-wide, work-consent, folder-window …). 만든 홈·데이터 폴더만 쓴다. 가짜 팀 이름(`acme.localhost` …)을 `/etc/hosts`에 넣고 web 빌드와 rhwp를 준비한다. 전체 25분 한도, 재시도 1번 | `desktop-e2e-mac` (`desktop/e2e/.work/`: html 리포트, fixture 로그) |
| Mac dmg | e2e와 같은 러너 | 서명 없는 universal `dist:mac` → `scripts/ci/dmg-check.ts` | 늘 `desktop-dmg` (dmg, 3일) |
| Windows installer | windows-2025 | 서명 없는 NSIS 둘(`<version>-ci.1`, `-ci.2`) → `scripts/ci/windows-install-check.ps1` | 늘 `desktop-windows-install-logs` |
| Linux packages (install, update over, uninstall) | ubuntu-24.04 | 서명 없는 빌드 둘: `-ci.2`는 `dist:linux` 그대로(.deb·AppImage, x64·arm64), `-ci.1`은 x64 .deb → `scripts/ci/appimage-runtime-check.sh`: 두 AppImage 런타임에 버전 없는 라이브러리(`libz.so` 같은 것) 없음(`readelf -d`), x86_64는 Fedora 42 컨테이너에서 `--appimage-version` → `scripts/ci/linux-install-check.sh full`: 설치(파일, 메뉴 항목, `trina-ax://` 형식, `Icon=` 이름의 256·512 px PNG와 scalable SVG, 올라간 AppArmor 프로필) → xvfb에서 시작, 첫 창, 샌드박스(`--no-sandbox` 없음, 렌더러가 제 user namespace), 링크 처리기 → 덮어 설치(버전, 처리기, 데이터 폴더) → 제거(파일·메뉴·프로필·처리기 없음, 데이터는 남음) → AppImage는 `.deb` 안내 창을 띄우고 끝나야 한다 | 늘 `desktop-linux-install-logs`; arm64 .deb와 AppImage는 `desktop-linux-arm64-deb` |
| Linux package (arm64: install and start) | ubuntu-24.04-arm | arm64 AppImage 런타임 검사(Fedora 42 컨테이너에서 `--appimage-version`), 위 job의 arm64 .deb를 설치, xvfb에서 시작(첫 창, 샌드박스), 제거. 빌드는 하지 않는다 | 늘 `desktop-linux-arm64-logs` |
| Desktop e2e (Linux, subset) | ubuntu-24.04 | `desktop/e2e/linux.config.ts`: smoke, desktop, quit, settings, language, offline, update, local-apps. 맥 e2e처럼 가짜 팀 이름, web 빌드, rhwp. xvfb + `dbus-run-session` + 비밀번호를 준 `gnome-keyring-daemon --unlock`(빈 비밀번호면 login 모음이 생기지 않는다; local-apps.spec이 설정을 봉인한다), `XDG_CURRENT_DESKTOP=GNOME`. node_modules의 Electron에는 AppArmor 프로필이 없어 이 run만 `kernel.apparmor_restrict_unprivileged_userns=0`, `--no-sandbox`는 쓰지 않는다. dev push에도 돈다 | `desktop-e2e-linux` |

- **맥 job은 Intel 맥(macos-15-intel)에서 돈다.** 2026-11-16 08:30 UTC 뒤로 arm64 `macos-15` job은 러너를 하나도 받지 못하고
  취소됐다("The job was not acquired by Runner of type hosted even after multiple attempts", "Due to capacity constraints, jobs
  targeting macOS arm64 runners may experience longer queue times"). 테스트가 깨진 것이 아니라 GitHub의 arm64 맥 부족이다. Intel
  맥은 다른 풀이다. arm64가 돌아오면 레포 변수 `DESKTOP_MAC_RUNNER=macos-15`로 커밋 없이 되돌린다. 캐시 키에 `runner.arch`가 있어
  두 프로세서의 Electron·rhwp가 섞이지 않는다.

- **dmg 검사는 설정을 읽는다.** 형식(`dmg.format`, 기본 UDZO), 볼륨 이름(`dmg.title`), 파일 시스템(`dmg.filesystem`, 없으면 설치된
  electron-builder의 기본: 26.0.17까지 APFS, 26.0.18부터 HFS+), `dmg.contents`의 위치(`.DS_Store`의 Iloc), 배경 그림(`dmg.background`, 없으면
  build-resources의 background.tiff|png, 없으면 electron-builder 기본 그림)이 볼륨에 있는지(`.background/<파일>` 또는 26.0.18부터 `/.background.<확장자>`; `@2x` 그림이 옆에 있으면 TIFF 하나), `.DS_Store`가 그 파일을 가리키는지, 창이 그림 배경인지, 아이콘·글자
  크기. 값을 검사에 적지 않으므로 dmg 설정을 바꾸는 PR(#1036, #985)은 검사를 고칠 필요가 없다. 설정과 결과가 다르면 실패한다.
- **윈도우 검사는 실제 PC를 쓰지 않는다.** 순서: 깨끗한 runner 프로필 확인 → `/S` 설치(제거 항목·파일·바로가기, 서명 상태
  NotSigned/Valid 보고) → 버린 데이터 폴더(`MYCEL_DESKTOP_USER_DATA`)로 앱 실행, `trina-ax://` 처리기 확인 → 업데이터와 같은
  `--updated /S --force-run`으로 덮어 설치(새 버전, 처리기 유지, 앱 재시작) → 조용한 제거(항목·파일·바로가기·처리기 삭제, 데이터는 남음).
- **리눅스 검사는 Ubuntu 24.04의 샌드박스 규칙을 직접 켠다.** 스크립트가 `kernel.apparmor_restrict_unprivileged_userns=1`을 설정한다:
  러너 이미지가 바뀌어도 .deb는 제 AppArmor 프로필로 샌드박스를 쓰고, AppImage는 AppRun이 `--no-sandbox`를 붙여 앱이 거절해야 한다.
  AppImage의 자체 업데이트(받기, 서명된 릴리스와 대조, 끝날 때 교체)는 업데이터 설정과 `verifyInstaller`의 단위 테스트와 QA 행이
  맡는다(살아 있는 업데이트 시험에는 서명된 가짜 피드가 필요하다). 결정: `docs/decisions/20261119-linux-desktop-app.md`.
- **Electron이 안 끝나도 job은 멈추지 않는다.** 단독 fixture는 `desktop/e2e/fixture-run.ts`로 돌린다: 결과 줄이 나오면 SIGKILL로 끝낸다
  (#1015). 로그는 `desktop/e2e/.work/logs/`.
- **비용**: 공개 레포라 hosted runner는 무료. 경로 필터, PR마다 `cancel-in-progress`, bun 저장소와 Electron·electron-builder 내려받기 캐시.
  dev push에는 e2e job만 경로 필터 없이 돈다(PR 필터에서 빠진 `web/src` 변경이 offline·HWP 데스크톱 시험을 깨면 병합 직후에 보인다). 뒤의 병합이 앞의 run을 멈춘다.
- **실패했을 때**: e2e는 artifact의 html 리포트와 fixture 로그를 본다. dmg는 step summary의 `FAIL` 줄이 설정의 어느 값과 다른지 말한다
  (artifact의 dmg를 열어 본다; 서명이 없으니 우클릭 › 열기). 윈도우는 step summary와 `install-check.log`. 설치 파일이 0이 아닌 코드로 끝나면 만든 electron-builder 버전, sha256, Application 이벤트 로그(`installer-crash-events.txt`)를 남긴다(QA TC-3590). 재시도는 없다: 설치 파일이 죽으면 사람에게도 죽을 수 있다.
- 손으로 돌리기: `bun run --cwd desktop dist:mac:arm64 && bun scripts/ci/dmg-check.ts desktop/release` (맥),
  `cd desktop && bun build.ts && bunx playwright test -c e2e/ci.config.ts`; 리눅스(Ubuntu 24.04, sudo):
  `bun run --cwd desktop dist:linux && scripts/ci/linux-install-check.sh full <old.deb> <new.deb> <new.AppImage>`
  (환경 변수는 desktop.yml의 linux-packages job).

## 13. 릴리스용 맥 러너 (self-hosted, 사무실 맥)

GitHub hosted macOS 풀에 러너가 없어 릴리스의 맥 job(사무실 zip, 맥 앱, whisper-cli)이 계속 취소될 때 쓰는, 사무실 맥 한 대의
self-hosted 러너. 이 레포는 공개라 누구나 PR을 열 수 있다. 그래서 이 러너는 **v\* 태그의 release.yml만** 받고, job마다 새 일회용
러너를 쓴다. When GitHub's hosted macOS pools have no capacity, the release's Mac jobs run on one office Mac. Only release.yml at a
v\* tag may use it, each job gets a fresh one-time runner, and the runner account cannot reach the rest of the Mac.

**지금 상태: 꺼져 있음 (준비만, 2026-11-17).** hosted 맥 러너가 돌아와 0.5.11은 hosted에서 빌드·서명·공증됐다. 이 맥에는 아무것도
설치되지 않았다(계정, 볼륨, 데몬, GitHub 러너 등록 없음). 레포 변수 `RELEASE_MAC_RUNNER`는 없다(2026-11-17 19:49Z에 지움; 기본
macos-15). 워크플로 변경은 그 변수가 `trina-mac-release`일 때만 이 러너를 고르므로, 쓰지 않는 동안 아무 비용도 없다. Status: off; nothing is installed. The workflows pick this runner only when
`RELEASE_MAC_RUNNER=trina-mac-release`.

**켜기는 대표만 (owner only).** 러너 등록(`root-steps.sh`/`setup.sh`)과 `RELEASE_MAC_RUNNER` 변경은 대표가 그때 명시적으로 OK한 뒤에만
한다. 에이전트·릴리스 담당이 스스로 켜지 않는다. Switching on is owner-only: no registration and no variable change without the owner's
explicit OK at that time.

**켜기 전에 반드시 (mandatory before switching on)** — 하나라도 아니면 켜지 않는다:

1. **러너 쪽 문(host-side gate)**: job-started hook(`/Library/TrinaCI/job-started.sh`)이 release.yml at v\* 태그(main에 있는 커밋)가 아닌
   job을 step 전에 거절하고 그 job을 끝낸다. setup.sh가 설치하고, 일회성 데몬 검사가 "hook refusal kills Runner.Worker" PASS로 확인한다.
2. **러너를 워크플로로 제한(runner group / selected workflows)**: 요금제가 허락하면 runner group을 "Selected workflows: release.yml at
   refs/tags/v\*"로 제한하고 러너를 그 그룹에 둔다. 2026-11-17 현재 조직은 Free 요금제라(`gh api orgs/trina-app --jq .plan.name` = free) custom runner group이 없다.
   그동안은 1·3·4와 라벨로 막고, 요금제가 바뀌면 이것을 먼저 한다.
3. **fork PR 승인**: 레포 설정 "Require approval for all outside collaborators"(API `approval_policy: all_external_contributors`).
   2026-11-17에 켰다. 켜기 전에 `gh api repos/trina-app/trina-ax/actions/permissions/fork-pr-contributor-approval`로 다시 확인한다.
4. **레포 러너만**: 러너는 이 레포(trina-app/trina-ax)에만 등록한다. 조직(org) 러너로 절대 등록하지 않는다. supervisor는
   `repos/trina-app/trina-ax/actions/runners/generate-jitconfig`만 부른다.

각 job의 첫 step "Release Mac runner guard"는 **덧붙인 방어(defense in depth)일 뿐**이다. fork PR이 워크플로를 고쳐 이 라벨을 고르면
그 step은 없으니, 막는 것은 위 1–4다.

**켜기 (switch on, hosted 맥이 다시 없을 때, 대표 OK 뒤)**: 위 1–4를 확인하고, 아래 "설치" 1–3(토큰, 받기,
`sudo bash ~/.tfx/mac-runner/root-steps.sh` = `setup.sh`)이 모두 PASS면 `gh variable set RELEASE_MAC_RUNNER --repo trina-app/trina-ax --body
trina-mac-release`. **끄기**: 변수를 지우거나(기본 macos-15) hosted 라벨로 바꾸고, 러너도 멈춘다(`sudo launchctl bootout
system/app.trina.ci.runner`, 기다리던 러너 등록은 "지우기" 2). 변수만 바꾸면 릴리스는 hosted로 가지만, 설치된 러너는 이 라벨을 고른
job을 계속 기다린다(1이 막는다). 완전히 치우려면 "지우기".

**누가 쓸 수 있나 (who may run on it)**

- 라벨은 `trina-mac-release` 하나뿐인 레포 러너(`trina-mac-<시각>`). `self-hosted`·`macOS`·`ARM64` 라벨이 없어 `runs-on: [self-hosted]`
  같은 job은 닿지 않는다. 조직이 Free 요금제라 runner group(워크플로 제한)은 없다.
- 쓰는 job: release.yml의 build-office, build-mac-app(mac-app.yml), build-mac-whisper(mac-whisper.yml). 레포 변수
  `RELEASE_MAC_RUNNER=trina-mac-release`로 고른다(Run workflow의 `mac_runner` 입력이 먼저). mac-app.yml·mac-whisper.yml은
  release.yml이 v\* 태그에서 부를 때만 이 변수를 본다(`github.workflow_ref`는 부른 쪽). PR(Desktop e2e, unsigned dmg 검사,
  whisper-cli PR 검사)과 그 워크플로들의 Run workflow는 hosted에 남는다.
- 문 두 겹: (1) 러너의 job-started hook(`/Library/TrinaCI/job-started.sh`, 워크플로가 건너뛸 수 없다; 이것이 진짜 문)과 (2) 각 job의
  첫 step "Release Mac runner guard"(self-hosted에서만; 덧붙인 방어, fork가 고친 워크플로에는 없다). 둘 다 `github.repository == trina-app/trina-ax`, 이벤트 push 또는 workflow_dispatch,
  ref `refs/tags/v*`, `github.workflow_ref`가 `trina-app/trina-ax/.github/workflows/release.yml@refs/tags/v*`일 때만 통과한다. hook은
  태그의 커밋이 main에 있는지도 본다(공개 API `compare/main...<sha>`가 identical/behind; prepare와 같은 규칙). 태그 ruleset을 건너뛸 수
  있는 사람(maintain·admin)이 아무 커밋에 태그를 달아 자기 release.yml을 가져오는 길을 막는다. hook이 거절하면 그 job의
  `Runner.Worker`를 바로 끝낸다(`if: always()` step도 돌지 않는다).
- 레포 설정: 바깥 기여자의 fork PR 워크플로는 모두 승인이 있어야 돈다(`approval_policy: all_external_contributors`, 2026-11-17).
- v\* 태그는 태그 ruleset으로 막혀 있다(10장). 그래도 maintain·admin 역할은 ruleset을 건너뛸 수 있다. 이 맥에서 도는 코드는 main에
  들어간(리뷰된) 커밋뿐이다.
- 남는 것: 거절당할 job도 러너를 잠깐 차지한다(한 번에 하나).

**격리 (isolation)**

- 계정 `_trinaci`: 숨김, 일반(관리자 아님), 자기 그룹(staff 아님), 암호·로그인 셸 없음, `cron.deny`·`at.deny`에 있다. 러너는 이
  계정으로 돈다(관리자 계정이 아니다). 관리자 홈(750, staff)에는 그룹이 달라 못 들어가고, `_trinaci` deny ACL을 하나 더 둔다.
- 러너와 모든 step은 샌드박스 `runner.sb` 안에서 돈다: `/Users` 아래 전부 금지, `/Volumes`는 자기 볼륨과 빌드가 붙이는 dmg
  (`/Volumes/Trina AX …`)만, `/tmp`·`/private/var/tmp` 전부 금지(다른 세션의 파일과 로컬 DB 소켓; TMPDIR은 볼륨에 있다), localhost TCP 금지,
  `launchctl`·`crontab`·`at` 실행 금지.
- pf(`com.apple/260.trina-ci`, 루트 데몬 `app.trina.ci.pf`가 부팅 때와 1분마다 올린다)가 이 계정의 소켓에서 lo0의 모든 것(샌드박스가
  이름 붙이지 못하는 `::ffff:127.0.0.1` 같은 IPv4-mapped 주소 포함), 이 맥 자신의 주소, LAN(IPv4 사설 대역, 이 맥 IPv6 주소의 /64), Tailscale, link-local로 가는 TCP/UDP를 막는다. 인터넷은 열려 있다. pf 규칙이
  이번 부팅에 올라가지 않았으면 러너를 시작하지 않는다.
- **이 계정에는 인증서도 키도 암호도 없다.** 서명은 지금처럼 레포 비밀값(`MAC_DEVELOPER_ID_P12_*`, `APPLE_API_*`, "맥 앱" 절)으로
  job마다 `$RUNNER_TEMP`에 키체인을 만들고 끝에 지운다.
- 이 맥에 있는 비밀은 하나: 일회용 러너를 받아 오는 fine-grained 토큰(trina-app-admin, 저장소 trina-ax 하나, Administration: Read and
  write). `/Library/TrinaCI/secrets/github-auth.header`(root 600)에 있고 러너 계정은 읽지 못한다. curl이 파일에서 바로 읽는다(argv에 없다).
- 남는 위험: 무언가 pf를 `com.apple` anchor 없이 다시 올리면 다음 1분 검사까지 pf 규칙이 빠진다(샌드박스의 localhost·소켓 차단은 그대로).

**매번 새로 (ephemeral)**

루트 데몬 `app.trina.ci.runner`(`/Library/TrinaCI/supervisor.sh`)가 job 하나마다:

1. `_trinaci`의 프로세스를 모두 끝내고(kill -9), launchd job·crontab·`/tmp`의 파일·Apple 임시/캐시 폴더를 지우고, 볼륨의 HOME,
   TMPDIR, 러너 폴더를 통째로 지운다. 남는 것이 있으면 job을 더 받지 않는다(로그에 남긴다).
2. root 소유 원본(`/Library/TrinaCI/runner-dist`)에서 러너 폴더를 새로 복사한다(`.env`에 job hook, `.path`). 이 폴더는 `_trinaci`
   소유다: 러너가 일회용 등록을 거기에 쓰고, GitHub이 새 버전을 내면 그 안에서 스스로 업데이트한다. 어차피 job 뒤에 통째로 지운다.
3. GitHub에 일회용(JIT) 러너 설정을 받아(`generate-jitconfig`) `_trinaci`로 샌드박스 안에서 돌린다. 러너는 job 하나를 받고 끝나며,
   supervisor가 그 등록을 지운다(job을 받지 않고 끝난 것도). job이 러너 자격 증명을 읽어도 그 job이 끝나면 쓸모가 없다. 1분 안에
   끝나면(업데이트 실패, GitHub 오류) 5분 쉰다. job이 붙인 디스크 이미지도 떼고, 계정의 `/var/folders` 폴더 전체를 지운다.

job 사이에 남는 도구 캐시(setup-bun, setup-go, bun 캐시, 내려받은 actions)는 없다. job-completed hook도 같은 것을 지운다(보조).

**디스크 (disk)**

- 맥 빌드 한 번에 약 15 GB(체크아웃·node_modules ~3 GB, Electron 두 아키텍처와 universal 앱·dmg·zip, Go·bun). 계정의 HOME, TMPDIR,
  러너는 따로 만든 APFS 볼륨 `TrinaCI`(쿼터 60 GB, `nobrowse`라 Finder·데스크톱에 안 보인다)에 있다. 빌드가 시스템 디스크를 채울 수
  없다. supervisor는 25 GB, job-started hook은 20 GB가 안 남았으면 job을 받지 않는다. 시스템 디스크에 남는 것(`/tmp`, Apple 임시 폴더)은
  매 job 뒤에 지운다. 로그는 50 MB에서 한 번 돌린다.
- 데몬은 `Nice 5`. 한 번에 job 하나(릴리스의 맥 job 셋은 차례로 돈다; 맥 앱은 공증 때문에 한 시간 넘게 걸린다).
- Node.js는 하나의 목록(`scripts/system/packages.json`의 darwin-arm64 버전, 주소, sha256)을 그대로 따라 root 소유로 `/Library/TrinaCI/node`에 둔다. setup.sh는 Node.js를 따로 고정하지 않는다. Homebrew(관리자 소유)는 PATH에 없다.

**설치 (setup, 관리자, sudo 한 번)**

1. 토큰: trina-app-admin → Settings → Developer settings → Fine-grained tokens → Generate. Resource owner `trina-app`, Only select
   repositories `trina-ax`, Repository permissions → **Administration: Read and write**. 만료일은 정한다(만료 전에 2·3을 다시).
2. 받기(sha256은 setup.sh가 확인한다):

```sh
mkdir -p ~/.tfx/mac-runner-stage && cd ~/.tfx/mac-runner-stage
curl -fsSLO https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-osx-arm64-2.338.2.tar.gz
curl -fsSLO "$(jq -r '.artifacts.node.platforms["darwin-arm64"].url' <레포>/scripts/system/packages.json)"   # Node.js: 목록의 주소
```

3. 실행(토큰은 숨긴 입력으로 묻는다; 파일로 주면 읽고 지운다). 여러 번 돌려도 된다:

```sh
sudo bash <레포>/scripts/macos/release-runner/setup.sh
```

setup.sh는 두 번 검사한다: 관리자의 sudo로 한 번, 그리고 job과 같은 맥락(일회성 LaunchDaemon `app.trina.ci.selftest`, SessionCreate,
`_trinaci`로 샌드박스 안, `selftest.sh`)에서 한 번(인터넷, swiftc, notarytool, node, job 키체인에 .p12 넣기와 key partition list,
`/Volumes/Trina AX …`에 dmg 붙이기; 그리고 막혀야 할 것: localhost와 `::ffff:` 주소, LAN, `/tmp`, `/Users`, hook이 거절하면
`Runner.Worker`가 끝나는지). codesign 자체는 믿을 수 있는 인증서가 있어야 해서 첫 릴리스 job이 진짜 검사다. 끝에 `PASS`/`FAIL`을 찍는다(관리자 홈·`.ssh`·키체인·토큰을 못 읽음, crontab·launchctl 안 됨, localhost·LAN 차단,
인터넷·swiftc·notarytool·node·job 키체인·dmg 붙이기는 됨, 일회용 러너가 job을 기다림). 그 뒤 GitHub → Settings → Actions → Runners에
`trina-mac-…`가 Idle인지 보고 레포 변수 `RELEASE_MAC_RUNNER`를 `trina-mac-release`로 바꾼다. hosted로 돌아가려면 변수를
`macos-15`(또는 `macos-15-intel`)로 되돌린다. 커밋은 필요 없다.

러너 업데이트: 새 actions/runner가 나오면 일회용 러너가 job마다 스스로 내려받아 업데이트한다(느려질 뿐). setup.sh의
`RUNNER_VERSION`·`RUNNER_SHA256`을 새 릴리스로 바꾸고 새 tarball을 받아 setup.sh를 다시 돌리면 그 시간이 없어진다.

로그: `/private/var/log/trina-ci/runner.log`(supervisor와 러너), `/private/var/log/trina-ci/pf.log`.

**지우기 (removal)**

```sh
# 1) 이 맥에서: 데몬 둘, _trinaci의 프로세스·launchd job·crontab, pf 규칙과 우리 pf 참조, 관리자 홈의 deny ACL, cron/at deny 줄,
#    /Library/TrinaCI(저장된 토큰 포함), 로그, TrinaCI 볼륨(/etc/fstab 줄도), _trinaci 계정과 그룹
sudo bash <레포>/scripts/macos/release-runner/remove.sh
# 2) GitHub: 남은 일회용 러너 등록(기다리던 것이 offline으로 남는다)을 지우고 hosted로 돌린다(sudo 필요 없음)
export GH_TOKEN=$(gh auth token -u trina-app-admin)
for id in $(gh api repos/trina-app/trina-ax/actions/runners --jq '.runners[] | select(.name | startswith("trina-mac-")) | .id'); do
  gh api -X DELETE "repos/trina-app/trina-ax/actions/runners/$id"; done
gh variable delete RELEASE_MAC_RUNNER --repo trina-app/trina-ax   # unset = hosted macos-15
# 3) fine-grained 토큰을 GitHub에서 지운다(trina-app-admin → Settings → Developer settings → Fine-grained tokens)
```

손으로 하나씩 하려면(remove.sh가 하는 것): `sudo launchctl bootout system/app.trina.ci.runner`, `sudo launchctl bootout system/app.trina.ci.pf`,
`sudo rm /Library/LaunchDaemons/app.trina.ci.{runner,pf}.plist`, `_trinaci`의 프로세스를 pid로 끝내기, `sudo pfctl -a com.apple/260.trina-ci -F all`,
`sudo chmod -a "user:_trinaci deny list,search,readattr,readextattr,readsecurity" ~`, `/usr/lib/cron/cron.deny`·`at.deny`에서 `_trinaci` 줄 지우기,
`sudo chflags -R nouchg /Library/TrinaCI /Volumes/TrinaCI && sudo rm -rf /Library/TrinaCI /private/var/log/trina-ci`,
`sudo diskutil apfs deleteVolume TrinaCI`(그리고 `/etc/fstab`의 그 UUID 줄), `sudo dscl . -delete /Users/_trinaci`, `sudo dscl . -delete /Groups/_trinaci`.
이 계정에는 키체인이 따로 없다(job 키체인은 job이 지운다).

## 14. 웹 브라우저 시험 guard set (merge queue, 참고용)

web e2e(Playwright, 2,400개쯤, 한 worker로 ~1.7시간)는 dev push마다 feature-map.yml이 돌리지만 필수 검사가 아니어서, 2026-11-17에
30개가 아무도 모르게 깨져 있었다. 그래서 병합 큐의 항목(`merge_group`)마다 그중 작은 묶음(**guard set**)을 돌린다.

- **어디서**: ci.yml의 따로 된 job `e2e-guard`("web e2e guard (advisory)"). 자기 checkout, bun install, web 빌드를 하고 guard를 돌린다
  (native·HWP·pandoc은 필요 없다). `merge_group`에서만 돌고 PR·push에서는 건너뛴다.
- **무엇을**: `bun run --cwd web e2e:guard` (web/package.json): Chromium, worker 하나(모의 팀 서버가 상태를 함께 쓴다). 휴대폰 글꼴은
  feature-map.yml과 같다(Roboto를 sans-serif·system-ui로, `web/test/e2e/fonts/phone-font.conf`).
- **참고용(advisory)**: 이 job은 `check`의 needs에 없어서 아무것도 이것을 요구하지 않는다. 빨개도 큐 항목은 기다리지 않고, 필수 검사
  "typecheck, native, unit, fast fuzz, web, relay"의 판정은 전과 같다. guard step에는 자체 10분 한도가 있다(job 20분). 결과는 run summary에
  통과/실패와 실패한 `spec:line` 표로 남고, 실패하면 artifact `web-e2e-guard-results`(trace, 스크린샷, 7일)가 생긴다.
- **지금 묶음**: 6개 파일 `phone-targets`, `rail.spec`, `session-markers`, `chat-list-folds`, `chat-project-ask-access`,
  `mentions-only-count` (67개 시험, Linux에서 ~3.5분; 설치와 web 빌드까지 job 전체 ~7분). 앞의 넷은 dev에서 실패하는 동안 빠져 있다가 drift 수정(#1224)
  뒤에 다시 들어왔다(2026-11-17, dev bad5009a3에서 67 통과).
- **필수로 올리기**: 큐에서 guard가 연속으로 ~20번 초록이면 `e2e-guard`를 `check`의 needs와 그 step의 판정에 넣는다(필수 이름은 `check`
  그대로라 ruleset은 안 바꾼다).
  그 전에 빨간 guard는 읽기만 하고 기다리지 않는다. 깨진 spec은 고치거나(제품 버그) 시험을 고친다(의도한 변경). 묶음에서 빼는 것은 마지막 수단이다.
- **손으로**: 전체는 `bun run e2e:web`. Linux와 같은 글꼴로 돌리려면 Docker(`mcr.microsoft.com/playwright:v1.64.1-noble` + Bun 1.3.12 +
  fonts-roboto-unhinted + phone-font.conf)에서 `bun run build:web` 뒤 `cd web && bun run e2e:guard`.

## 15. dev의 웹 e2e (Feature map, feature-map.yml)

`.github/workflows/feature-map.yml`: dev push마다 웹 Playwright 전체(`web/playwright.config.ts`, chromium + webkit, 모의 팀 서버)를
리눅스 4 shard(shard마다 worker 1개: 모의 서버가 상태를 공유한다)로 돌리고, QA 시트 Features 탭을 고친다(`docs/FEATURES.md`).
PR·merge queue에는 돌지 않고 필수 검사도 아니다. 따로 밤마다 도는 워크플로는 없다(4f 결정, 2026-11-17).

- **언제**: dev push 중 웹 e2e 결과나 기능 지도가 바뀔 수 있는 경로만: `web/**`, `shared/**`, `server/**`, `mobile/src/**`·`tests/lib/**`
  (모의 서버와 spec이 import한다), `resources/**`(skill-packs, promo-video, hwp), `scripts/hwp-bundle.ts`·`scripts/release-notices.ts`·
  `versions.json`·`tsconfig.json`(빌드), `scripts/linux/apparmor-bwrap.in`(변환 격리), `docs/features.ts`·`scripts/features/**`(Features 탭),
  요약 스크립트, `package.json`, `bun.lock`, 워크플로 자신. 경로 목록은 `tests/unit/ci-web-e2e-summary.test.ts`가 모의 서버·spec의 import와 맞춰 본다. 손으로: `gh workflow run feature-map.yml --ref dev`.
- **한 번에 하나, 도는 run은 취소하지 않는다**: `concurrency: feature-map-<브랜치>`, `cancel-in-progress: false`. 하나가 돌고 하나만
  기다리며, 더 새 push가 기다리는 run을 바꾼다(기다리던 run은 job 없이 끝나 러너를 쓰지 않는다). 러너를 아끼는 것은 위의 경로 필터다:
  run 하나가 러너 ~4개를 30–40분 쓴다. 모든 run이 끝까지 돌므로 이슈는 끝까지 시험한 가장 새 dev 머리를 보여 준다. 시트 쓰기도 중간에 끊기지 않는다. 시트(Features 탭)는 dev run에서만 쓴다: 다른 브랜치를 손으로 돌려도 dev와 겹쳐 쓰지 않는다.
- **요약과 이슈** (job `summary`, dev push만): shard의 blob 리포트를 `playwright merge-reports`로 합쳐 run summary에 합계와 실패한
  spec:line·첫 오류 줄을 쓴다(`scripts/ci/web-e2e-summary.ts`). 라벨 `web-e2e-dev`가 붙은 이슈 하나("Web e2e on dev: N failing
  (날짜, sha)")를 빨간 run에서 열거나 고치고(제목·본문; 댓글은 실패 수가 바뀔 때만), 초록 run에서 닫는다. 모든 shard가 끝까지 돈 run만 이슈를 건드린다
  (취소된 run·shard는 아니다). `issues: write`는 이 job에만 있다. 합친 HTML 리포트(`playwright-report`)와 shard별 실패 trace는 7일 보관.
- **리눅스 글꼴**: Roboto를 휴대폰 글꼴로 쓴다(`web/test/e2e/fonts/phone-font.conf`). 크기를 재는 spec(phone-targets, 44 px 검사)은
  건너뛰지 않는다. 리눅스에서만 실패하면 러너 글꼴·픽셀 탓일 수 있으니 맥에서 다시 돌려 본 뒤 회귀로 판단한다.

## User-facing release notes

Write the annotated tag message from [the EN/KO release template](../.github/RELEASE_TEMPLATE.md). The workflow carries it into Linux bundles, signed feeds and the GitHub release body. A line `Rollout: all` in it publishes a stable release to every server at once instead of the staged roll-out (section 2); the workflow takes that line out of the notes. Review default changes, artifact names, README/FAQ/llms parity before tagging. Backfilling published release bodies is a separate authorized maintainer action; this docs branch does not publish them.
