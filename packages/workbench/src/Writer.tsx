import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ArticleQuality, BlogComposeStyle, DraftDetail, DraftCreateRequest } from '@ncos/contracts';
import type { CoreClient } from '@ncos/core-client';
import { DraftEditor } from './DraftEditor';
import { ContentPlanner } from './ContentPlanner';
import type { ImprovementInput } from './improvement';

import { message, type WritingPreferences } from './common';
export type { WritingPreferences } from './common';
export function Writer({ client, openRequest, onDirtyChange, onSaved, preferences, onPreferences, improvementRequest, topicRequest, composeTopicRequest, onFindKeywords }: {
  onFindKeywords?: () => void;
  composeTopicRequest?: { keyword: string; nonce: number } | null;
  improvementRequest?: { input: ImprovementInput; nonce: number } | null; topicRequest?: { keyword: string; nonce: number } | null;
  client: CoreClient; openRequest: { id: number; nonce: number } | null; onDirtyChange: (value: boolean) => void;
  onSaved: (id: number, selected: boolean) => void; preferences: WritingPreferences; onPreferences: (value: WritingPreferences) => void;
}) {
  const [improvement, setImprovement] = useState<ImprovementInput | null>(null);
  const [completion, setCompletion] = useState<{ recommendationId: number; draftId: number; error: string } | null>(null);
  const completionBusy = useRef(false);
  const [mode, setMode] = useState<'quick' | 'plan'>('quick');
  const [plannerDirty, setPlannerDirty] = useState(false);
  const [plannerBusy, setPlannerBusy] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [notes, setNotes] = useState('');
  const [style, setStyle] = useState<BlogComposeStyle>('auto');
  const [length, setLength] = useState(2500);
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [quality, setQuality] = useState<ArticleQuality | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const epoch = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  const llm = useQuery({ queryKey: ['workbench-llm'], queryFn: () => client.llmStatus(), retry: false, refetchInterval: 30_000 });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++epoch.current; }; }, []);
  useEffect(() => { onDirtyChange(dirty || plannerDirty || plannerBusy || pending || (!draft && (!!notes.trim() || !!keyword.trim()))); }, [dirty, plannerDirty, plannerBusy, pending, draft, notes, keyword, onDirtyChange]);
  useEffect(() => {
    if (!pending) return;
    const start = Date.now(); setElapsed(0);
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [pending]);
  async function open(id: number) {
    const request = ++epoch.current;
    setLoadingDraft(true); setError('');
    try {
      const loaded = await client.getDraft(id);
      if (request !== epoch.current || !mounted.current) return;
      setDraft(loaded); setImprovement(null); setCompletion(null); setQuality(null); setCreatedId(null); setTags([]); setDirty(false);
    } catch (e) { if (request === epoch.current && mounted.current) setError(`원고를 불러오지 못했습니다. ${message(e)}`); }
    finally { if (request === epoch.current && mounted.current) setLoadingDraft(false); }
  }
  useEffect(() => { if (openRequest) void open(openRequest.id); }, [openRequest]);
  useEffect(() => {
    if (!improvementRequest) return;
    ++epoch.current; setLoadingDraft(false);
    const input = improvementRequest.input;
    setMode('quick'); setKeyword(input.keyword); setNotes(input.notes); setStyle('auto'); setImprovement(input);
    setDraft(null); setQuality(null); setCreatedId(null); setTags([]); setDirty(false); setError(''); setCompletion(null);
  }, [improvementRequest]);
  useEffect(() => { if (topicRequest) setMode('plan'); }, [topicRequest]);
  useEffect(() => {
    if (!composeTopicRequest) return;
    ++epoch.current; setLoadingDraft(false); setMode('quick');
    setKeyword(composeTopicRequest.keyword); setNotes(''); setImprovement(null); setCompletion(null);
    setDraft(null); setQuality(null); setCreatedId(null); setTags([]); setDirty(false); setError('');
  }, [composeTopicRequest]);
  async function markDone(recommendationId: number, draftId: number) {
    try {
      await client.updatePerformanceRecommendation(recommendationId, 'done');
      if (mounted.current) onSavedRef.current(draftId, false);
      if (mounted.current) setCompletion(current => current?.recommendationId === recommendationId ? null : current);
    } catch (e) { if (mounted.current) setCompletion({ recommendationId, draftId, error: message(e) }); }
  }
  async function retryCompletion() {
    if (!completion || completionBusy.current) return;
    completionBusy.current = true;
    try { await markDone(completion.recommendationId, completion.draftId); }
    finally { completionBusy.current = false; }
  }
  async function compose() {
    if (busy.current || plannerBusy || !keyword.trim() || !llm.data?.ready) return;
    if (dirty && !window.confirm('수정 중인 원고를 저장하지 않고 새 글을 만들까요?')) return;
    busy.current = true;
    const request = ++epoch.current;
    const context = improvement;
    setPending(true); setError(''); setQuality(null); setCreatedId(null);
    try {
      const result = await client.composeBlog({ keyword: keyword.trim(), user_notes: notes.trim(), style, target_chars: length, allow_sensitive_unknown: preferences.allowSensitiveUnknown, ...(context?.sourceDraftId ? { source_draft_id: context.sourceDraftId, source_draft_mode: context.sourceDraftMode } : {}) });
      if (mounted.current) onSavedRef.current(result.draft.draft_id, request === epoch.current);
      if (context) await markDone(context.recommendationId, result.draft.draft_id);
      if (request !== epoch.current || !mounted.current) return;
      setCreatedId(result.draft.draft_id);
      const detail = await client.getDraft(result.draft.draft_id);
      if (request !== epoch.current || !mounted.current) return;
      setDraft(detail); setQuality(result.quality); setTags(result.suggested_tags); setCreatedId(null); setDirty(false);
    } catch (e) {
      if (request === epoch.current && mounted.current) setError(`${message(e)} 통신이 끊겼다면 내 원고에서 저장 여부를 확인한 뒤 다시 실행하세요.`);
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  async function createFromPlan(input: DraftCreateRequest) {
    if (busy.current || plannerBusy || loadingDraft) return;
    if (dirty && !window.confirm('수정 중인 원고를 저장하지 않고 플랜 원고를 만들까요?')) return;
    busy.current = true;
    const request = ++epoch.current;
    setPending(true); setError(''); setQuality(null); setCreatedId(null);
    try {
      const result = await client.createDraft(input);
      if (mounted.current) onSavedRef.current(result.draft_id, request === epoch.current);
      if (request !== epoch.current || !mounted.current) return;
      setCreatedId(result.draft_id);
      const detail = await client.getDraft(result.draft_id);
      if (request !== epoch.current || !mounted.current) return;
      setDraft(detail); setTags([]); setCreatedId(null); setDirty(false);
    } catch (e) { if (request === epoch.current && mounted.current) setError(`${message(e)} 통신이 끊겼다면 내 원고에서 저장 여부를 먼저 확인하세요.`); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  return <>
    <div className="subnav" aria-label="글 작성 방법"><button aria-pressed={mode === 'quick'} onClick={() => setMode('quick')}>빠른 작성</button><button aria-pressed={mode === 'plan'} onClick={() => setMode('plan')}>근거와 플랜으로 쓰기</button></div>
    <div className={mode === 'plan' ? 'writer-layout planned-layout' : 'writer-layout'}>
    <div hidden={mode !== 'plan'}><ContentPlanner client={client} disabled={pending || loadingDraft} aiReady={!!llm.data?.ready} allowSensitiveUnknown={preferences.allowSensitiveUnknown} topicRequest={topicRequest} onGenerate={input => void createFromPlan(input)} onDirtyChange={setPlannerDirty} onBusyChange={setPlannerBusy}/></div>
    <section hidden={mode !== 'quick'} className="panel compose-panel" aria-labelledby="compose-heading">
      <p className="eyebrow">1 · 주제와 내용</p><h2 id="compose-heading">무엇에 대해 쓸까요?</h2><p>주제와 실제 경험을 적으면 자동 검사를 거친 원고를 만듭니다. 공개 전 사실과 표현은 직접 확인하세요.</p>
      {improvement && <div className="notice"><p>{improvement.label} · 추천 #{improvement.recommendationId} · {improvement.sourceDraftId ? `참조 원고 #${improvement.sourceDraftId}` : '연결 원고 없음'}</p><p>{improvement.sourceDraftMode === 'revision' ? '기존 원고와 같은 주제로 새 개선 원고를 만듭니다.' : '기존 원고를 참고하되 후속 주제로 새 원고를 만듭니다.'} 주제를 수정하면 추천 연결과 자동 메모가 해제됩니다. 기존 원고를 덮어쓰지 않습니다.</p><button className="text-button" onClick={() => { setImprovement(null); setNotes(''); }}>추천 연결 해제</button></div>}
      <form onSubmit={e => { e.preventDefault(); void compose(); }}>
        <fieldset disabled={pending || loadingDraft || plannerBusy}>
          <label htmlFor="topic">글 주제</label><input id="topic" value={keyword} onChange={e => { if (improvement && e.target.value !== improvement.keyword) { setImprovement(null); setNotes(''); } setKeyword(e.target.value); }} placeholder="예: 후쿠오카 여행 준비" maxLength={100}/>
          <label htmlFor="notes">꼭 넣을 내용 <span className="muted">선택</span></label><textarea id="notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="직접 경험한 내용, 확인한 장소·일정 등을 적어주세요." maxLength={2000} rows={5}/>
          <div className="form-grid"><div><label htmlFor="style">글 스타일</label><select id="style" value={style} onChange={e => setStyle(e.target.value as BlogComposeStyle)}><option value="auto">자동 선택</option><option value="informational">정보형</option><option value="review">후기형</option><option value="product">구매가이드</option></select></div><div><label htmlFor="length">목표 분량</label><select id="length" value={length} onChange={e => setLength(Number(e.target.value))}><option value={2500}>약 2,500자</option><option value={4000}>약 4,000자</option></select></div></div>
        </fieldset>
        <button className="primary full-width" disabled={!keyword.trim() || !llm.data?.ready || pending || loadingDraft || plannerBusy}>{pending ? '작성·검사 처리 중…' : '완성 글 만들기'}</button>
      </form>
      {onFindKeywords && <button type="button" className="text-button" onClick={onFindKeywords}>키워드 추천 보기</button>}
      {pending && <p role="status" className="notice">작성·검사 처리 중 · {elapsed}초 경과. 서버 응답 전에는 정확한 진행률을 알 수 없습니다.</p>}
      <div className="ai-status"><strong>글쓰기 AI</strong>{llm.isFetching && !llm.data ? <p role="status">연결 확인 중…</p> : llm.data ? <><p>{llm.data.ready ? `사용 가능 · ${llm.data.engine} · ${llm.data.model}` : llm.data.message}</p>{!llm.data.ready && <p>{llm.data.action}</p>}</> : <p role="alert">AI 상태를 확인하지 못했습니다. {message(llm.error)}</p>}<button className="text-button" onClick={() => void llm.refetch()}>AI 연결 다시 확인</button></div>
      {error && <p role="alert" className="notice error">{error}</p>}
      {createdId && <div className="notice"><p>원고 #{createdId}의 생성·저장 응답은 받았지만 편집 화면을 불러오지 못했습니다. 재생성하지 않고 다시 열 수 있습니다.</p><button onClick={() => void open(createdId)}>저장된 원고 다시 열기</button></div>}
    </section>
    <div className="writing-result">
      {completion && <div className="notice error" role="alert"><p>원고 #{completion.draftId}은 저장됐지만 추천 #{completion.recommendationId} 완료 표시를 반영하지 못했습니다. {completion.error}</p><button onClick={() => void retryCompletion()}>추천 완료 표시만 다시 시도</button></div>}
      {mode === 'plan' && pending && <p role="status" className="notice">원고 작성·저장 처리 중 · {elapsed}초 경과. 정확한 진행률은 제공되지 않습니다.</p>}
      {mode === 'plan' && error && <p role="alert" className="notice error">{error}</p>}
      {mode === 'plan' && createdId && <button onClick={() => void open(createdId)}>저장된 원고 #{createdId} 다시 열기</button>}
      {loadingDraft && <p role="status">선택한 원고를 불러오는 중…</p>}
      {draft ? <DraftEditor key={draft.draft_id} client={client} draft={draft} quality={quality} suggestedTags={tags} preferences={preferences} onPreferences={onPreferences} onDirtyChange={setDirty} disabled={pending || loadingDraft || plannerBusy} onUpdated={next => { setDraft(next); setQuality(null); onSavedRef.current(next.draft_id, true); }}/>
      : <section className="panel empty-editor"><p className="eyebrow">2 · 원고 편집과 검수</p><h2>작성한 글이 여기에 표시됩니다</h2><p>제목과 본문을 직접 수정하고, 새 버전으로 저장할 수 있습니다.</p><ol><li>주제를 입력하고 완성 글을 만듭니다.</li><li>내용과 출처를 확인하고 수정합니다.</li><li>내 원고에 저장한 뒤 네이버 임시저장을 선택합니다.</li></ol><p className="notice">원고 저장은 이 컴퓨터에, 네이버 임시저장은 별도 로그인 브라우저에 저장합니다. 자동으로 공개하지 않습니다.</p></section>}
    </div>
  </div></>;
}
