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
