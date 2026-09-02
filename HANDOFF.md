# HANDOFF — Naver Content OS

- 작성 시각: `2026-09-03 06:21 KST`
- 저장소: `coreline-ai/naver-contents-os`
- 브랜치/기준 커밋: `main` / `f7ad2a9`
상태: **구현·자동 검증·실 API 스모크 완료, Chrome 확장 수동 UI 스모크만 남음**

이 문서는 현재 작업 트리를 다른 개발자 또는 에이전트가 바로 이어받기 위한 인계 문서다.

## 1. 프로젝트 개요

Naver Content OS는 키워드 조사부터 콘텐츠 기획, 초안 생성, SmartEditor 임시저장까지 연결하는 로컬 우선 도구다.

기본 흐름:

1. 키워드 교정 및 민감도 사전 확인
2. SearchAd·NAVER API HUB 기반 검색량/트렌드/검색 결과 수집
3. Opportunity Score·연관 키워드·Research Workspace 분석
4. 15편 콘텐츠 플랜 및 LLM/구조 초안 생성
5. 사용자가 검토한 최신 Draft를 SmartEditor에 **임시저장**

프로젝트의 안전 경계:

- 자동 공개 발행은 하지 않는다.
- SearchAd 계정 캠페인 데이터는 조회 전용이며 생성·수정·삭제하지 않는다.
- `.env`, Local Core token, SQLite DB, API Secret은 커밋하지 않는다.
- 실제 민감 키워드로 판별된 경우 AI 초안은 계속 차단한다.

## 2. 이번 작업의 핵심 결과

현재 개발 계획: [dev-plan/implement_20260902_222543.md](dev-plan/implement_20260902_222543.md)

### 2.1 입력 중 연관 키워드 추천

- 입력 즉시 Extension storage의 최근 키워드를 먼저 표시한다.
- 한글/CJK 2자 또는 기타 문자 3자부터 `700ms` debounce 후 SearchAd 추천을 합친다.
- 최대 8개, 정규화 중복 제거, 단일 in-flight 요청, 늦은 응답 차단을 적용했다.
- Arrow Up/Down, Enter, Escape와 ARIA combobox를 지원한다.
- 추천 클릭 또는 Enter는 기존 키워드 분석을 정확히 한 번 실행한다.

### 2.2 사이드패널 상단 탐색 카드

- 키워드 입력창 바로 아래에 `연관 키워드 | 급상승 키워드` 탭을 추가했다.
- 연관 키워드 Top 8을 Opportunity Score보다 먼저 보여준다.
- 일반·지역·쇼핑·뉴스 모드별 급상승 후보를 수집할 수 있다.
- 후보 클릭 시 해당 키워드로 즉시 재분석한다.

### 2.3 급상승 후보와 `freshness-v1`

- KST 기준 오늘을 제외한 완료된 14일을 사용한다.
- 최근 7일과 이전 7일의 같은 상대지수 series를 비교한다.
- 방향은 `new | rising | steady | falling | insufficient`이다.
- 각 구간 6일 이상, 전체 12일 이상 관측된 경우에만 수치 비교한다.
- 누락일이나 공급자 실패는 0으로 채우지 않고 `null/부분 데이터/계산 불가`로 유지한다.
- News 최신순 최대 100건에서 최근 7일 링크를 중복 제거해 기사 **표본**을 계산한다.
- 점수 가중치는 일반·지역 65:35, 쇼핑 70:30, 뉴스 35:65다.
- 다른 요청의 Trend ratio를 절대 검색량처럼 비교하면 안 된다.
- 결과는 입력 주제 기반 후보이며 NAVER 공식 실시간 인기 검색어 순위가 아니다.

### 2.4 Research Workspace

- 내비게이션에 `급상승` 화면을 추가했다.
- 일반·지역·쇼핑·뉴스 입력 조건과 모드별 validation을 구현했다.
- 최근/이전 7일 평균, 방향, 상승률, 뉴스 표본, 최신성 점수, 신뢰도, 공급자 상태를 표시한다.
- 후보 클릭 시 `/v1/keywords/analyze`로 분석하고 새 snapshot으로 키워드 맵 화면을 갱신한다.

### 2.5 API와 저장

추가된 API:

