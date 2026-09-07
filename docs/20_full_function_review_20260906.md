# 전체 기능 재검토 및 누락 연결 결과

갱신: **2026-09-06 22:39 KST** · 작업 트리 기준 `main / b8d461e` · 커밋/푸시 미실행.

## 결론

기존 확장과 웹의 **30개 기능군**을 진입 화면·공유 클라이언트·서버 처리·회귀 테스트로 다시 대조했다. 웹의 성과 화면은 채널 목록/개선 글 준비만 연결되어 있었고, 표 가져오기·집계·관리·추적 링크·광고 계정 화면이 빠져 있었다. 이번에 P2-B를 연결했다.

**현재: P0·P1·P2-A·P2-B 구현 및 자동 검증 완료. P2-C·P3와 실계정 인수는 미완료.**
기능군 기준 29개는 웹 진입점이 있으며 F29 현재 탭 수집의 웹 연결만 남는다. 이 수치는 제품 완성도 97%나 모든 세부 동작의 실계정 성공률이 아니다.

## 이번에 수정한 누락

| 발견 사항 | 조치 | 검증 근거 |
|---|---|---|
| 성과 상세 기능의 웹 진입점 없음 | 성과 확인·개선 / 자료 가져오기·채널 / 광고 계정 성과로 연결 | 웹 성과·앱·메뉴 테스트, 격리 브라우저 |
| 서버에 채널 범위 필터 없음 | 읽기 API에 선택적 channel_id, overview에 import_id 추가 | 2채널·이전 기간·다른 채널 import 거부·비활성·구형 호출 테스트 |
| 전체 최신 100건에서만 특정 채널을 찾으면 해당 채널 이력이 빠짐 | 선택 채널의 이력도 별도 조회, 채널별 최대 100건 명시 | 공유 클라이언트·웹 선택 조건 테스트 |
| 검색어 30개/가져오기 10개까지만 UI 표시 | 반환된 목록 전체 표시, 검색어의 개별 기간·상태와 이력의 채널 이름 표시 | 31번째 검색어/12번째 가져오기 테스트 |
| API의 Trend·조회/공감/댓글이 상세 화면에서 빠짐 | 기존 지표를 출처·수집시각·상대지수 안내와 함께 연결 | Trend 표시 테스트·기존 타입/빌드 |
| 공감수 헤더와 일부 정규화 지표가 미리보기에서 누락 | 공감수/좋아요수 alias 추가, 저장되는 모든 공개 집계 지표 표시 | 파서 및 전체 지표 미리보기 테스트·브라우저 재확인 |
| 이전 입력의 추적 링크/미리보기 또는 중복 저장 위험 | 요청 서명/epoch/중복 잠금, 입력 변경 시 이전 결과 제외 | 공유 패널 기존 회귀·추적 링크 지연/중복 테스트 |
| 변경·삭제에 대한 명확한 실행 단계 부족 | 저장/채널 변경 잠금, 가져오기 삭제에 화면 내 확인·취소, 원고 보존 안내 | 채널 중복·삭제 확인·저장 재시도 테스트 |
| 광고 메뉴와 오늘 할 일에서 광고 화면으로 직접 연결 안 됨 | 정확한 광고 하위 화면으로 연결, 조회 전 화면 내 동의 | 메뉴/오늘 할 일/광고 동의·quota·기간 지연 테스트 |
| 빠른 작성에서 추천으로 가는 동선 없음 | ‘키워드 추천 보기’ 버튼 연결, 메뉴 전환으로 글을 자동 생성하지 않음 | 앱 라우팅 테스트 |
| 웹 구현으로 표시해도 web_ui/web_test 경로를 검사하지 않음 | 구조 검사 강화, 미구현/자동/실계정 검증 의미 분리 | parity 검사 및 이 보고서 |

## 기능군 재대조

