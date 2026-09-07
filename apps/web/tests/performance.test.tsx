import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { CoreClient } from '@ncos/core-client';
import type { PerformanceChannel, PerformanceImportRun, PerformanceImportRequest, QueryPerformanceItem } from '@ncos/contracts';
import { PerformanceWorkspace, AdPerformancePanel } from '@ncos/workbench';
import { PerformanceImportPanel, TrackingLinkPanel, PerformanceDashboard } from '@ncos/workbench/performance';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, query: QueryClient;
const channels = [
  { id: 1, source: 'creator_advisor', display_name: '블로그 A', enabled: true },
  { id: 2, source: 'creator_advisor', display_name: '블로그 B', enabled: true },
  { id: 3, source: 'biz_advisor', display_name: '스토어', enabled: true },
  { id: 4, source: 'search_advisor', display_name: '웹사이트', enabled: true },
] as PerformanceChannel[];
const imports = [1,2].map(id => ({ id, channel_id: id, data_kind: 'content_performance', period: { start: '2026-08-01', end: '2026-08-07' }, grain: 'weekly', status: 'ready', row_count: 1 })) as PerformanceImportRun[];
const overview = (id: number) => ({ creator: { channel_id: id, channel_name: `블로그 ${id === 1 ? 'A' : 'B'}`, source: 'creator_advisor', period: imports[0].period, metrics: { impressions: id * 111, inflows: 0, ctr: 0, average_rank: null }, changes: {}, status: 'ready' }, commerce: null, website: null });
const adResult = (keyword = '광고 샘플') => ({ status: 'ok', read_only: true, rows: [], recommendations: [{ keyword, reason: '후속 글 공백' }], data_status: { searchad: 'ok' } });
function deferred<T = unknown>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function makeClient() { return { listPerformanceChannels: vi.fn().mockResolvedValue({ items: channels }), listPerformanceImports: vi.fn().mockResolvedValue({ items: imports }), listPublishedContents: vi.fn().mockResolvedValue({ items: [] }), performanceOverview: vi.fn(async (id: number) => overview(id)), contentPerformance: vi.fn().mockResolvedValue({ items: [] }), queryPerformance: vi.fn().mockResolvedValue({ items: [] }), performanceRecommendations: vi.fn().mockResolvedValue({ items: [] }), capabilities: vi.fn().mockResolvedValue({ providers: {} }), adPerformance: vi.fn().mockResolvedValue(adResult()), createPerformanceImport: vi.fn(), composeBlog: vi.fn(), updatePerformanceRecommendation: vi.fn().mockResolvedValue({}) }; }
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(async () => { await act(async () => root.unmount()); query.clear(); host.remove(); vi.restoreAllMocks(); });
async function settle() { await act(async () => { await new Promise(r => setTimeout(r, 20)); }); }
async function render(ui: React.ReactNode) { await act(async () => root.render(<QueryClientProvider client={query}>{ui}</QueryClientProvider>)); await settle(); await settle(); }
function button(text: string) { return [...host.querySelectorAll('button')].find(b => b.textContent === text)!; }
async function click(text: string) { expect(button(text)).toBeTruthy(); await act(async () => button(text).click()); await settle(); }
async function fill(selector: string, value: string) { const node = host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!; expect(node).toBeTruthy(); await act(async () => { const proto = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node,value); node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); }); await settle(); }
async function workspace(client: ReturnType<typeof makeClient>, props: Record<string, unknown> = {}) { await render(<PerformanceWorkspace client={client as unknown as CoreClient} onImprove={vi.fn()} onAnalyze={vi.fn()} {...props}/>); }

