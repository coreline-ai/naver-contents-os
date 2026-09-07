import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CoreClient } from '@ncos/core-client';
import type { AdPerformanceResponse } from '@ncos/contracts';
import { PerformanceDashboard, PerformanceImportPanel, TrackingLinkPanel } from './PerformancePanels';
import { buildImprovementInput, type ImprovementInput } from './improvement';
import { message, formatTime } from './common';
import { blocked, DataStatus, numberText, statusLabel } from './research-common';
export type PerformanceView = 'summary' | 'imports' | 'ads';
export function PerformanceWorkspace({ client, onImprove, onAnalyze, onDirtyChange, viewRequest }: { client: CoreClient; onImprove: (input: ImprovementInput) => void; onAnalyze: (keyword: string) => void; onDirtyChange?: (dirty: boolean) => void; viewRequest?: { view: PerformanceView; nonce: number } | null }) {
  const [view, setView] = useState<PerformanceView>('summary');
  const [channelId, setChannel] = useState(0), [importId, setImport] = useState(0);
  const [status, setStatus] = useState<'open' | 'dismissed' | 'done'>('open');
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const qc = useQueryClient();
  useEffect(() => { if (viewRequest) setView(viewRequest.view); }, [viewRequest]);
  const channels = useQuery({ queryKey: ['web-performance', 'channels'], queryFn: () => client.listPerformanceChannels() });
  const imports = useQuery({ queryKey: ['web-performance', 'imports'], queryFn: () => client.listPerformanceImports(100) });
  const publications = useQuery({ queryKey: ['web-performance', 'publications'], queryFn: () => client.listPublishedContents('', false) });
  const enabled = channels.data?.items.filter(c => c.enabled) ?? [];
  const channel = enabled.find(c => c.id === channelId);
  const channelImports = useQuery({ queryKey: ['web-performance', 'channel-imports', channelId], queryFn: () => client.listPerformanceImports(100, channelId), enabled: !!channel });
  const selectedImports = channelImports.data?.items.filter(i => i.channel_id === channelId) ?? [];
  const selectedImport = selectedImports.find(i => i.id === importId);
  useEffect(() => {
    if (!channels.data) return;
    if (!enabled.some(c => c.id === channelId)) { setChannel(enabled[0]?.id ?? 0); setImport(0); }
  }, [channels.data, channelId]);
  useEffect(() => { if (channelImports.data && importId && !selectedImports.some(i => i.id === importId)) setImport(0); }, [channelImports.data, channelId, importId]);
  // Never fall back to another channel while the selected channel/import is changing.
  const valid = !!channel && (!importId || !!selectedImport);
  const overview = useQuery({ queryKey: ['web-performance', 'overview', channelId, importId], queryFn: () => client.performanceOverview(channelId, importId || undefined), enabled: valid });
  const contents = useQuery({ queryKey: ['web-performance', 'contents', channelId, importId], queryFn: () => client.contentPerformance(importId || undefined, channelId), enabled: valid && channel.source === 'creator_advisor' && (!selectedImport || selectedImport.data_kind === 'content_performance') });
  const queries = useQuery({ queryKey: ['web-performance', 'queries', channelId, importId], queryFn: () => client.queryPerformance(importId || undefined, channelId), enabled: valid && channel.source === 'creator_advisor' && (!selectedImport || selectedImport.data_kind === 'query_performance') });
  const recommendations = useQuery({ queryKey: ['web-performance', 'recommendations', channelId, status], queryFn: () => client.performanceRecommendations(status, channelId), enabled: !!channel });
  async function refresh() {
    await qc.invalidateQueries({ queryKey: ['web-performance'] });
    await qc.invalidateQueries({ queryKey: ['workbench-today'] });
    await qc.invalidateQueries({ queryKey: ['workbench-improvements'] });
  }
  async function mutate(action: () => Promise<unknown>) {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError('');
    try { await action(); await refresh(); } catch (e) { setError(message(e)); }
    finally { mutation.current = false; setBusy(false); }
  }
  const faults = [error, channels.error, imports.error, channelImports.error, overview.error, contents.error, queries.error, recommendations.error, publications.error].filter(Boolean);
  const features = { creator: channel?.source === 'creator_advisor', commerce: channel?.source === 'biz_advisor', website: channel?.source === 'search_advisor' };
  return <div className="performance-workspace"><section className="panel"><h2>발행한 콘텐츠의 실제 성과</h2><p>성과 표를 연결하면 채널별 실적을 확인하고 다음 글로 이어갈 수 있습니다. 네이버 로그인 비밀번호·쿠키를 받거나 통계를 자동 수집하지 않습니다.</p><div className="subnav" aria-label="성과 작업">{([['summary','성과 확인·개선'], ['imports','자료 가져오기·채널'], ['ads','광고 계정 성과']] as const).map(([key,label]) => <button key={key} aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}</div></section>
    {notice && <p role="status" className="notice">{notice}</p>}{faults.length > 0 && <p role="alert" className="notice error">{faults.map(f => typeof f === 'string' ? f : message(f)).join(' · ')}</p>}
    <div hidden={view !== 'summary'}>
      <section className="panel"><div className="section-title"><h2>확인할 채널과 자료</h2><button onClick={() => void refresh()}>저장 자료 다시 읽기</button></div><div className="form-grid"><div><label htmlFor="performance-channel">성과 채널</label><select id="performance-channel" value={channelId} onChange={e => { setChannel(Number(e.target.value)); setImport(0); setNotice(''); setError(''); }}><option value={0}>채널 선택</option>{enabled.map(c => <option key={c.id} value={c.id}>{c.display_name} · {({creator_advisor:'블로그',biz_advisor:'스토어',search_advisor:'웹사이트'})[c.source]}</option>)}</select></div><div><label htmlFor="performance-period">표시 자료</label><select id="performance-period" disabled={!channel} value={importId} onChange={e => setImport(Number(e.target.value))}><option value={0}>각 대상 최신 자료 · 행마다 기간 확인</option>{selectedImports.map(i => <option key={i.id} value={i.id}>#{i.id} · {i.period.start} ~ {i.period.end} · {i.data_kind === 'content_performance' ? '게시물' : i.data_kind === 'query_performance' ? '검색어' : i.data_kind === 'commerce_attribution' ? '스토어' : '웹사이트'}</option>)}</select></div></div><p>요약은 표시된 채널·기간·단위의 합계입니다. ‘각 대상 최신’ 목록은 행마다 기간이 다를 수 있어 목록 전체를 하나의 합계로 계산하지 않습니다. 가져오기 선택 시 목록은 해당 파일, 요약은 같은 기간·단위의 모든 파일을 집계합니다.</p>{!enabled.length && !channels.isFetching && <div className="notice"><p>연결된 활성 채널이 없습니다. 자료 가져오기에서 블로그·스토어·웹사이트를 선택하세요.</p><button className="primary" onClick={() => setView('imports')}>첫 성과 자료 연결하기</button></div>}{channels.isFetching && <p role="status">채널 확인 중…</p>}</section>
      {channel && valid && <><p className="notice">선택 채널: <strong>{channel.display_name}</strong> · 다른 채널 지표와 합산하지 않습니다. 자료 선택 목록은 이 채널의 최근 가져오기 최대 100건입니다. 개선 추천은 표시 자료 선택과 별개로 이 채널의 최신 유효 근거를 사용합니다.</p><fieldset disabled={busy}><PerformanceDashboard overview={overview.data ?? null} recommendations={status === 'open' ? recommendations.data?.items ?? [] : []} contents={contents.data?.items ?? []} queries={queries.data?.items ?? []} publications={publications.data?.items ?? []} features={features} loading={overview.isFetching || recommendations.isFetching} onAction={(item, action) => onImprove(buildImprovementInput(item, action))} onDismiss={id => void mutate(() => client.updatePerformanceRecommendation(id, 'dismissed'))} onMap={(id, publication) => void mutate(() => client.mapContentPerformance(id, publication))}/></fieldset>
      {!overview.isFetching && !contents.isFetching && !queries.isFetching && !overview.data?.creator && !overview.data?.commerce && !overview.data?.website && !contents.data?.items.length && !queries.data?.items.length && <p className="notice">선택한 조건의 성과 자료가 없습니다. 미수집을 0으로 표시하지 않습니다.</p>}
      <section className="panel"><h2>개선 작업 상태</h2><div className="subnav" aria-label="개선 상태">{([['open','진행할 작업'],['done','완료'],['dismissed','숨김']] as const).map(([value,label]) => <button key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>{label}</button>)}</div><ul className="record-list">{recommendations.data?.items.map(item => <li key={item.id}><div><strong>{item.published_title || item.keyword}</strong><p>{item.reason}</p><p>{item.period.start} ~ {item.period.end} · {item.calculation_version}</p></div><button disabled={busy} onClick={() => void mutate(() => client.updatePerformanceRecommendation(item.id, status === 'open' ? 'done' : 'open'))}>{status === 'open' ? '완료로 표시' : '다시 진행'}</button></li>)}</ul>{!recommendations.data?.items.length && <p>이 상태의 추천이 없습니다.</p>}</section></>}
    </div>
    <div hidden={view !== 'imports'}><PerformanceImportPanel expanded client={client} channels={channels.data?.items ?? []} imports={imports.data?.items ?? []} onChanged={() => void refresh()} onNotice={setNotice} onDirtyChange={onDirtyChange}/><TrackingLinkPanel client={client} publications={publications.data?.items ?? []} onNotice={setNotice}/><p className="muted">추적 링크는 스마트스토어의 공개 주소에 식별자를 붙이는 선택 기능입니다. 링크만 만들어도 클릭·매출이 자동 수집되지는 않습니다. 최근 가져오기 조회는 최대 100건입니다.</p></div>
    <div hidden={view !== 'ads'}><AdPerformancePanel client={client} onAnalyze={onAnalyze}/></div>
  </div>;
}
function dateInput(days = 0) { const d = new Date(); d.setDate(d.getDate() - days); return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10); }
export function AdPerformancePanel({ client, onAnalyze }: { client: CoreClient; onAnalyze: (keyword: string) => void }) {
  const [since,setSince]=useState(dateInput(6)),[until,setUntil]=useState(dateInput());
  const [response,setResponse]=useState<{key:string;value:AdPerformanceResponse}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirm,setConfirm]=useState(false);
  const lock=useRef(false),alive=useRef(true),key=JSON.stringify([since,until]),current=useRef(key); current.current=key;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{setConfirm(false);setError('');},[key]);
  const capabilities=useQuery({queryKey:['workbench-capabilities'],queryFn:()=>client.capabilities(),staleTime:30000});
  const denied=blocked(capabilities.data,['searchad']);
  const valid=!!since && !!until && since<=until && until<=dateInput();
  async function run(){if(lock.current||!valid||denied)return;lock.current=true;setBusy(true);setConfirm(false);setError('');const request=key;try{const value=await client.adPerformance(since,until,true);if(alive.current&&request===current.current)setResponse({key:request,value});}catch(e){if(alive.current&&request===current.current)setError(message(e));}finally{lock.current=false;if(alive.current)setBusy(false);}}
  const data=response?.key===key?response.value:null;
  return <section className="panel"><h2>광고 계정 성과 · 읽기 전용</h2><p>SearchAd 계정의 광고 실적입니다. 내 블로그 방문자·매출과 합산하지 않으며 광고 생성·수정은 하지 않습니다. 조회 전까지 API를 호출하지 않습니다.</p><div className="form-grid"><div><label htmlFor="ad-since">광고 시작일</label><input id="ad-since" type="date" value={since} onChange={e=>setSince(e.target.value)}/></div><div><label htmlFor="ad-until">광고 종료일</label><input id="ad-until" type="date" max={dateInput()} value={until} onChange={e=>setUntil(e.target.value)}/></div></div><button className="primary" disabled={busy||!valid||denied} onClick={()=>setConfirm(true)}>{busy?'광고 자료 조회 중…':'선택 기간 최신 조회'}</button>{confirm&&<div className="notice" role="group" aria-label="광고 조회 확인"><p>설정된 광고 계정의 캠페인·그룹·키워드·통계를 외부 조회합니다. 계정 규모에 따라 호출 수가 달라집니다. 실행할까요?</p><div className="action-row"><button onClick={()=>void run()}>확인하고 조회</button><button onClick={()=>setConfirm(false)}>취소</button></div></div>}{!valid&&<p role="alert">오늘까지의 올바른 시작·종료일을 선택하세요.</p>}{denied&&<p role="alert">광고 API 사용 한도에 도달했습니다.</p>}{error&&<p role="alert">{error}</p>}{data&&<><p>{statusLabel(data.status)} · {formatTime(data.collected_at)} · {data.period ? `${data.period.since} ~ ${data.period.until}` : '응답의 집계 기간 미제공'}</p><DataStatus values={data.data_status}/><p>캠페인 {numberText(data.campaign_count)}개 · 그룹 {numberText(data.adgroup_count)}개</p><div className="table-scroll"><table><thead><tr>{['키워드','노출','클릭','CTR (%)','CPC (원)','비용 (원)','전환','전환 가치 (원)','ROAS (%)','콘텐츠'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{data.rows.map(row=><tr key={row.id}><td>{row.keyword}<details><summary>계정 구분</summary>{row.campaign_id} / {row.adgroup_id}</details></td>{[row.impressions,row.clicks,row.ctr,row.cpc,row.cost,row.conversions,row.conversion_value,row.roas].map((n,i)=><td key={i}>{numberText(n,2)}</td>)}<td>{row.content.state} · 원고 {row.content.draft_count}개</td></tr>)}</tbody></table></div>{!data.rows.length&&<p>표시할 광고 성과가 없습니다. 자료별 연결 상태를 확인하세요.</p>}<h3>콘텐츠가 필요한 광고 키워드</h3><ul className="record-list">{data.recommendations.map((r,i)=><li key={i}><div><strong>{r.keyword}</strong><p>{r.reason}</p></div><button onClick={()=>onAnalyze(r.keyword)}>주제 분석 준비</button></li>)}</ul></>}</section>;
}
