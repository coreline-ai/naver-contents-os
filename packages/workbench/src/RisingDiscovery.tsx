import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CapabilitiesResponse, RisingCandidate, RisingMode, RisingResponse } from '@ncos/contracts';
import type { CoreClient } from '@ncos/core-client';
import { message, formatTime } from './common';
import { blocked, DataStatus, directionLabels, modeLabels, numberText, statusLabel } from './research-common';

export function RisingResults({ result, onAnalyze, disabled, preview = 8 }: { preview?: number; result: RisingResponse; onAnalyze: (keyword: string) => void; disabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const old = Date.now() - new Date(result.collected_at).getTime() > 86400_000;
  return <div className="rising-result"><p><strong>{result.effective_seed}</strong> · {modeLabels[result.mode]} · {statusLabel(result.status)}</p><p>수집 {formatTime(result.collected_at)}{old ? ' · 오래된 결과: 최신 수집 권장' : ''}</p><p>비교 기간 {result.comparison_window.start_date} ~ {result.comparison_window.end_date} · 최근 구간 시작 {result.comparison_window.recent_start}</p><DataStatus values={result.data_status}/>
    {!result.candidates.length ? <p className="notice">후보를 가져오지 못했습니다. 실제 결과 없음과 연결·사용량 오류는 위 상태에서 구분할 수 있습니다.</p> : <div className="candidate-grid">{(expanded ? result.candidates : result.candidates.slice(0, preview)).map(c => <article className="candidate-card" key={c.keyword}><div className="section-title"><button className="record-title" disabled={disabled} onClick={() => onAnalyze(c.keyword)}>{c.keyword}</button><span className={`direction ${c.direction}`}>{directionLabels[c.direction]}</span></div><dl className="metric-row"><div><dt>상승률</dt><dd>{c.direction === 'new' ? '신규 · 이전 0' : c.growth_rate == null ? '자료 부족' : `${c.growth_rate > 0 ? '+' : ''}${numberText(c.growth_rate, 1)}%`}</dd></div><div><dt>최신성 점수</dt><dd>{numberText(c.freshness_score, 1)}{c.freshness_score != null ? ' / 100' : ''}</dd></div><div><dt>월 검색량</dt><dd>{c.volume_masked ? '10 미만 포함 · 제한값' : numberText(c.monthly_searches)}</dd></div></dl><p>이전 7일 {numberText(c.previous7_avg, 1)} → 최근 7일 {numberText(c.recent7_avg, 1)} <small>상대지수 평균</small></p><p>최근 7일 뉴스 표본 {numberText(c.news_7d_sample_count)}건{c.sample_capped ? ' · 수집 상한 도달' : ''} · 신뢰도 {({ unavailable: '판정 불가', low: '낮음', medium: '보통', high: '높음' })[c.confidence]}</p><CandidateEvidence candidate={c}/></article>)}</div>}
    {result.candidates.length > preview && <button aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? '간단히 보기' : `전체 후보 ${result.candidates.length}개 보기`}</button>}
    <p className="muted">{result.disclaimer} · 수집 호출 {result.actual_calls}/{result.estimated_calls} · 산식 {result.score_version}</p>
  </div>;
}
function CandidateEvidence({ candidate: c }: { candidate: RisingCandidate }) { return <details><summary>점수 근거·자료 시각</summary><p>유효 날짜: 이전 {c.coverage.previous_days}/7일 · 최근 {c.coverage.recent_days}/7일</p><p>추세 {numberText(c.components.trend_score, 1)} × {numberText(c.components.trend_weight, 2)} + 뉴스 {numberText(c.components.news_score, 1)} × {numberText(c.components.news_weight, 2)}</p><p>뉴스량 점수 {numberText(c.components.news_volume_score, 1)} · 뉴스 시의성 {numberText(c.components.news_recency_score, 1)} · 최근 기사 {formatTime(c.latest_news_at)}</p><p>뉴스는 검색 결과의 표본이지 전체 기사 발생량이 아닙니다. 점수는 공식 순위나 수익 보장이 아닙니다.</p>{c.components.reason && <p>산출 제한: {c.components.reason}</p>}<DataStatus values={c.data_status}/><dl className="source-meta">{Object.entries(c.source_meta).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value == null ? '미제공' : typeof value === 'boolean' ? value ? '예' : '아니오' : String(value)}</dd></div>)}</dl></details>; }
export function RisingDiscovery({ client, seed, onSeed, onAnalyze, capabilities, disabled }: { client: CoreClient; seed: string; onSeed: (value: string) => void; onAnalyze: (keyword: string) => void; capabilities?: CapabilitiesResponse; disabled: boolean }) {
  const [mode, setMode] = useState<RisingMode>('general'), [region, setRegion] = useState(''), [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [allHistory, setAllHistory] = useState(false);
  const [result, setResult] = useState<{ key: string; run: RisingResponse } | null>(null);
  const lock = useRef(false), epoch = useRef(0), alive = useRef(true);
  const key = JSON.stringify([seed.trim(), mode, region.trim(), category.trim()]);
  const currentKey = useRef(key); currentKey.current = key;
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++epoch.current; }; }, []);
  useEffect(() => { ++epoch.current; setResult(null); setError(''); }, [key]);
  const recent = useQuery({ queryKey: ['web-recent-rising'], queryFn: () => client.recentRising() });
  const valid = mode === 'local' ? !!region.trim() : !!seed.trim() && (mode !== 'shopping' || !!category.trim());
  const latest = useQuery({ queryKey: ['web-rising', key], queryFn: () => client.latestRising({ seed: seed.trim(), mode, region: region.trim(), category: category.trim() }), enabled: valid, retry: false });
  const denied = blocked(capabilities, ['searchad', mode === 'shopping' ? 'hub_shopping' : 'hub_trend', 'hub_search']);
  async function collect() {
    if (!valid || lock.current || disabled || denied) return;
    if (!window.confirm('이 조건의 최신 자료를 외부 API에서 수집할까요? 최대 10회의 수집 호출이 필요하며, 공개 실시간 검색 순위가 아닌 최근 추이 후보를 계산합니다.')) return;
    lock.current = true; setBusy(true); setError(''); const request = ++epoch.current, requestKey = key;
    try {
      const next = await client.rising({ seed: seed.trim(), mode, region: region.trim(), category: category.trim(), candidate_limit: 20, force_refresh: true });
      if (alive.current) { void recent.refetch(); if (request === epoch.current && requestKey === currentKey.current) setResult({ key: requestKey, run: next }); }
    } catch (e) { if (alive.current && request === epoch.current && requestKey === currentKey.current) setError(message(e)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const shown = result?.key === key ? result.run : latest.data?.run;
  return <section className="panel"><div className="section-title"><div><p className="eyebrow">지금 쓸 주제 찾기</p><h2>최신·급상승 키워드 후보</h2><p>입력한 분야의 검색 추이와 최신 뉴스 표본을 비교합니다. <strong>네이버 공식 실시간 인기 검색어 순위가 아닙니다.</strong></p></div></div>
    <div className="subnav" aria-label="급상승 분야">{Object.entries(modeLabels).map(([value, label]) => <button key={value} aria-pressed={mode === value} onClick={() => { setMode(value as RisingMode); }}>{label}</button>)}</div>
    <div className="form-grid">{mode === 'local' && <div><label htmlFor="rising-region">지역명 · 필수</label><input id="rising-region" value={region} onChange={e => setRegion(e.target.value)} placeholder="예: 성수" maxLength={100}/></div>}{mode === 'shopping' && <div><label htmlFor="rising-category">쇼핑 카테고리 코드 · 필수</label><input id="rising-category" value={category} onChange={e => setCategory(e.target.value)} placeholder="네이버 쇼핑 카테고리 코드" maxLength={30}/><p>쇼핑인사이트의 카테고리 코드를 입력하세요. 판매량 순위가 아닌 클릭 추이입니다.</p></div>}</div>
    <div className="action-row"><button className="primary" disabled={disabled || busy || !valid || denied} onClick={() => void collect()}>{busy ? '최신 자료 수집 중…' : '이 조건으로 최신 수집'}</button>{valid && <button disabled={latest.isFetching} onClick={() => void latest.refetch()}>저장된 결과 다시 읽기</button>}</div>
    {denied && <p role="alert">사용 한도에 도달한 연결이 있습니다. 앱 설정에서 사용량을 확인하세요.</p>}
    {busy && <p role="status">요청한 조건으로 수집 중입니다. 조건을 바꾸더라도 이전 요청을 다시 보내지 않습니다. 완료 결과는 수집 이력에 남습니다.</p>}
    {(error || latest.error || recent.error) && <p role="alert" className="notice error">{error || message(latest.error || recent.error)}</p>}
    {shown ? <RisingResults key={shown.run_id} result={shown} onAnalyze={onAnalyze} disabled={disabled}/> : <p className="notice">{valid ? '이 조건으로 저장된 결과가 없습니다. 최신 수집을 누르세요.' : '위 검색창에 관심 주제를 입력하세요. 지역 분야는 지역명만 입력해도 됩니다.'}</p>}
    <details className="tool-section" open={!shown}><summary>최근 수집한 분야 · 입력 없이 둘러보기</summary><p>이 컴퓨터에 저장된 조건별 최근 결과입니다. 화면을 열어도 외부 수집은 자동 실행하지 않습니다.</p>{recent.isFetching && <p role="status">최근 수집 이력 확인 중…</p>}{recent.data && !recent.data.runs.length && <p>아직 수집 이력이 없습니다. 관심 주제로 첫 수집을 시작하세요.</p>}{recent.data?.runs.slice(0, allHistory ? 8 : 3).map(run => <section key={run.run_id} className="recent-run"><div className="section-title"><h3>{modeLabels[run.mode]} · {run.effective_seed}</h3><button disabled={busy} onClick={() => { onSeed(run.seed); setMode(run.mode); setRegion(run.region); setCategory(run.category); }}>이 조건 선택</button></div><RisingResults preview={4} result={run} onAnalyze={onAnalyze} disabled={disabled}/></section>)}{(recent.data?.runs.length ?? 0) > 3 && <button onClick={() => setAllHistory(v => !v)}>{allHistory ? '최근 3개 조건만' : '수집 조건 더 보기'}</button>}</details>
  </section>;
}
