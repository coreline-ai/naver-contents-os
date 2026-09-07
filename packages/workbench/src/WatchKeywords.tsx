import React, { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CoreClient } from '@ncos/core-client';
import { formatTime, message } from './common';
import { numberText, statusLabel } from './research-common';
export function WatchKeywords({ client, keyword, onAnalyze, quotaBlocked }: { client: CoreClient; keyword: string; onAnalyze: (keyword: string) => void; quotaBlocked: boolean }) {
  const watch = useQuery({ queryKey: ['web-watchlist'], queryFn: () => client.listWatchlist() });
  const [selected, setSelected] = useState<number[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  async function act(kind: 'add' | 'delete' | 'refresh', ids: number[] = []) {
    if (lock.current || (kind === 'add' && !keyword.trim()) || (kind === 'refresh' && (!ids.length || quotaBlocked))) return;
    if (kind === 'delete' && !window.confirm('관심 키워드에서 삭제할까요? 원고와 분석 이력은 삭제하지 않습니다.')) return;
    if (kind === 'refresh' && !window.confirm(`${ids.length}개 키워드의 자료를 갱신할까요? 예상 ${ids.length * 2}회의 외부 조회가 필요합니다.`)) return;
    lock.current = true; setBusy(true); setError('');
    try { if (kind === 'add') await client.addWatchlist(keyword.trim()); else if (kind === 'delete') { await client.deleteWatchlist(ids[0]); setSelected(current => current.filter(id => id !== ids[0])); } else await client.refreshWatchlist(ids, true); await watch.refetch(); }
    catch (e) { setError(message(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="panel"><h2>관심 키워드</h2><p>나중에 다시 확인할 키워드를 보관합니다. 자동 조회는 하지 않으며 같은 비교 조건의 변화만 표시합니다.</p><div className="action-row"><button disabled={busy || !keyword.trim()} onClick={() => void act('add')}>입력한 키워드 추가</button><button disabled={busy || !selected.length || quotaBlocked} onClick={() => void act('refresh', selected)}>선택한 키워드 갱신</button><button disabled={busy || !watch.data?.items.length || quotaBlocked} onClick={() => void act('refresh', watch.data!.items.map(i => i.id))}>전체 갱신</button><button disabled={busy || watch.isFetching} onClick={() => void watch.refetch()}>저장 목록 다시 읽기</button></div>{quotaBlocked && <p role="alert">조회 사용 한도에 도달했습니다. 목록 확인·편집은 가능합니다.</p>}{(busy || watch.isFetching) && <p role="status">처리 중…</p>}{(error || watch.error) && <p role="alert" className="notice error">{error || message(watch.error)}</p>}
    {watch.data && <><p>{watch.data.items.length}/{watch.data.cap}개 저장</p><div className="table-scroll"><table><thead><tr><th>선택</th><th>키워드</th><th>월 검색량</th><th>상대 변화</th><th>수집·상태</th><th>관리</th></tr></thead><tbody>{watch.data.items.map(item => <tr key={item.id}><td><input type="checkbox" aria-label={`${item.keyword} 선택`} checked={selected.includes(item.id)} onChange={e => setSelected(current => e.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))}/></td><td><button onClick={() => onAnalyze(item.keyword)}>{item.keyword}</button></td><td>{item.last_snapshot?.volume_masked ? '제한값 포함' : numberText(item.last_snapshot?.monthly_searches)}</td><td>{({ up: '상승', down: '하락', flat: '변동 없음', new: '신규', unknown: '비교 자료 부족', insufficient: '비교 자료 부족' } as Record<string, string>)[item.direction] ?? item.direction} {item.delta == null ? '' : numberText(item.delta, 2)}<details><summary>비교 자료</summary><p>현재 {item.last_snapshot?.latest_period ?? '없음'}: {numberText(item.last_snapshot?.latest_ratio, 1)}</p><p>이전 {item.previous_snapshot?.latest_period ?? '없음'}: {numberText(item.previous_snapshot?.latest_ratio, 1)}</p><p>{item.comparison_key} · 절대 검색량 변화 아님</p></details></td><td>{formatTime(item.last_snapshot?.collected_at)}<p>{statusLabel(item.status)}{item.stale ? ' · 최신화 필요' : ''}</p></td><td><button disabled={busy} onClick={() => void act('delete', [item.id])}>목록에서 삭제</button></td></tr>)}</tbody></table></div>{!watch.data.items.length && <p className="empty">아직 관심 키워드가 없습니다. 위 검색창에 주제를 입력하고 추가하세요.</p>}</>}
  </section>;
}