| Method | Endpoint | 역할 |
|---|---|---|
| `POST` | `/v1/keywords/suggest` | SearchAd 기반 연관 키워드 최대 8개 |
| `POST` | `/v1/research/rising` | 모드별 급상승 후보 수집·계산·저장 |
| `GET` | `/v1/research/rising/latest` | 같은 조건의 마지막 저장 run 조회 |

모든 `/v1/*` 요청에는 `X-Local-Token`이 필요하다.

급상승 요청 예시:

```json
{
  "seed": "러닝화",
  "mode": "general",
  "region": "",
  "category": "",
  "candidate_limit": 5,
  "force_refresh": false
}
```

모드 입력 규칙:

| 모드 | 필수값 | 추세 소스 |
|---|---|---|
| `general` | `seed` | Search Trend |
| `local` | `region`, 선택 `seed` | Search Trend |
| `shopping` | `seed`, `category` code | Shopping Insight |
| `news` | `seed` | Search Trend + News |

호출/캐시 정책:

- 후보 최대 20개, 5개 단위 추세 batch, News 상위 최대 5개
- 1회 수집의 실제 외부 호출은 최대 10회
- SearchAd 추천 cache 24시간
- 일 단위 Trend/Shopping cache 6시간
- News 최신순 cache 15분
- `force_refresh`는 사용자가 `최신 수집`을 명시적으로 누른 경우에만 사용

저장:

- `DiscoveryRun` 테이블과 Alembic revision `d73a91c5e4f2`를 추가했다.
- 현재 로컬 `data/ncos.db`의 revision은 `d73a91c5e4f2`이며 저장된 discovery run은 1건이다.
- Secret, 인증 header, 기사 전문, 공급자 원문 전체는 저장하지 않는다.

### 2.6 함께 들어 있는 이전 미커밋 개선

현재 작업 트리에는 이번 급상승 기능 이전에 시작한 다음 변경도 함께 있다.

- 8개 BlogType 모두 AI 초안 생성 활성화
- Ollama timeout 600초, `think: false`, `num_ctx: 4096`, `num_predict: 2048`
- 민감도 API가 응답하지 않은 `unknown` 상태에서도 사용자 설정으로 AI 초안 사용 가능
- 해당 설정의 기본값은 허용이며 Extension storage에 저장
- 실제 민감 판정 `true`는 사용자 설정과 무관하게 계속 차단

이 변경을 급상승 기능과 분리해 커밋하려면 `App.tsx`, `README.md`, `app-state.test.tsx`는 `git add -p`로 hunk 분리가 필요하다.

## 3. 주요 변경 파일

| 영역 | 파일 | 책임 |
|---|---|---|
| 계약 | `packages/contracts/src/index.ts` | suggestion/rising/freshness TypeScript 계약 |
| Core client | `apps/extension/lib/core.ts` | 추천·급상승 API 및 AbortSignal |
| 최근 키워드 | `apps/extension/lib/recent-keywords.ts` | local-first 최근 키워드 저장/검색 |
| 사이드패널 | `apps/extension/entrypoints/sidepanel/App.tsx` | 자동완성, 상단 탭, 빠른 재분석, 민감도 설정 |
| Workspace | `apps/extension/entrypoints/research/App.tsx` | 급상승 화면·모드·결과 표·재분석 |
| API | `apps/local-core/app/api.py` | 요청 모델·validation·endpoint |
| Research | `apps/local-core/app/services/research.py` | 후보 수집, batch, 부분 실패, run 저장 |
| 점수 계산 | `apps/local-core/app/services/freshness.py` | 날짜 창·추세·뉴스·점수 순수 함수 |
| DB 모델 | `apps/local-core/app/models_db.py` | `DiscoveryRun` 모델 |
| Migration | `alembic/versions/d73a91c5e4f2_keyword_discovery_runs.py` | `discovery_runs` 테이블 |
| HUB provider | `python/providers/naver_hub/client.py` | 정확한 날짜 범위와 News 최신순 수집 |
| LLM | `python/providers/llm/ollama.py` | Qwen3/Ollama 생성 옵션 |
| Planner | `python/planner/templates.py` | 8개 BlogType 생성 활성화 |
| 문서 | `README.md`, `docs/12_api_contracts_and_smoke_tests.md` | 실행법·의미·API·검증 계약 |

