# 코어 동기화와 로컬 조립 기록

2026-10-27. 이 기록은 `trina-ax-release-candidate`의 로컬 조립 후보를 설명한다. 원본 코어의 실제 병합, GitHub 공개·푸시 또는 운영 배포 기록이 아니다.

| 항목 | 기준 |
|---|---|
| 후보의 필터 코어 baseline | `6e6bad5753900c68e3287903271a686cdc78c41c` |
| 필터 입력 로컬 합성 snapshot | `c904bb7d1d5c85fbd2c3c9afe0d5c18cb215929b` |
| 코어 소스 manifest | 1,238 files · SHA-256 `45e2cdea61ae0ca23a87130cbd6dcddeba0018c60a253b005861578284dafef0` |
| 원본 main 참고 기준 | `86acee7f9f0de55165cbbc095414fab3c9b0da09` |
| 원본 feat/cloud 참고 기준 | `1588597ef0f590d6db732bddfd4050ebc2930b48` |
| 공통 기능 통합 | P2/P3/P4의 로컬 합성·검증 후보에서 만든 고객 정보 제거 필터 코어 |
| 판매판·사이트 overlay | 독립 `p5-trina-work`의 `editions/trina/` P5 구현 및 P6 website/branding |
| README | P6 영문·한글 후보를 루트 `README.md`와 `README.ko.md`로 적용하고 상대 링크 수정 |
| 공개 포크·배포 SHA | 없음. 이 조립은 미커밋 로컬 검토 후보 |

**main과 feat/cloud를 실제 원본 ref에 merge한 것이 아니다.** 두 SHA는 합성 검토의 출처다. 필터 baseline과 overlay 이후 변경, 검증 결과를 함께 봐야 한다. 원본 main/feat refs와 기존 `trina-ax-local-v2`는 이 조립 작업에서 변경하지 않았다. candidate의 공통 DB 수정과 전체 코어 검증은 root의 별도 통합 작업이며, edition 검증으로 이를 대신하지 않는다.

P5 독립 구현 사본의 과거 기반은 filtered main v2 `afaa7a8f35a3753693e6057ca6767007bfae1818`였다. 이번 후보는 그 코어 전체를 복사하지 않고 위 최신 filtered baseline에 판매판·사이트만 겹쳤다. P5 과거 검증의 외부 `coreRoot` 경로 대신, 이번 검증에서는 이 후보 자체의 코어 계약·비밀번호 모듈을 사용한다.

초기 조립 baseline은 `82b1bac0d6331429322eef3813c1f0fb922cbdb6`였고, root가 최종 필터 결과로 fast-forward했다. root의 필터 증거는 7,692 objects · 3,651 trees · refs 1 검사 통과이며 기존 정책/도구·매핑 불변을 확인했다. candidate `.git`에는 remote가 없다.

## 실제 main 병합 승인 뒤의 반입

`c904bb7…`는 원본 main 위에 cloud와 수정 내용을 one-parent 로컬 검토 snapshot으로 이어 붙인 것으로, 실제 merge topology가 아니다. `6e6bad5…`는 그 미공개 검토 snapshot의 필터 결과일 뿐 영구 public upstream 기준으로 확정하지 않는다. 로컬 검토 snapshot commit들을 실제 main에 강제로 삽입하지 않는다.

실제 main 병합 승인을 받은 뒤에는 정상 병합의 최종 real-main tree와 검토한 내용의 동등성을 먼저 검사하고, 진짜 main을 새 사본에서 다시 필터한다. 그때 `previous-manifest`는 원본 main의 445개 commit에 대응하는 승인된 v2 manifest를 기준으로 한다. 이번 미공개 review manifest를 이미 공개된 이력이나 영구 매핑으로 취급하지 않는다. 지금까지 공개된 새 서버판 기록은 없으며, 원본 ref의 force-push나 기록 재작성은 하지 않았다.

