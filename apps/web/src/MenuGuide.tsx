import type { KeywordView, PerformanceView } from '@ncos/workbench';
export type MenuDestination = { area: 'write'; plan?: boolean } | { area: 'keywords'; view?: KeywordView } | { area: 'drafts'; published?: boolean } | { area: 'performance'; view?: PerformanceView };
export const menuLocations: Array<{ old: string; location: string; destination?: MenuDestination }> = [
  { old: '오늘의 작업', location: '글쓰기 → 오늘 이어서 할 일', destination: { area: 'write' } },
  { old: '콘텐츠 작업함', location: '내 원고 → 저장된 원고', destination: { area: 'drafts' } },
  { old: '발행 콘텐츠', location: '내 원고 → 공개 완료 기록', destination: { area: 'drafts', published: true } },
  { old: '근거 브리프', location: '글쓰기 → 근거와 플랜으로 쓰기', destination: { area: 'write', plan: true } },
  { old: '의도별 키워드 · 키워드 맵', location: '키워드 찾기 → 분석 후 상세 분석 도구', destination: { area: 'keywords', view: 'analysis' } },
  { old: '급상승', location: '키워드 찾기 → 최신·급상승', destination: { area: 'keywords', view: 'latest' } },
  { old: 'Watchlist', location: '키워드 찾기 → 관심 키워드', destination: { area: 'keywords', view: 'watchlist' } },
  { old: '특화 분석', location: '키워드 찾기 → 분야별 자료', destination: { area: 'keywords', view: 'specialized' } },
  { old: '광고 성과', location: '성과 → 광고 계정 성과', destination: { area: 'performance', view: 'ads' } },
];
export function MenuGuide({ onOpen }: { onOpen: (destination: MenuDestination) => void }) {
  return <details className="menu-guide"><summary>기존 Research Workspace 기능은 어디 있나요?</summary><p>첨부 화면의 많은 메뉴를 아래 작업별로 묶었습니다. 앱 설정은 메뉴 편집이 아니라 AI·API 연결과 블로그 기본값을 확인하는 곳입니다.</p><ul>{menuLocations.map(item => <li key={item.old}><strong>{item.old}</strong><span>{item.location}</span>{item.destination && <button onClick={() => onOpen(item.destination!)} aria-label={`${item.old} 기능으로 이동`}>열기</button>}</li>)}</ul><p>성과 메뉴에는 자료 가져오기·채널별 집계·개선 작업·추적 링크·광고 조회가 있습니다. 현재 네이버 탭 수집의 웹 연결은 아직 이관 전이며 기존 확장에서 사용할 수 있습니다.</p></details>;
}
