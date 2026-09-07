import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ArticleQuality, DraftDetail, SpecializedResponse } from '@ncos/contracts';
import { CoreError, type CoreClient } from '@ncos/core-client';
import { message, formatTime, type WritingPreferences } from './common';

function external(value: unknown): string | null { try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
export function DraftEditor({ client, draft, quality, suggestedTags, preferences, onPreferences, onDirtyChange, onUpdated, disabled }: {
  client: CoreClient; draft: DraftDetail; quality: ArticleQuality | null; suggestedTags: string[]; preferences: WritingPreferences;
  onPreferences: (value: WritingPreferences) => void; onDirtyChange: (value: boolean) => void; onUpdated: (draft: DraftDetail) => void; disabled: boolean;
}) {
  const latest = draft.versions.at(-1)!;
  const [title, setTitle] = useState(latest.title);
  const [body, setBody] = useState(latest.body);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [conflict, setConflict] = useState<DraftDetail | null>(null);
  const [images, setImages] = useState<SpecializedResponse | null>(null);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imagesError, setImagesError] = useState('');
  const [jobId, setJobId] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [blogId, setBlogId] = useState(preferences.blogId);
  const [tags, setTags] = useState(preferences.tags || suggestedTags.join(', '));
  const [showFacts, setShowFacts] = useState(false);
  const [publicationUrl, setPublicationUrl] = useState('');
  const [publicationDate, setPublicationDate] = useState('');
  const [publicConfirmed, setPublicConfirmed] = useState(false);
  const [registering, setRegistering] = useState(false);
  const busy = useRef(false);
  const publishBusy = useRef(false);
  const registrationBusy = useRef(false);
  const [publishUnknown, setPublishUnknown] = useState(false);
  const alive = useRef(true);
  const uncertainAfter = useRef(0);
  useEffect(() => { setBlogId(preferences.blogId); }, [preferences.blogId]);
  useEffect(() => { setTags(preferences.tags || suggestedTags.join(', ')); }, [preferences.tags, suggestedTags]);
  const dirty = title !== latest.title || body !== latest.body;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setTitle(latest.title); setBody(latest.body); setNote(''); setConflict(null); }, [draft.draft_id, latest.version]);
  useEffect(() => { onDirtyChange(dirty || saving || publishing || registering); }, [dirty, saving, publishing, registering, onDirtyChange]);
  const facts = useQuery({ queryKey: ['workbench-facts', draft.fact_pack_id], queryFn: () => client.getFactPack(draft.fact_pack_id!), enabled: showFacts && !!draft.fact_pack_id });
  const previousJob = useQuery({ queryKey: ['workbench-latest-publish', draft.draft_id], queryFn: async () => { const result = await client.latestPublishJob(draft.draft_id); if (result && result.draft_id !== draft.draft_id) throw new Error('다른 원고의 최근 작업 응답입니다.'); return result; }, staleTime: 0 });
  useEffect(() => {
    if (previousJob.data?.draft_id === draft.draft_id) {
      setJobId(current => Math.max(current ?? 0, previousJob.data!.job_id));
      if (previousJob.data.job_id > uncertainAfter.current) setPublishUnknown(false);
    }
  }, [previousJob.data, draft.draft_id]);
  const job = useQuery({ queryKey: ['workbench-publish', jobId], queryFn: async () => { const result = await client.getPublishJob(jobId!); if (result.draft_id !== draft.draft_id) throw new Error('다른 원고의 작업 응답입니다. 다시 확인하세요.'); return result; }, enabled: !!jobId, refetchInterval: q => q.state.data && ['draft_saved', 'failed'].includes(q.state.data.status) ? false : 2000 });
  async function save() {
    if (busy.current || !dirty || !title.trim() || !body.trim()) return;
    busy.current = true; setSaving(true); setError(''); setStatus('');
    try {
      const saved = await client.addDraftVersion(draft.draft_id, { title, body, note, expected_version: latest.version });
      const loaded = await client.getDraft(draft.draft_id);
      if (alive.current) { onUpdated(loaded); setStatus(`수정 내용을 원고 버전 ${saved.version}으로 저장했습니다.`); }
    } catch (e) { if (alive.current) setError(`${message(e)} 편집 내용은 유지됩니다. 최신 원고를 확인한 뒤 다시 시도하세요.`); }
    finally { busy.current = false; if (alive.current) setSaving(false); }
  }
  async function compareLatest() {
    try { const current = await client.getDraft(draft.draft_id); if (alive.current) setConflict(current); }
    catch (e) { if (alive.current) setError(message(e)); }
  }
  async function findImages() {
    if (imagesLoading) return;
    setImagesLoading(true); setImagesError('');
    try { const result = await client.specialized(draft.keyword, 'image'); if (alive.current) setImages(result); }
    catch (e) { if (alive.current) setImagesError(message(e)); }
    finally { if (alive.current) setImagesLoading(false); }
  }
  async function publish() {
    const selectedTags = tags.split(',').map(t => t.trim()).filter(Boolean);
    if (publishBusy.current || previousJob.isPending || previousJob.isFetching || previousJob.isError || publishUnknown || dirty || (jobId && (!job.data || !['draft_saved', 'failed'].includes(job.data.status))) || selectedTags.length > 10 || selectedTags.some(t => t.length > 50)) return;
    publishBusy.current = true;
    if (!window.confirm(`블로그 ${blogId}에 현재 원고 v${latest.version}을 임시저장할까요? 별도 로그인 브라우저가 필요하며 공개 발행은 하지 않습니다.`)) { publishBusy.current = false; return; }
    uncertainAfter.current = Math.max(jobId ?? 0, previousJob.data?.job_id ?? 0);
    setPublishing(true); setPublishError('');
    try {
      const job = await client.startPublishJob(draft.draft_id, { blog_id: blogId, tags: selectedTags, expected_version: latest.version });
      if (alive.current) { setJobId(job.job_id); onPreferences({ ...preferences, blogId, tags }); }
    } catch (e) {
      if (alive.current) {
        const rejected = e instanceof CoreError && [400, 401, 403, 404, 409, 422].includes(e.status);
        setPublishError(rejected ? `${message(e)} 요청이 거부되었습니다. 연결·입력·최신 원고 버전을 확인하세요.` : `${message(e)} 작업이 생성되었는지 아래에서 다시 확인하세요. 중복 요청을 막기 위해 재실행을 중지했습니다.`);
        setPublishUnknown(!rejected);
        if (rejected && e.status === 409) void compareLatest();
      }
    }
    finally { publishBusy.current = false; if (alive.current) setPublishing(false); }
  }
  async function register() {
    if (!publicConfirmed || !publicationUrl || !publicationDate || registrationBusy.current) return;
    registrationBusy.current = true;
    setRegistering(true); setError('');
    try {
      await client.createPublishedContent({ draft_id: draft.draft_id, title: latest.title, canonical_url: publicationUrl, published_at: new Date(`${publicationDate}+09:00`).toISOString(), confirmed: true });
      if (alive.current) { setStatus('공개 완료 사실을 로컬 발행 기록에 등록했습니다.'); setPublicConfirmed(false); }
    } catch (e) { if (alive.current) setError(message(e)); }
    finally { registrationBusy.current = false; if (alive.current) setRegistering(false); }
  }
  const validTags = tags.split(',').filter(t => t.trim()).length <= 10 && tags.split(',').every(t => t.trim().length <= 50);
  return <section className="panel draft-editor" aria-labelledby="editor-title">
    <div className="section-title"><div><p className="eyebrow">2 · 편집과 검수</p><h2 id="editor-title">원고 #{draft.draft_id}</h2></div><span className="muted">로컬 저장 v{latest.version}</span></div>
    {draft.provider === 'skeleton' && <p className="notice">글 뼈대에서 시작한 원고입니다. AI 완성 글이나 자동 품질 검사 통과 원고가 아닙니다. 내용을 직접 채우고 검수하세요.</p>}
    <label htmlFor="draft-title">제목</label><input id="draft-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} disabled={disabled || saving}/>
    <label htmlFor="draft-body">본문</label><textarea id="draft-body" value={body} onChange={e => setBody(e.target.value)} maxLength={100000} disabled={disabled || saving} className="article-text" rows={18}/>
    <div className="editor-status"><span role="status">{dirty ? '변경 사항 미저장' : '로컬 저장됨'} · {body.length.toLocaleString()}자</span><span>{formatTime(latest.created_at)}</span></div>
    <label htmlFor="version-note">수정 메모 <span className="muted">선택</span></label><input id="version-note" value={note} onChange={e => setNote(e.target.value)} maxLength={200} disabled={saving}/>
    <button className="primary" disabled={disabled || saving || !dirty || !title.trim() || !body.trim()} onClick={() => void save()}>{saving ? '저장 중…' : '수정 내용 저장'}</button>
    {status && <p role="status" className="notice">{status}</p>}
    {error && <div className="notice error" role="alert"><p>{error}</p><button onClick={() => void compareLatest()}>최신 원고와 비교</button></div>}
    {conflict && <details open className="tool-section"><summary>서버 최신 v{conflict.versions.at(-1)?.version} · 현재 편집 내용은 유지 중</summary><h3>{conflict.versions.at(-1)?.title}</h3><pre className="article-preview">{conflict.versions.at(-1)?.body}</pre><button onClick={() => { if (window.confirm('현재 편집 내용을 버리고 서버 최신 원고를 불러올까요?')) { onUpdated(conflict); setTitle(conflict.versions.at(-1)!.title); setBody(conflict.versions.at(-1)!.body); setConflict(null); setError(''); } }}>편집 내용 버리고 최신 원고 불러오기</button></details>}
    <details className="tool-section"><summary>버전 이력 · {draft.versions.length}개</summary>{[...draft.versions].reverse().map(v => <details key={v.version}><summary>v{v.version} · {v.title} {v.note ? `· ${v.note}` : ''}</summary><pre className="article-preview">{v.body}</pre></details>)}</details>
    <details className="tool-section"><summary>자동 검사와 작성 정보</summary><p>작성 모델: {draft.provider} · {draft.model || '모델 정보 없음'} / 프롬프트: {draft.prompt_version}</p>{quality ? <><p>생성 시 자동 검사 {quality.score}점 · {quality.char_count.toLocaleString()}자. 편집 이후 내용의 점수가 아닙니다.</p><ul>{quality.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></> : <p>현재 원고에 연결된 자동 검사 결과가 제공되지 않았습니다.</p>}<p>자동 검사는 구조와 분량 등의 점검이며 사실성·상위 노출을 보증하지 않습니다.</p></details>
    <details className="tool-section" onToggle={e => setShowFacts(e.currentTarget.open)}><summary>이 원고의 근거 자료</summary>{!draft.fact_pack_id ? <p>연결된 근거 자료가 없습니다.</p> : <><p>근거 #{draft.fact_pack_id} · 작성에 사용한 버전 {draft.fact_pack_version ?? '미제공'}</p>{facts.isFetching && <p role="status">근거를 불러오는 중…</p>}{facts.error && <p role="alert">{message(facts.error)}</p>}{facts.data?.versions.filter(v => v.version === draft.fact_pack_version).map(v => <ul key={v.version}>{v.evidence.map(e => <li key={e.id}><strong>{e.label}</strong> · {e.selected ? '선택됨' : '미선택'}<p>{e.source_type} · {e.collected_at ?? '수집 시각 미제공'} · {e.freshness} {e.from_cache ? '· 저장된 자료' : ''}</p><pre className="article-preview">{typeof e.value === 'string' ? e.value : JSON.stringify(e.value, null, 2)}</pre>{external(e.source_url) && <a href={external(e.source_url)!} target="_blank" rel="noreferrer">원문 확인 ↗ 새 탭</a>}</li>)}</ul>)}</>}</details>
    <details className="tool-section"><summary>참고 사진 찾기</summary><p>사진을 검색하는 기능입니다. 이미지 생성·본문 자동 삽입은 하지 않습니다. 원본의 이용 조건을 확인하세요.</p><button disabled={imagesLoading} onClick={() => void findImages()}>{imagesLoading ? '검색 중…' : '참고 사진 검색'}</button>{imagesError && <p role="alert">{imagesError}</p>}{images && <><p>{images.rights_notice} {images.warning}</p><p>조회 상태: {images.status}</p><ul>{images.items?.map((item, i) => { const url = external(item.link); return <li key={i}>{url ? <a href={url} target="_blank" rel="noreferrer">{String(item.title || '원본 사진')} ↗ 새 탭</a> : '원본 주소 없음'}</li>; })}</ul></>}</details>
    <details className="tool-section"><summary>네이버에 임시저장</summary><p>별도 로그인 브라우저에 저장합니다. 공개 발행은 하지 않습니다. {dirty && '먼저 수정 내용을 로컬에 저장하세요.'}</p><label htmlFor="blog-id">네이버 블로그 ID</label><input id="blog-id" value={blogId} onChange={e => setBlogId(e.target.value)} placeholder="예: sence4u" maxLength={100}/><label htmlFor="publish-tags">태그 · 쉼표 구분, 최대 10개</label><input id="publish-tags" value={tags} onChange={e => setTags(e.target.value)} maxLength={510}/>{!validTags && <p role="alert">태그는 최대 10개, 각각 50자 이하여야 합니다.</p>}<button disabled={disabled || dirty || saving || publishing || previousJob.isPending || previousJob.isFetching || previousJob.isError || publishUnknown || (!!jobId && (!job.data || !['draft_saved', 'failed'].includes(job.data.status))) || !validTags || !/^[A-Za-z0-9_-]+$/.test(blogId)} onClick={() => void publish()}>{publishing ? '작업 요청 중…' : '네이버에 임시저장'}</button><div className="notice"><button disabled={publishing || previousJob.isFetching} onClick={() => void previousJob.refetch()}>기존 임시저장 작업 다시 확인</button>{previousJob.isFetching && <p role="status">이 원고의 최근 작업을 확인 중…</p>}{previousJob.error && <p role="alert">최근 작업을 확인하지 못해 새 요청을 막았습니다. {message(previousJob.error)}</p>}{!previousJob.isFetching && previousJob.data === null && <p>현재 조회된 작업 기록 없음</p>}{publishUnknown && <p>응답이 끊긴 요청의 생성 여부는 아직 확정할 수 없습니다. 새 작업이 확인되기 전에는 다시 요청하지 마세요.</p>}</div>{publishError && <p role="alert" className="notice error">{publishError}</p>}{job.error && <p role="alert">작업 상태를 확인하지 못했습니다. 중복 요청 전에 내 원고에서 확인하세요. {message(job.error)}</p>}{job.data && <div role="status"><p>작업 #{job.data.job_id} · {job.data.status === 'draft_saved' ? '네이버 임시저장 확인됨' : job.data.status === 'failed' ? '임시저장 실패' : '임시저장 처리 중'} · {job.data.stage}</p><p>{job.data.detail}</p><details><summary>실제 작업 이력</summary><ul>{job.data.history.map((h, i) => <li key={i}>{h.at} · {h.stage} · {h.status} {h.error_code}</li>)}</ul></details></div>}</details>
    <details className="tool-section"><summary>공개 완료 등록</summary><p>네이버에서 직접 공개한 글의 사실을 기록합니다. 이 버튼으로 글이 공개되지 않습니다.</p><label htmlFor="public-url">실제 공개 URL</label><input id="public-url" type="url" value={publicationUrl} onChange={e => setPublicationUrl(e.target.value)} maxLength={1000}/><label htmlFor="public-date">공개 시각 (KST)</label><input id="public-date" type="datetime-local" value={publicationDate} onChange={e => setPublicationDate(e.target.value)}/><label className="check-label"><input type="checkbox" checked={publicConfirmed} onChange={e => setPublicConfirmed(e.target.checked)}/>이 글이 실제로 공개된 것을 확인했습니다.</label><button disabled={!publicConfirmed || !publicationUrl || !publicationDate || registering || dirty} onClick={() => void register()}>공개 완료 사실 등록</button></details>
  </section>;
}