테스트 변경:

- `tests/unit/test_freshness.py`
- `tests/unit/test_hub_client.py`
- `tests/unit/test_research_service.py`
- `tests/integration/test_research_api.py`
- `apps/extension/tests/app-state.test.tsx`
- `apps/extension/tests/components.test.tsx`
- `apps/extension/tests/research.test.tsx`
- 기존 Draft/Planner/Ollama 관련 unit/integration 테스트

## 4. 현재 Git 상태

- 브랜치: `main`
- 기준 커밋: `f7ad2a9`
- remote: `origin https://github.com/coreline-ai/naver-contents-os.git`
- 커밋 생성 안 됨
- 작업 트리는 dirty 상태이며 이 문서 갱신도 포함된다.

이번 기능에서 새로 생긴 미추적 파일:

```text
alembic/versions/d73a91c5e4f2_keyword_discovery_runs.py
apps/extension/lib/recent-keywords.ts
apps/local-core/app/services/freshness.py
dev-plan/implement_20260902_222543.md
tests/unit/test_freshness.py
```

기능 시작 전부터 수정되어 있던 파일:

```text
README.md                                      # 이후 이번 기능 문서도 추가됨
apps/extension/entrypoints/sidepanel/App.tsx   # 이후 이번 기능 UI도 추가됨
apps/extension/lib/settings.ts
apps/extension/tests/app-state.test.tsx        # 이후 이번 기능 테스트도 추가됨
apps/local-core/app/services/drafts.py
python/planner/templates.py
python/providers/llm/ollama.py
tests/integration/test_drafts_service.py
tests/unit/test_planner.py
tests/unit/test_templates_llm.py
```

주의: 위 변경을 되돌리거나 `git reset --hard`로 정리하지 말고, 먼저 `git diff`와 개발 계획을 확인한다.

## 5. 검증 결과

| 검증 | 결과 |
|---|---|
| Python 전체 non-live | `159 passed, 4 deselected, 1 warning` |
| Extension Vitest | `32 passed` / 6 files |
| TypeScript | `pnpm typecheck` 통과 |
| Extension production build | `pnpm build:ext` 통과, 총 `331.07KB` |
| Build 산출물 | `apps/extension/.output/chrome-mv3/manifest.json` 존재 |
| Alembic | 임시 DB full upgrade 및 로컬 DB revision `d73a91c5e4f2` 확인 |
| Python compile | 관련 모듈 `compileall` 통과 |
| Whitespace | `git diff --check` 통과 |
| Runtime 추적 검사 | `scripts/check_no_tracked_runtime.sh` 통과 |

실 API 스모크:

- `POST /v1/keywords/suggest`: `러닝화`, limit 3 → `status=ok`, SearchAd 추천 반환
- `POST /v1/research/rising`: general/`러닝화`, 후보 5개 → `status=ok`
- 수집 기간: `2026-08-20` ~ `2026-09-02`, 최근 구간 시작 `2026-08-27`
- 예상/실제 외부 호출: `7/7`, 최대 10회 이내
- SearchAd/Trend/News 상태 모두 `ok`

검증 환경 참고:

- `./scripts/verify_all.sh`는 sandbox에서 사용자 `uv` cache 접근이 거부돼 중단됐다.
- 같은 단계를 프로젝트 `.venv`로 직접 실행했고 전부 통과했다. 코드 실패는 아니다.

## 6. 현재 런타임 상태와 실행 방법

작성 시점 기준:

- Local Core `127.0.0.1:3719`: **미기동** (`LISTEN` 없음)
- Extension production 산출물: **생성됨**
- Local DB migration: **적용됨**
- Local token 파일: **존재**, 권한 `600`

### Local Core 시작

```bash
cd /Volumes/Eprojects/project_202609/naver-content-os
uv run uvicorn app.main:app \
  --app-dir apps/local-core \
  --host 127.0.0.1 \
  --port 3719
```

상태 확인:

```bash
curl -sS http://127.0.0.1:3719/health
```

### Extension 재빌드

```bash
cd /Volumes/Eprojects/project_202609/naver-content-os
pnpm build:ext
```

Chrome에서 로드할 절대 경로:

```text
/Volumes/Eprojects/project_202609/naver-content-os/apps/extension/.output/chrome-mv3
```

