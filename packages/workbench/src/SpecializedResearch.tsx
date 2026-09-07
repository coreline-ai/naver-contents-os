import React, { useEffect, useRef, useState } from 'react';
import type { CapabilitiesResponse, SpecializedResponse, TrendPoint } from '@ncos/contracts';
import type { CoreClient } from '@ncos/core-client';
import { message, formatTime } from './common';
import { blocked, numberText, safeLink, statusLabel, TrendLine } from './research-common';
export function SpecializedResearch({ client, keyword, capabilities }: { client: CoreClient; keyword: string; capabilities?: CapabilitiesResponse }) {
  const [mode, setMode] = useState<'local' | 'shopping' | 'image'>('local'), [category, setCategory] = useState('');
  const [result, setResult] = useState<{ key: string; value: SpecializedResponse } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const key = JSON.stringify([keyword, mode, category]), current = useRef(key); current.current = key;
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => setError(''), [key]);
  const denied = blocked(capabilities, [mode === 'shopping' ? 'hub_shopping' : 'hub_search']);
  async function run() {
    if (!keyword.trim() || lock.current || denied || (mode === 'shopping' && !category.trim())) return;
    lock.current = true; setBusy(true); setError(''); const requestKey = key;
    try { const value = await client.specialized(keyword.trim(), mode, category.trim(), true); if (alive.current && requestKey === current.current) setResult({ key: requestKey, value }); }
    catch (e) { if (alive.current && requestKey === current.current) setError(message(e)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const shown = result?.key === key ? result.value : null;
  return <section className="panel"><h2>분야별 자료</h2><p>급상승 순위와 다른 도구입니다. 지역은 장소, 쇼핑은 클릭 추이, 사진은 참고 이미지 원문을 찾습니다.</p><div className="subnav" aria-label="자료 종류">{([['local', '지역·장소'], ['shopping', '쇼핑 클릭 추이'], ['image', '참고 사진']] as const).map(([value, label]) => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}</div>
    {mode === 'shopping' && <><label htmlFor="special-category">쇼핑 카테고리 코드</label><input id="special-category" value={category} onChange={e => setCategory(e.target.value)} maxLength={30}/></>}
    <p>{mode === 'image' ? '이미지 생성·본문 자동 삽입 기능이 아닙니다. 원본 권리와 이용 조건을 직접 확인하세요.' : mode === 'local' ? '장소 검색 결과입니다. 영업시간·가격은 원문에서 다시 확인하세요.' : '기간 내 상대 클릭 지수입니다. 판매량이나 구매 전환율이 아닙니다.'}</p><button className="primary" disabled={busy || denied || !keyword.trim() || (mode === 'shopping' && !category.trim())} onClick={() => void run()}>{busy ? '조회 중…' : '최신 자료 조회'}</button>{denied && <p role="alert">해당 API 사용 한도에 도달했습니다.</p>}{error && <p role="alert" className="notice error">{error}</p>}
    {shown && <><p>{shown.keyword} · {statusLabel(shown.status)} · {formatTime(shown.collected_at)}</p>{shown.warning && <p className="notice">{shown.warning}</p>}{shown.rights_notice && <p className="notice">{shown.rights_notice}</p>}<div className="candidate-grid">{shown.items?.map((item, i) => <article className="candidate-card" key={i}>{safeLink(item.thumbnail) && <img src={safeLink(item.thumbnail)!} alt="참고 검색 결과" loading="lazy" referrerPolicy="no-referrer"/>}<h3>{String(item.title ?? '제목 없음')}</h3><p>{String(item.road_address ?? item.address ?? item.category ?? '')}</p>{item.width != null && <p>{String(item.width)} × {String(item.height ?? '?')}</p>}{safeLink(item.link) ? <a href={safeLink(item.link)!} target="_blank" rel="noreferrer">원문 확인 ↗ 새 탭</a> : <p>원문 주소 없음</p>}</article>)}</div>{shown.series?.map((row, i) => <TrendLine key={i} label={String(row.title ?? shown.keyword)} points={(Array.isArray(row.points) ? row.points : []) as TrendPoint[]} collectedAt={shown.collected_at}/>)}{!shown.items?.length && !shown.series?.length && <p>표시할 자료가 없습니다. {statusLabel(shown.status)}</p>}{shown.total != null && <p>검색 결과 수 {numberText(shown.total)}</p>}{!!shown.plan_candidates?.length && <p>글 방향: {shown.plan_candidates.join(' · ')}</p>}</>}
  </section>;
}
