import type {
  ContentPerformanceItem,
  PerformanceAction,
  PerformanceChannel,
  PerformanceChannelListResponse,
  PerformanceDataKind,
  PerformanceGrain,
  PerformanceImportPreview,
  PerformanceImportRequest,
  PerformanceImportRun,
  PerformanceOverviewResponse,
  PerformanceRecommendation,
  PerformanceSource,
  PublishedContent,
  QueryPerformanceItem,
  TrackingLinkResponse,
} from '@ncos/contracts';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CoreClient, CoreError } from '@ncos/core-client';
import { parsePerformanceTable, PERFORMANCE_TEMPLATES } from './performance-import';

const METRIC_LABELS: Record<string, string> = { views: '조회수', impressions: '노출', inflows: '유입', ctr: 'CTR', average_rank: '평균 순위', likes: '공감', comments: '댓글', product_views: '상품 조회', orders: '결제 건', conversion_rate: '결제율', attributed_revenue: '기여 금액', collected_pages: '수집 페이지', indexed_pages: '색인 페이지', clicks: '클릭' };

const SOURCE_LABEL: Record<PerformanceSource, string> = {
  creator_advisor: '내 블로그 성과',
  biz_advisor: '스마트스토어 성과',
  search_advisor: '독립 웹사이트 성과',
};

const KIND_LABEL: Record<PerformanceDataKind, string> = {
  content_performance: '게시물 성과',
  query_performance: '검색어 성과',
  commerce_attribution: '스토어 유입·기여',
  site_performance: '웹 검색 성과',
};

import { IMPROVEMENT_LABELS as ACTION_LABEL } from './improvement';
export { buildImprovementDraftParams } from './improvement';

const SOURCE_KINDS: Record<PerformanceSource, PerformanceDataKind[]> = {
  creator_advisor: ['content_performance', 'query_performance'],
  biz_advisor: ['commerce_attribution'],
  search_advisor: ['site_performance'],
};

function message(error: unknown): string {
  return error instanceof CoreError ? `${error.code}: ${error.message}` : '요청을 완료하지 못했습니다.';
}

function formatNumber(value: number | null | undefined, suffix = ''): string {
  return value == null ? '결측' : `${value.toLocaleString()}${suffix}`;
}

function formatCollectedAt(value: string | null | undefined): string {
  if (!value) return '수집 시각 미확인';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : `${parsed.toLocaleString()} 수집`;
}