처음 로드하는 경우 사이드패널 설정의 `Local Core 토큰`에 아래 파일의 **내용**을 입력한다. 파일 경로 자체를 입력하면 안 된다.

```text
/Volumes/Eprojects/project_202609/naver-content-os/data/local_core_token.txt
```

## 7. 반드시 남은 수동 작업

브라우저 자동화 도구는 정책상 `chrome://extensions` 내부 페이지를 열 수 없어 확장 reload와 육안 검증을 완료하지 못했다.

수동 절차:

1. Chrome 주소창에서 `chrome://extensions`를 연다.
2. `Naver Content OS` 카드의 새로고침 아이콘을 누른다.
3. 네이버 페이지에서 확장 사이드패널을 다시 연다.
4. `러닝화`를 입력하고 700ms 후 연관 추천이 나오는지 확인한다.
5. 분석 후 `연관 키워드` Top 8 카드가 점수 카드보다 위에 나오는지 확인한다.
6. `급상승 키워드` 탭에서 `최신 수집`을 눌러 후보·상승률·최신성 점수를 확인한다.
7. Research Workspace를 열고 일반·지역·쇼핑·뉴스 모드 입력 validation과 결과 표를 확인한다.
8. 후보를 눌렀을 때 해당 키워드 분석이 한 번 실행되고 새 결과로 이동하는지 확인한다.
9. 430px 폭에서 dropdown·상단 카드·버튼이 잘리거나 본문을 가리지 않는지 확인한다.

통과 후 현재 계획의 다음 두 체크박스를 완료 처리하면 된다.

- Phase 6 `Chrome unpacked extension 산출물과 실제 화면 확인`
- Phase 6 완료 조건 `계획 종료 가능`

## 8. 알려진 제약과 주의점

- 급상승 화면은 전역 실시간 검색어 순위가 아니라 입력 seed 기반 후보 탐색이다.
- News 수치는 최신순 최대 100건 표본이며 전체 기사 발생량이 아니다.
- Search Trend/Shopping ratio는 요청 범위별 상대값이다.
- SearchAd의 `< 10`은 0이 아니라 마스킹된 값이다.
- 공급자 실패·관측 부족은 거짓 0점으로 대체하지 않는다.
- 자동 수집 스케줄러와 백그라운드 갱신은 구현하지 않았다.
- `force_refresh`는 쿼터를 사용하므로 사용자 동작에만 연결한다.
- 자동 공개 발행, 이미지 업로드, 댓글/공감, 다계정 자동화는 범위 밖이다.

재사용할 Dev Lessons:

1. API HUB 검색 응답은 JSON이어도 `Content-Type: text/plain`일 수 있으므로 본문 파싱을 우선한다.
2. SearchAd `/keywordstool` hint는 공백을 제거한 정규화 문자열로 보내야 한다.

## 9. 다음 작업 권장 순서

1. Local Core를 시작한다.
2. Chrome 확장을 reload한다.
3. 위 수동 UI smoke를 완료한다.
4. `dev-plan/implement_20260902_222543.md`의 Phase 6를 닫는다.
5. `git diff`, `git diff --check`, 전체 검증을 한 번 더 확인한다.
6. Draft/LLM 개선과 연관·급상승 기능을 논리적인 커밋으로 분리한다.
7. SmartEditor 임시저장 실DOM smoke는 별도 작업으로 수행한다.

권장 재검증 명령:

```bash
cd /Volumes/Eprojects/project_202609/naver-content-os
PYTHONPATH=apps/local-core:python .venv/bin/pytest -q
pnpm test:ext
pnpm typecheck
pnpm build:ext
git diff --check
bash scripts/check_no_tracked_runtime.sh
```

## 10. 참고 문서

- [README.md](README.md)
- [문서 인덱스](docs/INDEX.md)
- [API 계약·스모크 테스트](docs/12_api_contracts_and_smoke_tests.md)
- [연관 추천·급상승 개발 계획](dev-plan/implement_20260902_222543.md)
- [Research Workspace Phase 1~8 계획](dev-plan/implement_20260902_133257.md)
- [P0/P1 잔여 구현 계획](dev-plan/implement_20260902_112824.md)
- [로컬 환경·보안](docs/11_local_environment_and_security.md)
