# Naver Content OS

네이버 키워드 조사에서 콘텐츠 기획·초안 생성·SmartEditor 임시저장까지 연결하는 **로컬 우선 개발형 MVP**입니다.

자동 공개 발행은 하지 않습니다. SmartEditor 입력은 Health Check와 저장 성공 신호를 모두 통과해야 하며, 최종 검토와 발행은 사용자가 수행합니다.

## 현재 구현

- NAVER API HUB: Blog/Cafe/지식iN/Web/News 검색과 Search Trend
- NAVER SearchAd: `/keywordstool` 검색량·연관 키워드
- TTL cache, quota guard, 429 backoff, source provenance
- Opportunity Score v1, 질문 추출, cluster, 15편 plan
- WXT/React 사이드패널: 분석, SERP 첨부, Blog Inspector, 초안 생성
- Draft REST API, 버전 이력, snapshot·prompt·provider lineage
- Ollama·OpenAI 호환 provider와 LLM 없는 skeleton 초안
- SmartEditor title/body/tag 입력과 **임시저장 전용** Job
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

## SmartEditor 임시저장 준비

Chrome 136+에서는 기본 Chrome profile에 remote debugging을 사용할 수 없습니다. 전용 profile을 실행합니다.

```bash
./scripts/start_chrome_automation.sh
```

열린 별도 Chrome 창에서 네이버에 한 번 로그인한 뒤 실행합니다.

```bash
uv run python scripts/run_publish.py \
  --keyword "키워드" \
  --blog-id "내블로그ID" \
  --tags "태그1,태그2" \
  --no-llm
```

`--order`를 생략하면 첫 번째 LLM 생성 가능 plan item을 선택합니다. 이 명령은 공개 발행하지 않고 임시저장까지만 시도합니다.

## 검증

```bash
./scripts/verify_all.sh          # local unit/integration/type/build
./scripts/verify_all.sh --live   # NAVER API smoke 포함
```

기본 검증은 외부 API, Ollama, Codex proxy, Chrome, SmartEditor를 호출하지 않습니다. 현재 기준으로 Python non-live 117개와 Extension 13개 테스트가 통과합니다.

## 주요 문서

- [문서 인덱스](./docs/INDEX.md)
- [구현 전문가 분석](./docs/14_implementation_expert_review.md)
- [현재 안정화 개발 계획](./dev-plan/implement_20260902_095019.md)