## 반입 경계

- 반입: edition 제품 소스, 테스트, 문서, 고지, 라이선스가 확인된 폰트·그림과 website lockfile.
- 제외: 기존 `node_modules`, `dist`, `.astro`, `.validation`, `.shots`, 로그, private 디렉터리, 환경·인증 파일, DB, 개인 키와 운영 자격증명. 빌드와 검증 증거는 후보에서 새로 만든 로컬 파일이다.
- 웹사이트 의존성은 설치된 패키지 디렉터리만 별도 copy-on-write 복사하여 사용한다. 코어 의존성과 실제 실행 경로는 후보 기준으로 검증한다. 의존성 디렉터리는 공개 소스 manifest에서 제외한다.
- 가격·체험·환불 정책, merchant 등록, 실제 AWS/Cloudflare/릴레이 변경, 실모델 호출, 의료 데이터·배포 설정을 반입하거나 실행하지 않는다.

최종 검증 결과와 SHA-256 소스 manifest는 로컬 `.validation/p5-p6-assembly/`에 기록한다. 실제 공개 전에 root의 전체 필터·권리·의존성·코어 검증 및 최종 산출물 검토가 필요하다. 대응 소스 URL과 운영 정책이 확정되기 전에는 웹사이트의 미공개/noindex 상태를 유지한다.

## 후보 경로 재검증

최종 filtered HEAD에서 candidate 자체를 `TRINA_CORE_ROOT`로 지정한 판매판 테스트는 48 pass / 0 fail / 344 assertions였고 edition TypeScript는 exit 0이었다. 사이트는 후보 경로에서 새 빌드 exit 0, unit 69 pass / 0 fail / 463 assertions였다. 독립 localhost 브라우저에서 30 page/viewport/theme 조합과 동작·내부 링크를 확인했고 11개 화면을 기록했으며, console/CSP/외부 요청/overflow 문제가 없었다. 판매판의 합성 HTTP 화면도 로그인·초대·운영 버튼·권한·모바일 폭 검사를 통과했다. 이것은 실제 결제·VM·모델 또는 공개 배포 검증이 아니다.


## 2026-10-27 G4/G5 후속 로컬 검토 반입

위 초기 조립 표의 “미커밋” 설명은 초기 시점 기록이다. 이후 로컬 검토 overlay `ebf47f833b14803f208a638ae5b1491b336611f1`를 보존하고 G4 배포 고지 수집 및 G5 대응 소스 설정/표시 변경을 후속 반입했다. 원본 main/feat/cloud의 실제 병합이나 공개·배포가 아니다.

| 항목 | 후속 기준 |
|---|---|
| 필터 전 로컬 검토 snapshot | `edf8a4b90bc5efb6901d3cb8a8134e7605f38e57` |
| snapshot tree | `8cdb30d8813fe37d0772263c86ad623371d8685a` |
| 코어 소스 manifest | 1,245 files · SHA-256 `1eb12e12e202d118bd3a227d1409426f2a7a42a8bdc929e4a5e60579c73f8ed3` |
| 새 filtered main | `5135952660f618fb17951ef72ccad4c966aa9ea9` |
| filtered tree | `fed1ee9085e5b2229553d49d4ae3889810b260fb` |
| 후보 내부 로컬 merge | `6a3abebc73112210e37daa9a41a8f136dcebc0ed` |
| 필터 manifest SHA-256 | `9863b789921bd8317aef093c6c4642dac381d3ec98eb6504887fedd71016f09a` |

기존 449개 commit mapping을 모두 보존하고 새 snapshot 1개를 추가해 450개가 됐다. 별도 fresh 사본 두 개의 전체 manifest 바이트와 filtered HEAD가 동일하다. 각 필터 결과는 7,737 objects · 3,673 trees · 1 ref 검사를 통과했다. 기존 overlay 152개 파일의 바이트·권한을 merge 직후 대조해 동일함을 확인했으며, 이 UPSTREAM 문단만 후속 기록으로 추가했다.

