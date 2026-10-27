# 공개·배포 조건 — 로컬 후보

2026-10-27. 이 후보는 로컬 검토 대상이다. 테스트·개인정보 필터·LICENSE 보존은 각각 별도 증거이며 제3자 권리 허락이나 공개 승인이 아니다. 최신 소스·필터·edition 반입 기록은 [UPSTREAM](UPSTREAM.md)을 따른다.

## 실제 포함 범위와 권리

2026-10-27 대표 결정을 반영했다. `ee/`(호스팅 제어면)는 이 레포와 커밋 기록에서 뺐고, `shared/src/cloud-protocol/`만 남는다.

| 대상 | 현재 근거 | 남은 조건 |
|---|---|---|
| 일반 코어·Trina 추가 코드 | root LICENSE/package metadata는 AGPL-3.0-only | 실행 버전 출처·수정 기록·대응 소스와 구성요소 예외 보존 |
| Saram/chat-proto 유래 코드 | DECISIONS.md:292 복사 기록. 권리자(포텐랩)가 2026-10-27 AGPL 공개를 확인 | 원 고지 보존 |
| ee/ | 레포와 기록에서 제외(비공개 유지). 판매판은 `TRINA_CORE_ROOT`의 별도 사본에서 계약만 읽고, 없으면 `core_contract_unavailable`(503) | 공개본에 ee 코드를 다시 넣지 않는다 |
| shared/src/cloud-protocol | 폴더 한정 MIT LICENSE 보존 | 원문/저작권 고지 유지. 다른 shared로 MIT를 넓히지 않음 |
| pptx-preview@1.0.7 | npm 의존성. 설치 metadata ISC, LICENSE 없음. 저자의 현재 LICENSE는 소스 게시·자체 오픈소스화를 제한 | 대표가 2026-10-27 위험을 알고 유지하기로 결정. 권리 불일치는 해결된 것이 아니라 열린 항목으로 남긴다 |

## 배포 형태별 조건

- **Git 소스:** 위 소스 권리와 필터 검사, 원 고지를 먼저 해결한다. 의존성 선언과 제3자 코드가 담긴 번들 배포를 구분한다.
- **앱 웹 번들:** 검토 당시 web/dist에 별도 LICENSE/NOTICE 산출물이 없다. 실제 JS·폰트·worker·vendor별 버전/해시/허락·고지를 수집해 최종 산출물에 포함한다.
- **사이트 정적 번들:** website/public/licenses의 Apache·AGPL·NOTICE와 public/fonts의 OFL을 산출물에 보존한다. 부분 글꼴의 예약 이름 문제는 Trina UI 내부명·파일·CSS 이름으로 수정했고 원 OFL/저작권은 보존했다. 이것만으로 대응 소스 제공이나 전체 권리 검토가 완료되지는 않는다.
- **서버/office/desktop/image:** 실제 포함한 Bun·Pandoc·libvips·ONNX Runtime·Electron/Chromium 등의 고지와 버전별 제공 자료를 확인한다. GPL/LGPL의 해당 배포 방식별 대응 소스·설치/재링크 조건도 연결한다.
- **엔진/모델:** Claude Code/Codex 바이너리나 모델 가중치를 포함한다면 해당 버전의 이용·배포 허락을 별도 확인한다. 프로젝트 AGPL은 그 권한을 부여하지 않는다.

[제3자 고지 현황](THIRD-PARTY-NOTICES.md)은 준비 자료이며 완성된 SBOM/배포 고지 묶음이 아니다.

## 네트워크 서비스의 대응 소스

AGPL §13은 수정된 네트워크 제공 프로그램의 사용자에게 그 버전의 대응 소스를 무료 네트워크 경로로 받을 기회를 명확히 제공하도록 규정한다. §1의 대응 소스에는 필요한 생성·설치·실행·수정 스크립트도 포함된다. 현재 shared/src/source.ts는 published:false와 메일 요청 경로이므로 실제 서비스의 최종 제공 경로로 통과 처리하지 않는다. 특정 공개 GitHub 호스트 자체가 필수인 것은 아니며 실제 사용자에게 정확한 실행 버전 소스를 받을 수 있는 검증된 경로가 필요하다.

실제 공개/서비스 전 릴리스 ID·소스 manifest·빌드/설치 자료·소스 링크·라이선스/무보증 고지를 연결하고 비로그인/로그인 화면에서 확인한다. 비밀값·고객 데이터는 제공물에서 제외한다. 근거는 [로컬 LICENSE](../LICENSE) §1·4–6·13과 [GNU AGPL 원문](https://www.gnu.org/licenses/agpl-3.0.html)이다.

## 실행 승인

원본 main 병합/push, GitHub 이름 변경/생성/공개, 실제 배포, 계정·결제·AWS·DNS 변경은 승인된 대상과 행위로 각각 확인한다. 이 문서 작성은 그 실행 승인이 아니다. 권리 기록과 최종 배포물 검사를 남긴 뒤 승인된 ref/산출물만 공개한다.
