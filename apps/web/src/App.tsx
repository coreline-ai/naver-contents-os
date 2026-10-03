import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CoreClient } from '@ncos/core-client';
import { Writer, readDraftTags, DraftLibrary, TodayWork, PerformanceWorkspace, type PerformanceView, type ImprovementInput, type WritingPreferences, KeywordWorkspace, type KeywordView } from '@ncos/workbench';
import { AppearancePanel } from './AppearancePanel';
import { useTheme } from './theme';
import { SettingsPanel } from './SettingsPanel';
import { MenuGuide, type MenuDestination } from './MenuGuide';
import { sessionRequest, type WebSession } from './session';

export const AREAS = { write: '글쓰기', keywords: '키워드 찾기', drafts: '내 원고', performance: '성과', settings: '앱 설정' } as const;
export type Area = keyof typeof AREAS;
export function currentArea(): Area {
  const path = window.location.pathname.replace('/app', '').replaceAll('/', '');
  return path in AREAS ? path as Area : 'write';
}
export const core = new CoreClient('', { kind: 'web-session' });
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '요청을 완료하지 못했습니다.'; }
export function LoadState({ loading, error }: { loading: boolean; error: unknown }) {
  if (error) return <p role="alert" className="notice error">{errorMessage(error)} 저장 여부가 불확실하면 목록을 먼저 확인하세요.</p>;
  return loading ? <p role="status" className="muted">자료를 불러오는 중…</p> : null;
}