G4/G5는 기존 코어 manifest 대비 변경/추가 22개(신규 7개, 삭제 0개)다. [배포 고지 범위](RELEASE-NOTICES.md)는 `publicClear=false`의 부분 증거이며 라이선스 허락을 부여하지 않는다. [대응 소스 제공 설정](SOURCE-OFFER.md)은 관리자가 실제 대응 소스 URL을 설정·검증해야 하며 이번 반입이 URL 제공/운영 공개를 완료한 것은 아니다.

이 갱신은 승인된 로컬 사본만 사용했고 candidate에 remote를 추가하지 않았다. 기존 원본 core refs/index와 다른 포크를 변경하지 않았다. 새로운 후보의 전체 runtime/security/build 검증과 최종 source archive는 이 후속 ref에서 별도 수행하며, 앞 절의 과거 후보 테스트를 새 ref의 실행 증거로 대신하지 않는다.

## G4/G5 최종 설치기 테스트 계약 반영

후속 전체 검증에서 설치기 테스트의 `stderr == ''` 기대가 새 G4 고지 한 줄과 충돌했다. 제품 코드는 변경하지 않고 `tests/unit/g-installer.test.ts`만 수정했다. 허용하는 stderr는 산출물의 실제 package/pending 수와 일치하는 정확한 고지 한 줄이며 추가 stderr는 계속 실패한다. 고지 존재·`publicClear=false`·고지 원문의 외부 manifest 해시도 함께 검증한다.

| 항목 | 최종 테스트 계약 기준 |
|---|---|
| 필터 전 로컬 snapshot | `df0eba1a4f39e05f9eb354e38f7b8b5fa692d55c` |
| snapshot tree | `e5a139126f32e5b42b1afec340a27e1e88e0730d` |
| 코어 소스 manifest | 1,245 files · SHA-256 `7d0ffa7ff48acbb6c6ec7e4c06a51676553cc75a45dea1a47df3769081094212` |
| filtered main | `eee9b616d67f6c282ed9bde36bcf220007f82a19` |
| filtered tree | `c320884c97bb184f8a68fce46feb07fe810f6874` |
| 후보 내부 로컬 merge | `6ebd07e1b5691ebde2135108a3dde481ccaaf497` |
| 필터 manifest SHA-256 | `74dcacf46a103e686646df770a5a2facb49536dfd3d68ae230dc08ea50252539` |

직전 450개 mapping을 모두 보존하고 1개를 추가해 451개가 됐다. 두 fresh 필터의 전체 manifest 바이트가 같으며 각 결과의 7,742 objects · 3,676 trees · 1 ref 검사를 통과했다. 원본과 filtered 코어 각각 직전 기준 대비 위 테스트 한 파일만 달라졌고, 후보 merge 직후 기존 Trina 변경 152개 경로의 내용·모드가 모두 같았다. 이 문단만 최종 출처 기록으로 추가했다. 원본 refs/index 변경, 실제 main/cloud 병합, 원격 게시 또는 배포는 없었다.

코어 담당자의 집중 검증은 19 pass / 0 fail / 1,048 assertions와 source TypeScript exit 0이었다. 이번 후보 자체의 최종 전체 검증과 source archive는 이 후속 ref 기준 별도 수행한다. 제품 바이트가 동일한 이전 security/web/build/bundle 증거는 검증 범위와 실행 기준을 명시해 재사용할 수 있으며, 테스트 계약 변경으로 기존 전체 검증 실패를 성공으로 소급하지 않는다.

## Mobile native configuration follow-up