it('enters the real performance workspace with only local reads scoped to one channel', async () => {
  const c = makeClient(); await workspace(c);
  expect(c.performanceOverview).toHaveBeenCalledWith(1, undefined); expect(c.contentPerformance).toHaveBeenCalledWith(undefined, 1); expect(c.queryPerformance).toHaveBeenCalledWith(undefined, 1); expect(c.performanceRecommendations).toHaveBeenCalledWith('open', 1);
  expect(host.querySelector('[aria-label="Creator 성과 요약"]')?.textContent).toContain('111');
  expect(c.adPerformance).not.toHaveBeenCalled(); expect(c.composeBlog).not.toHaveBeenCalled(); expect(c.createPerformanceImport).not.toHaveBeenCalled();
});
it('does not let a delayed channel response overwrite the selected channel', async () => {
  const c = makeClient(), late = deferred<any>(); c.performanceOverview.mockImplementation(id => id === 1 ? late.promise : Promise.resolve(overview(2))); await workspace(c);
  await fill('#performance-channel','2'); expect(host.querySelector('[aria-label="Creator 성과 요약"]')?.textContent).toContain('222');
  await act(async () => late.resolve(overview(1))); await settle();
  expect(host.querySelector('[aria-label="Creator 성과 요약"]')?.textContent).not.toContain('111');
  expect(c.performanceRecommendations).toHaveBeenLastCalledWith('open', 2);
});
it('selects an exact import but clears it before switching channels', async () => {
  const c = makeClient(); await workspace(c); await fill('#performance-period','1');
  expect(c.performanceOverview).toHaveBeenLastCalledWith(1, 1); expect(c.contentPerformance).toHaveBeenLastCalledWith(1,1);
  await fill('#performance-channel','2'); expect((host.querySelector('#performance-period') as HTMLSelectElement).value).toBe('0');
  expect(c.performanceOverview).toHaveBeenLastCalledWith(2, undefined); expect(c.contentPerformance).not.toHaveBeenCalledWith(1,2);
});
it('does not issue an unscoped fallback when no channels are enabled', async () => {
  const c = makeClient(); c.listPerformanceChannels.mockResolvedValue({ items: channels.map(c=>({...c,enabled:false})) }); await workspace(c);
  expect(host.textContent).toContain('연결된 활성 채널이 없습니다'); expect(c.performanceOverview).not.toHaveBeenCalled(); expect(c.performanceRecommendations).not.toHaveBeenCalled();
});
it('keeps a missing summary distinct from observed zero and from fetch errors', async () => {
  const c = makeClient(); c.performanceOverview.mockResolvedValue({ creator: null, commerce: null, website: null } as any); await workspace(c);
  expect(host.textContent).toContain('미수집을 0으로 표시하지 않습니다');
});
it('keeps pasted data while switching workspace subtabs and reports dirty state', async () => {
  const c = makeClient(), dirty = vi.fn(); await workspace(c, { onDirtyChange: dirty }); await click('자료 가져오기·채널'); await click('샘플 양식 넣기');
  const table = (host.querySelector('textarea') as HTMLTextAreaElement).value; expect(dirty).toHaveBeenLastCalledWith(true);
  await click('성과 확인·개선'); await click('자료 가져오기·채널'); expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe(table); expect(c.createPerformanceImport).not.toHaveBeenCalled();
});
it('routes improvement actions without generating and supports hidden/done statuses', async () => {
  const c=makeClient(), improve=vi.fn(); const item={id:31,keyword:'여행',reason:'근거 있음',action:'create_followup',confidence:'medium',period:imports[0].period,calculation_version:'v2'};
  c.performanceRecommendations.mockResolvedValue({items:[item]}); await workspace(c,{onImprove:improve}); await click('후속 글');
  expect(improve).toHaveBeenCalledWith(expect.objectContaining({keyword:'여행',recommendationId:31})); expect(c.composeBlog).not.toHaveBeenCalled();
  await click('이번 추천 숨기기'); expect(c.updatePerformanceRecommendation).toHaveBeenCalledWith(31,'dismissed'); await click('숨김'); expect(c.performanceRecommendations).toHaveBeenLastCalledWith('dismissed',1);
  await click('다시 진행'); expect(c.updatePerformanceRecommendation).toHaveBeenCalledWith(31,'open'); await click('완료'); expect(c.performanceRecommendations).toHaveBeenLastCalledWith('done',1);
});
it('keeps commerce and website summaries separate from creator tables', async () => {
  const c=makeClient(); c.performanceOverview.mockImplementation(async id=>({creator:null,commerce:id===3?{...overview(1).creator,channel_name:'스토어',metrics:{inflows:7,attributed_revenue:1000}}:null,website:id===4?{...overview(1).creator,channel_name:'웹사이트',metrics:{clicks:5}}:null}) as any); await workspace(c);
  await fill('#performance-channel','3'); expect(host.querySelector('.performance-dashboard')?.textContent).toContain('기여 금액'); expect(host.querySelector('[aria-label="게시물별 성과"]')).toBeNull();
  await fill('#performance-channel','4'); expect(host.querySelector('.performance-dashboard')?.textContent).toContain('웹 클릭'); expect(host.querySelector('.performance-dashboard')?.textContent).not.toContain('기여 금액');
});

