import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KeywordWorkspace, RisingDiscovery, RisingResults, PcMobileDonut } from '@ncos/workbench';
import { KeywordDetails } from '../../../packages/workbench/src/KeywordDetails';
import { SpecializedResearch } from '../../../packages/workbench/src/SpecializedResearch';
import { WatchKeywords } from '../../../packages/workbench/src/WatchKeywords';
import type { CoreClient } from '@ncos/core-client';
import type { AnalyzeResponse, CapabilitiesResponse, RisingResponse } from '@ncos/contracts';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
export const fixtureRun: RisingResponse = { run_id: 9, seed: '여행', effective_seed: '여행', mode: 'general', region: '', category: '', status: 'partial', collected_at: '2026-09-03T00:00:00Z', comparison_window: { start_date: '2026-08-23', end_date: '2026-09-05', recent_start: '2026-08-30' }, estimated_calls: 10, actual_calls: 3, score_version: 'freshness-v1', data_status: { trend: 'partial' }, disclaimer: '공식 순위가 아닌 상대 추이 후보입니다.', candidates: [{ keyword: '후쿠오카 여행', direction: 'rising', previous7_avg: 10, recent7_avg: 20, growth_rate: 100, trend_score: 60, news_7d_sample_count: null, sample_capped: false, latest_news_at: null, news_score: null, freshness_score: 60, confidence: 'low', monthly_searches: 1500, volume_masked: false, coverage: { observed_days: 14, previous_days: 7, recent_days: 7 }, components: { trend_score: 60, news_volume_score: null, news_recency_score: null, news_score: null, trend_weight: 1, news_weight: 0, reason: '뉴스 자료 없음' }, data_status: { news: 'unconfigured' }, source_meta: {} }] };
const analysis = { keyword: '후쿠오카 여행', snapshot_id: 2, collected_at: '2026-09-06', data_status: {}, metric: null, related_keywords: [], landscape: null, trend: null, score: { value: null, score_version: 'fixture', coverage_weight: 0, available_component_count: 0, total_component_count: 0, confidence: 'unavailable', contributions: [], missing: [] }, questions: [], clusters: [], plan: [], serp: null } as AnalyzeResponse;
let root: Root, host: HTMLDivElement, query: QueryClient, client: Record<string, ReturnType<typeof vi.fn>>, write: ReturnType<typeof vi.fn>, plan: ReturnType<typeof vi.fn>;
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); write = vi.fn(); plan = vi.fn();
  client = { capabilities: vi.fn().mockResolvedValue({ providers: {} }), recentRising: vi.fn().mockResolvedValue({ runs: [fixtureRun], read_only: true }), latestRising: vi.fn().mockResolvedValue({ run: null }), rising: vi.fn().mockResolvedValue(fixtureRun), suggestKeywords: vi.fn().mockResolvedValue({ suggestions: [] }), analyze: vi.fn().mockResolvedValue(analysis), specialized: vi.fn().mockResolvedValue({ mode: 'local', keyword: '여행', status: 'ok', items: [], collected_at: '2026-09-06' }), graph: vi.fn(), audience: vi.fn(), commercial: vi.fn(), getIntentBoard: vi.fn(), listWatchlist: vi.fn().mockResolvedValue({ items: [], cap: 50 }), addWatchlist: vi.fn(), refreshWatchlist: vi.fn(), deleteWatchlist: vi.fn() };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); query.clear(); vi.restoreAllMocks(); });
