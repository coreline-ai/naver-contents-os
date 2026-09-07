import React, { useEffect, useRef, useState } from 'react';
import type { FactPack } from '@ncos/contracts';
import type { CoreClient } from '@ncos/core-client';
import { formatTime, message } from './common';

export function FactPackEditor({ client, pack, disabled, onChange, onDirtyChange, onBusyChange }: {
  client: CoreClient; pack: FactPack; disabled: boolean; onChange: (pack: FactPack) => void;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const version = pack.versions.at(-1)!;
  const [selected, setSelected] = useState(() => version.evidence.filter(e => e.selected).map(e => e.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const alive = useRef(true);
  const dirty = version.evidence.some(e => e.selected !== selected.includes(e.id));
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSelected(version.evidence.filter(e => e.selected).map(e => e.id)); }, [version]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  async function save(status: 'draft' | 'approved') {
    if (lock.current || disabled) return;
    if (status === 'approved' && (!selected.length || !window.confirm('선택한 자료의 출처와 내용을 확인했나요? 이 선택을 새 근거 버전으로 승인합니다. 사실성을 자동 보증하지는 않습니다.'))) return;
    lock.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      const next = await client.appendFactPackVersion(pack.fact_pack_id, selected, status, version.version);
      if (alive.current) onChange(next);
    } catch (e) { if (alive.current) setError(`${message(e)} 선택 내용은 유지됩니다. 응답을 받지 못했다면 최신 버전을 확인하세요.`); }
    finally { lock.current = false; if (alive.current) { setBusy(false); onBusyChange(false); } }
  }
  async function reload() {
    if (lock.current || disabled || !window.confirm('현재 선택을 버리고 서버의 최신 근거 버전을 불러올까요?')) return;
    lock.current = true; setBusy(true); onBusyChange(true);
    try { const next = await client.getFactPack(pack.fact_pack_id); if (alive.current) { onChange(next); setSelected(next.versions.at(-1)!.evidence.filter(e => e.selected).map(e => e.id)); setError(''); } }
    catch (e) { if (alive.current) setError(message(e)); }
    finally { lock.current = false; if (alive.current) { setBusy(false); onBusyChange(false); } }
  }
  return <section aria-labelledby="facts-heading" className="tool-section">
    <h3 id="facts-heading">2. 사용할 근거 선택</h3>
    <p>근거 #{pack.fact_pack_id} · v{version.version} · {version.status === 'approved' ? '승인됨' : '미승인'} · {formatTime(version.created_at)}</p>
    <p>검색 결과 제목·질문은 사실 자체가 아닙니다. 원문에서 확인한 자료만 선택하세요. 승인 뒤 선택을 바꾸면 다시 저장·승인해야 합니다.</p>
    {version.warnings.length > 0 && <ul className="notice">{version.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
    <fieldset disabled={disabled || busy} className="evidence-list">
      {version.evidence.map(item => <div className="evidence-item" key={item.id}>
        <label className="check-label"><input type="checkbox" checked={selected.includes(item.id)} onChange={e => setSelected(current => e.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))}/>{item.label}</label>
        <p>{item.source_type} · {formatTime(item.collected_at)} · {item.freshness === 'stale' ? '오래된 자료' : item.freshness === 'unknown' ? '최신성 미확인' : '수집 기간 기준 최신'}{item.from_cache ? ' · 캐시 자료' : ''}</p>
        <details><summary>내용과 출처 확인</summary><pre className="article-preview">{typeof item.value === 'string' ? item.value : JSON.stringify(item.value, null, 2)}</pre><p>출처 ID: {item.source_id}</p>{item.source_url && /^https?:\/\//i.test(item.source_url) && <a href={item.source_url} target="_blank" rel="noreferrer">원문 확인 ↗ 새 탭</a>}</details>
      </div>)}
      {!version.evidence.length && <p>선택할 근거가 없습니다. 분석의 연결 상태를 확인하거나 글 뼈대만 만들 수 있습니다.</p>}
    </fieldset>
    <p role="status">{selected.length}개 선택 · {dirty ? '선택 변경 미저장 · 작성에 사용할 수 없음' : version.status === 'approved' ? `작성에 사용할 승인 버전 v${version.version}` : '승인 전에는 AI 작성에 첨부되지 않음'}</p>
    <div className="action-row"><button disabled={disabled || busy || !dirty} onClick={() => void save('draft')}>선택만 저장</button><button disabled={disabled || busy || !selected.length || (!dirty && version.status === 'approved')} onClick={() => void save('approved')}>선택한 근거 승인</button><button disabled={disabled || busy} onClick={() => void reload()}>최신 근거 다시 읽기</button></div>
    {error && <p role="alert" className="notice error">{error}</p>}
    <details><summary>근거 버전 이력 · {pack.versions.length}개</summary><ul>{[...pack.versions].reverse().map(v => <li key={v.version}>v{v.version} · {v.status === 'approved' ? '승인됨' : '미승인'} · {v.evidence.filter(e => e.selected).length}개 선택 · {formatTime(v.created_at)}</li>)}</ul></details>
  </section>;
}