- Unfiltered local review snapshot: `9701e20c207c334d864ad664cf0a4dd0ddd15e30`; tree `75dbcd77d1ede86f5982a7d30e36de45d9513a02`.
- Filtered core: `910695d29d24b56227f0927d961a593d4e3cc9e2`. Existing 451 commit mappings are preserved; 452 mappings and the complete manifest match the independently repeated fresh copy.
- Common changes: explicit TypeScript helper extension in Expo configuration, TypeScript compiler support for that import, and the verified Node runtime requirement. No mobile identity, bridge, permission, or server behavior changed.
- The Trina edition additionally receives explicit operator recovery of provably undispatched expired/cancelled provisioning and an unused registration left by an interrupted first attempt. Dispatched or exchanged registrations fail closed. This is edition-only and is not an upstream core change.
- This remains an unpublished local review snapshot. Actual upstream merge/push, public repository operations, and production deployment require the existing owner approvals.

## 2026-10-27 GitHub 비공개 업로드용 기록 정리

대표 결정(비공개로 먼저 올리고, 권리 정리 뒤 공개)에 따라 `trina-ax-release-candidate`(HEAD `ce48af1`)의 새 사본에서 `git filter-repo`로 기록을 다시 썼다. 원래 후보는 바꾸지 않았다.

- 기록에서 뺀 경로: `ee/`, `tests/cloud/host-setup-test.sh`, `tests/cloud/host/`(ee/cloud 호스트 시험), `native/cmd/mycel-ctl/mycel-ctl`(실수로 커밋된 macOS 실행 파일, 개발자 홈 경로 포함).
- 작성자 메일: 로컬 호스트명·사설 IP·개인 메일을 `dev@potenlab.dev`로 바꿨다(이름은 유지).
- 커밋 메시지의 로컬 경로(`/Users/…`)를 `(local path)`로 바꿨다.
- 그 위 일반 커밋: `ee/cloud` 작업공간·`test:cloud` 제거와 잠금 파일 정리(ee/cloud 항목 10줄만 삭제), self-hosted runner workflow(`linux-lockdown.yml`) 삭제, NOTICE·PUBLICATION·CLAUDE.md 갱신.

이 기록은 아직 one-parent 검토 snapshot의 필터 결과다. 원본 코어 main 병합 뒤 진짜 main을 다시 필터하면 기록이 달라질 수 있고, 그때 이 비공개 레포를 바꾸려면 force push 승인이 필요하다. 공개 전환 전에 정한다.

## 2026-10-27 코어 리눅스 P2 수정 반입 (fix/linux-p2)

넣을 곳: trina-ax 포크(코어 수정 반입), 이유: AWS 리눅스 시험 실패를 코어 Team AX에서 먼저 고쳤고(모든 회사 해당), 이 포크가 받아 간다.

| 항목 | 값 |
|---|---|
| 받은 것 | 코어 `fix/linux-p2`의 `91fd604..e96e266` 커밋 10개 (15파일, +230 / −40) |
| 뺀 것 | 그 브랜치 첫 커밋 `503ba36`(web vite tsconfig). 이 레포에 이미 `5efc5ca`로 있다 |
| 적용 | `git format-patch` 10개를 `git am`으로 순서대로 적용. 커밋 메시지·저자 그대로 |
| 충돌 | 없음. 고친 15파일 모두 코어 `e96e266`의 blob과 같다 |
| 이 레포 커밋 | `4072bfc..92be904` (기준 `d0b13ee`) |