| 기능군 | 현재 위치/상태 | 주요 자동 검증 |
|---|---|---|
| F01–F04 작성·AI·품질·민감 판별 | 글쓰기·앱 설정, 기존 서버 경로 유지 | writer, composer, article_quality, drafts_service |
| F05–F07 연관·상승·기회 분석 | 키워드 찾기, 빠른 작성에서 진입 연결 | keywords, research_service |
| F08–F13 맵·의도·추이·독자·입찰·관심·분야별 자료 | 키워드 찾기 상세, 같은 탭에서 활용 | keywords, research, pc-mobile-donut |
| F14 참고 사진 | 글쓰기 검수·분야별 자료, 원본/권리 안내 | writer, simple-compose |
| F15–F17 근거·플랜·작성 방식 | 근거와 플랜으로 쓰기, 선택/버전/승인 후 작성 | planner, factpacks, templates_llm |
| F18–F21 원고·이력·오늘 할 일·공개 기록 | 내 원고·글쓰기, 광고 작업 연결 보완 | workflow, writer, today_work, drafts_service |
| F22–F25 채널·4종 표·집계·개선 관리 | **이번 웹 연결 완료**, 채널/기간 범위 분리 | performance.test.tsx, performance_api, performance_review |
| F26–F28 스토어·사이트·광고 성과 | **이번 웹 연결 완료**, 블로그 지표와 분리 | performance, performance-import, research |
| F29 현재 검색어/SERP/Blog Inspector | **확장에 유지, 웹 연결 미구현** | 기존 parsers 회귀만 유지, 웹 연동 PASS 아님 |
| F30 네이버 임시저장 | 웹 요청/상태/복구 연결, 별도 로그인 브라우저 필요 | writer, publisher; 새 실계정 인수 미실행 |

30개 항목별 원래 화면·API·웹 화면·테스트의 상세 목록은 [기능 보존표](web-feature-parity.json)에 유지한다. 구조 검사 통과는 동작/실계정 검수를 대체하지 않는다.

## 실제로 남은 작업

| 우선순위 | 잔여 범위 | 현재 판정 / 다음 완료 기준 |
|---|---|---|
| P2-C | 선택형 확장 → 웹 현재 페이지 자료 전달 | 정규화 수집 저장/ID 전달 계약, 미설치·미지원·파싱 실패 안내, 양쪽 adapter 회귀 필요 |
| P3 | 정식 `pnpm app:demo` | **명령/정식 fixture 미구현.** 운영 DB·세션·외부 provider를 확실히 분리한 실행기와 E2E 필요 |
| P3 | 호환성·접근성·사용자 인수 | 5개 폭 일부 화면 검수만 완료. 전 기능 키보드/확대·다중 브라우저·사용자 무안내 인수 필요 |
| 실계정 인수 | 실제 Advisor 표 헤더/집계·광고 계정 권한·지역/쇼핑 조회 | 이번 자료는 격리 가상 표다. 실제 계정에서 성공했다고 보지 않음 |
| 실계정 인수 | 실제 원고의 사실성/가독성과 SmartEditor 임시저장 | 기존 작성·저장 회귀를 유지했으나 이번 웹 검수에서 새 글 생성·네이버 입력은 실행하지 않음 |
| 별도 데이터 설계 | 전체 분야 공식 실시간 인기어 피드 | 현재 구현은 **입력 분야의 최근 상승 후보/저장 이력**. 범분야 실시간 순위 데이터원·권한·갱신 정책 미연결 |
| 운영 정리 | 기존 Dev Lesson durable_ref | 미추적 파일 참조로 `LESSON_CORPUS_INVALID`. Git stage로 숨기지 않음 |

### 의도적으로 하지 않는 기능

