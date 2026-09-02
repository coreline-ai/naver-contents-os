# Naver Content OS

네이버 키워드 조사에서 콘텐츠 기획·초안 생성·SmartEditor 임시저장까지 연결하는 **로컬 우선 개발형 MVP**입니다.

자동 공개 발행은 하지 않습니다. SmartEditor 입력은 Health Check와 저장 성공 신호를 모두 통과해야 하며, 최종 검토와 발행은 사용자가 수행합니다.

## 현재 구현

- NAVER API HUB: Blog/Cafe/지식iN/Web/News 검색과 Search Trend
- NAVER SearchAd: `/keywordstool` 검색량·연관 키워드
- TTL cache, 원자적 일·월 quota guard, provider별 RPS, `Retry-After`, source provenance
- Opportunity Score v1 + coverage/confidence, 질문 추출, cluster, 15편 plan
- WXT/React 사이드패널: PC·모바일 검색량, 연관 키워드, 상대 Trend, cluster, API HUB/Browser SERP 근거, Blog Inspector
- Draft REST API, 버전 이력, snapshot·prompt·provider lineage
- 사이드패널 Draft 제목·본문 편집, 새 버전 저장, 최신 버전 Publisher Job 연결·상태 조회
- Ollama·OpenAI 호환 provider와 LLM 없는 skeleton 초안
- SmartEditor title/body/tag 입력과 **임시저장 전용** Job, 독립 저장 신호 2개와 실패 증거
- Secret 없는 non-live 검증 GitHub Actions

이미지 업로드·자동 공개·댓글·공감·다계정 자동화는 현재 범위에 포함되지 않습니다.

## 요구 환경

- Node.js 24
- pnpm 11.13.1
- Python 3.12 (`uv` 사용)
- Chrome
- 선택: Ollama와 설치된 local model

## 설치

```bash
uv sync
pnpm install
cp .env.example .env  # 최초 1회, 실제 인증값은 .env에만 입력
```

필수 환경변수는 `.env.example`을 참고합니다. `.env`, Local Core token, SQLite DB는 Git에서 제외됩니다.

## Local Core 실행

```bash
uv run uvicorn app.main:app \
  --app-dir apps/local-core \
  --host 127.0.0.1 \
  --port 3719
```

앱 시작 시 migration이 적용되고 `data/local_core_token.txt`가 권한 `600`으로 생성됩니다.

## Extension 실행

```bash
pnpm build:ext
```

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 개발자 모드를 활성화합니다.
3. **압축해제된 확장 프로그램 로드**에서 `apps/extension/.output/chrome-mv3`를 선택합니다.
4. 사이드패널 설정에 `data/local_core_token.txt` 값을 입력합니다.

## 초안 API

사이드패널의 15편 plan에서 다음 기능을 사용할 수 있습니다.

- `구조 초안`: 모든 BlogType의 section skeleton 생성
- `AI 초안`: `HOWTO`, `POLICY`, `REVIEW`만 지원

AI 초안을 사용하려면 먼저 model을 설치합니다.

```bash
ollama pull qwen3:8b
```

원하는 model은 `.env`의 `OLLAMA_MODEL`로 고정할 수 있습니다.

`LLM_PROVIDER=openai_compat` 경로는 명시적으로 설정한 경우에만 사용됩니다. 설정과 데이터 외부 전송 주의사항은 [API 및 계정 설정](./docs/10_api_and_account_setup.md)을 확인하세요.

생성된 초안은 사이드패널에서 제목·본문을 수정한 뒤 `새 버전 저장`으로 append할 수 있습니다. 기존 버전은 덮어쓰지 않습니다.

## SmartEditor 임시저장 준비

Chrome 136+에서는 기본 Chrome profile에 remote debugging을 사용할 수 없습니다. 전용 profile을 실행합니다.

```bash
./scripts/start_chrome_automation.sh
```

열린 별도 Chrome 창에서 네이버에 한 번 로그인합니다. 이후 사이드패널에서 다음 순서로 실행할 수 있습니다.

1. 콘텐츠 플랜에서 구조/AI 초안을 생성합니다.
2. 필요한 내용을 편집하고 `새 버전 저장`으로 최신 버전을 확정합니다.
3. 네이버 blog ID와 tags를 입력하고 `최신 버전 임시저장 시작`을 누릅니다.
4. 확인 대화상자에 동의한 뒤 Job 상태가 `draft_saved` 또는 `failed`로 끝나는지 확인합니다.

Publisher API는 `POST /v1/drafts/{draft_id}/publish-jobs`로 지정 Draft의 최신 버전만 시작하며 `GET /v1/publish-jobs/{job_id}`로 상태를 조회합니다. 요청·응답에 본문이나 API Secret을 포함하지 않습니다.

CLI 경로도 유지됩니다.

```bash
uv run python scripts/run_publish.py \
  --keyword "키워드" \
  --blog-id "내블로그ID" \
  --tags "태그1,태그2" \
  --no-llm
```

`--order`를 생략하면 첫 번째 LLM 생성 가능 plan item을 선택합니다. UI와 CLI 모두 공개 발행하지 않고 임시저장까지만 시도합니다. 저장 완료 알림과 별도의 저장 상태 DOM 변화가 함께 확인되지 않으면 Job은 실패합니다. 입력영역·프로필을 마스킹한 실패 증거는 Git에서 제외된 `data/publisher-artifacts/`에 저장됩니다.

## 검증

```bash
./scripts/verify_all.sh          # local unit/integration/type/build
./scripts/verify_all.sh --live   # NAVER API smoke 포함
```

기본 검증은 외부 API, Ollama, Codex proxy, Chrome, SmartEditor를 호출하지 않습니다. 현재 기준으로 Python non-live 136개와 Extension 23개, 총 159개 테스트가 통과합니다.

## 주요 문서

- [문서 인덱스](./docs/INDEX.md)
- [구현 전문가 분석](./docs/14_implementation_expert_review.md)
- [P0/P1 잔여 구현 계획](./dev-plan/implement_20260902_112824.md)