const core = () => client as unknown as CoreClient;
async function pause(ms = 15) { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); }
async function mount(element: React.ReactNode) { await act(async () => root.render(<QueryClientProvider client={query}>{element}</QueryClientProvider>)); await pause(); }
async function workspace() { await mount(<KeywordWorkspace client={core()} onWrite={write} onPlan={plan}/>); }
function button(text: string) { const element = [...host.querySelectorAll('button')].find(el => el.textContent === text); if (!element) throw new Error(`Missing button ${text}`); return element; }
async function click(text: string) { await act(async () => button(text).click()); await pause(); }
async function input(selector: string, value: string) { await act(async () => { const el = host.querySelector(selector)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); }); }
it('shows collected candidates on entry without external collection or AI, labels timing and provenance', async () => {
  await workspace(); expect(host.textContent).toContain('후쿠오카 여행'); expect(host.textContent).toContain('공식 실시간 인기 검색어 순위가 아닙니다');
  expect(host.textContent).toContain('오래된 결과'); expect(host.textContent).toContain('100%');
  expect(client.recentRising).toHaveBeenCalledOnce(); expect(client.rising).not.toHaveBeenCalled(); expect(client.suggestKeywords).not.toHaveBeenCalled(); expect(client.analyze).not.toHaveBeenCalled(); expect(client.latestRising).not.toHaveBeenCalled();
});
it('handles empty local history and collection failure without inventing a ranking', async () => {
  client.recentRising.mockResolvedValue({ runs: [], read_only: true }); client.rising.mockRejectedValue(new Error('429 사용량 한도'));
  await workspace(); expect(host.textContent).toContain('아직 수집 이력이 없습니다'); await input('#keyword-query', '여행'); await click('이 조건으로 최신 수집');
  expect(host.textContent).toContain('429 사용량 한도'); expect(client.rising).toHaveBeenCalledOnce();
});
it('candidate click analyzes immediately and prepares writer without generating', async () => {
  await workspace(); await click('후쿠오카 여행'); expect(client.analyze).toHaveBeenCalledWith('후쿠오카 여행', null, false);
  await click('이 키워드로 글쓰기'); expect(write).toHaveBeenCalledWith('후쿠오카 여행'); expect(plan).not.toHaveBeenCalled(); expect(host.querySelectorAll('[style]')).toHaveLength(0);
});
it('debounces suggestions and excludes late old suggestions', async () => {
  let resolve!: (v: unknown) => void; client.suggestKeywords.mockImplementationOnce(() => new Promise(r => resolve = r));
  await workspace(); await input('#keyword-query', '가'); await pause(430); expect(client.suggestKeywords).not.toHaveBeenCalled();
  await input('#keyword-query', '여행'); await pause(430); await input('#keyword-query', '캠핑');
  await act(async () => resolve({ suggestions: [{ keyword: '오래된 추천' }] })); await pause(430);
  expect(client.suggestKeywords).toHaveBeenCalledTimes(2); expect(client.suggestKeywords.mock.calls[0][1].aborted).toBe(true); expect(host.textContent).not.toContain('오래된 추천');
});
it('suggestion selection analyzes once and late analysis cannot replace the changed topic', async () => {
  let resolve!: (v: unknown) => void; client.analyze.mockImplementationOnce(() => new Promise(r => resolve = r));
  client.suggestKeywords.mockResolvedValue({ suggestions: [{ keyword: '추천 캠핑', source: 'searchad', monthly_searches: 100, volume_masked: false }] });
  await workspace(); await input('#keyword-query', '캠핑'); await pause(430);
  await act(async () => (host.querySelector('.keyword-chips button') as HTMLButtonElement).click());
  await input('#keyword-query', '새로운 주제'); await act(async () => resolve(analysis));
  expect(host.textContent).not.toContain('후쿠오카 여행 분석'); expect(client.analyze).toHaveBeenCalledOnce();
});
it('blocks synchronous duplicate analysis submits', async () => {
  client.analyze.mockReturnValue(new Promise(() => {})); await workspace(); await input('#keyword-query', '여행');
  await act(async () => { const form = host.querySelector('form')!; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(client.analyze).toHaveBeenCalledOnce();
});
it.each([['일반','general'], ['뉴스','news'], ['지역','local'], ['쇼핑','shopping']])('collects %s only after explicit action and validates required condition', async (label, mode) => {
  await mount(<RisingDiscovery client={core()} seed="여행" onSeed={() => {}} onAnalyze={() => {}} disabled={false}/>); await click(label);
  if (mode === 'local') { expect(button('이 조건으로 최신 수집').disabled).toBe(true); await input('#rising-region', '부산'); }
  if (mode === 'shopping') { expect(button('이 조건으로 최신 수집').disabled).toBe(true); await input('#rising-category', '50000000'); }
  expect(client.rising).not.toHaveBeenCalled(); await click('이 조건으로 최신 수집');
  expect(client.rising).toHaveBeenCalledWith(expect.objectContaining({ mode, force_refresh: true, candidate_limit: 20 }));
});
it('ignores late collection after changing conditions and prevents duplicate collection', async () => {
  let resolve!: (v: unknown) => void; client.rising.mockImplementationOnce(() => new Promise(r => resolve = r));
  await mount(<RisingDiscovery client={core()} seed="여행" onSeed={() => {}} onAnalyze={() => {}} disabled={false}/>);
  await act(async () => { button('이 조건으로 최신 수집').click(); button('이 조건으로 최신 수집').click(); }); expect(client.rising).toHaveBeenCalledOnce();
  await click('뉴스'); await act(async () => resolve(fixtureRun)); await pause(); expect(host.querySelectorAll('.rising-result')).toHaveLength(1); // history only, not the news condition
});
it('quota prevents collection but does not hide saved candidates', async () => {
  await mount(<RisingDiscovery client={core()} seed="여행" onSeed={() => {}} onAnalyze={() => {}} disabled={false} capabilities={{ providers: { searchad: { quota: { blocked: true } } } } as unknown as CapabilitiesResponse}/>);
  expect(button('이 조건으로 최신 수집').disabled).toBe(true); expect(host.textContent).toContain('후쿠오카 여행'); expect(client.rising).not.toHaveBeenCalled();
});
it('shows missing news as unavailable, masks volume and exposes all candidates on demand', async () => {
  const run = { ...fixtureRun, candidates: Array.from({ length: 12 }, (_, i) => ({ ...fixtureRun.candidates[0], keyword: `후보${i}`, volume_masked: true })) };
  await mount(<RisingResults result={run} disabled={false} onAnalyze={() => {}}/>); expect(host.querySelectorAll('.candidate-card')).toHaveLength(8); expect(host.textContent).toContain('뉴스 표본 자료 없음'); expect(host.textContent).toContain('제한값');
  await click('전체 후보 12개 보기'); expect(host.querySelectorAll('.candidate-card')).toHaveLength(12);
});
it('opens detailed tools without fetching and supports stored intent only by explicit action', async () => {
  client.getIntentBoard.mockResolvedValue({ items: [], collected_at: '2026-09-06', intent_version: 'v1' });
  await mount(<KeywordDetails client={core()} analysis={analysis} onAnalyze={() => {}} onWatch={() => {}}/>);
  await click('키워드 맵'); await click('독자 특성'); expect(client.graph).not.toHaveBeenCalled(); expect(client.audience).not.toHaveBeenCalled();
  await click('의도별 키워드'); await click('저장된 분석으로 의도 보기'); expect(client.getIntentBoard).toHaveBeenCalledWith(2);
});
it.each([['지역·장소', 'local'], ['쇼핑 클릭 추이', 'shopping'], ['참고 사진', 'image']])('supports specialized %s without auto querying', async (label, mode) => {
  await mount(<SpecializedResearch client={core()} keyword="여행"/>); await click(label); if (mode === 'shopping') await input('#special-category', '50000000');
  expect(client.specialized).not.toHaveBeenCalled(); await click('최신 자료 조회'); expect(client.specialized).toHaveBeenCalledWith('여행', mode, mode === 'shopping' ? '50000000' : '', true);
});
it('keeps watchlist local until explicit add/refresh and honors consent', async () => {
  await mount(<WatchKeywords client={core()} keyword="여행" onAnalyze={() => {}} quotaBlocked={false}/>); expect(client.refreshWatchlist).not.toHaveBeenCalled();
  await click('입력한 키워드 추가'); expect(client.addWatchlist).toHaveBeenCalledWith('여행'); expect(button('전체 갱신').disabled).toBe(true);
});
it('SVG device share works with strict style CSP; missing/masked values are not percentages', async () => {
  await mount(<PcMobileDonut svg pc={100} mobile={900}/>); expect(host.querySelector('svg')).not.toBeNull(); expect(host.querySelectorAll('[style]')).toHaveLength(0); expect(host.textContent).toContain('90%');
  await mount(<PcMobileDonut svg pc={null} mobile={900}/>); expect(host.querySelector('svg')).toBeNull(); expect(host.textContent).toContain('계산 불가');
});
it('returns audience and commercial data for the selected node and invalidates it after rebuilding the graph', async () => {
  const graph = { nodes: [{ id: 'root', keyword: '후쿠오카 여행', depth: 0, volume: 1000, cluster: '여행', enrichment_status: 'ok' }, { id: 'next', keyword: '후쿠오카 숙소', depth: 1, volume: 900, cluster: '숙소', enrichment_status: 'ok' }], edges: [{ source: 'root', target: 'next' }], collected_at: '2026-09-06', call_budget: { actual: 2, maximum: 12 } };
  client.graph.mockResolvedValue(graph); client.audience.mockResolvedValue({ keyword: '후쿠오카 숙소', warning: '독립 정규화', segments: {}, data_status: {} });
  client.commercial.mockResolvedValue({ rows: [{ keyword: '후쿠오카 숙소', device: 'PC', average_position_bid: null, minimum_exposure_bid: 0, median_bid: 10, estimated_impressions: 15, estimated_clicks: 1, commercial_score: 12 }], data_status: {}, collected_at: '2026-09-06', score_version: 'test', score_note: '수익 아님' });
  await mount(<KeywordDetails client={core()} analysis={analysis} onAnalyze={() => {}} onWatch={() => {}}/>); await click('키워드 맵'); await click('이 도구 조회');
  await act(async () => host.querySelector('g[aria-label^="후쿠오카 숙소"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await click('독자 특성으로'); await click('이 도구 조회'); expect(client.audience).toHaveBeenCalledWith('후쿠오카 숙소', false); expect(host.textContent).toContain('독립 정규화');
  await click('광고 입찰 참고'); await click('이 도구 조회'); expect(client.commercial).toHaveBeenCalledWith(['후쿠오카 숙소'], 'PC', false); expect(host.textContent).toContain('자료 없음'); expect(host.textContent).not.toContain('자료 없음원');
  await click('키워드 맵'); await click('최신 자료로 다시 조회'); await click('독자 특성'); expect(host.textContent).not.toContain('독립 정규화');
  await click('광고 입찰 참고'); expect(host.querySelector('table')).toBeNull();
});
it('watchlist refreshes exactly selected IDs after consent; cancelling deletion leaves data alone', async () => {
  client.listWatchlist.mockResolvedValue({ cap: 50, items: [{ id: 3, keyword: '여행', direction: '상승', status: 'ok', stale: false, delta: 10, last_snapshot: { monthly_searches: 100, latest_ratio: 20, collected_at: '2026-09-06' }, previous_snapshot: { latest_ratio: 10 }, comparison_key: 'same-window' }] });
  await mount(<WatchKeywords client={core()} keyword="여행" onAnalyze={() => {}} quotaBlocked={false}/>);
  await act(async () => (host.querySelector('input[type=checkbox]') as HTMLInputElement).click()); await click('선택한 키워드 갱신'); expect(client.refreshWatchlist).toHaveBeenCalledWith([3], true);
  vi.mocked(window.confirm).mockReturnValue(false); await click('목록에서 삭제'); expect(client.deleteWatchlist).not.toHaveBeenCalled(); expect(host.textContent).toContain('same-window');
});
