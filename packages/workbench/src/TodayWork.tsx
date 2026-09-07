import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CoreClient } from '@ncos/core-client';
import type { TodayWorkItem } from '@ncos/contracts';
import { message, formatTime } from './common';

const labels = { inspect_error: '작업 오류 확인', resume_draft: '이어서 편집', register_publication: '공개 기록 확인', refresh_data: '자료 새로 확인', open_analysis: '주제 분석 준비', open_performance: '성과 개선 보기' };
export function TodayWork({ client, onOpenDraft, onAnalyze, onPerformance, onAdPerformance, onPublications }: {
  client: CoreClient; onOpenDraft: (id: number) => void; onAnalyze: (keyword: string) => void; onPerformance: () => void; onAdPerformance?: () => void; onPublications: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const work = useQuery({ queryKey: ['workbench-today'], queryFn: () => client.todayWork(5) });
  async function run(item: TodayWorkItem) {
    if (busy) return;
    if (item.source_type === 'ad_performance') { (onAdPerformance ?? onPerformance)(); return; }
    if (item.action === 'open_performance' || item.source_type === 'performance_recommendation') { onPerformance(); return; }
    if (item.draft_id && ['inspect_error', 'resume_draft', 'register_publication'].includes(item.action)) { onOpenDraft(item.draft_id); return; }
    if (item.action === 'register_publication') { onPublications(); return; }
    if (item.action === 'refresh_data' && item.source_type === 'watchlist') {
      if (!window.confirm(`‘${item.keyword}’의 최신 자료를 외부 API에서 조회할까요? 사용량이 소비될 수 있습니다.`)) return;
      setBusy(true); setError('');
      try { await client.refreshWatchlist([item.source_id]); await work.refetch(); }
      catch (e) { setError(message(e)); }
      finally { setBusy(false); }
      return;
    }
    onAnalyze(item.keyword);
  }
  return <section className="panel today-work"><div className="section-title"><div><h2>오늘 이어서 할 일</h2><p>저장된 자료에서 고른 우선 작업, 최대 5개입니다. 자동 생성·새 조회는 하지 않습니다.</p></div><div className="action-row"><button onClick={() => setExpanded(v => !v)}>{expanded ? '요약 보기' : '추천 작업 전체 보기'}</button><button disabled={busy || work.isFetching} onClick={() => void work.refetch()}>다시 읽기</button></div></div>
    {(work.isFetching || busy) && <p role="status">작업 목록 확인 중…</p>}{(error || work.error) && <p role="alert" className="notice error">{error || message(work.error)}</p>}
    <ul className="record-list">{work.data?.items.slice(0, expanded ? 5 : 2).map(item => <li key={item.id}><div className="record-main"><strong>{item.title}</strong><p>{item.reason}{item.stale ? ' · 최신화 점검 대상' : ''}</p><p>{item.keyword} · {formatTime(item.calculated_at)}</p></div><button disabled={busy} onClick={() => void run(item)}>{labels[item.action]}</button></li>)}</ul>
    {work.data && !work.data.items.length && <p>현재 추천된 작업이 없습니다. 새 글을 작성해 보세요.</p>}
  </section>;
}
