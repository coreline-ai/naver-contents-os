# HANDOFF — 네이버 콘텐츠 운영 OS

작성일: `2026-09-02` · 기준 커밋: `26af3e5` (main) · 테스트: pytest 112 + vitest 10 전부 통과

이 문서 하나로 다른 개발자/에이전트가 이어서 작업할 수 있도록 프로젝트 전체 상태를 정리한다.

## 1. 프로젝트가 무엇인가

키워드 하나를 입력하면 **검색량·트렌드·경쟁 규모 수집 → Opportunity Score → 15편 콘텐츠 플랜 → LLM 초안 → SmartEditor 임시저장**까지 이어지는 로컬 우선 파이프라인. 자동 공개 발행은 하지 않는다 — **최종 발행은 항상 사람이 결정** (프로젝트 전체의 제1원칙).

- 설계 문서: [docs/INDEX.md](docs/INDEX.md) (01~13, 특히 [13 착수 체크리스트](docs/13_development_kickoff_checklist.md))
- 개발 이력: [dev-plan/implement_20260901_205331.md](dev-plan/implement_20260901_205331.md) (V1, Phase 1~6 완료) · [dev-plan/implement_20260901_222443.md](dev-plan/implement_20260901_222443.md) (V2 LLM, 완료)

## 2. 저장소 구조

```
apps/local-core/app/    FastAPI Local Core (127.0.0.1:3719) — 인증·분석·초안 API, alembic 자동 적용
apps/extension/         WXT + React 19 사이드패널 확장 (SERP/Blog 파서 content script 포함)
packages/contracts/     확장↔코어 공유 TypeScript 타입
python/providers/       외부 데이터: naver_hub(검색 5채널+트렌드), searchad(검색량), llm(Ollama/OpenAI호환), gateway(캐시·429·quota)
python/intelligence/    Opportunity Score v1, 질문 추출, bigram 클러스터
python/planner/         15편 플래너, BlogType 8종 템플릿(HOWTO/POLICY/REVIEW 생성 활성)
python/publisher/       SmartEditor 자동화: selectors(중앙 관리), health(7게이트), editor, jobs(상태기계), browser(CDP)
scripts/                verify_api_hub.py, verify_searchad.py, run_publish.py (E2E 러너)
tests/                  unit / integration / smoke(-m smoke, 실호출) / fixtures
docs/dev-lessons/       재사용 교훈 2건 (아래 §6)
data/                   런타임 SQLite(ncos.db)·로컬 토큰 (gitignore)
```

## 3. 실행 방법

```bash
# 준비 (1회)
uv sync && pnpm install

# Local Core 서버 (기동 시 alembic upgrade 자동)
uv run uvicorn app.main:app --app-dir apps/local-core --host 127.0.0.1 --port 3719

# 확장 빌드 → Chrome 확장 개발자 모드에서 apps/extension/.output/chrome-mv3 로드
pnpm build:ext

# 테스트
uv run pytest -q                 # unit+integration (smoke 제외)
uv run pytest -m smoke tests/smoke  # 실호출 (자격증명 필요, 쿼터 소모)
pnpm --filter extension test     # vitest 파서 회귀

# E2E: 초안 생성 → SmartEditor 임시저장 (Chrome을 --remote-debugging-port=9222로 실행, 네이버 로그인 상태)
uv run python scripts/run_publish.py --keyword "애드포스트 승인" --blog-id <내블로그ID> [--no-llm] [--dry-run]
```

- API 인증: 모든 `/v1/*`는 `X-Local-Token` 헤더 필요. 토큰은 `.env`의 `LOCAL_CORE_TOKEN` 또는 자동 생성된 `data/local_core_token.txt`. 확장 사이드패널 설정에 붙여넣는다.
- CORS는 `chrome-extension://` Origin만 허용.

## 4. 환경변수 (.env — 커밋 금지, 계약은 [.env.example](.env.example))

| 그룹 | 키 | 상태 |
|---|---|---|
| API HUB | `NAVER_HUB_CLIENT_ID/SECRET` | 설정됨, 실호출 검증됨 |
| SearchAd | `NAVER_SEARCHAD_API_KEY/SECRET_KEY/CUSTOMER_ID` | 설정됨, 실호출 검증됨 |
| LLM | `LLM_PROVIDER=local\|openai_compat` + `OLLAMA_*` / `OPENAI_COMPAT_*` / `CODEX_PROXY_*` | 기본 local. §5 참조 |
| Core | `LOCAL_CORE_HOST/PORT/TOKEN` | 기본 127.0.0.1:3719 |

