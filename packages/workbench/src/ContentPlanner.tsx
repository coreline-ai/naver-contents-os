import React, { useEffect, useRef, useState } from 'react';
import type { AnalyzeResponse, DraftCreateRequest, FactPack, PreflightResponse } from '@ncos/contracts';
import type { CoreClient } from '@ncos/core-client';
import { FactPackEditor } from './FactPackEditor';
import { formatTime, message } from './common';

const types: Record<string, string> = { HOWTO: '방법 안내', POLICY: '정책·조건', REVIEW: '후기', COMPARISON: '비교', HOMEFEED: '홈피드', PRODUCT: '제품', NEWS: '뉴스', SERIES: '연재' };
export function ContentPlanner({ client, disabled, aiReady, allowSensitiveUnknown, onGenerate, onDirtyChange, onBusyChange, topicRequest }: {
  topicRequest?: { keyword: string; nonce: number } | null;
  client: CoreClient; disabled: boolean; aiReady: boolean; allowSensitiveUnknown: boolean;
  onGenerate: (input: DraftCreateRequest) => void; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [pack, setPack] = useState<FactPack | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [factBusy, setFactBusy] = useState(false);
  const [factDirty, setFactDirty] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const lock = useRef(false);
  const alive = useRef(true);
  const appliedTopic = useRef<number | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onBusyChange(busy || factBusy); }, [busy, factBusy, onBusyChange]);
  useEffect(() => { onDirtyChange(factDirty || busy || factBusy || !!keyword.trim()); }, [keyword, factDirty, busy, factBusy, onDirtyChange]);
  function changeKeyword(value: string) {
    if (disabled || busy || factBusy || (factDirty && !window.confirm('저장하지 않은 근거 선택을 버리고 주제를 바꿀까요?'))) return;
    setKeyword(value); setAnalysis(null); setPreflight(null); setPack(null); setFactDirty(false); setSelectedPlan(null); setError(''); setWarning('');
  }
  useEffect(() => {
    if (!topicRequest || appliedTopic.current === topicRequest.nonce || disabled || busy || factBusy) return;
    appliedTopic.current = topicRequest.nonce;
    if (topicRequest.keyword.trim()) changeKeyword(topicRequest.keyword);
  }, [topicRequest, disabled, busy, factBusy]);
  async function analyze() {
    if (lock.current || disabled || factBusy || !keyword.trim()) return;
    if (factDirty && !window.confirm('근거 선택 변경을 버리고 다시 분석할까요?')) return;
    lock.current = true; setBusy(true); setError(''); setWarning(''); setAnalysis(null); setPreflight(null); setPack(null); setFactDirty(false); setSelectedPlan(null);
    const topic = keyword.trim();
    try {
      try { const check = await client.preflight(topic); if (alive.current) setPreflight(check); }
      catch (e) { if (alive.current) setWarning(`민감 키워드·오타 확인을 완료하지 못했습니다. ${message(e)}`); }
      const result = await client.analyze(topic, null, false);
      if (alive.current) { setAnalysis(result); setSelectedPlan(result.plan[0]?.order ?? null); }
    } catch (e) { if (alive.current) setError(message(e)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function createPack() {
    if (lock.current || disabled || factBusy || !analysis) return;
    lock.current = true; setBusy(true); setError('');
    try { const result = await client.createFactPack(analysis.snapshot_id); if (alive.current) { setPack(result); setFactDirty(false); } }
    catch (e) { if (alive.current) setError(message(e)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const plan = analysis?.plan.find(p => p.order === selectedPlan);
  const approved = pack && pack.latest_status === 'approved' && !factDirty;
  const sensitiveAllowed = preflight?.sensitive === false || (preflight?.sensitive == null && allowSensitiveUnknown);
  const canGenerateAI = aiReady && sensitiveAllowed && approved && plan?.generation_status === 'ready';
  function generate(mode: 'skeleton' | 'llm') {
    if (disabled || busy || factBusy || !analysis || !plan || (mode === 'llm' && !canGenerateAI)) return;
    onGenerate({ keyword: analysis.keyword, snapshot_id: analysis.snapshot_id, plan_item: plan, questions: analysis.questions.map(q => q.text), generation_mode: mode, ...(approved ? { fact_pack_id: pack.fact_pack_id, fact_pack_version: pack.latest_version } : {}) });
  }
  return <section className="panel content-planner" aria-labelledby="planner-heading">
    <p className="eyebrow">근거와 플랜으로 쓰기</p><h2 id="planner-heading">자료를 확인하고 글의 방향을 정하세요</h2>
    <p>빠른 작성과 별개입니다. 분석 → 근거 승인 → 플랜 선택 순서로 진행하며, 승인한 자료만 이 경로의 원고에 연결합니다.</p>
    <form onSubmit={e => { e.preventDefault(); void analyze(); }}><label htmlFor="plan-keyword">1. 분석할 주제</label><div className="inline-form"><input id="plan-keyword" value={keyword} onChange={e => changeKeyword(e.target.value)} disabled={disabled || busy || factBusy} maxLength={100} placeholder="예: 후쿠오카 여행"/><button disabled={disabled || busy || factBusy || !keyword.trim()}>{busy ? '처리 중…' : '주제 분석'}</button></div></form>
    {busy && <p role="status">요청을 처리하고 있습니다. 외부 조회 상태에 따라 시간이 걸릴 수 있습니다.</p>}
    {warning && <p className="notice">{warning}</p>}
    {preflight?.correction && preflight.correction !== keyword && <p className="notice">추천 표기: <button disabled={disabled || busy || factBusy} onClick={() => changeKeyword(preflight.correction!)}>{preflight.correction}</button> · 누르면 주제만 변경합니다. 다시 분석하세요.</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {analysis && <>
      <p>분석: {analysis.keyword} · Snapshot #{analysis.snapshot_id} · {formatTime(analysis.collected_at)}</p>
      <details><summary>분석 자료 연결 상태</summary><ul>{Object.entries(analysis.data_status).map(([source, status]) => <li key={source}>{source} · {status}</li>)}</ul></details>
      {pack ? <FactPackEditor key={pack.fact_pack_id} client={client} pack={pack} disabled={disabled || busy} onChange={next => { setPack(next); setFactDirty(false); }} onDirtyChange={setFactDirty} onBusyChange={setFactBusy}/> : <div className="tool-section"><h3>2. 사용할 근거 확인</h3><p>저장된 분석에서 자료를 정리합니다. 이 버튼은 외부 API나 AI를 새로 호출하지 않습니다.</p><button disabled={disabled || busy} onClick={() => void createPack()}>근거 자료 불러오기</button></div>}
      <div className="tool-section"><h3>3. 콘텐츠 플랜 선택 · {analysis.plan.length}개</h3><p>8가지 글 유형을 지원합니다. 실제 제공된 플랜을 모두 표시하며 구조 전용 항목은 완성 글로 표시하지 않습니다.</p><fieldset disabled={disabled || busy || factBusy} className="plan-list">{analysis.plan.map(item => <label key={item.order} className="plan-option"><input type="radio" name="content-plan" checked={item.order === selectedPlan} onChange={() => setSelectedPlan(item.order)}/><span><strong>{item.order}. {item.title}</strong><small>{types[item.blog_type] ?? item.blog_type} · {item.target_keyword} · {item.generation_status === 'ready' ? 'AI 작성 지원' : '구조 전용'}</small><small>{item.angle} · {item.reason}</small>{(item.series_prev != null || item.series_next != null) && <small>연재 연결: 이전 {item.series_prev ?? '없음'} / 다음 {item.series_next ?? '없음'}</small>}</span></label>)}</fieldset></div>
      <div className="tool-section"><h3>4. 원고 만들기</h3><p>{preflight?.sensitive === true ? '민감 키워드로 확인되어 AI 작성이 차단됩니다.' : !sensitiveAllowed ? '민감 키워드 판별 미완료: 설정에서 미확인 시 허용 여부를 확인하세요.' : !aiReady ? 'AI 연결 상태를 확인하세요. 글 뼈대는 만들 수 있습니다.' : !approved ? 'AI 작성 전 근거를 선택·승인하세요.' : `승인 근거 #${pack.fact_pack_id} v${pack.latest_version}을 연결합니다.`}</p><div className="action-row"><button className="primary" disabled={disabled || busy || factBusy || !canGenerateAI} onClick={() => generate('llm')}>승인 근거로 글 만들기</button><button disabled={disabled || busy || factBusy || !plan} onClick={() => generate('skeleton')}>글 뼈대만 만들기</button></div><p>글 뼈대는 작성 가이드이며 완성 글이 아닙니다. 생성한 원고는 오른쪽 편집 화면에 표시됩니다.</p></div>
    </>}
  </section>;
}
