import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnalyzeResponse, KeywordSuggestionResponse } from '@ncos/contracts';
import type { CoreClient } from '@ncos/core-client';
import { message } from './common';
import { blocked, numberText } from './research-common';
import { RisingDiscovery } from './RisingDiscovery';
import { KeywordAnalysis } from './KeywordAnalysis';
import { KeywordDetails } from './KeywordDetails';
import { WatchKeywords } from './WatchKeywords';
import { SpecializedResearch } from './SpecializedResearch';
export type KeywordView = 'latest' | 'analysis' | 'watchlist' | 'specialized';
export function KeywordWorkspace({ client, onWrite, onPlan, viewRequest }: { client: CoreClient; onWrite: (keyword: string) => void; onPlan: (keyword: string) => void; viewRequest?: { view: KeywordView; nonce: number } | null }) {
  const [view, setView] = useState<KeywordView>('latest'), [keyword, setKeyword] = useState('');
  const [suggestions, setSuggestions] = useState<KeywordSuggestionResponse | null>(null), [suggesting, setSuggesting] = useState(false), [suggestError, setSuggestError] = useState('');
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const inflight = useRef(new Set<string>());
  const epoch = useRef(0), suggestionEpoch = useRef(0), alive = useRef(true), lastAnalyzed = useRef('');
  const query = useQueryClient();
  const capabilities = useQuery({ queryKey: ['workbench-capabilities'], queryFn: () => client.capabilities(), staleTime: 30_000 });
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++epoch.current; }; }, []);
  useEffect(() => { if (viewRequest) setView(viewRequest.view); }, [viewRequest]);
  useEffect(() => {
    const request = ++suggestionEpoch.current, abort = new AbortController();
    setSuggestions(null); setSuggestError(''); setSuggesting(false);
    const normalized = keyword.replace(/\s/g, '');
    if (normalized.length < (/[\u2e80-\ud7af]/.test(normalized) ? 2 : 3) || keyword.trim() === lastAnalyzed.current) return () => abort.abort();
    const timer = setTimeout(() => {
      setSuggesting(true);
      void client.suggestKeywords(keyword.trim(), abort.signal).then(value => { if (request === suggestionEpoch.current && !abort.signal.aborted) setSuggestions(value); }).catch(e => { if (request === suggestionEpoch.current && !abort.signal.aborted) setSuggestError(message(e)); }).finally(() => { if (request === suggestionEpoch.current && !abort.signal.aborted) setSuggesting(false); });
    }, 400);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [keyword, client]);
  function changeKeyword(value: string) { ++epoch.current; setKeyword(value); setAnalysis(null); setBusy(false); setError(''); setNotice(''); }
  async function analyze(value = keyword, force = false) {
    const topic = value.trim(); if (!topic || inflight.current.has(topic)) return;
    inflight.current.add(topic);
    const request = ++epoch.current; lastAnalyzed.current = topic;
    setKeyword(topic); setView('analysis'); setBusy(true); setAnalysis(null); setSuggestions(null); ++suggestionEpoch.current; setError('');
    try { const data = await client.analyze(topic, null, force); if (alive.current && request === epoch.current) setAnalysis(data); }
    catch (e) { if (alive.current && request === epoch.current) setError(message(e)); }
    finally { inflight.current.delete(topic); if (alive.current && request === epoch.current) setBusy(false); }
  }
  async function watch(value: string) {
    try { await client.addWatchlist(value); await query.invalidateQueries({ queryKey: ['web-watchlist'] }); if (alive.current) setNotice(`‘${value}’을 관심 키워드에 추가했습니다.`); }
    catch (e) { if (alive.current) setError(message(e)); }
  }
  return <div className="keyword-workspace"><section className="panel keyword-entry"><h2>어떤 주제를 찾아볼까요?</h2><p>입력하면 연관어를 추천합니다. 추천은 저장된 최근 검색과 SearchAd 자료이며 전체 인기 순위가 아닙니다.</p><form onSubmit={e => { e.preventDefault(); void analyze(); }}><label htmlFor="keyword-query">키워드·관심 분야</label><div className="inline-form"><input id="keyword-query" value={keyword} onChange={e => changeKeyword(e.target.value)} placeholder="예: 후쿠오카 여행, 가을 캠핑" maxLength={100} autoComplete="off"/><button className="primary" disabled={!keyword.trim() || busy}>{busy ? '분석 중…' : '키워드 분석'}</button></div></form><p className="muted">한글 2글자 이상 입력 후 연관어 조회 · 조회 시 API 사용량이 소비될 수 있습니다.</p>
    {suggesting && <p role="status">연관어 추천 중…</p>}{suggestError && <p role="alert">추천 조회 실패: {suggestError} 직접 키워드 분석은 시도할 수 있습니다.</p>}{suggestions && <><div className="keyword-chips" aria-label="입력 연관어 추천">{suggestions.suggestions.map(s => <button key={s.keyword} onClick={() => void analyze(s.keyword)}>{s.keyword}<small>{s.source === 'recent' ? '최근 검색' : '연관어'} · {s.volume_masked ? '제한값' : numberText(s.monthly_searches)}</small></button>)}</div>{!suggestions.suggestions.length && <p>입력과 일치하는 추천어가 없습니다.</p>}</>}
    <div className="subnav" aria-label="키워드 도구">{([['latest', '최신·급상승'], ['analysis', '키워드 분석'], ['watchlist', '관심 키워드'], ['specialized', '분야별 자료']] as const).map(([id, label]) => <button key={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}</div></section>
    {(error || capabilities.error) && <p role="alert" className="notice error">{error || message(capabilities.error)}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    <div hidden={view !== 'latest'}><RisingDiscovery client={client} seed={keyword} onSeed={changeKeyword} onAnalyze={value => void analyze(value)} capabilities={capabilities.data} disabled={busy}/></div>
    {view === 'analysis' && (analysis ? <><KeywordAnalysis result={analysis} disabled={busy} onAnalyze={value => void analyze(value)} onWrite={() => onWrite(analysis.keyword)} onPlan={() => onPlan(analysis.keyword)}/><button disabled={busy} onClick={() => { if (window.confirm('캐시를 건너뛰고 최신 자료로 다시 분석할까요?')) void analyze(analysis.keyword, true); }}>이 키워드 최신 재분석</button><KeywordDetails key={analysis.snapshot_id} client={client} analysis={analysis} capabilities={capabilities.data} onAnalyze={value => void analyze(value)} onWatch={value => void watch(value)}/></> : <section className="panel"><h2>{busy ? '키워드 분석 중…' : '분석할 키워드를 선택하세요'}</h2><p>{busy ? '네이버 자료를 확인하고 있습니다. 다른 키워드를 선택하면 이전 응답은 화면에 섞이지 않습니다.' : '추천 키워드를 누르거나 위 검색창에서 분석을 실행하세요.'}</p></section>)}
    {view === 'watchlist' && <WatchKeywords client={client} keyword={keyword} onAnalyze={value => void analyze(value)} quotaBlocked={blocked(capabilities.data, ['searchad', 'hub_trend'])}/>}
    {view === 'specialized' && <SpecializedResearch client={client} keyword={keyword} capabilities={capabilities.data}/>}
  </div>;
}
