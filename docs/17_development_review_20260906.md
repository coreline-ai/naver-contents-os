# 17. 개발 검토 및 자체 검증 — 2026-09-06

## 결론

기존 자동 테스트가 통과한 상태에서도 성과 집계·추천·저장 경계에서 결함이 재현됐다. 실패 테스트를 먼저 추가하고 수정한 뒤 전체 검증을 다시 실행했다. 이번 결과는 **작업 트리의 코드·빌드 검증**이며, 새 빌드의 실제 네이버 계정 인수나 Chrome 설치 적용 완료를 의미하지 않는다.

## 확인·수정한 주요 문제

| 영역 | 재현된 문제 | 수정 및 예방 |
|---|---|---|
| 게시물 식별 | URL 없이 제목만 다른 행들이 `publication:None`으로 충돌 | URL → 실제 콘텐츠 ID → 제목 순서로 식별. 과거 키를 가진 행도 같은 대상이면 중복 저장하지 않음 |
| 집계 | 최신 파일만 합산, 누락·pending을 0으로 처리, 평균 순위 단순 평균 | 같은 채널·기간·단위의 모든 파일 집계. 불완전한 지표는 null, 순위는 노출 가중 평균 |
| 비교 | 일간/주간, 길이·간격이 다른 기간, 다른 글의 동일 검색어 비교 | 인접한 동일 길이·단위와 동일 대상만 비교. 요약은 가져온 대상 집합까지 일치해야 증감 표시 |
| 추천 수명 | 개선된 성과가 들어와도 옛 추천 유지, 만료·보관 글 재노출 | 최신 snapshot·한국 날짜 기준 90일·보관 여부 검사. 내 성과/오늘 할 일에 동일한 읽기 전용 필터 적용 |
| 후속 글 | 이미 작성된 후속 Draft가 있어도 다시 새 글 추천 | 동일 검색어의 별도 비보관 Draft/발행 글이 있으면 추천 생성·노출 억제 |
| 시장 데이터 | PC `< 10` + 모바일 숫자에서 예외, 한쪽 결측도 합계 표시 | 양쪽이 유효한 숫자일 때만 합산. 내 노출 결측을 0으로 해석하는 추천 제거 |
| 가져오기 UI | 미리보기 후 기간/표 변경, 늦은 응답, 연속 클릭으로 잘못된 저장 | 입력·클라이언트별 검증 결과 무효화, 검토한 요청만 저장, 동기 중복 잠금, 정규화된 최대 5행 확인 |
| 추적·매핑 | 파라미터 경계/스토어별 ID 충돌, 긴 ID, 다른 글로 귀속 변경 | 필드 구분·스토어 scope를 포함한 고정 길이 hash, URL/콘텐츠 ID/추적 링크 매핑 충돌 거부 |
| 개선 원고 | 다른 검색어의 후속 글이 기존 Draft 키워드 검사에서 막힘 | `revision`/`followup` 명시. 기존 글 수정은 원래 키워드, 후속 글은 검색어를 사용하고 항상 새 Draft 생성 |
| 완료 처리 | 이후 다른 주제 원고도 기존 추천을 완료 처리 | 제출 시점의 주제에 추천 연결. 주제를 바꾸면 참조/로딩 차단 해제, 완료 처리 1회 |

주요 구현 위치:

- `apps/local-core/app/services/performance.py`: 계산·추천·매핑·추적 ID
- `apps/local-core/app/services/work.py`: 오늘 할 일 공통 추천 필터
- `apps/local-core/app/services/composer.py`, `apps/local-core/app/api.py`: 개선/후속 참조 모드
- `apps/extension/entrypoints/research/PerformanceWorkspace.tsx`: 가져오기 확인·요약·작성 연결
- `apps/extension/entrypoints/sidepanel/App.tsx`: 요청에 귀속된 참조/완료 처리
- `packages/contracts/src/index.ts`: 양쪽 계약

