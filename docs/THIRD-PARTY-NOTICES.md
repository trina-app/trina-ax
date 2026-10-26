# 제3자 고지 현황

2026-10-27, 로컬 후보. 알려진 출처와 누락을 설명하며 완성된 배포용 고지 묶음이 아니다.

| 범위 | 보존된 원문·출처 | 한계 |
|---|---|---|
| Team AX/Trina 코드 | [LICENSE](../LICENSE), [NOTICE](../NOTICE) | 별도 라이선스·권리 미확정 부분을 새로 허락하지 않음 |
| 공유 cloud 프로토콜 | [폴더 한정 MIT](../shared/src/cloud-protocol/LICENSE) | ee/cloud 및 shared의 다른 폴더까지 확대하지 않음 |
| 역사적 Trina 웹사이트 | [Apache-2.0](../editions/trina/branding/LICENSE.website-upstream.txt), [원 저작권 출처](../editions/trina/branding/NOTICE.website-upstream.md) | 새 서버판 전체가 Apache라는 뜻이 아님 |
| 사이트 글꼴 | [Geist OFL](../editions/trina/website/public/fonts/OFL-Geist.txt), [Pretendard OFL](../editions/trina/website/public/fonts/OFL-Pretendard.txt) | 실제 폰트/부분 글꼴과 함께 배포. [Trina UI 변경 기록](../editions/trina/website/public/fonts/NOTICE-Trina-UI.txt): 예약 이름을 쓰지 않도록 내부 이름/파일/CSS 변경 |
| 사이트 정적 출력 | [고지](../editions/trina/website/public/licenses/NOTICE.txt), 같은 폴더 Apache·AGPL 원문 | 실제 dist의 바이트 확인 필요; 대응 소스 제공과 별개 |

Saram/chat-proto 12개 명시 파일, ee/cloud, pptx-preview@1.0.7은 [PUBLICATION](PUBLICATION.md)의 권리 근거가 해결될 때까지 배포 허락을 확정하지 않는다. 저자 [현재 pptx-preview LICENSE](https://raw.githubusercontent.com/501351981/pptx-preview/main/LICENSE)는 설치 metadata의 ISC와 다른 제한을 담고 있다. 이것이 정확한 1.0.7 배포 당시 조건이었다고 추정하지 않는다.

앱 웹 번들의 React/KaTeX/pdf.js/Office/viewer/vendor/폰트, 서버의 web-push와 semantic runtime, desktop의 Electron/Chromium 등은 최종 artifact에서 실제 포함 버전·전이 구성요소를 확정해야 한다. lockfile/단일 SPDX metadata만으로 모든 저작권 문구·복합 라이선스를 대체하지 않는다. JSZip의 선택형 허락, pako의 복합 허락, libvips의 별도 LGPL 및 linked library 고지도 구분한다.

최종 release에는 파일/패키지·버전·출처 revision·SHA·허락 원문·저작권·수정 내역·선택한 제공 방식이 연결된 목록과 고지 묶음을 넣는다. 필요한 대응 소스·설치/재링크 자료를 보존하고 실제 zip/tar/app/image/web output에 포함되는지 검사한다.
