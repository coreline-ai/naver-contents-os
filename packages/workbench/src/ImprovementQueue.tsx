import React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CoreClient } from '@ncos/core-client';
import type { PerformanceAction } from '@ncos/contracts';
import { message, formatTime } from './common';
import { buildImprovementInput, IMPROVEMENT_LABELS, type ImprovementInput } from './improvement';

export function ImprovementQueue({ client, onOpen }: { client: CoreClient; onOpen: (input: ImprovementInput) => void }) {
  const queue = useQuery({ queryKey: ['workbench-improvements'], queryFn: () => client.performanceRecommendations() });
  return <section className="panel"><div className="section-title"><div><h2>성과를 바탕으로 글 개선하기</h2><p>자료에 기반한 개선 제안입니다. 누르면 글쓰기 화면에 작성 조건만 준비하며, AI 실행은 직접 선택합니다.</p></div><button onClick={() => void queue.refetch()}>추천 다시 읽기</button></div>
    {queue.isFetching && <p role="status">추천을 읽는 중…</p>}{queue.error && <p role="alert" className="notice error">{message(queue.error)}</p>}
    <ul className="record-list">{queue.data?.items.map(item => <li key={item.id}><div className="record-main"><strong>{item.published_title || item.keyword}</strong><p>{item.reason}</p><p>근거 기간 {item.period.start} ~ {item.period.end} · 확신도 {item.confidence} · 계산 {item.calculation_version}</p><p>{formatTime(item.created_at)} · {item.draft_id ? `참조 원고 #${item.draft_id}` : '연결된 원고 없음'}</p></div><div><button onClick={() => onOpen(buildImprovementInput(item, item.action))}>{IMPROVEMENT_LABELS[item.action]} 준비</button><details className="tool-section"><summary>다른 개선 방식</summary><div className="action-row">{(Object.keys(IMPROVEMENT_LABELS) as PerformanceAction[]).filter(action => action !== item.action).map(action => <button key={action} onClick={() => onOpen(buildImprovementInput(item, action))}>{IMPROVEMENT_LABELS[action]} 준비</button>)}</div></details></div></li>)}</ul>
    {queue.data && !queue.data.items.length && <p className="empty">진행할 개선 추천이 없습니다. 성과 자료가 없으면 추천이나 점수를 만들지 않습니다.</p>}
  </section>;
}