- 자동 공개 발행, 광고 생성/수정, 비밀번호·쿠키/CLI OAuth 토큰 복사.
- 사진 자동 생성/삽입, 방문하지 않은 장소의 실제 후기 조작.
- 비공개 통계 자동 스크래핑. 성과 표는 사용자가 가져온 집계 자료를 사용한다.
- 앱 설정은 메뉴 편집이나 비밀키 입력 화면이 아니다. 작성 기본값·연결·AI 상태·API 사용량을 보여주고 서버 키는 `.env`에서 관리한다.

## 변경 위치

- `packages/workbench/src/PerformanceWorkspace.tsx`: 웹 성과 작업/채널/기간/상태/광고 동의.
- `packages/workbench/src/PerformancePanels.tsx`, `performance-import.ts`: 확장과 공유하는 대시보드/표/추적 링크/파서.
- `apps/extension/entrypoints/research/PerformanceWorkspace.tsx`, `apps/extension/lib/performance-import.ts`: 기존 import 경로 재수출. 공유 Tailwind source를 추가하여 확장 스타일 유지.
- `apps/local-core/app/services/performance.py`, `api.py`, `packages/core-client/src/index.ts`: 하위 호환 선택적 범위 필터. DB schema/점수 산식 변경 없음.
- `apps/web/src/App.tsx`, `MenuGuide.tsx`, `style.css`, 공통 Writer/TodayWork: 정확한 진입점, 메뉴 이동 중 표 입력 유지, 미저장 이탈 보호.

## 검증 결과

- `UV_CACHE_DIR=/tmp/ncos-uv-cache bash scripts/verify_all.sh`: **Python 296 + Extension 75 + Web 87 = 458건 PASS**.
- 웹/확장 typecheck·production build, Python compileall, 빈 DB migration head, Chrome-free/30기능 경로 검사 PASS. `git diff --check` PASS.
- 외부 live smoke 4건 제외. 알려진 Starlette/httpx deprecation 경고 1개 유지.
- 최종 로그: `/tmp/ncos-review-final-verify.log`.
- 격리 브라우저: 채널 추가 → 표 미리보기 → 1행 저장 → 선택 채널 노출100/유입0 확인 → 본문 최신화 조건 전달. 다른 블로그900/유입9, 스토어 기여10,000원, 사이트 클릭6은 서로 분리됨. 검색어 기간, 공감0/댓글2 미리보기, 광고 동의 후 빈 자료 안내 확인.
- 성과 요약/가져오기에서 320/430/768/1280/1440px 문서 전체 가로 넘침 없음. 표 자체 가로 스크롤은 허용. 320px 입력 폼 시각 확인, 해당 검수 탭 console warning/error 없음.
- `/tmp/ncos_review_browser_qa.py`, `/tmp/ncos-web-review-qa`는 임시 harness다. 별도 DB/쿠키·빈 키·외부 소켓 차단·가상 provider 사용. **정식 demo 구현으로 계산하지 않음.** 검수 후3720 서버/탭 종료.

## 실사용 반영

- 활성 임시저장 작업0, 프로젝트 PID/경로 확인 후 이전3719 서버만 정상 종료했다.
- 백업: `data/backups/ncos-before-web-20260906-223640-689322.db` (mode600, Git 제외).
- 최신 실행: `http://127.0.0.1:3719/app/performance`, PID94422 / exec14569. 다음 작업에서는 재확인한다.
- 실제 웹 세션에서 최신 성과 입력 화면을 열어 두었다. 운영 성과 채널/가져오기는 아직0건이므로 집계 숫자가 없는 것이 정상이다. 가상 숫자를 운영 화면에 넣지 않았다.
- 재시작 전후 Keyword13 / Draft20 / DraftVersion21 / PublishedContent0 / DiscoveryRun6 / OwnedChannel0 / PerformanceImportRun0 동일, SQLite integrity_check=ok.
- 사용자가 열어 둔 Chrome의 기존 확장/웹 입력은 강제 새로고침하지 않았다. 확장 production build는 검증했지만 설치된 확장의 reload/live 검수까지 수행했다고 주장하지 않는다.
