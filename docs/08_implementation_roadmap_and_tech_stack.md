# 08. 구현 우선순위·로드맵·기술 스택

## 0) 제거/재편 우선순위
1. `.env` 기반 네이버 자동 로그인 제거
2. Search API 인증을 **NAVER API HUB**로 교체
3. `customtkinter` 제거, 웹/확장 중심 UI로 통일
4. 고정 글 구조에서 유형별 템플릿/BlogType 전환
5. 상태 DB 도입 및 Job state 도입
6. selector health check + 자동 중단 가드

## 권장 기술 스택(최종 제안)

| 영역 | 추천 |
|---|---|
| Browser Extension | WXT + TypeScript |
| UI | React 19 |
| UI 컴포넌트 | Tailwind CSS + shadcn/ui |
| 상태관리(클라이언트) | Zustand |
| 서버 상태 | TanStack Query |
| Extension Storage | chrome.storage + WXT Storage |
| Local Backend | FastAPI + Python 3.12, `uv`로 고정 |
| 스키마 | Pydantic v2 |
| DB | SQLite + WAL + FTS5 |
| ORM | SQLAlchemy 2 |
| Migration | Alembic |
| 검색 API | NAVER API HUB(Search/Trend) |
| 검색량 API | NAVER SearchAd API |
| SERP 분석 | Content Script + DOM Parser |
| Blog 분석 | Content Script + Parser Layer |
| 콘텐츠 엔진 | Python Provider Layer |
| 로컬 LLM | Ollama / OpenAI-compatible |
| SmartEditor | Extension Adapter 우선 |
| 자동화 fallback | Playwright 또는 Selenium |
| Scheduler | APScheduler |
| 로그 | structlog |
| 테스트 | Vitest + Pytest + Playwright |
| 패키징 | Tauri shell 또는 local companion app |

## 스택 판단 이유(요약)
- WXT은 Chrome/Edge/Firefox/Safari/Whale 적합성 면에서 통합성 우수.
- React 19 + Tailwind/shadcn로 사이드패널 UI 생산성 높음.
- 로컬 백엔드(FastAPI)는 기존 Python 자동화 모듈 재사용에 유리.
- SQLite 기반은 개인/중소형 운영에서 배포 간편성 및 성능 균형이 좋음.

## 2026-09 런타임 기준 보정

- Node.js는 **24 LTS**를 기준 버전으로 사용. 공식 릴리스 표에서 Node 24는 LTS이고 Node 20은 EOL 상태입니다. [Node.js Releases](https://nodejs.org/en/about/previous-releases)
- Python은 시스템 기본 버전과 분리해 프로젝트 전용 **3.12** 환경을 생성. 최신 3.14를 바로 채택하기보다 자동화·이미지·브라우저 관련 의존성 호환성을 우선합니다.
- 패키지 버전은 `packageManager`, `engines`, `.python-version`, lockfile로 고정.
- 초기 V1에는 Docker·Tauri 패키징을 넣지 않고 로컬 개발 흐름이 안정된 뒤 추가.

현재 PC의 실제 준비 상태는 [11_local_environment_and_security.md](./11_local_environment_and_security.md), 착수 순서는 [13_development_kickoff_checklist.md](./13_development_kickoff_checklist.md)를 참고합니다.

## 운영 철학
- 브라우저 확장(사이드바)에서 즉시 실행.
- 로컬 backend는 검색·분석·생성·자동화 제어.
- 사람 최종 검토를 전제로 자동 발행은 단계적으로 도입.
