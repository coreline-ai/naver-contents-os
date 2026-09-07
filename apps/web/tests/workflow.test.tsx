import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { TodayWork, DraftLibrary, ImprovementQueue, buildImprovementInput } from '@ncos/workbench';
import type { CoreClient } from '@ncos/core-client';
import type { PerformanceRecommendation, TodayWorkItem } from '@ncos/contracts';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, query: QueryClient;
const recommendation = { id: 31, keyword: '후쿠오카 교통패스', published_keyword: '후쿠오카 여행', published_title: '기존 여행 원고', draft_id: 7, published_url: 'https://blog.naver.com/test/123', action: 'create_followup', reason: '실적 기준 추천', confidence: 'medium', calculation_version: 'fixture', period: { start: '2026-08-01', end: '2026-08-31' }, created_at: '2026-09-06T10:00:00Z' } as PerformanceRecommendation;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); query.clear(); vi.restoreAllMocks(); });
async function settle() { await act(async () => { await new Promise(r => setTimeout(r, 15)); }); }
async function render(ui: React.ReactNode) { await act(async () => root.render(<QueryClientProvider client={query}>{ui}</QueryClientProvider>)); await settle(); }
async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === text)!.click()); await settle(); }
it('builds revision with the published keyword and followup with the new keyword, without URL payloads', () => {
  const revision = buildImprovementInput(recommendation, 'refresh_body'), followup = buildImprovementInput(recommendation, 'create_followup');
  expect(revision.keyword).toBe('후쿠오카 여행'); expect(revision.sourceDraftMode).toBe('revision');
  expect(followup.keyword).toBe('후쿠오카 교통패스'); expect(followup.sourceDraftMode).toBe('followup');
  expect(followup.notes).toContain('기존 게시물'); expect(followup.sourceDraftId).toBe(7);
});
it('recommendation entry only prepares an in-memory request, without composing or completing anything', async () => {
  const client = { performanceRecommendations: vi.fn().mockResolvedValue({ items: [recommendation] }), composeBlog: vi.fn(), updatePerformanceRecommendation: vi.fn() };
  const open = vi.fn(); await render(<ImprovementQueue client={client as unknown as CoreClient} onOpen={open}/>); await click('후속 글 준비');
  expect(open).toHaveBeenCalledWith(buildImprovementInput(recommendation, 'create_followup'));
  expect(client.composeBlog).not.toHaveBeenCalled(); expect(client.updatePerformanceRecommendation).not.toHaveBeenCalled();
});
it('shows priority summary then all five actions; refresh is explicit and confirmed', async () => {
  const items = [
    { id: 'job:1', source_type: 'publish_job', action: 'inspect_error', draft_id: 7 },
    { id: 'performance:1', source_type: 'performance_recommendation', action: 'open_performance', draft_id: 7 },
    { id: 'watchlist:8', source_id: 8, source_type: 'watchlist', action: 'refresh_data' },
    { id: 'query:1', source_type: 'discovery_run', action: 'open_analysis' },
    { id: 'published:1', source_type: 'published_content', action: 'register_publication' },
  ].map(item => ({ priority: 1, source_id: 1, stale: false, draft_id: null, publish_job_id: null, published_content_id: null, published_url: null, title: '할 일', keyword: '여행', calculated_at: '2026-09-06T10:00:00Z', reason: '검수', ...item, action: item.action as TodayWorkItem['action'] })) satisfies TodayWorkItem[];
  const client = { todayWork: vi.fn().mockResolvedValue({ items }), refreshWatchlist: vi.fn().mockResolvedValue({ items: [] }) };
  const draft = vi.fn(), analysis = vi.fn(), performance = vi.fn(), publication = vi.fn();
  await render(<TodayWork client={client as unknown as CoreClient} onOpenDraft={draft} onAnalyze={analysis} onPerformance={performance} onPublications={publication}/>);
  expect(host.querySelectorAll('li')).toHaveLength(2); expect(client.refreshWatchlist).not.toHaveBeenCalled();
  await click('작업 오류 확인'); expect(draft).toHaveBeenCalledWith(7);
  await click('성과 개선 보기'); expect(performance).toHaveBeenCalledOnce();
  await click('추천 작업 전체 보기'); expect(host.querySelectorAll('li')).toHaveLength(5);
  await click('자료 새로 확인'); expect(client.refreshWatchlist).toHaveBeenCalledWith([8]);
  await click('주제 분석 준비'); expect(analysis).toHaveBeenCalledWith('여행');
  await click('공개 기록 확인'); expect(publication).toHaveBeenCalledOnce();
});
it('can archive and restore publication records without deleting an external post', async () => {
  let archived = false;
  const client = { listDrafts: vi.fn().mockResolvedValue({ items: [] }), listPublishedContents: vi.fn().mockImplementation(async () => ({ items: [{ id: 4, title: '공개 기록', state: archived ? 'archived' : 'published', published_at: '2026-08-01T00:00:00Z', canonical_url: 'https://example.com', draft_id: 7 }] })), updatePublishedContent: vi.fn().mockImplementation(async (_id, input) => { archived = input.archived; }) };
  await render(<DraftLibrary client={client as unknown as CoreClient} onOpen={() => {}}/>); await click('공개 완료 기록');
  await click('공개 기록 보관'); expect(client.updatePublishedContent).toHaveBeenCalledWith(4, { archived: true });
  await click('공개 기록 복원'); expect(client.updatePublishedContent).toHaveBeenCalledWith(4, { archived: false });
});
it('opens ad-specific work in the ad tab even when its action is open_performance', async()=>{
  const ad=vi.fn(), general=vi.fn();
  const client={todayWork:vi.fn().mockResolvedValue({items:[{id:'ad:1',source_type:'ad_performance',action:'open_performance',title:'광고 공백',keyword:'여행'}]})};
  await render(<TodayWork client={client as unknown as CoreClient} onOpenDraft={vi.fn()} onAnalyze={vi.fn()} onPerformance={general} onAdPerformance={ad} onPublications={vi.fn()}/>);
  await click('성과 개선 보기');expect(ad).toHaveBeenCalledOnce();expect(general).not.toHaveBeenCalled();
});