| 코어 | 이 레포 | 내용 |
|---|---|---|
| `91fd604` | `4072bfc` | 보안 시험: 대소문자 구분 파일시스템에서 `groups/Marketing`과 닮은 이름 되돌리기 (409 기대) |
| `7ca793b` | `355067a` | 프롬프트 시간 줄을 ICU 패턴 없이 고정 영어로 (리눅스 "a.m." 차이) |
| `77e6096` | `532fbf6` | make_file: 변환기 없을 때 OS에 맞는 안내, typst 없이도 PDF 보안 시험 |
| `5933932` | `42f0cbe` | 시험: 맥 전용 도구(ditto zip, Apple Vision OCR fixture)를 플랫폼 조건 뒤로 |
| `d5dad85` | `2004f3b` | 시험: 연결 폴더 리눅스 fixture, API 엔진 egress 모드가 시험 파일 사이로 새지 않게 |
| `b270f67` | `fbe630d` | 중계 시험 t2: 생산 속도와 이 호스트의 소켓 버퍼 한도로 판정 |
| `b342b1f` | `68350f3` | 웹: 새 채팅 화면이 뜨기 전에 시작한 아티팩트도 패널이 열림 |
| `327082e` | `cae9cbb` | 웹: 폴더 목록 로딩 중 고른 파일도 업로드, 늦은 목록 응답이 덮지 않음 |
| `b0d7c66` | `d028257` | make_file: 빈 CSV 줄을 바로 버림 (빈 줄 수백만 개) |
| `e96e266` | `92be904` | e2e: 업로드 취소 시험이 두 번째 청크 요청을 기다림 |

코어 `fix/linux-p2`는 아직 코어 main에 병합·push되지 않은 로컬 브랜치다. 나중에 코어 main이 같은 수정을 다른 SHA로 받아 오면, 다음 동기화 때 같은 내용이 이미 있는 것으로 처리한다(내용 대조 후).

### 시험 결과 (`92be904`)

리눅스: `lfx-env:2`(= `p2-linux-dev:20261027` + Playwright chromium + `libnss-myhostname`), Debian 13 ARM64 컨테이너(Colima 4 vCPU). 소스는 `git archive 92be904`만 컨테이너 안 파일시스템에 풀었다. `native/bin/linux-arm64`는 맥에서 `native/build.sh`로 만든 것을 넣었다. 컨테이너 안에서 `bun install --frozen-lockfile`, `p2build` 계정, `env -i`, `LANG=C.UTF-8`, UTC, `unshare --net`(루프백만, 외부 네트워크 없음), `docker run --init`. 시험하는 동안만 Colima의 `kernel.apparmor_restrict_unprivileged_userns`를 0으로 두고 끝나고 1로 되돌렸다.

| 묶음 | 리눅스 | 코어 리눅스 고친 뒤 (참고) |
|---|---|---|
| `bun test tests/unit` | 1943 pass / 59 skip / 0 fail (2002) | 1943 / 59 / 0 (2002) |
| `bun test tests/security` | 1482 / 23 / 0 (1505) | 1482 / 23 / 0 |
| `bun test tests/relay` | 25 / 0 | 25 / 0 |
| `bun run --cwd web e2e` (`--cpus 2`) | 108 passed / 3 skipped / 0 failed (111) | 108 / 0 / 3 (111) |

리눅스는 모두 통과해 수정 전 비교는 하지 않았다. `ee/`가 없어서 생긴 차이는 없었다. `tests/unit/g-cloud-deployment.test.ts`는 `server/src`만 불러 이 레포에서도 돈다. unit 파일 수(171)·시험 수(2002)가 코어와 같다. `tests/cloud`(ee/cloud 호스트 시험)는 이 레포에 없어 돌리지 않았다.

맥(개발 맥, 이 레포 경로):

| 항목 | 결과 |
|---|---|
| `bun install --frozen-lockfile` | 통과 (변경 없음) |
| `bun run typecheck` | 통과 |
| web unit (`bun run --cwd web test`) | 168 / 0 |
| web build | 통과 |
| `editions/trina` `bun test test` (`TRINA_CORE_ROOT` 없음) | 105 pass / 24 skip / 0 fail (129) |
| 같은 시험, `TRINA_CORE_ROOT=trina-ax-release-candidate` | 129 / 0 |
| `editions/trina` typecheck | 통과 |
| `editions/trina/website` `bun run test` (astro build + 시험) | 69 / 0 |
| `bun test tests/unit` | 1962 / 13 / 22 (1997). 수정 전 `d0b13ee`: 1961 / 13 / 22 (1996) |
| `bun test tests/security` | 1493 / 0 / 6. 수정 전 `d0b13ee`: 1493 / 0 / 6 |

