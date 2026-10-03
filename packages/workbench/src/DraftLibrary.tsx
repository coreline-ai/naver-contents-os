import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DraftUserStatus } from '@ncos/contracts';
import type { CoreClient } from '@ncos/core-client';
import { message, formatTime } from './common';

const labels = { editing: '작성 중', review_ready: '검수 대기', archived: '보관됨' };
const publishLabels: Record<string, string> = {
  none: '요청 기록 없음', pending: '요청 대기', waiting_extension: '확장 연결 대기',
  running: '처리 중', failed: '실패',
  draft_saved: '구형 저장 응답 · 재열기 미검증',
  verified_draft_saved: '재열기 검증까지 완료',
};
export function DraftLibrary({ client, onOpen, initialView = 'drafts' }: { initialView?: 'drafts' | 'published'; client: CoreClient; onOpen: (id: number) => void }) {
  const [view, setView] = useState<'drafts' | 'published'>(initialView);
  useEffect(() => { setView(initialView); }, [initialView]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<DraftUserStatus | ''>('');
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const drafts = useQuery({ queryKey: ['web-drafts', query, status, cursors.at(-1)], queryFn: () => client.listDrafts({ query, status: status || undefined, cursor: cursors.at(-1), limit: 20 }), enabled: view === 'drafts' });
  const published = useQuery({ queryKey: ['web-publications', query], queryFn: () => client.listPublishedContents(query, true), enabled: view === 'published' });
  async function change(id: number, next: DraftUserStatus) {
    if (busy) return;
    setBusy(true); setError('');
    try { await client.updateDraftStatus(id, next); await drafts.refetch(); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  async function archivePublication(id: number, archived: boolean) {
    if (busy || !window.confirm(archived ? '공개 기록을 보관할까요? 네이버 글은 삭제하지 않습니다.' : '이 공개 기록을 복원할까요?')) return;
    setBusy(true); setError('');
    try { await client.updatePublishedContent(id, { archived }); await published.refetch(); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    <div className="section-title"><div><h2>원고와 발행 기록</h2><p>로컬 원고 저장, 네이버 임시저장, 실제 공개 기록을 구분합니다.</p></div><button onClick={() => void (view === 'drafts' ? drafts : published).refetch()}>목록 다시 읽기</button></div>
    <div className="subnav" aria-label="원고 목록 종류"><button aria-pressed={view === 'drafts'} onClick={() => setView('drafts')}>저장된 원고</button><button aria-pressed={view === 'published'} onClick={() => setView('published')}>공개 완료 기록</button></div>
    <div className="library-filters"><div><label htmlFor="draft-search">제목·키워드 검색</label><input id="draft-search" value={query} onChange={e => { setQuery(e.target.value); setCursors([undefined]); }} placeholder="찾을 제목이나 키워드"/></div>{view === 'drafts' && <div><label htmlFor="draft-status">원고 상태</label><select id="draft-status" value={status} onChange={e => { setStatus(e.target.value as DraftUserStatus | ''); setCursors([undefined]); }}><option value="">모든 상태</option><option value="editing">작성 중</option><option value="review_ready">검수 대기</option><option value="archived">보관됨</option></select></div>}</div>
    {(drafts.isFetching || published.isFetching) && <p role="status">목록을 불러오는 중…</p>}
    {(error || (view === 'drafts' ? drafts.error : published.error)) && <p role="alert" className="notice error">{error || message(view === 'drafts' ? drafts.error : published.error)}</p>}
    {view === 'drafts' ? <>
      {drafts.data && !drafts.data.items.length && <p className="empty">조건에 맞는 원고가 없습니다. 새 글을 작성하거나 검색 조건을 바꿔보세요.</p>}
      <ul className="record-list">{drafts.data?.items.map(item => <li key={item.draft_id}><div className="record-main"><button className="record-title" onClick={() => onOpen(item.draft_id)}>{item.title}</button><p>{item.keyword} · v{item.latest_version} · {labels[item.user_status]}</p><p>네이버 임시저장: {publishLabels[item.latest_job_status] ?? '상태 확인 필요'} {item.latest_job_error ? `· ${item.latest_job_error}` : ''}</p></div><div className="record-actions"><button onClick={() => onOpen(item.draft_id)}>이어서 편집</button>{item.user_status === 'archived' ? <button disabled={busy} onClick={() => void change(item.draft_id, 'editing')}>복원</button> : <><button disabled={busy} onClick={() => void change(item.draft_id, item.user_status === 'editing' ? 'review_ready' : 'editing')}>{item.user_status === 'editing' ? '검수 대기로' : '작성 중으로'}</button><button disabled={busy} onClick={() => { if (window.confirm('원고를 보관할까요? 내용과 버전은 삭제하지 않습니다.')) void change(item.draft_id, 'archived'); }}>보관</button></>}</div></li>)}</ul>
      <div className="pager"><button disabled={cursors.length < 2} onClick={() => setCursors(cursors.slice(0, -1))}>이전 목록</button><span>{cursors.length}페이지</span><button disabled={!drafts.data?.next_cursor} onClick={() => setCursors([...cursors, drafts.data!.next_cursor!])}>다음 목록</button></div>
    </> : <><ul className="record-list">{published.data?.items.map(item => <li key={item.id}><div><strong>{item.title}</strong><p>{/^https?:\/\//i.test(item.canonical_url) ? <a href={item.canonical_url} target="_blank" rel="noreferrer">실제 공개 글 확인 ↗ 새 탭</a> : item.canonical_url}</p><p>공개 시각: {formatTime(item.published_at)} · {item.state === 'published' ? '공개됨' : item.state === 'stale' ? '최신화 점검 대상' : '보관됨'}</p></div><div className="record-actions">{item.draft_id && <button onClick={() => onOpen(item.draft_id!)}>연결 원고 편집</button>}<button disabled={busy} onClick={() => void archivePublication(item.id, item.state !== 'archived')}>{item.state === 'archived' ? '공개 기록 복원' : '공개 기록 보관'}</button></div></li>)}</ul>{published.data && !published.data.items.length && <p className="empty">등록된 공개 기록이 없습니다. 원고의 ‘공개 완료 등록’에서 실제 공개 사실을 기록할 수 있습니다.</p>}</>}
  </section>;
}