금지: `NAVER_ID/PASSWORD` (브라우저 세션만 사용). 보안 규칙 10개: [docs/11](docs/11_local_environment_and_security.md).

## 5. LLM 경로 (V2, 실검증 완료)

- **local (기본)**: Ollama. 현재 이 PC에 모델 미설치 → `ollama pull <model>` 필요. 미설치 시 `--no-llm` 스켈레톤 경로 사용 가능.
- **openai_compat**: ChatGPT 구독을 Codex OAuth 프록시로 사용 (API 키 불필요). 이 PC에 `codex login` 완료 상태(`~/.codex/auth.json` 존재).
  ```dotenv
  LLM_PROVIDER=openai_compat
  CODEX_PROXY_AUTOSTART=true    # Local Core가 npx 프록시 자동 기동·정리
  OPENAI_COMPAT_MODEL=gpt-5.4   # 비우면 첫 모델 자동
  ```
  2026-09-01 실검증: `npx -y @thkdog/codex-openai-proxy` → gpt-5.4 계열 4모델 노출, gpt-5.4-mini로 3,682자 초안 생성(draft_id=2). 401 발생 시 `codex login` 재로그인. 비공식 경로(자기 계정·자기 책임) — [docs/10 "LLM 경로"](docs/10_api_and_account_setup.md) 참조.
- 프롬프트 외부 전송은 `openai_compat` **명시 설정 시에만** 발생. 코드 진입점: `python/providers/llm/factory.py::build_llm_provider`.

## 6. 반드시 알아야 할 함정 (Dev Lessons — `docs/dev-lessons/`)

1. **HUB 검색 API는 JSON을 `Content-Type: text/plain`으로 반환** — content-type을 절대 신뢰하지 말고 본문 파싱. (DL-…42b6f755, 회귀 테스트 있음)
2. **SearchAd keywordstool은 공백 포함 키워드를 4xx로 거부** — 클라이언트가 공백 제거 후 전송. (DL-…c0f87a11)

기타: SearchAd 검색량 `"< 10"`은 0이 아닌 masked/missing으로 처리. Trend `ratio`는 상대값(절대 검색량 아님). API 한도는 하드코딩 금지 — Gateway가 자체 월한도(설정값)로 차단·80% 경고. 새 계획 작성 시 `dev-plan` 스킬의 `dev_lesson.py find`로 교훈 검색부터.

## 7. 남은 작업 (사람 손 필요)

| 우선 | 항목 | 방법 |
|---|---|---|
| 1 | 확장 실브라우저 육안 확인 | `pnpm build:ext` → 확장 로드 → 토큰 입력 → 네이버 검색 페이지에서 "현재 검색어 가져오기"·분석 표시 확인 |
| 2 | SmartEditor 임시저장 실검증 | Chrome `--remote-debugging-port=9222` + `run_publish.py`. **selector는 실DOM 미검증 추정값** — health check가 실패 항목을 알려주면 [python/publisher/selectors.py](python/publisher/selectors.py) 보정 (게이트가 있어 오입력 위험 없음) |
| 3 | API HUB 콘솔 한도·알림 | `Application → 한도 및 알림`에서 일·월 한도 + 통보 대상자 등록 |
| 4 | (선택) Ollama 모델 설치 | 로컬 LLM 초안용 `ollama pull <model>` |

V2.1 후보(계획 문서 잔여 리스크 참조): 스트리밍 표시, 본문 길이 미달 이어쓰기, 사이드패널 초안 생성 UI, Whale 지원, CI + fixture 회귀 게이트.

## 8. 협업 시 주의

- 병행 세션이 존재했음: 품질 보강(Gateway 결과 객체화, 스키마 검증, NFKC 정규화, 초안 REST API `/v1/drafts`)이 `3dfd023`에 커밋됨. **파일 수정 전 최신 상태를 다시 읽을 것.**
- 커밋 규칙: Phase/작업 단위 커밋, `.env`·`data/`는 절대 커밋 금지 (커밋 전 `git ls-files | grep -x .env` 확인 습관).
- 계획 문서의 체크박스는 실제 진행과 일치시켜야 함 (dev-plan 스킬 규칙).