맥 unit·security 실패는 수정 전과 이름까지 같다(새 실패 0). 코어 맥 실행의 실패 목록과도 같다. 이 맥 환경에서 원래 나는 실패다: 긴 소켓 경로(`g-prod-ops`), `/var` → `/private/var` 임시 폴더(`skills`), 사무실 모드·구독 관리 모드(`g-subscription`, `office`, `office-tunnel`, 보안 `r4b-office-*`), P2 credential 파일(`p2-smoke-prepare`). 시험 수 +1은 `b-review`의 새 시간 줄 시험이다.

시험은 실제 Anthropic API·모델을 부르지 않았다(리눅스는 네트워크 없음, 맥은 최소 환경 변수로 가짜 엔진만). 비밀값은 쓰지 않았다.

## 2026-10-27 코어 배포 채널 반입 (feat/release-channel)

- 받은 것: 코어 `feat/release-channel` `3d13f8d`(코어 `fix/linux-p2` 위 1커밋) → 이 레포 `498105f`. 충돌 없음.
- 업데이트 주소·서명 키·사무실 업데이트 제품 값·Cloudflare 이름이 코어 파일 여러 곳에 박혀 있던 것을 `shared/src/release-channel.ts`와 `native/internal/bundle/release_keys.go` 두 곳으로 모았다. 판매판은 `editions/<name>/branding/release-channel.json`을 `scripts/edition-release.ts`로 적용한다.
- Trina 적용(다음 커밋): `editions/trina/branding/release-channel.json`
  - 주소 `https://updates.trina.app`
  - 키 ID `086478d11148fd06`
  - 제품 값 `trina-ax-office`
  - 개인키 폴더 `~/.config/trina-ax-release`
  - Cloudflare zone `trina.app`, bucket/Worker `trina-ax-updates`
- 고객 주소 예약어에 `update(s)`, `release(s)`, `download(s)`를 더했다.
- 다음 동기화: 코어 main이 같은 변경을 다른 SHA로 받으면 이미 있는 것으로 처리한다. 두 채널 파일이 충돌하면 코어 쪽을 받고 `bun scripts/edition-release.ts editions/trina/branding/release-channel.json --apply`를 다시 한다.
- 맥 검증
  - typecheck 통과, Go `internal/bundle`·`cmd/mycel-ctl` 통과
  - 업데이트·설치·이름 관련 단위 시험 145 / 7 skip / 0
  - `editions/trina` 105 / 24 skip / 0
- 리눅스 설치 시험(T2)은 별도로 돌린다.

## 2026-10-27 코어 배포 자동화 반입 (feat/release-ci)

- 받은 것: 코어 `feat/release-ci` `0ef404f` → 이 레포 `33c579b`. 충돌 없음.
- 내용
  - `v*` 태그 → 전체 시험 → 리눅스 kit·사무실 zip·윈도우 설치 파일 빌드 → GitHub 비밀값의 키로 서명 → `updates.trina.app` 업로드(사무실·서버 피드) → GitHub Release.
  - 서명 키가 `RELEASE_CHANNEL.keys`(Trina 키)가 아니면 빌드 전에 멈춘다.
  - 상세: `docs/RELEASE-CI.md`
- 이 레포에서 할 일(대표 확인 뒤)
  - GitHub Actions 결제
  - 비밀값 `RELEASE_SIGNING_KEY`(`~/.config/trina-ax-release/release-key.pem`)와 `CLOUDFLARE_API_TOKEN`(trina.app zone, R2 쓰기)
  - `bun scripts/release/hosting.ts setup`(`updates.trina.app`)
- 맥 검증: typecheck 통과. 배포·채널·업데이트 시험 80 / 0(Trina 값으로).
