# 02. 구조/모듈 및 파이프라인 정리

## 코드 구조(영역별)

| 영역 | 주요 파일/모듈 | 역할 | 평가 |
|---|---|---|---:|
| 입력/콘텐츠 | `content_parser.py` | 원본 콘텐츠 정리 | ★★★★☆ |
| 키워드 | `golden_keywords.py` | 골든 키워드 계산 | ★★★★☆ |
| 키워드 | `keyword_researcher.py` | 검색 데이터 수집 | ★★★★☆ |
| 글작성 | `thread_expander.py` | 짧은 글→장문 확장 | ★★★★☆ |
| AI 공통 | `llm_generator.py` | Claude/OpenAI 호출 | ★★★★☆ |
| 이미지 | `image_handler.py` | 이미지 전처리/배치 | ★★★★☆ |
| 이미지 | `unsplash_client.py` | 추가 이미지 확보 | ★★★☆☆ |
| 썸네일 | `thumbnail_html.py` | HTML/CSS 썸네일 | ★★★★☆ |
| 브라우저 | `browser.py` | Chrome 실행 | ★★★★☆ |
| 로그인 | `login.py` | 네이버 로그인 | ★★★☆☆ |
| 에디터 | `editor.py` | SmartEditor ONE 제어 | ★★★★★ |
| 오케스트레이션 | `orchestrator.py` | 전체 흐름 조율 | ★★★★☆ |
| 선택자 설정 | `selectors.py` | 네이버 DOM selector 중앙 관리 | ★★★★★ |
| GUI | `gui/` | 데스크톱 UI | ★★★☆☆ |
| Web | `web/` | FastAPI 웹 UI | ★★★★☆ |

## 추가 관찰
- `core/`에 `golden_keywords`, `keyword_researcher`, `thread_expander`, `llm_generator`, 이미지/썸네일 모듈이 분리되어 있어 **재사용성이 높음**.
- UI가 desktop/웹 양쪽 흔적으로 전환 흔적이 있으므로, 향후 구조 정리가 필요함.

## 강점
- 파트별로 기능이 잘 분리됨.
- 핵심 자동화 파이프라인(특히 editor/selectors)은 실행 가능한 수준으로 촘촘함.
- 여러 프로젝트 조합(데스크톱+웹+백엔드) 시 모듈 추출이 쉬움.
