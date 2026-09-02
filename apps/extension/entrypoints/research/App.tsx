import type {
  AdPerformanceResponse,
  AudienceResponse,
  CommercialResponse,
  ResearchGraphNode,
  ResearchGraphResponse,
  RisingMode,
  RisingResponse,
  SpecializedResponse,
  WatchlistItem,
} from '@ncos/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CoreClient, CoreError } from '~/lib/core';
import { useSettings } from '~/lib/settings';

type WorkspaceView = 'graph' | 'rising' | 'watchlist' | 'specialized' | 'performance';

const COLORS = ['#059669', '#2563eb', '#7c3aed', '#db2777', '#d97706', '#0891b2', '#475569'];

function colorFor(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function money(value: number | null): string {
  return value == null ? '결측' : `${Math.round(value).toLocaleString()}원`;
}

function errorText(error: unknown): string {
  return error instanceof CoreError ? `${error.code}: ${error.message}` : '요청을 완료하지 못했습니다.';
}

function safeExternalUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '#';
  } catch {
    return '#';
  }
}

export default function App() {
  const settings = useSettings();
  const params = new URLSearchParams(window.location.search);
  const [keyword, setKeyword] = useState(params.get('keyword') ?? '');
  const [snapshotId, setSnapshotId] = useState<number | null>(Number(params.get('snapshot_id')) || null);
  const [view, setView] = useState<WorkspaceView>('graph');
  const [graph, setGraph] = useState<ResearchGraphResponse | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [minimumVolume, setMinimumVolume] = useState(0);
  const [commercial, setCommercial] = useState<CommercialResponse | null>(null);
  const [audience, setAudience] = useState<AudienceResponse | null>(null);
  const [specialized, setSpecialized] = useState<SpecializedResponse | null>(null);
  const [specialMode, setSpecialMode] = useState<'local' | 'shopping' | 'image'>('local');
  const [shoppingCategory, setShoppingCategory] = useState('');
  const [performance, setPerformance] = useState<AdPerformanceResponse | null>(null);
  const [rising, setRising] = useState<RisingResponse | null>(null);
  const [risingMode, setRisingMode] = useState<RisingMode>('general');
  const [risingRegion, setRisingRegion] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => { void settings.load(); }, []);
  const client = useMemo(() => new CoreClient(settings.coreUrl, settings.token), [settings.coreUrl, settings.token]);
  const capabilities = useQuery({
    queryKey: ['research-capabilities', settings.coreUrl, settings.token],
    queryFn: () => client.capabilities(),
    enabled: settings.loaded && !!settings.token,
  });
  const watchlist = useQuery({
    queryKey: ['research-watchlist', settings.coreUrl, settings.token],
    queryFn: () => client.listWatchlist(),
    enabled: settings.loaded && !!settings.token && view === 'watchlist',
  });

  useEffect(() => {
    if (view !== 'rising' || !settings.token) return;
    if (risingMode === 'local' && !risingRegion.trim()) { setRising(null); return; }
    if (risingMode === 'shopping' && !shoppingCategory.trim()) { setRising(null); return; }
    if (risingMode !== 'local' && !keyword.trim()) { setRising(null); return; }
    let active = true;
    void client.latestRising({ seed: keyword, mode: risingMode, region: risingRegion, category: shoppingCategory })
      .then((response) => { if (active) setRising(response.run); })
      .catch(() => { if (active) setRising(null); });
    return () => { active = false; };
  }, [client, keyword, risingMode, risingRegion, settings.token, shoppingCategory, view]);

  const selected = graph?.nodes.find((node) => node.id === selectedId) ?? graph?.nodes[0] ?? null;

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setNotice('');
    try { await action(); } catch (error) { setNotice(errorText(error)); } finally { setBusy(''); }
  }

  async function buildGraph(force = false) {
    if (!keyword.trim()) return;
    await run('graph', async () => {
      const result = await client.graph(keyword, snapshotId, force);
      setGraph(result);
      setSelectedId(result.nodes[0]?.id ?? '');
    });
  }

  async function analyzeCommercial() {
    if (!selected) return;
    await run('commercial', async () => setCommercial(await client.commercial([selected.keyword])));
  }

  async function analyzeAudience() {
    if (!selected) return;
    if (!window.confirm('기기 2·성별 2·연령 11개 상대 추세를 조회합니다. 최대 15회 호출을 진행할까요?')) return;
    await run('audience', async () => setAudience(await client.audience(selected.keyword)));
  }

  async function addSelectedToWatchlist() {
    if (!selected) return;
    await run('watch-add', async () => {
      await client.addWatchlist(selected.keyword);
      setNotice(`${selected.keyword}을 Watchlist에 추가했습니다.`);
    });
  }

  async function collectRising() {
    if (risingMode === 'local' && !risingRegion.trim()) { setNotice('지역명을 입력하세요.'); return; }
    if (risingMode === 'shopping' && !shoppingCategory.trim()) { setNotice('쇼핑 category code를 입력하세요.'); return; }
    if (risingMode !== 'local' && !keyword.trim()) { setNotice('주제 키워드를 입력하세요.'); return; }
    if (!window.confirm('최근 14일 추세와 뉴스 표본을 수집합니다. 최대 10회 provider 호출을 진행할까요?')) return;
    await run('rising', async () => setRising(await client.rising({
      seed: keyword,
      mode: risingMode,
      region: risingRegion,
      category: shoppingCategory,
      candidate_limit: 20,
      force_refresh: true,
    })));
  }

  async function analyzeRisingKeyword(nextKeyword: string) {
    await run('rising-analyze', async () => {
      const analyzed = await client.analyze(nextKeyword, null);
      setKeyword(analyzed.keyword);
      setSnapshotId(analyzed.snapshot_id);
      setGraph(null);
      setSelectedId('');
      setView('graph');
      setNotice(`${analyzed.keyword} 재분석을 완료했습니다. 새 snapshot #${analyzed.snapshot_id}`);
    });
  }

  const providerEntries = Object.entries(capabilities.data?.providers ?? {});
  const searchadBlocked = capabilities.data?.providers.searchad?.quota?.blocked ?? false;
  const trendBlocked = capabilities.data?.providers.hub_trend?.quota?.blocked ?? false;
  const searchBlocked = capabilities.data?.providers.hub_search?.quota?.blocked ?? false;
  const shoppingBlocked = capabilities.data?.providers.hub_shopping?.quota?.blocked ?? false;

  return (
    <div className="min-h-screen bg-slate-100 text-sm text-slate-900">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div>
          <h1 className="text-base font-bold">Research Workspace</h1>
          <p className="text-[10px] text-slate-400">조회 전용 · 자동 갱신 없음</p>
        </div>
        <input className="min-w-52 flex-1 rounded-lg border border-slate-300 px-3 py-2" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="연구할 키워드" />
        <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-500">snapshot #{snapshotId ?? '없음'}</span>
        {providerEntries.map(([name, provider]) => (
          <span key={name} className={`rounded-full px-2 py-1 text-[10px] ${provider.status === 'ok' || provider.status === 'configured' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
            {name} {provider.status}{provider.quota?.warning ? ' · quota 경고' : ''}
          </span>
        ))}
      </header>

      {notice && <div className="mx-4 mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">{notice}</div>}
      {settings.loaded && !settings.token && <div className="mx-4 mt-3 rounded-lg bg-rose-50 p-3 text-xs text-rose-700">사이드패널 설정에서 Local Core 토큰을 먼저 저장하세요.</div>}

      <main className="grid min-h-[calc(100vh-68px)] grid-cols-1 lg:grid-cols-[210px_minmax(0,1fr)]">
        <aside className="border-r border-slate-200 bg-white p-3">
          <nav className="space-y-1">
            {([
              ['graph', '키워드 맵'],
              ['rising', '급상승'],
              ['watchlist', 'Watchlist'],
              ['specialized', '특화 분석'],
              ['performance', '광고 성과'],
            ] as const).map(([value, label]) => (
              <button key={value} className={`w-full rounded-lg px-3 py-2 text-left text-xs font-medium ${view === value ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`} onClick={() => setView(value)}>{label}</button>
            ))}
          </nav>
          {view === 'graph' && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <label className="text-[11px] text-slate-500">최소 검색량 {minimumVolume.toLocaleString()}</label>
              <input className="mt-1 w-full" type="range" min="0" max="10000" step="100" value={minimumVolume} onChange={(event) => setMinimumVolume(Number(event.target.value))} />
              <p className="mt-3 text-[10px] leading-4 text-slate-400">크기=검색량 · 색=클러스터 · 테두리=수집 상태. Trend는 절대 검색량이 아닙니다.</p>
            </div>
          )}
          <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
            {providerEntries.map(([name, provider]) => provider.quota ? (
              <div key={name}>
                <div className="flex justify-between text-[10px] text-slate-500"><span>{name}</span><span>{provider.quota.monthly.used.toLocaleString()}/{provider.quota.monthly.limit.toLocaleString()}</span></div>
                <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-100"><div className={`h-full ${provider.quota.blocked ? 'bg-rose-500' : provider.quota.warning ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, provider.quota.ratio * 100)}%` }} /></div>
              </div>
            ) : null)}
          </div>
        </aside>

        {view === 'graph' && (
          <GraphWorkspace
            graph={graph}
            selected={selected}
            minimumVolume={minimumVolume}
            busy={busy}
            onBuild={() => void buildGraph(false)}
            onRefresh={() => void buildGraph(true)}
            onSelect={setSelectedId}
            onCommercial={() => void analyzeCommercial()}
            onAudience={() => void analyzeAudience()}
            onWatch={() => void addSelectedToWatchlist()}
            commercial={commercial}
            audience={audience}
            searchadBlocked={searchadBlocked}
            trendBlocked={trendBlocked}
          />
        )}
        {view === 'rising' && (
          <RisingWorkspace
            result={rising}
            mode={risingMode}
            region={risingRegion}
            category={shoppingCategory}
            busy={busy}
            onMode={(value) => { setRisingMode(value); setRising(null); }}
            onRegion={setRisingRegion}
            onCategory={setShoppingCategory}
            onCollect={() => void collectRising()}
            onAnalyze={(value) => void analyzeRisingKeyword(value)}
            quotaBlocked={searchadBlocked || searchBlocked || (risingMode === 'shopping' ? shoppingBlocked : trendBlocked)}
          />
        )}
        {view === 'watchlist' && (
          <WatchlistWorkspace
            items={watchlist.data?.items ?? []}
            cap={watchlist.data?.cap ?? 50}
            busy={busy}
            onAdd={() => void run('watch-add', async () => { await client.addWatchlist(keyword); await watchlist.refetch(); })}
            onDelete={(id) => void run('watch-delete', async () => { await client.deleteWatchlist(id); await watchlist.refetch(); })}
            onRefresh={(ids) => void run('watch-refresh', async () => {
              if (!window.confirm(`${ids.length * 2}회 안팎의 provider 호출을 진행할까요?`)) return;
              await client.refreshWatchlist(ids);
              await watchlist.refetch();
            })}
            refreshBlocked={searchadBlocked || trendBlocked}
          />
        )}
        {view === 'specialized' && (
          <SpecializedWorkspace
            result={specialized}
            mode={specialMode}
            category={shoppingCategory}
            busy={busy}
            onMode={setSpecialMode}
            onCategory={setShoppingCategory}
            onRun={() => void run('specialized', async () => setSpecialized(await client.specialized(keyword, specialMode, shoppingCategory)))}
            quotaBlocked={specialMode === 'shopping' ? shoppingBlocked : searchBlocked}
          />
        )}
        {view === 'performance' && (
          <PerformanceWorkspace
            result={performance}
            busy={busy}
            onRun={(since, until) => void run('performance', async () => {
              if (!window.confirm('SearchAd 계정의 캠페인·광고그룹·키워드·성과를 조회 전용으로 불러올까요?')) return;
              setPerformance(await client.adPerformance(since, until));
            })}
            quotaBlocked={searchadBlocked}
          />
        )}
      </main>
    </div>
  );
}

function graphPositions(nodes: ResearchGraphNode[]): Record<string, { x: number; y: number }> {
  const groups = new Map<number, ResearchGraphNode[]>();
  for (const node of nodes) groups.set(node.depth, [...(groups.get(node.depth) ?? []), node]);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [depth, rows] of groups) {
    rows.forEach((node, index) => {
      if (depth === 0) positions[node.id] = { x: 400, y: 260 };
      else {
        const radius = depth === 1 ? 165 : 290;
        const angle = (Math.PI * 2 * index) / Math.max(1, rows.length) - Math.PI / 2;
        positions[node.id] = { x: 400 + Math.cos(angle) * radius, y: 260 + Math.sin(angle) * radius };
      }
    });
  }
  return positions;
}

export function OpportunityGraph({ graph, selectedId, minimumVolume, onSelect }: { graph: ResearchGraphResponse; selectedId: string; minimumVolume: number; onSelect: (id: string) => void }) {
  const nodes = graph.nodes.filter((node) => node.depth === 0 || (node.volume ?? 0) >= minimumVolume);
  const visible = new Set(nodes.map((node) => node.id));
  const positions = graphPositions(nodes);
  return (
    <svg viewBox="0 0 800 520" className="h-[60vh] min-h-[420px] w-full rounded-xl bg-slate-950" role="img" aria-label="키워드 기회 그래프">
      {graph.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target)).map((edge) => {
        const source = positions[edge.source]; const target = positions[edge.target];
        return source && target ? <line key={`${edge.source}-${edge.target}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke="#334155" strokeWidth="1.5" /> : null;
      })}
      {nodes.map((node) => {
        const point = positions[node.id];
        const radius = node.depth === 0 ? 30 : Math.max(10, Math.min(26, 8 + Math.log10((node.volume ?? 0) + 10) * 4));
        return (
          <g key={node.id} role="button" tabIndex={0} aria-label={`${node.keyword}, 검색량 ${node.volume ?? '결측'}`} onClick={() => onSelect(node.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(node.id); }} className="cursor-pointer outline-none">
            <circle cx={point.x} cy={point.y} r={radius} fill={colorFor(node.cluster)} stroke={selectedId === node.id ? '#f8fafc' : node.enrichment_status === 'ok' ? '#10b981' : '#f59e0b'} strokeWidth={selectedId === node.id ? 5 : 2} />
            <text x={point.x} y={point.y + radius + 13} textAnchor="middle" fill="#e2e8f0" fontSize="11">{node.keyword.slice(0, 13)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function GraphWorkspace({ graph, selected, minimumVolume, busy, onBuild, onRefresh, onSelect, onCommercial, onAudience, onWatch, commercial, audience, searchadBlocked, trendBlocked }: { graph: ResearchGraphResponse | null; selected: ResearchGraphNode | null; minimumVolume: number; busy: string; onBuild: () => void; onRefresh: () => void; onSelect: (id: string) => void; onCommercial: () => void; onAudience: () => void; onWatch: () => void; commercial: CommercialResponse | null; audience: AudienceResponse | null; searchadBlocked: boolean; trendBlocked: boolean }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const inspectorRef = useRef<HTMLElement>(null);

  function selectNode(id: string) {
    onSelect(id);
    setDrawerOpen(true);
    window.setTimeout(() => inspectorRef.current?.focus(), 0);
  }

  return (
    <section className="grid min-w-0 grid-cols-1 gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40" disabled={!!busy || searchadBlocked} title={searchadBlocked ? 'SearchAd quota 도달' : undefined} onClick={onBuild}>{busy === 'graph' ? '생성 중…' : '그래프 생성 · 최대 12회'}</button>
          {graph && <button className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs disabled:opacity-40" disabled={searchadBlocked} onClick={onRefresh}>강제 새로고침</button>}
          {graph && <span className="text-[11px] text-slate-500">node {graph.nodes.length} · edge {graph.edges.length} · 실제 호출 {graph.call_budget.actual}/{graph.call_budget.maximum}</span>}
        </div>
        {graph ? <OpportunityGraph graph={graph} selectedId={selected?.id ?? ''} minimumVolume={minimumVolume} onSelect={selectNode} /> : <div className="grid h-[60vh] min-h-[420px] place-items-center rounded-xl border border-dashed border-slate-300 bg-white text-center text-slate-400"><div><b className="block text-slate-600">Opportunity Graph</b><span className="text-xs">호출 수를 확인한 뒤 사용자가 직접 생성합니다.</span></div></div>}
        {commercial && <CommercialTable result={commercial} />}
        {audience && <AudienceTable result={audience} />}
      </div>
      <aside ref={inspectorRef} tabIndex={-1} className={`${drawerOpen ? 'fixed' : 'hidden'} inset-x-3 bottom-3 z-30 max-h-[72vh] overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-2xl outline-none lg:sticky lg:top-20 lg:block lg:h-fit lg:max-h-none lg:shadow-none`}>
        <div className="flex items-center justify-between"><h2 className="font-semibold">선택 노드</h2><button className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 lg:hidden" onClick={() => setDrawerOpen(false)}>닫기</button></div>
        {selected ? <>
          <p className="mt-2 text-lg font-bold">{selected.keyword}</p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <dt className="text-slate-400">검색량</dt><dd className="text-right">{selected.volume?.toLocaleString() ?? (selected.volume_masked ? '10 미만' : '결측')}</dd>
            <dt className="text-slate-400">Trend</dt><dd className="text-right">{selected.trend_delta == null ? '미수집' : `${selected.trend_delta > 0 ? '+' : ''}${selected.trend_delta}`}</dd>
            <dt className="text-slate-400">블로그</dt><dd className="text-right">{selected.blog_total?.toLocaleString() ?? '미수집'}</dd>
            <dt className="text-slate-400">경쟁</dt><dd className="text-right">{selected.competition ?? '결측'}</dd>
            <dt className="text-slate-400">cluster</dt><dd className="text-right">{selected.cluster}</dd>
          </dl>
          <div className="mt-4 grid grid-cols-1 gap-2">
            <button className="rounded bg-violet-600 px-2 py-1.5 text-xs text-white disabled:opacity-40" disabled={searchadBlocked} onClick={onCommercial}>상업성 분석 · 4회</button>
            <button className="rounded bg-sky-600 px-2 py-1.5 text-xs text-white disabled:opacity-40" disabled={trendBlocked} onClick={onAudience}>타깃 상대 추세 · 15회</button>
            <button className="rounded border border-slate-300 px-2 py-1.5 text-xs" onClick={onWatch}>Watchlist 추가</button>
          </div>
        </> : <p className="mt-2 text-xs text-slate-400">그래프에서 노드를 선택하세요.</p>}
      </aside>
    </section>
  );
}

export function CommercialTable({ result }: { result: CommercialResponse }) {
  return <section className="mt-3 overflow-x-auto rounded-xl bg-white p-4"><h2 className="font-semibold">상업성 · {result.score_version}</h2><p className="text-[10px] text-slate-400">Organic Opportunity와 합산하지 않는 광고 입찰 기반 지표입니다.</p><table className="mt-2 w-full text-xs"><thead><tr className="text-left text-slate-400"><th>키워드</th><th className="text-right">평균순위</th><th className="text-right">최소노출</th><th className="text-right">중간입찰</th><th className="text-right">점수</th></tr></thead><tbody>{result.rows.map((row) => <tr key={row.keyword} className="border-t border-slate-100"><td className="py-2">{row.keyword}</td><td className="text-right">{money(row.average_position_bid)}</td><td className="text-right">{money(row.minimum_exposure_bid)}</td><td className="text-right">{money(row.median_bid)}</td><td className="text-right font-semibold">{row.commercial_score ?? '결측'}</td></tr>)}</tbody></table></section>;
}

export function AudienceTable({ result }: { result: AudienceResponse }) {
  return <section className="mt-3 rounded-xl bg-white p-4"><h2 className="font-semibold">타깃 상대 추세</h2><p className="mt-1 rounded bg-amber-50 p-2 text-[10px] text-amber-800">{result.warning}</p><div className="mt-3 grid gap-3 md:grid-cols-3">{Object.entries(result.segments).map(([dimension, rows]) => <div key={dimension}><h3 className="text-xs font-semibold">{dimension}</h3><ul className="mt-1 space-y-1 text-[11px]">{rows.map((row) => <li key={row.label} className="flex justify-between rounded bg-slate-50 px-2 py-1"><span>{row.label}</span><span>{row.points.at(-1)?.ratio.toFixed(1) ?? '결측'}</span></li>)}</ul></div>)}</div></section>;
}

const DIRECTION_LABEL: Record<string, string> = { new: '신규', rising: '상승', steady: '보합', falling: '하락', insufficient: '자료 부족' };

export function RisingWorkspace({ result, mode, region, category, busy, onMode, onRegion, onCategory, onCollect, onAnalyze, quotaBlocked }: { result: RisingResponse | null; mode: RisingMode; region: string; category: string; busy: string; onMode: (mode: RisingMode) => void; onRegion: (value: string) => void; onCategory: (value: string) => void; onCollect: () => void; onAnalyze: (keyword: string) => void; quotaBlocked: boolean }) {
  return (
    <section className="min-w-0 p-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          {([['general', '일반'], ['local', '지역'], ['shopping', '쇼핑'], ['news', '뉴스']] as const).map(([value, label]) => <button key={value} className={`rounded-lg px-3 py-2 text-xs font-semibold ${mode === value ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-600'}`} onClick={() => onMode(value)}>{label}</button>)}
          {mode === 'local' && <input className="rounded-lg border border-slate-300 px-3 py-2 text-xs" value={region} onChange={(event) => onRegion(event.target.value)} placeholder="지역명 (예: 성수)" />}
          {mode === 'shopping' && <input className="rounded-lg border border-slate-300 px-3 py-2 text-xs" value={category} onChange={(event) => onCategory(event.target.value)} placeholder="Shopping category code" />}
          <button className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40" disabled={!!busy || quotaBlocked || (mode === 'local' && !region.trim()) || (mode === 'shopping' && !category.trim())} onClick={onCollect}>{busy === 'rising' ? '수집 중…' : '최신 수집 · 최대 10회'}</button>
        </div>
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          <b>입력 주제 기반 급상승 후보</b>
          <p className="mt-1">최근 7일과 이전 7일의 상대 추세를 비교합니다. NAVER 공식 실시간 인기 검색어 순위나 절대 검색량이 아닙니다.</p>
        </div>
        {result && <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500"><span>기간 {result.comparison_window.start_date}~{result.comparison_window.end_date}</span><span>수집 {new Date(result.collected_at).toLocaleString()}</span><span>호출 {result.actual_calls}/{result.estimated_calls}</span><span>상태 {result.status}</span></div>}
      </div>

      {result && result.candidates.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-xl bg-white">
          <table className="w-full min-w-[900px] text-xs">
            <thead><tr className="text-left text-slate-400"><th className="p-3">키워드</th><th>방향</th><th className="text-right">이전 7일</th><th className="text-right">최근 7일</th><th className="text-right">상승률</th><th className="text-right">뉴스 표본</th><th className="text-right">최신성</th><th>신뢰도</th><th>데이터</th></tr></thead>
            <tbody>{result.candidates.map((candidate) => <tr key={candidate.keyword} className="border-t border-slate-100 hover:bg-slate-50"><td className="p-3"><button className="font-semibold text-indigo-700 hover:underline" disabled={busy === 'rising-analyze'} onClick={() => onAnalyze(candidate.keyword)}>{candidate.keyword}</button><span className="ml-2 text-[10px] text-slate-400">{candidate.monthly_searches?.toLocaleString() ?? (candidate.volume_masked ? '10 미만' : '검색량 결측')}</span></td><td className={candidate.direction === 'rising' || candidate.direction === 'new' ? 'text-rose-600' : candidate.direction === 'falling' ? 'text-sky-600' : 'text-slate-500'}>{DIRECTION_LABEL[candidate.direction]}</td><td className="text-right tabular-nums">{candidate.previous7_avg?.toFixed(1) ?? '—'}</td><td className="text-right tabular-nums">{candidate.recent7_avg?.toFixed(1) ?? '—'}</td><td className="text-right tabular-nums">{candidate.direction === 'new' ? '신규' : candidate.growth_rate == null ? '—' : `${candidate.growth_rate > 0 ? '+' : ''}${candidate.growth_rate}%`}</td><td className="text-right tabular-nums" title="최신순 최대 100건에서 최근 7일 기사 중복을 제거한 표본입니다.">{candidate.news_7d_sample_count ?? '—'}{candidate.sample_capped ? '+' : ''}</td><td className="text-right font-bold tabular-nums">{candidate.freshness_score ?? '—'}</td><td>{candidate.confidence}</td><td className="text-[10px] text-slate-400">추세 {candidate.data_status.trend} · 뉴스 {candidate.data_status.news}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <div className="mt-3 grid min-h-64 place-items-center rounded-xl border border-dashed border-slate-300 bg-white text-center text-slate-400"><div><b className="block text-slate-600">급상승 후보를 수집하세요</b><span className="text-xs">주제·지역·카테고리 조건에 맞는 후보만 생성합니다.</span></div></div>}
    </section>
  );
}

function WatchlistWorkspace({ items, cap, busy, onAdd, onDelete, onRefresh, refreshBlocked }: { items: WatchlistItem[]; cap: number; busy: string; onAdd: () => void; onDelete: (id: number) => void; onRefresh: (ids: number[]) => void; refreshBlocked: boolean }) {
  const [selected, setSelected] = useState<number[]>([]);
  return <section className="p-4"><div className="flex flex-wrap gap-2"><button className="rounded bg-indigo-600 px-3 py-2 text-xs text-white" disabled={!!busy} onClick={onAdd}>현재 키워드 추가</button><button className="rounded border border-slate-300 bg-white px-3 py-2 text-xs disabled:opacity-40" disabled={!selected.length || !!busy || refreshBlocked} onClick={() => onRefresh(selected)}>선택 갱신 · 예상 {selected.length * 2}회</button><button className="rounded border border-slate-300 bg-white px-3 py-2 text-xs disabled:opacity-40" disabled={!items.length || !!busy || refreshBlocked} onClick={() => onRefresh(items.map((item) => item.id))}>전체 갱신</button><span className="self-center text-[11px] text-slate-400">{items.length}/{cap} · 자동 갱신 없음</span></div><div className="mt-3 overflow-x-auto rounded-xl bg-white"><table className="w-full text-xs"><thead><tr className="text-left text-slate-400"><th className="p-3">선택</th><th>키워드</th><th>월 검색량</th><th>상대 변화</th><th>수집 시각</th><th>상태</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id} className="border-t border-slate-100"><td className="p-3"><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /></td><td className="font-medium">{item.keyword}</td><td>{item.last_snapshot?.monthly_searches?.toLocaleString() ?? (item.last_snapshot?.volume_masked ? '10 미만' : '결측')}</td><td>{item.direction}{item.delta == null ? '' : ` ${item.delta > 0 ? '+' : ''}${item.delta}`}</td><td>{item.last_snapshot ? new Date(item.last_snapshot.collected_at).toLocaleString() : '미수집'}</td><td>{item.status}{item.stale ? ' · stale' : ''}</td><td><button className="text-rose-600" onClick={() => onDelete(item.id)}>삭제</button></td></tr>)}</tbody></table>{items.length === 0 && <p className="p-6 text-center text-xs text-slate-400">선택한 키워드가 없습니다.</p>}</div></section>;
}

function SpecializedWorkspace({ result, mode, category, busy, onMode, onCategory, onRun, quotaBlocked }: { result: SpecializedResponse | null; mode: 'local' | 'shopping' | 'image'; category: string; busy: string; onMode: (mode: 'local' | 'shopping' | 'image') => void; onCategory: (value: string) => void; onRun: () => void; quotaBlocked: boolean }) {
  return <section className="p-4"><div className="flex flex-wrap gap-2">{(['local', 'shopping', 'image'] as const).map((value) => <button key={value} className={`rounded px-3 py-2 text-xs ${mode === value ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600'}`} onClick={() => onMode(value)}>{value}</button>)}{mode === 'shopping' && <input className="rounded border border-slate-300 px-3 py-2 text-xs" value={category} onChange={(event) => onCategory(event.target.value)} placeholder="category code" />}<button className="rounded bg-slate-900 px-3 py-2 text-xs text-white disabled:opacity-40" disabled={!!busy || quotaBlocked || (mode === 'shopping' && !category.trim())} onClick={onRun}>조회</button></div>{result && <div className="mt-3 rounded-xl bg-white p-4"><h2 className="font-semibold">{result.mode} · {result.status}</h2>{result.rights_notice && <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-800">{result.rights_notice}</p>}{result.warning && <p className="mt-2 text-xs text-slate-500">{result.warning}</p>}<div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{(result.items ?? []).map((item, index) => <a key={`${index}-${String(item.link ?? '')}`} href={safeExternalUrl(item.link)} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-100 p-3 hover:border-indigo-300">{Boolean(item.thumbnail) && <img src={safeExternalUrl(item.thumbnail)} alt="" className="mb-2 h-32 w-full rounded object-cover" />}<b className="block text-sky-700">{String(item.title ?? '결과')}</b><span className="mt-1 block text-[10px] text-slate-400">{String(item.category ?? item.road_address ?? '')}{item.width ? ` · ${String(item.width)}×${String(item.height ?? '')}` : ''}</span></a>)}</div>{(result.series ?? []).length > 0 && <div className="mt-3 grid gap-2 md:grid-cols-2">{(result.series ?? []).map((row, index) => { const points = Array.isArray(row.points) ? row.points as Array<{ period?: string; ratio?: number }> : []; const latest = points.at(-1); return <div key={`${index}-${String(row.title ?? '')}`} className="rounded bg-slate-50 p-3 text-xs"><b>{String(row.title ?? result.keyword)}</b><p className="mt-1 text-slate-500">최근 상대지수 {latest?.ratio?.toFixed(1) ?? '결측'} · {latest?.period ?? '기간 결측'}</p></div>; })}</div>}</div>}</section>;
}

function PerformanceWorkspace({ result, busy, onRun, quotaBlocked }: { result: AdPerformanceResponse | null; busy: string; onRun: (since: string, until: string) => void; quotaBlocked: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [since, setSince] = useState(start); const [until, setUntil] = useState(today);
  return <section className="p-4"><div className="flex flex-wrap gap-2"><input type="date" className="rounded border border-slate-300 bg-white px-3 py-2 text-xs" value={since} onChange={(event) => setSince(event.target.value)} /><input type="date" className="rounded border border-slate-300 bg-white px-3 py-2 text-xs" value={until} onChange={(event) => setUntil(event.target.value)} /><button className="rounded bg-indigo-600 px-3 py-2 text-xs text-white disabled:opacity-40" disabled={!!busy || quotaBlocked} onClick={() => onRun(since, until)}>{busy === 'performance' ? '조회 중…' : '성과 조회 · 최대 23회'}</button><span className="self-center rounded-full bg-emerald-50 px-2 py-1 text-[10px] text-emerald-700">READ ONLY</span></div>{result && <div className="mt-3 space-y-3"><div className="rounded-xl bg-white p-4"><h2 className="font-semibold">콘텐츠 공백 후보 {result.recommendations.length}개</h2><ul className="mt-2 grid gap-2 md:grid-cols-2">{result.recommendations.map((row) => <li key={row.keyword} className="rounded bg-amber-50 p-3 text-xs"><b>{row.keyword}</b><p className="mt-1 text-amber-800">{row.reason}</p><span className="text-[10px] text-slate-500">클릭 {row.clicks ?? '결측'} · 전환 {row.conversions ?? '결측'}</span></li>)}</ul></div><div className="overflow-x-auto rounded-xl bg-white"><table className="w-full text-xs"><thead><tr className="text-left text-slate-400"><th className="p-3">키워드</th><th>노출</th><th>클릭</th><th>CTR(%)</th><th>CPC(원)</th><th>전환</th><th>ROAS(%)</th><th>콘텐츠</th></tr></thead><tbody>{result.rows.map((row) => <tr key={row.id} className="border-t border-slate-100"><td className="p-3 font-medium">{row.keyword}</td><td>{row.impressions ?? '결측'}</td><td>{row.clicks ?? '결측'}</td><td>{row.ctr == null ? '결측' : `${row.ctr}%`}</td><td>{money(row.cpc)}</td><td>{row.conversions ?? '결측'}</td><td>{row.roas == null ? '결측' : `${row.roas}%`}</td><td>{row.content.state}</td></tr>)}</tbody></table></div></div>}</section>;
}