## 실제 실행한 검증

| 검사 | 결과 |
|---|---|
| 시작 전 전체 검증 | Python 238 / Extension 66 통과 — 아래 회귀 경계는 기존 테스트가 잡지 못함 |
| 추가 실패 재현 | 초기 Python 15건, UI 3건 실패. 후속 참조·구버전 계산·매핑 충돌·중복 후속 추천·지연 파일 읽기도 별도 실패 재현 |
| 최종 전체 Python | 267 passed, 외부 smoke 4 deselected, 기존 경고 1건 |
| 최종 Extension | 74 passed / 11 files, happy-dom |
| 전체 합계 | 341 passed |
| TypeScript / compileall | 통과 |
| MV3 production build | 통과, 441.23 kB |
| 실제 Alembic | 임시 DB에 이전 schema → head → 이전 schema → head 실행 |
| 데이터 보존 | 합성 기존 Keyword·Draft·원문·발행 글 보존, FK 검사 및 import 삭제 cascade 통과 |
| 추적 파일 검사 / diff check | 통과 |

재실행:

```bash
pnpm test:performance
UV_CACHE_DIR=/tmp/ncos-uv-cache ./scripts/verify_all.sh
```

새 회귀 테스트는 `tests/unit/test_performance_review.py`, `tests/integration/test_performance_migration.py`, `apps/extension/tests/performance-import-panel.test.tsx`에 있으며, 기존 composer·sidepanel·API 테스트도 보강했다.

## 기존 데이터·업데이트 주의

- 계산 버전은 `performance-v2`다. 구버전 추천은 노출하지 않는다. 같은 성과 자료를 다시 미리보기·저장하면 snapshot 중복 없이 최신 규칙으로 재계산한다. 사용자의 완료/숨김 결정은 보존한다.
- 과거 잘못된 제목 충돌로 **저장되지 않았던 행은 자동 복구할 수 없다**. 원래 표를 다시 가져와야 한다.
- 예전 추적 ID 연결은 유지한다. 새 생성 ID는 `nc1_…` 형식이다. 예전 충돌로 잘못 덮인 연결 이력은 원본 자료 없이 추정 복구하지 않는다.
- URL 매핑은 발행 등록과 같은 정규화 주소를 사용한다. 네이버 모바일/PC 주소의 모든 별칭 동등성은 이번 검증 범위가 아니다.
- 달의 길이가 다른 월간 자료도 억지로 비교하지 않는다. 현재 증감 비교는 동일 일수·인접 기간에 한정한다.
- 운영 DB 변경·서버 재시작·확장 reload·커밋·푸시는 하지 않았다. 기존 dirty tree를 보존했다.

## 남은 검증·개발 우선순위

1. **실계정 UAT**: 실제 Creator/Biz/Search 표의 헤더·단위, 430px 사이드패널, 정보/후기/상품 원고 품질 및 SmartEditor 임시저장 확인. 외부 API·실모델·네이버 공개 발행은 이번에 호출하지 않았다.
2. **P2 사용성**: 현재 요약은 각 데이터 종류의 최신 채널 한 곳을 표시한다. 채널 전환 UI, API에 있는 Trend 상대지수의 화면 표시, 알려진 네이버 URL 별칭 정규화는 별도 보완 대상이다.
3. **P2 규모 검증**: 대량 누적 데이터에서 추천별 DB 조회 비용과 긴 목록 페이지 처리를 부하 테스트해야 한다. 1,000행 가져오기 상한 검증은 대량 누적 성능 보장이 아니다.
4. **개발 도구 정리**: Starlette TestClient의 httpx deprecation 경고 1건. 기존 Dev Lesson은 미추적 durable reference로 `LESSON_CORPUS_INVALID` 상태이며 임의 stage/승격하지 않았다.

자동 검사 통과는 사실 정확성·네이버 최신 DOM·실계정 집계 형식의 완전한 보장이 아니다.