const previewResult = (r: PerformanceImportRequest) => ({ valid:true,channel:channels.find(c=>c.id===r.channel_id),source:r.source,data_kind:r.data_kind,period:{start:r.period_start,end:r.period_end},grain:r.grain,row_count:r.rows.length,warnings:[],rows:r.rows });
it.each([
  ['내 블로그 성과','게시물 성과','content_performance',1], ['내 블로그 성과','검색어 성과','query_performance',1], ['스마트스토어 성과','스토어 유입·기여','commerce_attribution',3], ['독립 웹사이트 성과','웹 검색 성과','site_performance',4],
])('previews and explicitly saves %s / %s through the shared web parser', async (source,kind,dataKind,channelId) => {
  const c={previewPerformanceImport:vi.fn(async r=>previewResult(r)),createPerformanceImport:vi.fn().mockResolvedValue({row_count:1})}, dirty=vi.fn();
  await render(<PerformanceImportPanel expanded client={c as unknown as CoreClient} channels={channels} imports={[]} onChanged={vi.fn()} onNotice={vi.fn()} onDirtyChange={dirty}/>);
  await click(String(source)); await click(String(kind)); await click('샘플 양식 넣기'); await click('열 매핑·미리보기');
  expect(c.previewPerformanceImport).toHaveBeenCalledWith(expect.objectContaining({channel_id:channelId,data_kind:dataKind})); expect(c.createPerformanceImport).not.toHaveBeenCalled();
  await act(async()=>{button('확인하고 로컬 저장').click();button('확인하고 로컬 저장').click();});await settle();
  expect(c.createPerformanceImport).toHaveBeenCalledOnce(); expect(c.createPerformanceImport).toHaveBeenCalledWith(c.previewPerformanceImport.mock.calls[0][0]); expect(dirty).toHaveBeenLastCalledWith(false);
});
it('shows all returned imports, labels channel scope, and requires explicit deletion', async () => {
  const c={deletePerformanceImport:vi.fn().mockResolvedValue({})};
  await render(<PerformanceImportPanel expanded client={c as unknown as CoreClient} channels={channels} imports={Array.from({length:12},(_,i)=>({...imports[0],id:i+1}))} onChanged={vi.fn()} onNotice={vi.fn()}/>);
  expect(host.textContent).toContain('#12 · 블로그 A'); expect([...host.querySelectorAll('button')].filter(b=>b.textContent==='삭제')).toHaveLength(12);
  await click('삭제'); expect(c.deletePerformanceImport).not.toHaveBeenCalled(); await click('취소'); expect(c.deletePerformanceImport).not.toHaveBeenCalled(); await click('삭제'); await click('삭제 확인'); expect(c.deletePerformanceImport).toHaveBeenCalledWith(1);
});
it('requires ownership for a new independent site and locks duplicate channel creation', async () => {
  const late=deferred(), c={createPerformanceChannel:vi.fn(()=>late.promise)};
  await render(<PerformanceImportPanel client={c as unknown as CoreClient} channels={[]} imports={[]} onChanged={vi.fn()} onNotice={vi.fn()}/>);
  await click('독립 웹사이트 성과'); await fill('[aria-label="독립 웹사이트 URL"]','https://example.com'); expect(button('채널 연결').disabled).toBe(true);
  await act(async()=>host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await act(async()=>{button('채널 연결').click();button('채널 연결').click();}); expect(c.createPerformanceChannel).toHaveBeenCalledOnce();
  expect(c.createPerformanceChannel).toHaveBeenCalledWith(expect.objectContaining({ownership_confirmed:true,source:'search_advisor'})); await act(async()=>late.resolve({id:5,display_name:'사이트'}));
});
it('displays query rows beyond 30 with their own period and state', async () => {
  const rows=Array.from({length:31},(_,i)=>({id:i,query:`검색어 ${i}`,period:imports[0].period,data_state:'observed_zero',metrics:{impressions:0,inflows:0,ctr:null,average_rank:null}})) as QueryPerformanceItem[];
  await render(<PerformanceDashboard overview={null} recommendations={[]} contents={[]} queries={rows} publications={[]} features={{creator:true,commerce:false,website:false}} loading={false} onAction={vi.fn()} onDismiss={vi.fn()} onMap={vi.fn()}/>);
  expect(host.textContent).toContain('검색어 30'); expect(host.textContent).toContain('2026-08-01–2026-08-07'); expect(host.textContent).toContain('확인된 0'); expect(host.textContent).toContain('결측');
});
it('discards an old tracking link after changing the destination and blocks duplicate builds', async () => {
  const late=deferred(), c={buildTrackingLink:vi.fn(()=>late.promise)};
  await render(<TrackingLinkPanel client={c as unknown as CoreClient} publications={[]} onNotice={vi.fn()}/>);
  await fill('[aria-label="스마트스토어 URL"]','https://smartstore.naver.com/one'); await act(async()=>{button('추적 링크 만들기').click();button('추적 링크 만들기')?.click();});
  expect(c.buildTrackingLink).toHaveBeenCalledOnce(); await fill('[aria-label="스마트스토어 URL"]','https://smartstore.naver.com/two'); await act(async()=>late.resolve({url:'https://old-result.example',tracking_id:'old-link'})); expect(host.textContent).not.toContain('old-link');
});
it('shows a manual-copy fallback if clipboard permission is denied', async () => {
  vi.spyOn(navigator.clipboard,'writeText').mockRejectedValue(new Error('denied'));
  const c={buildTrackingLink:vi.fn().mockResolvedValue({url:'https://smartstore.naver.com/one?nt_source=test',tracking_id:'one'})};
  await render(<TrackingLinkPanel client={c as unknown as CoreClient} publications={[]} onNotice={vi.fn()}/>); await fill('[aria-label="스마트스토어 URL"]','https://smartstore.naver.com/one');await click('추적 링크 만들기');await click('복사');expect(host.textContent).toContain('표시된 링크를 직접 복사');
});
it('does not fetch ads until inline confirmation and only prepares analysis from the result', async () => {
  const c=makeClient(), analyze=vi.fn(); await render(<AdPerformancePanel client={c as unknown as CoreClient} onAnalyze={analyze}/>); expect(c.adPerformance).not.toHaveBeenCalled();
  await click('선택 기간 최신 조회'); await click('취소'); expect(c.adPerformance).not.toHaveBeenCalled(); await click('선택 기간 최신 조회'); await click('확인하고 조회'); expect(c.adPerformance).toHaveBeenCalledOnce();expect(c.adPerformance.mock.calls[0][2]).toBe(true);
  await click('주제 분석 준비'); expect(analyze).toHaveBeenCalledWith('광고 샘플');expect(c.composeBlog).not.toHaveBeenCalled();
});
it('rejects invalid dates and known quota blocks before asking for ad calls', async () => {
  const c=makeClient();c.capabilities.mockResolvedValue({providers:{searchad:{quota:{blocked:true}}}});await render(<AdPerformancePanel client={c as unknown as CoreClient} onAnalyze={vi.fn()}/>);expect(button('선택 기간 최신 조회').disabled).toBe(true);expect(host.textContent).toContain('사용 한도');
  await fill('#ad-since','2099-01-01');expect(host.textContent).toContain('올바른 시작');expect(c.adPerformance).not.toHaveBeenCalled();
});
it('ignores delayed ad data for a replaced period and locks duplicate requests', async () => {
  const c=makeClient(), late=deferred();c.adPerformance.mockImplementation(()=>late.promise as any);await render(<AdPerformancePanel client={c as unknown as CoreClient} onAnalyze={vi.fn()}/>);await click('선택 기간 최신 조회');
  await act(async()=>{const b=button('확인하고 조회');b.click();b.click();});expect(c.adPerformance).toHaveBeenCalledOnce();await fill('#ad-since','2026-08-01');await act(async()=>late.resolve(adResult('오래된 결과')));expect(host.textContent).not.toContain('오래된 결과');
});
it('shows the existing Trend relative index and collection time without inventing search counts',async()=>{
  const row={id:1,title:'글',period:imports[0].period,data_state:'partial',metrics:{impressions:100,inflows:0,ctr:0},market:{searchad:null,serp:null,trend:{latest_ratio:47.5,collected_at:'2026-08-30T10:00:00Z',note:'기간 내 비교',source:'NAVER_API_HUB'}},mapped:false};
  await render(<PerformanceDashboard overview={null} recommendations={[]} contents={[row as any]} queries={[]} publications={[]} features={{creator:true,commerce:false,website:false}} loading={false} onAction={vi.fn()} onDismiss={vi.fn()} onMap={vi.fn()}/>);
  expect(host.textContent).toContain('47.5');expect(host.textContent).toContain('상대지수 · 검색 횟수 아님');expect(host.textContent).toContain('NAVER_API_HUB');expect(host.textContent).toContain('기간 내 비교');
});
it('includes every normalized public metric in the reviewed preview, not just headline metrics',async()=>{
  const c={previewPerformanceImport:vi.fn(async r=>previewResult(r))};await render(<PerformanceImportPanel expanded client={c as unknown as CoreClient} channels={channels} imports={[]} onChanged={vi.fn()} onNotice={vi.fn()}/>);
  await fill('[aria-label="성과 표 붙여넣기"]','제목,공감수,댓글수\n검수,0,2');await click('열 매핑·미리보기');expect(host.querySelector('[aria-label="정규화된 성과 미리보기"]')?.textContent).toContain('공감: 0 · 댓글: 2');
});