export default function App() {
  const theme = useTheme();
  const [area, setArea] = useState(currentArea);
  const [keywordsVisited, setKeywordsVisited] = useState(currentArea() === 'keywords');
  const [keywordView, setKeywordView] = useState<{ view: KeywordView; nonce: number } | null>(null);
  const [libraryView, setLibraryView] = useState<'drafts' | 'published'>('drafts');
  const [composeTopicRequest, setComposeTopicRequest] = useState<{ keyword: string; nonce: number } | null>(null);
  useEffect(() => { if (area === 'keywords') setKeywordsVisited(true); }, [area]);
  const [improvementRequest, setImprovementRequest] = useState<{ input: ImprovementInput; nonce: number } | null>(null);
  const [topicRequest, setTopicRequest] = useState<{ keyword: string; nonce: number } | null>(null);
  const [writerDirty, setWriterDirty] = useState(false);
  const [performanceDirty, setPerformanceDirty] = useState(false);
  const dirty = writerDirty || performanceDirty;
  const [performanceVisited, setPerformanceVisited] = useState(currentArea() === 'performance');
  const [performanceView, setPerformanceView] = useState<{ view: PerformanceView; nonce: number } | null>(null);
  useEffect(() => { if (area === 'performance') setPerformanceVisited(true); }, [area]);
  const [openRequest, setOpenRequest] = useState<{ id: number; nonce: number } | null>(() => {
    const id = Number(new URLSearchParams(window.location.search).get('draft_id'));
    return Number.isSafeInteger(id) && id > 0 ? { id, nonce: 0 } : null;
  });
  const activeDraftId = useRef(openRequest?.id ?? null);
  const dirtyRef = useRef(dirty); dirtyRef.current = writerDirty;
  const areaRef = useRef(area); areaRef.current = area;
  const [preferences, setPreferences] = useState<WritingPreferences>(() => {
    try {
      const value = JSON.parse(localStorage.getItem('ncos-web-preferences') ?? '{}');
      return { draftTags: readDraftTags(value.draftTags), blogId: typeof value.blogId === 'string' ? value.blogId : '', tags: typeof value.tags === 'string' ? value.tags : '', allowSensitiveUnknown: typeof value.allowSensitiveUnknown === 'boolean' ? value.allowSensitiveUnknown : true };
    } catch { return { blogId: '', tags: '', allowSensitiveUnknown: true }; }
  });
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  const [session, setSession] = useState<WebSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const queryClient = useQueryClient();
  const [reconnect, setReconnect] = useState(false);
  useEffect(() => {
    let active = true;
    void sessionRequest('GET').then(s => { if (active) setSession(s); }).catch(e => { if (active) setError(errorMessage(e)); });
    const pop = () => {
      const next = currentArea();
      const id = Number(new URLSearchParams(window.location.search).get('draft_id'));
      if (next === 'write' && Number.isSafeInteger(id) && id > 0 && id !== activeDraftId.current) {
        if (dirtyRef.current && !window.confirm('미저장 변경을 버리고 이전 원고로 이동할까요?')) {
          history.pushState(null, '', `/app/${areaRef.current}${areaRef.current === 'write' && activeDraftId.current ? `?draft_id=${activeDraftId.current}` : ''}`);
          return;
        }
        activeDraftId.current = id;
        setOpenRequest({ id, nonce: Date.now() });
      }
      setArea(next);
    };
    window.addEventListener('popstate', pop);
    return () => { active = false; window.removeEventListener('popstate', pop); };
  }, []);
  function navigate(next: Area) {
    const suffix = next === 'write' && activeDraftId.current ? `?draft_id=${activeDraftId.current}` : '';
    history.pushState(null, '', `/app/${next}${suffix}`);
    setArea(next);
    requestAnimationFrame(() => heading.current?.focus());
  }
  function openDraft(id: number) {
    if (writerDirty && !window.confirm('미저장 변경이 있습니다. 변경 내용을 버리고 선택한 원고를 열까요?')) return;
    activeDraftId.current = id;
    setOpenRequest({ id, nonce: Date.now() });
    history.pushState(null, '', `/app/write?draft_id=${id}`);
    setArea('write');
    requestAnimationFrame(() => heading.current?.focus());
  }
  function openImprovement(input: ImprovementInput) {
    if (writerDirty && !window.confirm('작성 중인 내용을 버리고 성과 개선 조건을 준비할까요?')) return;
    activeDraftId.current = null; setOpenRequest(null);
    setImprovementRequest({ input, nonce: Date.now() });
    navigate('write');
  }
  function prepareAnalysis(keyword: string) {
    if (writerDirty && !window.confirm('작성 중인 내용이 있습니다. 선택한 키워드를 근거 플랜에 준비할까요?')) return;
    setTopicRequest({ keyword, nonce: Date.now() }); navigate('write');
  }
  function keywordWriter(keyword: string) {
    if (writerDirty && !window.confirm('작성 중인 내용을 버리고 선택한 키워드로 새 글을 준비할까요?')) return;
    activeDraftId.current = null; setOpenRequest(null);
    setComposeTopicRequest({ keyword, nonce: Date.now() }); navigate('write');
  }
  function openMenu(destination: MenuDestination) {
    if (destination.area === 'performance') setPerformanceView({ view: destination.view ?? 'summary', nonce: Date.now() });
    if (destination.area === 'keywords') setKeywordView({ view: destination.view ?? 'latest', nonce: Date.now() });
    if (destination.area === 'drafts') setLibraryView(destination.published ? 'published' : 'drafts');
    if (destination.area === 'write' && destination.plan) setTopicRequest({ keyword: '', nonce: Date.now() });
    navigate(destination.area);
  }
  function savePreferences(value: WritingPreferences) {
    setPreferences(value);
    try { localStorage.setItem('ncos-web-preferences', JSON.stringify(value)); }
    catch { setError('설정을 브라우저에 저장하지 못했습니다. 현재 화면에서는 유지됩니다.'); setReconnect(true); }
  }
  async function pair() {
    if (!code.trim() || connecting) return;
    setConnecting(true); setError('');
    try { setSession(await sessionRequest('POST', code.trim())); setCode(''); setReconnect(false); await queryClient.invalidateQueries(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setConnecting(false); }
  }
  async function disconnect() {
    if (dirty && !window.confirm('저장하지 않은 변경 내용이 있습니다. 연결을 종료하면 사라질 수 있습니다. 종료할까요?')) return;
    if (!window.confirm('이 브라우저의 앱 연결을 종료할까요? 저장된 원고는 삭제되지 않습니다.')) return;
    try { await sessionRequest('DELETE'); queryClient.clear(); setWriterDirty(false); setPerformanceDirty(false); setPerformanceVisited(false); activeDraftId.current = null; setOpenRequest(null); setImprovementRequest(null); setTopicRequest(null); setComposeTopicRequest(null); setKeywordsVisited(false); setSession({ connected: false, mode: 'live' }); }
    catch (e) { setError(errorMessage(e)); }
  }
  return <div className="app-shell">
    <a href="#workspace" className="skip-link">본문으로 이동</a>
    <header className="topbar">
      <a className="brand" href="/app/" onClick={e => { e.preventDefault(); navigate('write'); }}><span className="brand-mark">N</span><span>Naver Content OS<small>내 콘텐츠 작업실</small></span></a>
      <nav aria-label="주요 작업">{(['write', 'keywords', 'drafts', 'performance'] as const).map(key => <button key={key} aria-current={area === key ? 'page' : undefined} onClick={() => navigate(key)}>{AREAS[key]}</button>)}</nav>
      <button className="settings-link" aria-current={area === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}>앱 설정</button>
    </header>
    <div className="statusbar"><span><i className={session?.connected ? 'dot connected' : 'dot'}/>{session?.connected ? '실제 사용 · 로컬 서버 연결됨' : session === null && !error ? '연결 확인 중' : '로컬 앱 연결 필요'}</span><span>자동 공개 발행 없음 <button className="text-button" onClick={() => setReconnect(v => !v)}>연결 관리</button></span></div>
    <main id="workspace" className="workspace">
      <div className="page-heading"><p className="eyebrow">내 콘텐츠 작업실</p><h1 ref={heading} tabIndex={-1}>{AREAS[area]}</h1></div>
      {area === 'settings' && <AppearancePanel theme={theme}/>}
      {(!session?.connected || reconnect) && <section className="panel connect-panel" aria-labelledby="connect-title">
        <h2 id="connect-title">이 컴퓨터의 작업실에 연결하세요</h2>
        <p>확장 설치나 긴 토큰 복사 없이, 실행기에 표시된 일회용 코드로 연결합니다. 코드는 5분 동안 한 번만 사용할 수 있습니다.</p>
        <form onSubmit={e => { e.preventDefault(); void pair(); }}><label htmlFor="pairing-code">일회용 연결 코드</label><div className="inline-form"><input id="pairing-code" type="password" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} maxLength={128}/><button className="primary" disabled={connecting || !code.trim()}>{connecting ? '연결 중…' : '작업실 연결'}</button></div></form>
        <p className="muted">새 코드 발급: 프로젝트 터미널에서 <code>pnpm app:pair</code></p>
        {error && <p className="notice error" role="alert">{error}</p>}
      </section>}
      {session?.connected && <>
        <MenuGuide onOpen={openMenu}/>
        <div hidden={area !== 'write'}><TodayWork client={core} onOpenDraft={openDraft} onAnalyze={prepareAnalysis} onPerformance={() => openMenu({ area: 'performance', view: 'summary' })} onAdPerformance={() => openMenu({ area: 'performance', view: 'ads' })} onPublications={() => openMenu({ area: 'drafts', published: true })}/><Writer onFindKeywords={() => openMenu({ area: 'keywords', view: 'latest' })} client={core} openRequest={openRequest} improvementRequest={improvementRequest} topicRequest={topicRequest} composeTopicRequest={composeTopicRequest} onDirtyChange={setWriterDirty} preferences={preferences} onPreferences={savePreferences} onSaved={(id, selected) => {
          void queryClient.invalidateQueries({ queryKey: ['web-drafts'] });
          void queryClient.invalidateQueries({ queryKey: ['workbench-today'] });
          void queryClient.invalidateQueries({ queryKey: ['workbench-improvements'] });
          void queryClient.invalidateQueries({ queryKey: ['web-performance'] });
          if (selected) activeDraftId.current = id;
          if (selected && currentArea() === 'write') history.replaceState(null, '', `/app/write?draft_id=${id}`);
        }}/></div>
        {area === 'drafts' && <DraftLibrary client={core} onOpen={openDraft} initialView={libraryView}/>}
        {keywordsVisited && <div hidden={area !== 'keywords'}><KeywordWorkspace client={core} onWrite={keywordWriter} onPlan={prepareAnalysis} viewRequest={keywordView}/></div>}
        {performanceVisited && <div hidden={area !== 'performance'}><PerformanceWorkspace client={core} onImprove={openImprovement} onAnalyze={prepareAnalysis} onDirtyChange={setPerformanceDirty} viewRequest={performanceView}/></div>}
        {area === 'settings' && <SettingsPanel client={core} preferences={preferences} onPreferences={savePreferences} onDisconnect={() => void disconnect()}/>}
      </>}
    </main>
    <footer>자료와 원고는 이 컴퓨터에 저장됩니다. AI 및 네이버 조회를 실행하면 설정된 서비스로 필요한 입력을 전송합니다.</footer>
  </div>;
}