function todayInput(daysAgo = 0): string {
  const value = new Date();
  value.setDate(value.getDate() - daysAgo);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function stateLabel(value: string): string {
  return {
    pending: '반영 대기', partial: '부분 데이터', observed_zero: '확인된 0', unavailable: '사용 불가', ready: '정상',
  }[value] ?? value;
}

export default function PerformanceWorkspace({
  client,
  onOpenImprovement,
}: {
  client: CoreClient;
  onOpenImprovement: (recommendation: PerformanceRecommendation, action: PerformanceAction) => void;
}) {
  const [contentImportId, setContentImportId] = useState(0);
  const [queryImportId, setQueryImportId] = useState(0);
  const channels = useQuery({ queryKey: ['performance-channels', client], queryFn: () => client.listPerformanceChannels() });
  const imports = useQuery({ queryKey: ['performance-imports', client], queryFn: () => client.listPerformanceImports() });
  const overview = useQuery({ queryKey: ['performance-overview', client], queryFn: () => client.performanceOverview() });
  const contents = useQuery({ queryKey: ['performance-contents', client, contentImportId], queryFn: () => client.contentPerformance(contentImportId || undefined) });
  const queries = useQuery({ queryKey: ['performance-queries', client, queryImportId], queryFn: () => client.queryPerformance(queryImportId || undefined) });
  const recommendations = useQuery({ queryKey: ['performance-recommendations', client], queryFn: () => client.performanceRecommendations() });
  const publications = useQuery({ queryKey: ['performance-publications', client], queryFn: () => client.listPublishedContents('', false) });
  const [notice, setNotice] = useState('');
  const contentImports = (imports.data?.items ?? []).filter((item) => item.data_kind === 'content_performance');
  const queryImports = (imports.data?.items ?? []).filter((item) => item.data_kind === 'query_performance');
  useEffect(() => {
    if (contentImportId && !contentImports.some((item) => item.id === contentImportId)) setContentImportId(0);
    if (queryImportId && !queryImports.some((item) => item.id === queryImportId)) setQueryImportId(0);
  }, [imports.dataUpdatedAt, contentImportId, queryImportId]);

  async function refreshAll() {
    await Promise.all([
      channels.refetch(), imports.refetch(), overview.refetch(), contents.refetch(),
      queries.refetch(), recommendations.refetch(), publications.refetch(),
    ]);
  }

  const queryError = [channels, imports, overview, contents, queries, recommendations, publications]
    .find((query) => query.isError)?.error;

  return (
    <section className="min-w-0 p-4" aria-label="내 콘텐츠 성과">
      <div className="rounded-2xl bg-gradient-to-br from-[#102a2e] to-[#19483f] p-5 text-white shadow-sm">
        <p className="text-[10px] font-semibold tracking-[0.14em] text-emerald-200">발행 후 성과 → 다음 글</p>
        <h2 className="mt-1 text-xl font-bold">내 성과</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-emerald-50/80">
          통계를 나열하지 않고 제목 개선·본문 최신화·후속 글 중 지금 할 일을 보여줍니다.
          계정 비밀번호나 로그인 쿠키는 받지 않습니다.
        </p>
      </div>

      {(notice || queryError) && (
        <p className={`mt-3 rounded-xl p-3 text-xs ${queryError ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-800'}`} role={queryError ? 'alert' : 'status'}>
          {queryError ? message(queryError) : notice}
        </p>
      )}

      {(contentImports.length > 0 || queryImports.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-[10px] text-slate-500" aria-label="성과 표시 기간">
          <b className="text-slate-700">목록 표시 기간</b>
          {contentImports.length > 0 && <label>게시물 <select className="ml-1 rounded border border-slate-300 px-2 py-1" value={contentImportId} onChange={(event) => setContentImportId(Number(event.target.value))}><option value={0}>각 게시물 최신</option>{contentImports.map((item) => <option key={item.id} value={item.id}>{item.period.start}–{item.period.end} · {item.grain}</option>)}</select></label>}
          {queryImports.length > 0 && <label>검색어 <select className="ml-1 rounded border border-slate-300 px-2 py-1" value={queryImportId} onChange={(event) => setQueryImportId(Number(event.target.value))}><option value={0}>각 검색어 최신</option>{queryImports.map((item) => <option key={item.id} value={item.id}>{item.period.start}–{item.period.end} · {item.grain}</option>)}</select></label>}
        </div>
      )}

      <PerformanceDashboard
        overview={overview.data ?? null}
        recommendations={recommendations.data?.items ?? []}
        contents={contents.data?.items ?? []}
        queries={queries.data?.items ?? []}
        publications={publications.data?.items ?? []}
        features={channels.data?.features ?? { creator: false, commerce: false, website: false }}
        loading={overview.isFetching || recommendations.isFetching}
        onAction={onOpenImprovement}
        onDismiss={(id) => void client.updatePerformanceRecommendation(id, 'dismissed').then(refreshAll).catch((error) => setNotice(message(error)))}
        onMap={(snapshotId, publicationId) => void client.mapContentPerformance(snapshotId, publicationId).then(refreshAll).catch((error) => setNotice(message(error)))}
      />

      <PerformanceImportPanel
        client={client}
        channels={channels.data?.items ?? []}
        imports={imports.data?.items ?? []}
        onChanged={() => void refreshAll()}
        onNotice={setNotice}
      />

      {channels.data?.features.commerce && (
        <TrackingLinkPanel
          client={client}
          publications={publications.data?.items ?? []}
          onNotice={setNotice}
        />
      )}
    </section>
  );
}

export function PerformanceDashboard({
  overview,
  recommendations,
  contents,
  queries,
  publications,
  features,
  loading,
  onAction,
  onDismiss,
  onMap,
}: {
  overview: PerformanceOverviewResponse | null;
  recommendations: PerformanceRecommendation[];
  contents: ContentPerformanceItem[];
  queries: QueryPerformanceItem[];
  publications: PublishedContent[];
  features: PerformanceChannelListResponse['features'];
  loading: boolean;
  onAction: (item: PerformanceRecommendation, action: PerformanceAction) => void;
  onDismiss: (id: number) => void;
  onMap: (snapshotId: number, publicationId: number) => void;
}) {
  const creator = overview?.creator;
  return (
    <div className="performance-dashboard mt-4 space-y-4">
      {!features.creator && !features.commerce && !features.website && !loading && (
        <div className="rounded-xl border border-dashed border-emerald-300 bg-white p-5 text-center">
          <h3 className="font-bold">먼저 성과 표를 연결하세요</h3>
          <p className="mt-1 text-xs text-slate-500">아래 가져오기에서 종류를 고르고 표를 붙여넣으면 됩니다.</p>
        </div>
      )}

      {features.creator && creator && (
        <section className="panel rounded-xl border border-slate-200 bg-white p-4" aria-label="Creator 성과 요약">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div><h3 className="font-bold">내 블로그 흐름</h3><p className="text-[10px] text-slate-400">{creator.channel_name || `채널 #${creator.channel_id}`} · {creator.period.start}–{creator.period.end} · {creator.grain} · {creator.source} · {formatCollectedAt(creator.collected_at)}</p></div>
            <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] text-emerald-700">{stateLabel(creator.status)}</span>
          </div>
          {creator.aggregation_note && <p className="mt-2 text-[10px] text-slate-500">{creator.aggregation_note}</p>}
          <div className="metric-row mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            {([
              ['노출', formatNumber(creator.metrics.impressions)],
              ['유입', formatNumber(creator.metrics.inflows)],
              ['유입률', formatNumber(creator.metrics.ctr, '%')],
              ['평균 순위', formatNumber(creator.metrics.average_rank, '위')],
            ] as const).map(([label, value], index) => (
              <div key={label} className="relative rounded-xl bg-slate-50 p-3">
                <p className="text-[10px] text-slate-400">{index > 0 ? '→ ' : ''}{label}</p>
                <p className="mt-1 text-lg font-bold text-slate-800">{value}</p>
                {creator.changes[label === '노출' ? 'impressions' : label === '유입' ? 'inflows' : label === '유입률' ? 'ctr' : 'average_rank'] != null && (
                  <p className="mt-1 text-[10px] text-slate-500">이전 대비 {creator.changes[label === '노출' ? 'impressions' : label === '유입' ? 'inflows' : label === '유입률' ? 'ctr' : 'average_rank']! > 0 ? '+' : ''}{creator.changes[label === '노출' ? 'impressions' : label === '유입' ? 'inflows' : label === '유입률' ? 'ctr' : 'average_rank']}%</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {features.creator && (
        <section className="panel rounded-xl border border-slate-200 bg-white p-4" aria-label="성과 개선 추천">
          <div className="flex items-center justify-between gap-2"><div><h3 className="font-bold">지금 개선할 일</h3><p className="text-xs text-slate-500">버튼을 눌러도 자동 작성하지 않습니다. 작업 유형을 선택한 뒤 완성 글 화면에서 최종 실행합니다.</p></div><span className="rounded bg-slate-100 px-2 py-1 text-xs">{recommendations.length}건</span></div>
          <div className="candidate-grid mt-3 grid gap-3 lg:grid-cols-2">
            {recommendations.length === 0 && <p className="rounded bg-slate-50 p-3 text-xs text-slate-500">현재 표본 조건을 만족하는 개선 작업이 없습니다.</p>}
            {recommendations.map((item) => (
              <article key={item.id} className="candidate-card rounded-xl border border-slate-200 p-3">
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-[10px] text-slate-400">{item.period.start}–{item.period.end} · {item.calculation_version}</p><h4 className="mt-1 truncate font-semibold">{item.published_title || item.keyword}</h4></div><span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700">근거 {item.confidence}</span></div>
                <p className="mt-2 text-xs leading-5 text-slate-600">{item.reason}</p>
                {item.draft_id && <p className="mt-1 text-[10px] text-slate-400">연결된 최신 Draft #{item.draft_id}를 참고하고, 결과는 새 Draft로 저장합니다.</p>}
                <div className="action-row mt-3 grid grid-cols-3 gap-1">
                  {(['improve_title', 'refresh_body', 'create_followup'] as const).map((action) => (
                    <button key={action} className={`rounded px-1 py-1.5 text-[10px] font-semibold ${item.action === action ? 'bg-indigo-600 text-white' : 'border border-slate-300 text-slate-600'}`} onClick={() => onAction(item, action)}>{ACTION_LABEL[action]}</button>
                  ))}
                </div>
                <button className="mt-2 text-[10px] text-slate-400 underline" onClick={() => onDismiss(item.id)}>이번 추천 숨기기</button>
              </article>
            ))}
          </div>
        </section>
      )}

      {features.creator && contents.length > 0 && (
        <section className="panel overflow-hidden rounded-xl border border-slate-200 bg-white" aria-label="게시물별 성과">
          <div className="border-b border-slate-100 p-4"><h3 className="font-bold">게시물별 성과</h3><p className="text-xs text-slate-500">시장 수요와 내 실적은 합산하지 않고 옆에 표시합니다.</p></div>
          <div className="table-scroll overflow-x-auto"><table className="w-full min-w-[920px] text-left text-xs"><thead className="bg-slate-50 text-[10px] text-slate-500"><tr><th className="p-3">게시물</th><th>상태</th><th>내 노출</th><th>내 유입</th><th>CTR</th><th>평균 순위</th><th>시장 검색량</th><th>검색 추이 참고</th><th>SERP 표본</th><th>발행 글 연결</th></tr></thead><tbody>
            {contents.map((item) => <tr key={item.id} className="border-t border-slate-100"><td className="max-w-60 p-3"><p className="truncate font-medium">{item.title || item.canonical_url || '제목 없음'}</p><p className="mt-0.5 truncate text-[10px] text-slate-400">{item.period.start}–{item.period.end}</p><details><summary>조회·반응 지표</summary><p>조회수 {formatNumber(item.metrics.views)} · 공감 {formatNumber(item.metrics.likes)} · 댓글 {formatNumber(item.metrics.comments)}</p></details></td><td><span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px]">{stateLabel(item.data_state)}</span></td><td>{formatNumber(item.metrics.impressions)}</td><td>{formatNumber(item.metrics.inflows)}</td><td>{formatNumber(item.metrics.ctr, '%')}</td><td>{formatNumber(item.metrics.average_rank, '위')}</td><td><p>{formatNumber(item.market.searchad?.monthly_searches)}</p><p className="text-[9px] text-slate-400">SEARCH_AD · {formatCollectedAt(item.market.searchad?.collected_at)}</p></td><td><p>{formatNumber(item.market.trend?.latest_ratio)}</p><p className="text-[9px] text-slate-400">상대지수 · 검색 횟수 아님</p><p className="text-[9px] text-slate-400">NAVER_API_HUB · {formatCollectedAt(item.market.trend?.collected_at)}</p>{item.market.trend?.note && <p>{item.market.trend.note}</p>}</td><td><p>{formatNumber(item.market.serp?.sample_count)}</p><p className="text-[9px] text-slate-400">현재 화면·최대 10</p></td><td>{item.mapped ? <span className="text-emerald-700">연결됨</span> : <select aria-label={`${item.title || '게시물'} 발행 글 연결`} className="max-w-44 rounded border border-slate-300 px-1 py-1 text-[10px]" defaultValue="" onChange={(event) => { const id = Number(event.target.value); if (id) onMap(item.id, id); }}><option value="">직접 선택</option>{publications.map((publication) => <option key={publication.id} value={publication.id}>{publication.title}</option>)}</select>}</td></tr>)}
          </tbody></table></div>
        </section>
      )}

      {features.creator && queries.length > 0 && (
        <section className="panel rounded-xl border border-slate-200 bg-white p-4" aria-label="검색어 성과">
          <h3 className="font-bold">유입 검색어</h3>
          <div className="candidate-grid mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{queries.map((item) => <article key={item.id} className="candidate-card rounded-lg bg-slate-50 p-3"><p className="font-medium">{item.query}</p><p className="mt-1 text-[10px] text-slate-500">{item.period.start}–{item.period.end} · {stateLabel(item.data_state)}</p><p className="mt-1 text-[10px] text-slate-500">노출 {formatNumber(item.metrics.impressions)} · 유입 {formatNumber(item.metrics.inflows)} · CTR {formatNumber(item.metrics.ctr, '%')} · 평균 {formatNumber(item.metrics.average_rank, '위')}</p></article>)}</div>
        </section>
      )}

      {features.commerce && overview?.commerce && <OptionalSummary title="스마트스토어 유입·기여" summary={overview.commerce} warning="Biz 집계 기준의 기여 성과이며 블로그 글의 직접 매출로 단정하지 않습니다." />}
      {features.website && overview?.website && <OptionalSummary title="독립 웹사이트 웹 검색 성과" summary={overview.website} warning="네이버 블로그가 아닌 소유 확인된 사이트 전용이며 약 1주 지연·최근 90일 범위입니다." />}
    </div>
  );
}

function OptionalSummary({ title, summary, warning }: { title: string; summary: NonNullable<PerformanceOverviewResponse['commerce']>; warning: string }) {
  const labels: Record<string, string> = {
    inflows: '유입', product_views: '상품 조회', orders: '결제 건', conversion_rate: '결제율',
    attributed_revenue: '기여 금액', collected_pages: '수집 페이지', indexed_pages: '색인 페이지',
    impressions: '웹 노출', clicks: '웹 클릭', ctr: 'CTR',
  };
  return <section className="panel rounded-xl border border-slate-200 bg-white p-4"><h3 className="font-bold">{title}</h3><p className="mt-1 text-[10px] text-slate-400">{summary.channel_name || `채널 #${summary.channel_id}`} · {summary.period.start}–{summary.period.end} · {summary.source} · {formatCollectedAt(summary.collected_at)}</p><p className="mt-1 text-[10px] text-amber-700">{warning}</p><div className="action-row mt-3 flex flex-wrap gap-2">{Object.entries(summary.metrics).map(([key, value], index) => <div key={key} className="min-w-28 rounded bg-slate-50 p-2"><p className="text-[9px] text-slate-400">{index > 0 ? '→ ' : ''}{labels[key] ?? key}</p><p className="font-semibold">{formatNumber(value, key.includes('rate') || key === 'ctr' ? '%' : key === 'attributed_revenue' ? '원' : '')}</p></div>)}</div></section>;
}

export function PerformanceImportPanel({
  client,
  channels,
  imports,
  onChanged,
  onNotice,
  onDirtyChange,
  expanded = false,
}: {
  expanded?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  client: CoreClient;
  channels: PerformanceChannel[];
  imports: PerformanceImportRun[];
  onChanged: () => void;
  onNotice: (value: string) => void;
}) {
  const operation = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [source, setSource] = useState<PerformanceSource>('creator_advisor');
  const [kind, setKind] = useState<PerformanceDataKind>('content_performance');
  const [channelId, setChannelId] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [addingChannel, setAddingChannel] = useState(false);
  const [channelName, setChannelName] = useState('내 블로그');
  const [siteUrl, setSiteUrl] = useState('');
  const [ownershipConfirmed, setOwnershipConfirmed] = useState(false);
  const [periodStart, setPeriodStart] = useState(todayInput(6));
  const [periodEnd, setPeriodEnd] = useState(todayInput());
  const [grain, setGrain] = useState<PerformanceGrain>('weekly');
  const [table, setTable] = useState('');
  const [localPreview, setLocalPreview] = useState<ReturnType<typeof parsePerformanceTable> | null>(null);
  const [previewResponse, setServerPreview] = useState<PerformanceImportPreview | null>(null);
  const verifiedRequest = useRef<PerformanceImportRequest | null>(null);
  const requestEpoch = useRef(0);
  const saving = useRef(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const sourceChannels = useMemo(() => channels.filter((channel) => channel.source === source), [channels, source]);
  useEffect(() => { onDirtyChange?.(!!table.trim() || !!busy); }, [table, busy, onDirtyChange]);
  const signature = JSON.stringify([source, kind, channelId, periodStart, periodEnd, grain, table]);
  const currentInput = useRef({ signature, client });
  currentInput.current = { signature, client };
  const verifiedInput = useRef<typeof currentInput.current | null>(null);
  const serverPreview = verifiedInput.current?.signature === signature && verifiedInput.current.client === client ? previewResponse : null;

  useEffect(() => {
    ++requestEpoch.current;
    verifiedRequest.current = null;
    verifiedInput.current = null;
    setServerPreview(null);
    return () => { ++requestEpoch.current; };
  }, [signature, client]);

  useEffect(() => {
    const active = sourceChannels.find((channel) => channel.enabled) ?? sourceChannels[0];
    setChannelId((current) => sourceChannels.some((channel) => channel.id === current) ? current : active?.id ?? 0);
  }, [source, sourceChannels]);

  function changeSource(next: PerformanceSource) {
    if (operation.current) return;
    setSource(next);
    setKind(SOURCE_KINDS[next][0]);
    setChannelName(next === 'creator_advisor' ? '내 블로그' : next === 'biz_advisor' ? '내 스토어' : '내 웹사이트');
    setAddingChannel(false); setOwnershipConfirmed(false); setTable(''); setLocalPreview(null); setServerPreview(null); setError('');
  }

  async function maintain(action: () => Promise<unknown>) {
    if (operation.current || busy) return;
    operation.current = true; setBusy('maintenance'); setError('');
    try { await action(); if (alive.current) setPendingDelete(null); onChanged(); }
    catch (cause) { if (alive.current) setError(message(cause)); }
    finally { operation.current = false; if (alive.current) setBusy(''); }
  }

  async function createChannel() {
    if (operation.current) return;
    operation.current = true;
    const input = currentInput.current;
    setBusy('channel'); setError('');
    try {
      const created = await client.createPerformanceChannel({
        source,
        display_name: channelName,
        site_url: source === 'search_advisor' ? siteUrl : null,
        ownership_confirmed: source === 'search_advisor' && ownershipConfirmed,
      });
      if (alive.current && input.signature === currentInput.current.signature) { setChannelId(created.id); setAddingChannel(false); } onChanged(); onNotice(`${created.display_name} 연결을 만들었습니다.`);
    } catch (cause) { setError(message(cause)); } finally { operation.current = false; if (alive.current) setBusy(''); }
  }

  function requestFrom(rows: PerformanceImportRequest['rows']): PerformanceImportRequest {
    return { channel_id: channelId, source, data_kind: kind, period_start: periodStart, period_end: periodEnd, grain, rows };
  }

  async function readFile(file: File) {
    const epoch = ++requestEpoch.current;
    const input = currentInput.current;
    const isCurrent = () => epoch === requestEpoch.current && input.signature === currentInput.current.signature && input.client === currentInput.current.client;
    setLocalPreview(null); setServerPreview(null); setError('');
    try {
      const text = await file.text();
      if (isCurrent()) setTable(text);
    } catch {
      if (isCurrent()) setError('파일을 읽지 못했습니다. 파일을 다시 선택하거나 표를 붙여넣으세요.');
    }
  }

  async function preview() {
    if (saving.current) return;
    const epoch = ++requestEpoch.current;
    const input = currentInput.current;
    const parsed = parsePerformanceTable(table, kind);
    setLocalPreview(parsed); setServerPreview(null); setError('');
    if (parsed.errors.length) return;
    if (!channelId) { setError('먼저 이 데이터의 채널을 연결하세요.'); return; }
    const request = requestFrom(parsed.rows);
    const isCurrent = () => epoch === requestEpoch.current && input.signature === currentInput.current.signature && input.client === currentInput.current.client;
    setBusy('preview');
    try {
      const response = await client.previewPerformanceImport(request);
      if (isCurrent()) {
        verifiedInput.current = input;
        verifiedRequest.current = request;
        setServerPreview(response);
      }
    }
    catch (cause) { if (isCurrent()) setError(message(cause)); }
    finally { setBusy(''); }
  }

  async function save() {
    if (saving.current || !serverPreview || !verifiedRequest.current) return;
    saving.current = true; operation.current = true;
    const input = currentInput.current;
    const request = verifiedRequest.current;
    setBusy('save'); setError('');
    try {
      const saved = await client.createPerformanceImport(request);
      onNotice(saved.duplicate ? '같은 자료가 이미 있어 중복 저장하지 않았습니다.' : `${saved.row_count}행을 안전하게 가져왔습니다.`);
      if (alive.current && input.signature === currentInput.current.signature) { setServerPreview(null); setTable(''); setLocalPreview(null); } onChanged();
    } catch (cause) { setError(message(cause)); }
    finally { saving.current = false; operation.current = false; if (alive.current) setBusy(''); }
  }

  return (
    <details className="performance-tool panel mt-4 rounded-xl border border-slate-200 bg-white" open={expanded || !channels.length}>
      <summary className="cursor-pointer list-none p-4 font-bold marker:hidden">성과 자료 가져오기 <span className="font-normal text-slate-400">· 표 붙여넣기 또는 CSV</span></summary>
      <fieldset disabled={!!busy && busy !== 'preview'} className="border-t border-slate-100 p-4">
        <ol className="grid gap-2 text-xs md:grid-cols-4"><li className="rounded bg-emerald-50 p-2"><b>1.</b> 종류 선택</li><li className="rounded bg-emerald-50 p-2"><b>2.</b> 채널 연결</li><li className="rounded bg-emerald-50 p-2"><b>3.</b> 표 미리보기</li><li className="rounded bg-emerald-50 p-2"><b>4.</b> 로컬 저장</li></ol>
        <div className="subnav mt-4 grid grid-cols-3 gap-2" aria-label="성과 자료 종류">{(Object.keys(SOURCE_LABEL) as PerformanceSource[]).map((value) => <button key={value} className={`rounded-lg px-2 py-2 text-xs font-semibold ${source === value ? 'bg-[#102a2e] text-white' : 'bg-slate-100 text-slate-600'}`} aria-pressed={source === value} onClick={() => changeSource(value)}>{SOURCE_LABEL[value]}</button>)}</div>
        <div className="action-row mt-3 flex flex-wrap gap-2">{SOURCE_KINDS[source].map((value) => <button key={value} className={`rounded-full px-2 py-1 text-[10px] ${kind === value ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`} aria-pressed={kind === value} onClick={() => { setKind(value); setServerPreview(null); }}>{KIND_LABEL[value]}</button>)}</div>

        <div className="performance-form mt-4 grid gap-2 md:grid-cols-[1fr_1fr_auto]">
          {sourceChannels.length > 0 && !addingChannel ? <select aria-label="연결 채널" value={channelId} onChange={(event) => setChannelId(Number(event.target.value))} className="rounded-lg border border-slate-300 px-3 py-2 text-xs"><option value={0}>채널 선택</option>{sourceChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.display_name}{channel.enabled ? '' : ' (꺼짐)'}</option>)}</select> : <input aria-label="채널 이름" value={channelName} onChange={(event) => setChannelName(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs" placeholder="채널 표시 이름" />}
          {source === 'search_advisor' ? <input aria-label="독립 웹사이트 URL" value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs" placeholder="https://example.com" /> : <div className="rounded-lg bg-slate-50 px-3 py-2 text-[10px] text-slate-500">비밀번호·쿠키 없이 집계표만 사용</div>}
          {sourceChannels.length > 0 && !addingChannel ? <button className="rounded-lg border border-emerald-300 px-3 py-2 text-xs font-semibold text-emerald-700" onClick={() => { setAddingChannel(true); setChannelId(0); }}>새 채널</button> : <button disabled={busy === 'channel' || !channelName.trim() || (source === 'search_advisor' && (!siteUrl.trim() || !ownershipConfirmed))} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40" onClick={() => void createChannel()}>채널 연결</button>}
        </div>
        {source === 'search_advisor' && (addingChannel || sourceChannels.length === 0) && <label className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-[10px] text-amber-800"><input type="checkbox" checked={ownershipConfirmed} onChange={(event) => setOwnershipConfirmed(event.target.checked)} /><span>내가 소유·관리하고 Search Advisor에서 확인한 독립 웹사이트입니다. 네이버 블로그·SmartStore는 등록하지 않습니다.</span></label>}

        <div className="performance-form mt-3 grid grid-cols-3 gap-2"><label className="text-[10px] text-slate-500">시작일<input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-xs" /></label><label className="text-[10px] text-slate-500">종료일<input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-xs" /></label><label className="text-[10px] text-slate-500">집계 단위<select value={grain} onChange={(event) => setGrain(event.target.value as PerformanceGrain)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-xs"><option value="daily">일간</option><option value="weekly">주간</option><option value="monthly">월간</option></select></label></div>

        <div className="mt-3 flex flex-wrap items-center gap-2"><button className="rounded border border-slate-300 px-2 py-1 text-[10px]" onClick={() => { setTable(PERFORMANCE_TEMPLATES[kind]); setLocalPreview(null); setServerPreview(null); }}>샘플 양식 넣기</button><label className="cursor-pointer rounded border border-slate-300 px-2 py-1 text-[10px]">CSV/TSV 파일 읽기<input type="file" className="sr-only" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }} /></label><span className="text-[10px] text-slate-400">파일 원본은 서버에 전송하거나 저장하지 않습니다.</span></div>
        <textarea aria-label="성과 표 붙여넣기" value={table} onChange={(event) => { setTable(event.target.value); setLocalPreview(null); setServerPreview(null); }} className="mt-2 min-h-40 w-full resize-y rounded-xl border border-slate-300 p-3 font-mono text-[11px] leading-5" placeholder="스프레드시트 표를 헤더와 함께 붙여넣으세요." />
        <button disabled={!table.trim() || !!busy} className="mt-2 w-full rounded-lg bg-slate-800 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40" onClick={() => void preview()}>{busy === 'preview' ? '검증 중…' : '열 매핑·미리보기'}</button>

        {localPreview && <div className="mt-3 rounded-xl bg-slate-50 p-3"><p className="text-xs font-semibold">열 매핑</p><div className="mt-2 flex flex-wrap gap-1">{localPreview.headers.map((header) => <span key={header.original} className={`rounded px-1.5 py-0.5 text-[10px] ${header.mapped ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-500'}`}>{header.original} → {header.mapped ?? '제외'}</span>)}</div>{localPreview.warnings.map((warning) => <p key={warning} className="mt-2 text-[10px] text-amber-700">{warning}</p>)}{localPreview.errors.map((item) => <p key={item} className="mt-2 text-[10px] text-rose-700">{item}</p>)}</div>}
        {serverPreview && <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3"><p className="text-xs font-semibold text-emerald-900">저장 전 확인 · {serverPreview.row_count}행</p><p className="mt-1 text-[10px] text-emerald-700">{serverPreview.period.start}–{serverPreview.period.end} · {KIND_LABEL[serverPreview.data_kind]} · 원본 미저장</p><div className="table-scroll mt-2 max-h-48 overflow-auto rounded border border-emerald-200 bg-white" aria-label="정규화된 성과 미리보기"><table className="w-full text-left text-[10px]"><thead><tr><th className="p-2">대상</th><th>상태</th><th>저장 지표</th></tr></thead><tbody>{serverPreview.rows.slice(0, 5).map((row, index) => <tr key={index}><td className="p-2">{String(('title' in row && row.title) || ('query' in row && row.query) || ('canonical_url' in row && row.canonical_url) || ('tracking_id' in row && row.tracking_id) || ('page_url' in row && row.page_url) || '대상')}</td><td>{stateLabel(String(row.data_state ?? 'partial'))}</td><td>{Object.entries(row).filter(([key]) => Object.hasOwn(METRIC_LABELS, key)).map(([key, value]) => `${METRIC_LABELS[key]}: ${formatNumber(value as number | null)}`).join(' · ')}</td></tr>)}</tbody></table></div><p className="mt-1 text-[10px] text-emerald-700">최대 5행 표시 · 값을 수정하면 미리보기를 다시 확인해야 합니다.</p>{serverPreview.warnings.map((warning) => <p key={warning} className="mt-1 text-[10px] text-amber-700">{warning}</p>)}<button disabled={busy === 'save'} className="mt-3 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40" onClick={() => void save()}>{busy === 'save' ? '저장 중…' : '확인하고 로컬 저장'}</button></div>}
        {error && <p className="mt-3 rounded bg-rose-50 p-2 text-xs text-rose-700" role="alert">{error}</p>}

        {channels.length > 0 && <div className="mt-5 border-t border-slate-100 pt-4"><h4 className="text-xs font-bold">연결된 채널</h4><div className="mt-2 flex flex-wrap gap-2">{channels.map((channel) => <label key={channel.id} className="flex items-center gap-2 rounded border border-slate-200 px-2 py-1.5 text-[10px]"><input type="checkbox" checked={channel.enabled} onChange={(event) => void maintain(() => client.updatePerformanceChannel(channel.id, event.target.checked))} /><span>{channel.display_name} · {SOURCE_LABEL[channel.source]}</span></label>)}</div></div>}
        {imports.length > 0 && <div className="mt-4"><h4 className="text-xs font-bold">최근 가져오기 · {imports.length}건</h4><div className="mt-2 space-y-1">{imports.map((item) => <div key={item.id} className="flex items-center gap-2 rounded bg-slate-50 px-2 py-1.5 text-[10px]"><span className="min-w-0 flex-1 truncate">#{item.id} · {channels.find(c => c.id === item.channel_id)?.display_name ?? `채널 #${item.channel_id}`} · {KIND_LABEL[item.data_kind]} · {item.period.start}–{item.period.end} · {item.row_count}행 · {item.status}</span><button className="text-rose-600 underline" onClick={() => setPendingDelete(item.id)}>삭제</button>{pendingDelete === item.id && <div role="group" aria-label="가져오기 삭제 확인"><p>이 자료와 연결된 성과 지표·추천을 삭제합니다. 작성한 원고는 보존합니다.</p><button onClick={() => void maintain(() => client.deletePerformanceImport(item.id))}>삭제 확인</button><button onClick={() => setPendingDelete(null)}>취소</button></div>}</div>)}</div></div>}
      </fieldset>
    </details>
  );
}

export function TrackingLinkPanel({ client, publications, onNotice }: { client: CoreClient; publications: PublishedContent[]; onNotice: (value: string) => void }) {
  const [destination, setDestination] = useState('');
  const [source, setSource] = useState('naver.blog');
  const [medium, setMedium] = useState('social');
  const [detail, setDetail] = useState('');
  const [keyword, setKeyword] = useState('');
  const [publicationId, setPublicationId] = useState(0);
  const [resolved, setResolved] = useState<{ signature: string; value: TrackingLinkResponse } | null>(null);
  const signature = JSON.stringify([destination, source, medium, detail, keyword, publicationId]);
  const current = useRef(signature); current.current = signature;
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const result = resolved?.signature === signature ? resolved.value : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function build() {
    if (lock.current) return;
    lock.current = true; const requestKey = signature;
    setBusy(true); setError(''); setResolved(null);
    try { const value = await client.buildTrackingLink({ destination_url: destination, nt_source: source, nt_medium: medium, nt_detail: detail, nt_keyword: keyword, published_content_id: publicationId || null }); if (alive.current && requestKey === current.current) setResolved({ signature: requestKey, value }); }
    catch (cause) { if (alive.current && requestKey === current.current) setError(message(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <details className="performance-tool panel mt-4 rounded-xl border border-slate-200 bg-white"><summary className="cursor-pointer list-none p-4 font-bold marker:hidden">스마트스토어 추적 링크 만들기 <span className="font-normal text-slate-400">· 선택 기능</span></summary><div className="border-t border-slate-100 p-4"><p className="text-xs text-slate-500">공식 사용자 정의 채널 파라미터만 사용합니다. 영문·숫자와 <code>-_.</code>만 사용하고 값은 100자 이하로 제한합니다.</p><div className="performance-form mt-3 grid gap-2 md:grid-cols-2"><input aria-label="스마트스토어 URL" value={destination} onChange={(event) => setDestination(event.target.value)} className="rounded border border-slate-300 px-3 py-2 text-xs md:col-span-2" placeholder="https://smartstore.naver.com/..." /><input aria-label="nt_source" value={source} onChange={(event) => setSource(event.target.value)} className="rounded border border-slate-300 px-3 py-2 text-xs" placeholder="nt_source" /><input aria-label="nt_medium" value={medium} onChange={(event) => setMedium(event.target.value)} className="rounded border border-slate-300 px-3 py-2 text-xs" placeholder="nt_medium" /><input aria-label="nt_detail" value={detail} onChange={(event) => setDetail(event.target.value)} className="rounded border border-slate-300 px-3 py-2 text-xs" placeholder="nt_detail (선택)" /><input aria-label="nt_keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} className="rounded border border-slate-300 px-3 py-2 text-xs" placeholder="nt_keyword (선택)" /><select aria-label="연결할 발행 콘텐츠" value={publicationId} onChange={(event) => setPublicationId(Number(event.target.value))} className="rounded border border-slate-300 px-3 py-2 text-xs md:col-span-2"><option value={0}>발행 글 연결 안 함</option>{publications.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div><button disabled={busy || !destination || !source || !medium} onClick={() => void build()} className="mt-3 rounded bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{busy ? '확인 중…' : '추적 링크 만들기'}</button>{error && <p className="mt-2 text-xs text-rose-700">{error}</p>}{result && <div className="mt-3 rounded bg-indigo-50 p-3"><p className="text-[10px] font-semibold text-indigo-700">추적 ID · {result.tracking_id}</p><p className="mt-1 break-all text-xs text-indigo-900">{result.url}</p><p className="mt-1 text-[10px] text-indigo-700">{result.attribution_note}</p><button className="mt-2 rounded border border-indigo-300 bg-white px-2 py-1 text-[10px]" onClick={() => void navigator.clipboard.writeText(result.url).then(() => onNotice('추적 링크를 복사했습니다.')).catch(() => setError('복사 권한이 없습니다. 표시된 링크를 직접 복사하세요.'))}>복사</button></div>}</div></details>;
}
