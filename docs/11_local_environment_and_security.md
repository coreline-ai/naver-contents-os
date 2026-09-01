# 11. 로컬 개발 환경·보안 준비

점검일: **2026-09-01**

## 현재 PC 점검 결과

민감한 값은 읽거나 출력하지 않고 환경변수 키의 존재 여부만 확인했습니다.

| 항목 | 현재 상태 | 판정 |
|---|---|---:|
| Node.js | `v24.13.1` | 준비됨 |
| pnpm | `11.13.1` | 준비됨 |
| Python 기본 | `3.14.6` | 프로젝트용 3.12 별도 필요 |
| `uv` | `0.9.30` | 준비됨 |
| Git | `2.50.1` | 설치됨 |
| Git 저장소 | 미초기화 | 작업 필요 |
| SQLite | `3.51.0` | 준비됨 |
| Ollama | `0.20.4` | 선택 기능 준비됨 |
| Google Chrome | 설치됨 | 준비됨 |
| NAVER Whale | 미설치 | 선택 사항 |
| API HUB Client ID | `.env`에 설정됨 | 호출 검증 필요 |
| API HUB Client Secret | `.env`에 설정됨 | 호출 검증 필요 |
| SearchAd 3개 값 | `.env`에 없음 | 개발 차단 요소 |
| 실행 코드·패키지 설정 | 없음 | 스캐폴딩 필요 |

## 권장 런타임 고정

### Node

Node 24 LTS를 기준으로 사용합니다. 현재 설치 버전이 조건을 만족합니다.

```json
{
  "engines": { "node": ">=24 <25" },
  "packageManager": "pnpm@11.13.1"
}
```

### Python

시스템 Python 3.14와 분리해 Python 3.12를 설치하고 `.venv`를 만듭니다.

```bash
uv python install 3.12
uv venv --python 3.12
```

프로젝트에 `.python-version`과 `uv.lock`을 커밋하고 `.venv`는 커밋하지 않습니다.

## 환경변수 계약

실제 값은 `.env`에만 저장하고 저장소에는 값이 비어 있는 `.env.example`만 커밋합니다.

```dotenv
NAVER_HUB_CLIENT_ID=
NAVER_HUB_CLIENT_SECRET=

NAVER_SEARCHAD_API_KEY=
NAVER_SEARCHAD_SECRET_KEY=
NAVER_SEARCHAD_CUSTOMER_ID=

LLM_PROVIDER=local
OLLAMA_BASE_URL=http://127.0.0.1:11434

LOCAL_CORE_HOST=127.0.0.1
LOCAL_CORE_PORT=3719
LOCAL_CORE_TOKEN=
```

금지 항목:

```dotenv
NAVER_ID=
NAVER_PASSWORD=
```

네이버 계정 인증은 사용자가 브라우저에서 직접 완료한 세션을 사용합니다.

## Secret 경계

```text
Chrome/Whale Extension
  - API Secret 없음
  - 현재 탭 DOM 읽기
  - localhost 요청
          │
          ▼
Local Core: 127.0.0.1:3719
  - API HUB Secret
  - SearchAd Secret
  - 캐시/DB/점수 계산
          │
          ├─ NAVER API HUB
          └─ NAVER SearchAd
```

필수 보안 규칙:

1. FastAPI는 기본적으로 `127.0.0.1`에만 bind.
2. CORS는 개발 중에도 `*`를 쓰지 않고 허용 Extension Origin만 등록.
3. 확장 프로그램과 Local Core 사이에 무작위 `LOCAL_CORE_TOKEN` 사용.
4. Secret, Authorization header, 전체 API 응답을 로그에 남기지 않음.
5. 오류 로그는 키 앞 4자리조차 표시하지 않고 설정 여부만 기록.
6. API 응답 fixture를 저장하기 전 URL·블로그 ID 등 개인정보성 필드 검토.
7. `.env`, DB, 스크린샷, 사용자 콘텐츠를 원격 분석 서비스로 자동 전송하지 않음.
8. SmartEditor는 임시저장까지만 자동화하고 공개 발행은 사용자 확인 후 수행.

## 브라우저 준비

V1의 기준 브라우저는 현재 설치된 Chrome으로 잡습니다. Whale은 호환성 테스트 단계에서 추가합니다.

최소 수동 준비:

- Chrome에서 네이버 로그인 완료
- 네이버 검색 결과 페이지 접근 가능
- 본인 블로그 글쓰기 및 임시저장 가능
- 확장 프로그램 개발자 모드 사용 가능
- 테스트용 임시 글과 테스트용 블로그 계정 범위 확정

브라우저 로그인 쿠키·비밀번호를 Python이나 Extension storage로 복사하지 않습니다.

## 개발 시작 전에 추가할 저장소 파일

```text
package.json
pnpm-workspace.yaml
pyproject.toml
uv.lock
.python-version
.env.example
README.md
apps/extension/
apps/local-core/
packages/contracts/
tests/fixtures/
```

현재 `.gitignore`에는 `.env`, Node build 결과, `.DS_Store`가 포함되어 있습니다. 추가로 `.venv/`, Python cache, SQLite runtime DB, Playwright 결과물을 제외해야 합니다.

## 지금 막혀 있는 항목

1. SearchAd API Key·Secret Key·Customer ID 미설정
2. API HUB 키의 실제 호출 성공 여부 미검증
3. API HUB Application의 선택 API 목록 미확인
4. Python 3.12 프로젝트 환경 미생성
5. Git 저장소 및 코드 스캐폴드 미생성

위 항목을 해결하면 API 클라이언트 구현에 바로 들어갈 수 있습니다.
