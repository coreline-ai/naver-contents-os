# 05. SmartEditor 자동화 핵심 자산과 리스크

## 현재 구현 범위 업데이트

- V1 안정화 범위는 **제목·본문·태그·임시저장**이다. 이미지 업로드는 후속 범위다.
- Health Check는 selector 존재뿐 아니라 visible/enabled/editable과 실제 tag input 접근성을 검사한다.
- Health Check와 입력은 동일한 editor navigation에서 이어져 검사 후 DOM 변경 위험을 줄였다.
- 임시저장 버튼 클릭만으로 성공 처리하지 않고 저장 성공 signal을 확인한다.
- Chrome 136+는 기본 profile remote debugging을 허용하지 않으므로 `scripts/start_chrome_automation.sh`의 전용 `--user-data-dir` profile을 사용한다.
- 실제 블로그 임시저장 인수 테스트는 사용자 승인 후 수행한다.

## 1) 강점 요약
`automation/editor.py`와 `config/selectors.py`가 가장 높은 재사용 가치.

### `editor.py` 핵심 가치
- 1,196라인 분량 수준으로 단순 데모를 넘어섬.
- SmartEditor ONE에서 실제로 발생하는 미묘한 제어문제 대응 로직 포함.
- iframe/직접 렌더 이중 경로 처리.
- 임시저장 실패시 fallback 체계(JS 탐색→ESC→JS→요소 검색→로그).
- 이미지 삽입 후 포커스 복구 흐름(ESC/컴포넌트 재탐색/캡처).

### `selectors.py` 핵심 가치
- 클래스명/선택자 다중 후보를 중앙집중화해 유지보수성 확보.
- 네이버 DOM 변경 시 수정 범위를 최소화.

## 2) 실행상 디테일
- 제목 입력 시 사람 타이핑 유사 방식(_type_like_human) + 랜덤 sleep.
- Markdown 정리: `##`, `**`, `*`, backtick 제거해 SmartEditor 투입 전 정제.
- 이미지/태그/임시저장 동작에서 보수적 fallback.

## 3) 리스크
- DOM 변경이 최악의 유지보수 리스크.
- selector 변경 하나가 제목/이미지/태그/임시저장 전반에 연쇄 영향.

## 4) 권장 보강
- **Selector Health Check**(로그인/iframe/타이틀/바디/이미지/태그/임시저장) 상태 점검.
- 하나라도 실패하면 본문 작성 자동화를 시작하지 않도록 gating.
- 실패 시 “자동화 중지 + 사용자 알림”으로 잘못 게시 리스크 감소.

## 5) 로그인·브라우저 정책 정합성
- 기존 `NAVER_ID/PW` 자동 로그인은 제거하고,
- 사용자의 브라우저 세션(이미 로그인된 상태)을 우선 활용하는 방향이 더 적합.

이는 브라우저 확장 기반 통합 전략과 정합성이 높음.
