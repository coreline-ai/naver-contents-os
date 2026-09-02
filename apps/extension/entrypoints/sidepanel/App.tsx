import type {
  AnalyzeResponse,
  DraftDetail,
  DraftGenerationMode,
  KeywordSuggestion,
  PlanItem,
  PreflightResponse,
  PublishJob,
  RisingMode,
  RisingResponse,
  SerpObservation,
  SpecializedResponse,
} from '@ncos/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { CoreClient, CoreError } from '~/lib/core';
import { MSG_GET_BLOG, MSG_GET_SERP, requestActiveTab } from '~/lib/messages';
import type { BlogParse } from '~/lib/parsers/blog';
import type { SerpParse } from '~/lib/parsers/serp';
import { isSuggestionQuery, loadRecentKeywords, mergeSuggestions, recentSuggestions, rememberRecentKeyword } from '~/lib/recent-keywords';
import { useSettings } from '~/lib/settings';

const STATUS_LABEL: Record<string, string> = {
  ok: '정상',
  unconfigured: '미설정',
  auth: '인증 오류',
  quota: '한도 도달',
  rate_limit: '요청 제한',
  request: '요청 오류',
  schema: '스키마 오류',
  upstream_unreachable: '연결 오류',
  partial: '부분 데이터',
  empty: '데이터 없음',
  unsupported: '미지원',
};

const CONFIDENCE_LABEL: Record<string, string> = {
  unavailable: '판정 불가',
  low: '낮음',
  medium: '보통',
  high: '높음',
};

function safeExternalUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '#';
  } catch {
    return '#';
  }
}

export default function App() {
  const settings = useSettings();
  const [keyword, setKeyword] = useState('');
  const [serp, setSerp] = useState<SerpObservation | null>(null);
  const [serpNotice, setSerpNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [publishJobId, setPublishJobId] = useState<number | null>(null);
  const [blogInspection, setBlogInspection] = useState<BlogParse | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [sectionTab, setSectionTab] = useState<'analysis' | 'plan' | 'draft'>('analysis');
  const [analysisTab, setAnalysisTab] = useState<'overview' | 'keyword' | 'audience' | 'commercial'>('overview');
  const [mode, setMode] = useState<'general' | 'local' | 'shopping' | 'image'>('general');
  const [shoppingCategory, setShoppingCategory] = useState('');
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [preflightPending, setPreflightPending] = useState(false);
  const [sensitiveKeyword, setSensitiveKeyword] = useState(false);
  const [specialized, setSpecialized] = useState<SpecializedResponse | null>(null);
  const [recentKeywords, setRecentKeywords] = useState<string[]>([]);
  const [providerSuggestions, setProviderSuggestions] = useState<KeywordSuggestion[]>([]);
  const [suggestionStatus, setSuggestionStatus] = useState('idle');
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [discoveryTab, setDiscoveryTab] = useState<'related' | 'rising'>('related');
  const [risingMode, setRisingMode] = useState<RisingMode>('general');
  const [risingRegion, setRisingRegion] = useState('');
  const [risingResult, setRisingResult] = useState<RisingResponse | null>(null);
  const [risingPending, setRisingPending] = useState(false);
  const [risingError, setRisingError] = useState('');
  const suggestionAbort = useRef<AbortController | null>(null);
  const analysisEpoch = useRef(0);
  const draftEpoch = useRef(0);

  useEffect(() => {
    void settings.load();
    void loadRecentKeywords().then(setRecentKeywords);
  }, []);
  useEffect(() => {
    setTokenDraft(settings.token);
  }, [settings.token]);

  const client = useMemo(
    () => new CoreClient(settings.coreUrl, settings.token),
    [settings.coreUrl, settings.token],
  );

  const handshake = useQuery({
    queryKey: ['handshake', settings.coreUrl, settings.token],
    queryFn: () => client.handshake(),
    enabled: settings.loaded && !!settings.token,
    refetchInterval: 30_000,
  });

  const suggestions = useMemo(
    () => mergeSuggestions(recentSuggestions(keyword, recentKeywords), providerSuggestions),
    [keyword, providerSuggestions, recentKeywords],
  );

  useEffect(() => {
    suggestionAbort.current?.abort();
    if (!suggestionsOpen || !handshake.isSuccess || !isSuggestionQuery(keyword)) {
      setProviderSuggestions([]);
      setSuggestionStatus('idle');
      return;
    }
    const controller = new AbortController();
    suggestionAbort.current = controller;
    const timer = window.setTimeout(() => {
      setSuggestionStatus('loading');
      void client.suggestKeywords(keyword, controller.signal).then((response) => {
        if (controller.signal.aborted) return;
        setProviderSuggestions(response.suggestions);
        setSuggestionStatus(response.status);
        setActiveSuggestion(0);
      }).catch(() => {
        if (!controller.signal.aborted) setSuggestionStatus('unavailable');
      });
    }, 700);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, handshake.isSuccess, keyword, suggestionsOpen]);

  useEffect(() => {
    if (!result || !settings.token) return;
    if (risingMode === 'local' && !risingRegion.trim()) {
      setRisingResult(null);
      return;
    }
    if (risingMode === 'shopping' && !shoppingCategory.trim()) {
      setRisingResult(null);
      return;
    }
    let active = true;
    void client.latestRising({
      seed: result.keyword,
      mode: risingMode,
      region: risingRegion,
      category: shoppingCategory,
    }).then((response) => {
      if (active) setRisingResult(response.run);
    }).catch(() => {
      if (active) setRisingResult(null);
    });
    return () => { active = false; };
  }, [client, result?.keyword, risingMode, risingRegion, settings.token, shoppingCategory]);

  const analyze = useMutation<
    AnalyzeResponse,
    CoreError,
    { keyword: string; force?: boolean; serp: SerpObservation | null; requestId: number }
  >({
    mutationFn: ({ keyword: kw, force, serp: requestSerp }) =>
      client.analyze(kw, requestSerp, force ?? false),
    onSuccess: (data, variables) => {
      if (variables.requestId === analysisEpoch.current) {
        setResult(data);
        setSectionTab('analysis');
        void rememberRecentKeyword(data.keyword).then(setRecentKeywords);
      }
    },
  });

  const createDraft = useMutation<
    DraftDetail,
    CoreError,
    {
      planItem: PlanItem;
      mode: DraftGenerationMode;
      analysis: AnalyzeResponse;
      requestId: number;
    }
  >({
    mutationFn: async ({ planItem, mode, analysis }) => {
      const created = await client.createDraft({
        keyword: analysis.keyword,
        snapshot_id: analysis.snapshot_id,
        plan_item: planItem,
        questions: analysis.questions.filter((q) => q.kind === 'question').map((q) => q.text),
        generation_mode: mode,
      });
      return client.getDraft(created.draft_id);
    },
    onSuccess: (data, variables) => {
      if (variables.requestId === draftEpoch.current) {
        setDraft(data);
        setSectionTab('draft');
      }
    },
  });

  const addDraftVersion = useMutation<
    DraftDetail,
    CoreError,
    { draftId: number; title: string; body: string; note: string; requestId: number }
  >({
    mutationFn: async ({ draftId, title, body, note }) => {
      await client.addDraftVersion(draftId, { title, body, note });
      return client.getDraft(draftId);
    },
    onSuccess: (data, variables) => {
      if (variables.requestId === draftEpoch.current) setDraft(data);
    },
  });

  const startPublishJob = useMutation<
    PublishJob,
    CoreError,
    { draftId: number; blogId: string; tags: string[]; requestId: number }
  >({
    mutationFn: ({ draftId, blogId, tags }) =>
      client.startPublishJob(draftId, { blog_id: blogId, tags }),
    onSuccess: (job, variables) => {
      if (variables.requestId === draftEpoch.current) setPublishJobId(job.job_id);
    },
  });

  const publishJob = useQuery({
    queryKey: ['publish-job', publishJobId, settings.coreUrl],
    queryFn: () => client.getPublishJob(publishJobId!),
    enabled: publishJobId != null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'failed' || status === 'draft_saved' ? false : 1_000;
    },
  });

  function clearKeywordResults(): number {
    const requestId = ++analysisEpoch.current;
    ++draftEpoch.current;
    analyze.reset();
    createDraft.reset();
    addDraftVersion.reset();
    startPublishJob.reset();
    setResult(null);
    setDraft(null);
    setPublishJobId(null);
    setPreflight(null);
    setSensitiveKeyword(false);
    setSpecialized(null);
    setSectionTab('analysis');
    return requestId;
  }

  function changeKeyword(nextKeyword: string) {
    clearKeywordResults();
    setKeyword(nextKeyword);
    setSerp(null);
    setSerpNotice('');
  }

  function handleKeywordInput(nextKeyword: string) {
    changeKeyword(nextKeyword);
    setSuggestionsOpen(true);
    setActiveSuggestion(0);
  }

  function runAnalysis(
    targetKeyword: string,
    force = false,
    requestSerp: SerpObservation | null = serp,
  ) {
    if (!targetKeyword.trim()) return;
    const requestId = ++analysisEpoch.current;
    ++draftEpoch.current;
    createDraft.reset();
    setDraft(null);
    if (!force) setResult(null);
    analyze.mutate({ keyword: targetKeyword, force, serp: requestSerp, requestId });
  }

  async function beginAnalysis(targetKeyword: string) {
    if (!targetKeyword.trim() || preflightPending) return;
    setPreflightPending(true);
    setPreflight(null);
    try {
      const checked = await client.preflight(targetKeyword);
      setPreflight(checked);
      setSensitiveKeyword(
        checked.sensitive === true
          || (checked.sensitive === null && !settings.allowLlmWhenSensitiveUnknown),
      );
      if (checked.correction || checked.sensitive === true) return;
    } catch {
      // Preflight is optional. Missing permission or an older Local Core must not
      // block the existing analysis path.
    } finally {
      setPreflightPending(false);
    }
    if (mode !== 'general') {
      try {
        setSpecialized(await client.specialized(targetKeyword, mode, shoppingCategory));
      } catch {
        setSpecialized(null);
      }
    }
    runAnalysis(targetKeyword, false, null);
  }

  async function continueAfterPreflight(targetKeyword: string) {
    setKeyword(targetKeyword);
    setPreflight(null);
    if (mode !== 'general') {
      try {
        setSpecialized(await client.specialized(targetKeyword, mode, shoppingCategory));
      } catch {
        setSpecialized(null);
      }
    }
    runAnalysis(targetKeyword, false, null);
  }

  function openWorkspace() {
    if (!result) return;
    const sidepanelUrl = browser.runtime.getURL('/sidepanel.html');
    const url = `${sidepanelUrl.slice(0, sidepanelUrl.lastIndexOf('/') + 1)}research.html?keyword=${encodeURIComponent(result.keyword)}&snapshot_id=${result.snapshot_id}`;
    void browser.tabs.create({ url });
  }

  function analyzeSuggestedKeyword(nextKeyword: string) {
    setSuggestionsOpen(false);
    setProviderSuggestions([]);
    changeKeyword(nextKeyword);
    void beginAnalysis(nextKeyword);
  }

  async function collectRising() {
    if (!result || risingPending) return;
    if (risingMode === 'local' && !risingRegion.trim()) {
      setRisingError('지역명을 입력하세요.');
      return;
    }
    if (risingMode === 'shopping' && !shoppingCategory.trim()) {
      setRisingError('쇼핑 category code를 입력하세요.');
      return;
    }
    if (!window.confirm('연관 후보의 14일 추세와 최신 뉴스 표본을 수집합니다. 최대 10회 호출을 진행할까요?')) return;
    setRisingPending(true);
    setRisingError('');
    try {
      setRisingResult(await client.rising({
        seed: result.keyword,
        mode: risingMode,
        region: risingRegion,
        category: shoppingCategory,
        candidate_limit: 20,
        force_refresh: true,
      }));
    } catch (error) {
      setRisingError(error instanceof CoreError ? `${error.code}: ${error.message}` : '급상승 후보를 수집하지 못했습니다.');
    } finally {
      setRisingPending(false);
    }
  }

  function runCreateDraft(planItem: PlanItem, mode: DraftGenerationMode) {
    if (!result) return;
    const requestId = ++draftEpoch.current;
    createDraft.mutate({ planItem, mode, analysis: result, requestId });
  }

  async function pullCurrentSearch() {
    const requestId = clearKeywordResults();
    setSerp(null);
    setSerpNotice('');
    try {
      const parsed = await requestActiveTab<SerpParse>({ type: MSG_GET_SERP });
      if (requestId !== analysisEpoch.current) return;
      if (!parsed?.query) {
        setSerpNotice('현재 탭에서 검색어를 확인하지 못했습니다.');
        return;
      }
      setKeyword(parsed.query);
      if (!parsed.ok) {
        setSerpNotice('현재 네이버 검색 화면 구조를 인식하지 못했습니다.');
        return;
      }
      if (parsed.results.length === 0) {
        setSerpNotice('현재 검색 결과가 0건입니다.');
        return;
      }
      setSerp({
        source: 'BROWSER_DOM',
        collected_at: new Date().toISOString(),
        query: parsed.query,
        results: parsed.results,
      });
    } catch {
      if (requestId === analysisEpoch.current) {
        setSerpNotice('현재 탭과 연결할 수 없습니다. 네이버 검색 페이지인지 확인하세요.');
      }
    }
  }

  async function inspectCurrentBlog() {
    const parsed = await requestActiveTab<BlogParse>({ type: MSG_GET_BLOG });
    setBlogInspection(parsed?.found ? parsed : null);
  }

  const connected = handshake.isSuccess;
  const currentAnalysisMutation = analyze.variables?.requestId === analysisEpoch.current;
  const currentDraftMutation = createDraft.variables?.requestId === draftEpoch.current;

  return (
    <div className="min-h-screen bg-slate-50 p-3 text-sm text-slate-900">
      <header className="flex items-center justify-between">
        <h1 className="text-base font-bold">Naver Content OS</h1>
        <button
          className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-200"
          onClick={() => setShowSettings((v) => !v)}
        >
          설정
        </button>
      </header>

      <div className="mt-1 flex items-center gap-1.5 text-xs">
        <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-rose-500'}`} />
        {connected
          ? 'Local Core 연결됨'
          : !settings.token
            ? '토큰을 설정하세요'
            : handshake.isFetching
              ? '연결 확인 중…'
              : 'Local Core 연결 안 됨 (서버 실행·토큰 확인)'}
      </div>

      {showSettings && (
        <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
          <label className="block text-xs font-medium text-slate-600">Local Core 토큰</label>
          <input
            type="password"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder="data/local_core_token.txt 값"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
          <button
            className="mt-2 rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white"
            onClick={() => void settings.save({ token: tokenDraft }).then(() => setShowSettings(false))}
          >
            저장
          </button>
          <label className="mt-3 flex items-start gap-2 rounded bg-slate-50 p-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={settings.allowLlmWhenSensitiveUnknown}
              onChange={(event) => {
                const allowed = event.target.checked;
                void settings.save({ allowLlmWhenSensitiveUnknown: allowed });
                if (preflight?.sensitive === null) setSensitiveKeyword(!allowed);
              }}
              className="mt-0.5"
            />
            <span>
              민감 키워드 판별 API가 응답하지 않아도 AI 초안 사용
              <span className="mt-0.5 block text-[10px] text-amber-700">실제 민감 키워드로 판별된 경우에는 계속 차단됩니다.</span>
            </span>
          </label>
        </section>
      )}

      <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              value={keyword}
              onChange={(e) => handleKeywordInput(e.target.value)}
              onFocus={() => { if (keyword.trim()) setSuggestionsOpen(true); }}
              onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 100)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && suggestions.length > 0) {
                  event.preventDefault();
                  setSuggestionsOpen(true);
                  setActiveSuggestion((value) => (value + 1) % suggestions.length);
                } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
                  event.preventDefault();
                  setActiveSuggestion((value) => (value - 1 + suggestions.length) % suggestions.length);
                } else if (event.key === 'Escape') {
                  setSuggestionsOpen(false);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  if (suggestionsOpen && suggestions[activeSuggestion]) {
                    analyzeSuggestedKeyword(suggestions[activeSuggestion].keyword);
                  } else {
                    void beginAnalysis(keyword);
                  }
                }
              }}
              placeholder="키워드 입력"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={suggestionsOpen && suggestions.length > 0}
              aria-controls="keyword-suggestions"
              aria-activedescendant={suggestionsOpen && suggestions[activeSuggestion] ? `keyword-suggestion-${activeSuggestion}` : undefined}
              className="w-full rounded border border-slate-300 px-2 py-1.5"
            />
            {suggestionsOpen && (suggestions.length > 0 || suggestionStatus === 'loading') && (
              <div id="keyword-suggestions" role="listbox" className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
                {suggestions.map((suggestion, index) => (
                  <button
                    id={`keyword-suggestion-${index}`}
                    role="option"
                    aria-selected={index === activeSuggestion}
                    key={`${suggestion.source}-${suggestion.keyword}`}
                    className={`flex w-full items-center justify-between rounded px-2 py-2 text-left text-xs ${index === activeSuggestion ? 'bg-emerald-50 text-emerald-900' : 'hover:bg-slate-50'}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => analyzeSuggestedKeyword(suggestion.keyword)}
                  >
                    <span className="min-w-0 truncate font-medium">{suggestion.keyword}</span>
                    <span className="ml-2 shrink-0 text-[10px] text-slate-400">
                      {suggestion.source === 'recent' ? '최근' : suggestion.monthly_searches?.toLocaleString() ?? (suggestion.volume_masked ? '10 미만' : 'SearchAd')}
                    </span>
                  </button>
                ))}
                {suggestionStatus === 'loading' && <p className="px-2 py-1 text-[10px] text-slate-400">연관 키워드 확인 중…</p>}
                {suggestionStatus === 'unavailable' && <p className="px-2 py-1 text-[10px] text-amber-700">외부 추천을 불러오지 못해 최근 키워드만 표시합니다.</p>}
              </div>
            )}
          </div>
          <button
            className="whitespace-nowrap rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            disabled={!keyword || !connected || preflightPending || (currentAnalysisMutation && analyze.isPending) || (mode === 'shopping' && !shoppingCategory.trim())}
            onClick={() => void beginAnalysis(keyword)}
          >
            {preflightPending ? '확인 중…' : currentAnalysisMutation && analyze.isPending ? '분석 중…' : '분석'}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1" aria-label="분석 모드">
          {([
            ['general', '일반'],
            ['local', '지역'],
            ['shopping', '쇼핑'],
            ['image', '이미지'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              className={`rounded px-2 py-0.5 text-[11px] ${mode === value ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}
              onClick={() => { setMode(value); setSpecialized(null); }}
            >
              {label}
            </button>
          ))}
          {mode === 'shopping' && (
            <input
              value={shoppingCategory}
              onChange={(event) => setShoppingCategory(event.target.value)}
              className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-0.5 text-[11px]"
              placeholder="쇼핑 category code"
            />
          )}
        </div>
        {preflight && (preflight.correction || preflight.sensitive === true) && (
          <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs">
            {preflight.correction && (
              <p>교정 제안: <b>{preflight.correction}</b></p>
            )}
            {preflight.sensitive === true && (
              <p className="mt-1 text-rose-700">민감 키워드로 판별되어 AI 초안은 비활성화됩니다.</p>
            )}
            <div className="mt-2 flex gap-1">
              {preflight.correction && (
                <button className="rounded bg-amber-600 px-2 py-1 text-white" onClick={() => void continueAfterPreflight(preflight.correction!)}>교정 사용</button>
              )}
              <button className="rounded border border-amber-400 px-2 py-1" onClick={() => void continueAfterPreflight(preflight.keyword)}>원문 유지</button>
            </div>
          </div>
        )}
        {preflight && preflight.sensitive === null && preflight.data_status.adult !== 'ok' && (
          <div className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
            <p>
              민감 키워드 판별 API가 응답하지 않았습니다.
              {settings.allowLlmWhenSensitiveUnknown
                ? ' 사용자 설정에 따라 AI 초안을 사용할 수 있습니다.'
                : ' 기본 보호 설정으로 AI 초안을 비활성화했습니다.'}
            </p>
            {!settings.allowLlmWhenSensitiveUnknown && (
              <button
                className="mt-1.5 rounded bg-amber-700 px-2 py-1 font-medium text-white"
                onClick={() => {
                  void settings.save({ allowLlmWhenSensitiveUnknown: true });
                  setSensitiveKeyword(false);
                }}
              >
                이 기기에서 AI 초안 허용
              </button>
            )}
          </div>
        )}
        <div className="mt-2 flex items-center gap-2 text-xs">
          <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" onClick={() => void pullCurrentSearch()}>
            현재 검색어 가져오기
          </button>
          <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" onClick={() => void inspectCurrentBlog()}>
            현재 블로그 분석
          </button>
          {serp && <span className="text-emerald-700">SERP {serp.results.length}건 첨부됨</span>}
          {result && (
            <button
              className="ml-auto rounded border border-slate-300 px-2 py-1 hover:bg-slate-100"
              onClick={() => runAnalysis(result.keyword, true)}
            >
              강제 새로고침
            </button>
          )}
        </div>
        {serpNotice && <p className="mt-2 text-xs text-amber-700">{serpNotice}</p>}
        {currentAnalysisMutation && analyze.isError && (
          <p className="mt-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">
            오류({analyze.error.code}): {analyze.error.message}
          </p>
        )}
      </section>

      {result && (
        <KeywordDiscoveryCard
          result={result}
          tab={discoveryTab}
          onTab={setDiscoveryTab}
          risingMode={risingMode}
          onRisingMode={(value) => { setRisingMode(value); setRisingResult(null); setRisingError(''); }}
          region={risingRegion}
          onRegion={setRisingRegion}
          category={shoppingCategory}
          onCategory={setShoppingCategory}
          rising={risingResult}
          pending={risingPending}
          error={risingError}
          onCollect={() => void collectRising()}
          onSelect={analyzeSuggestedKeyword}
        />
      )}

      {result && (
        <nav className="mt-3 grid grid-cols-3 rounded-lg border border-slate-200 bg-white p-1" aria-label="작업 단계">
          {([
            ['analysis', '분석'],
            ['plan', '플랜'],
            ['draft', '초안'],
          ] as const).map(([value, label]) => (
            <button key={value} className={`rounded py-1 text-xs font-medium ${sectionTab === value ? 'bg-emerald-600 text-white' : 'text-slate-500 hover:bg-slate-100'}`} onClick={() => setSectionTab(value)}>{label}</button>
          ))}
        </nav>
      )}

      {result && (
        <>
          {sectionTab === 'analysis' && (
            <>
              <div className="mt-2 flex gap-1 overflow-x-auto">
                {([
                  ['overview', '개요'],
                  ['keyword', '키워드'],
                  ['audience', '타깃'],
                  ['commercial', '상업성'],
                ] as const).map(([value, label]) => (
                  <button key={value} className={`rounded-full px-2 py-1 text-[11px] ${analysisTab === value ? 'bg-slate-800 text-white' : 'bg-white text-slate-500'}`} onClick={() => setAnalysisTab(value)}>{label}</button>
                ))}
              </div>
              {(analysisTab === 'overview' || analysisTab === 'commercial') && <ScoreCard result={result} />}
              {(analysisTab === 'overview' || analysisTab === 'commercial') && <LandscapeCard result={result} />}
              {(analysisTab === 'overview' || analysisTab === 'keyword') && <RelatedKeywordsCard result={result} onSelect={analyzeSuggestedKeyword} />}
              {(analysisTab === 'overview' || analysisTab === 'audience') && <TrendCard result={result} />}
              {(analysisTab === 'overview' || analysisTab === 'keyword') && <ClusterCard result={result} onSelect={analyzeSuggestedKeyword} />}
              {analysisTab === 'overview' && <SearchEvidenceCard result={result} />}
              {specialized && <SpecializedCard result={specialized} />}
              <button className="mt-3 w-full rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white" onClick={openWorkspace}>Research Workspace 전체화면 열기</button>
              <PlanCard
                plan={result.plan}
                creating={currentDraftMutation && createDraft.isPending}
                onCreate={runCreateDraft}
                allowLlm={!sensitiveKeyword}
              />
            </>
          )}
          {sectionTab === 'plan' && (
            <>
              <PlanCard
                plan={result.plan}
                creating={currentDraftMutation && createDraft.isPending}
                onCreate={runCreateDraft}
                allowLlm={!sensitiveKeyword}
              />
              <QuestionsCard result={result} />
            </>
          )}
          {currentDraftMutation && createDraft.isError && (
            <p className="mt-3 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">
              초안 오류({createDraft.error.code}): {createDraft.error.message}
            </p>
          )}
          {sectionTab === 'draft' && draft && (
            <DraftCard
              draft={draft}
              savingVersion={addDraftVersion.isPending}
              versionError={addDraftVersion.error?.message ?? ''}
              onSaveVersion={(title, body, note) =>
                addDraftVersion.mutate({
                  draftId: draft.draft_id,
                  title,
                  body,
                  note,
                  requestId: draftEpoch.current,
                })
              }
              startingPublish={startPublishJob.isPending}
              publishError={startPublishJob.error?.message ?? publishJob.error?.message ?? ''}
              publishJob={publishJob.data ?? startPublishJob.data ?? null}
              onPublish={(blogId, tags) =>
                startPublishJob.mutate({
                  draftId: draft.draft_id,
                  blogId,
                  tags,
                  requestId: draftEpoch.current,
                })
              }
            />
          )}
          {sectionTab === 'draft' && !draft && <p className="mt-3 rounded bg-white p-3 text-xs text-slate-500">플랜에서 초안을 먼저 생성하세요.</p>}
        </>
      )}
      {blogInspection && <BlogInspectionCard inspection={blogInspection} />}
    </div>
  );
}

export function ScoreCard({ result }: { result: AnalyzeResponse }) {
  const score = result.score;
  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Opportunity Score</h2>
        <span className="text-2xl font-bold text-emerald-700">
          {score.value ?? '—'}
          <span className="ml-1 text-xs font-normal text-slate-400">/100 · {score.score_version}</span>
        </span>
      </div>
      <table className="mt-2 w-full text-xs">
        <tbody>
          {score.contributions.map((c) => (
            <tr key={c.component} className="border-t border-slate-100">
              <td className="py-1 text-slate-600">{c.component}</td>
              <td className="py-1 text-right tabular-nums">
                {c.status === 'ok' ? `+${c.points}` : '결측'}
              </td>
              <td className="py-1 pl-2 text-slate-400">{c.raw}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-[11px] text-slate-400">
        신뢰도 {CONFIDENCE_LABEL[score.confidence] ?? score.confidence} · coverage{' '}
        {Math.round(score.coverage_weight * 100)}% · 사용 가능 {score.available_component_count}/
        {score.total_component_count}
      </div>
      <div className="mt-1 text-[11px] text-slate-400">
        수집: {new Date(result.collected_at).toLocaleString()} · 출처:{' '}
        {Object.entries(result.data_status)
          .map(([k, v]) => `${k} ${STATUS_LABEL[v] ?? v}`)
          .join(' · ')}
      </div>
    </section>
  );
}

export function LandscapeCard({ result }: { result: AnalyzeResponse }) {
  const l = result.landscape;
  const m = result.metric;
  if (!l && !m) return null;
  const chips: [string, number | null][] = [
    ['PC 검색량', m?.monthly_pc_searches ?? null],
    ['모바일 검색량', m?.monthly_mobile_searches ?? null],
    ['월간 합계', m ? monthlyTotal(m) : null],
    ['블로그', l?.blog_total ?? null],
    ['카페', l?.cafe_total ?? null],
    ['지식iN', l?.kin_total ?? null],
    ['웹문서', l?.web_total ?? null],
    ['뉴스', l?.news_total ?? null],
  ];
  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <h2 className="font-semibold">검색 환경</h2>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {chips.map(([label, value]) => (
          <span key={label} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
            {label} <b className="tabular-nums">{value == null ? '결측' : value.toLocaleString()}</b>
          </span>
        ))}
        {m?.volume_masked && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs">검색량 마스킹(&lt;10)</span>}
        {m?.ad_competition && (
          <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs">광고 경쟁 {m.ad_competition}</span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {m && <DataMeta source={m.source} collectedAt={m.collected_at} fromCache={m.from_cache} />}
        {l && <DataMeta source={l.source} collectedAt={l.collected_at} fromCache={l.from_cache} />}
      </div>
    </section>
  );
}

function monthlyTotal(metric: AnalyzeResponse['related_keywords'][number]): number | null {
  if (metric.monthly_pc_searches == null || metric.monthly_mobile_searches == null) return null;
  return metric.monthly_pc_searches + metric.monthly_mobile_searches;
}

function mobileShare(metric: AnalyzeResponse['related_keywords'][number]): number | null {
  const total = monthlyTotal(metric);
  if (total == null || total <= 0 || metric.monthly_mobile_searches == null) return null;
  return metric.monthly_mobile_searches / total;
}

const RISING_DIRECTION_LABEL: Record<string, string> = {
  new: '신규',
  rising: '상승',
  steady: '보합',
  falling: '하락',
  insufficient: '자료 부족',
};

export function KeywordDiscoveryCard({
  result,
  tab,
  onTab,
  risingMode,
  onRisingMode,
  region,
  onRegion,
  category,
  onCategory,
  rising,
  pending,
  error,
  onCollect,
  onSelect,
}: {
  result: AnalyzeResponse;
  tab: 'related' | 'rising';
  onTab: (tab: 'related' | 'rising') => void;
  risingMode: RisingMode;
  onRisingMode: (mode: RisingMode) => void;
  region: string;
  onRegion: (value: string) => void;
  category: string;
  onCategory: (value: string) => void;
  rising: RisingResponse | null;
  pending: boolean;
  error: string;
  onCollect: () => void;
  onSelect: (keyword: string) => void;
}) {
  const related = [...result.related_keywords].sort((a, b) => {
    const volumeDiff = (monthlyTotal(b) ?? -1) - (monthlyTotal(a) ?? -1);
    return volumeDiff || a.keyword.localeCompare(b.keyword, 'ko');
  }).slice(0, 8);
  return (
    <section className="mt-3 rounded-xl border border-emerald-200 bg-white p-3 shadow-sm" aria-label="상단 키워드 탐색">
      <div className="grid grid-cols-2 rounded-lg bg-slate-100 p-1">
        <button className={`rounded-md py-1.5 text-xs font-semibold ${tab === 'related' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`} onClick={() => onTab('related')}>연관 키워드</button>
        <button className={`rounded-md py-1.5 text-xs font-semibold ${tab === 'rising' ? 'bg-white text-rose-600 shadow-sm' : 'text-slate-500'}`} onClick={() => onTab('rising')}>급상승 키워드</button>
      </div>
      {tab === 'related' && (
        <div className="mt-2">
          <div className="flex items-center justify-between"><p className="text-[10px] text-slate-400">검색량 상위 Top 8 · 누르면 즉시 재분석</p><span className="text-[10px] text-slate-400">SearchAd</span></div>
          {related.length > 0 ? <div className="mt-2 grid grid-cols-2 gap-1.5">
            {related.map((metric) => <button key={metric.keyword} className="min-w-0 rounded-lg border border-slate-100 bg-slate-50 px-2 py-1.5 text-left hover:border-emerald-300 hover:bg-emerald-50" onClick={() => onSelect(metric.keyword)}><b className="block truncate text-xs">{metric.keyword}</b><span className="text-[10px] text-slate-400">{monthlyTotal(metric)?.toLocaleString() ?? (metric.volume_masked ? '10 미만' : '검색량 결측')}</span></button>)}
          </div> : <p className="mt-2 rounded bg-slate-50 p-2 text-xs text-slate-400">연관 키워드 데이터가 없습니다.</p>}
        </div>
      )}
      {tab === 'rising' && (
        <div className="mt-2">
          <div className="flex flex-wrap gap-1" aria-label="급상승 분야">
            {([['general', '일반'], ['local', '지역'], ['shopping', '쇼핑'], ['news', '뉴스']] as const).map(([value, label]) => <button key={value} className={`rounded-full px-2 py-1 text-[10px] ${risingMode === value ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-600'}`} onClick={() => onRisingMode(value)}>{label}</button>)}
          </div>
          {risingMode === 'local' && <input className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-xs" value={region} onChange={(event) => onRegion(event.target.value)} placeholder="지역명 (예: 성수, 부산)" />}
          {risingMode === 'shopping' && <input className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-xs" value={category} onChange={(event) => onCategory(event.target.value)} placeholder="Shopping category code" />}
          <div className="mt-2 flex items-center gap-2">
            <button className="rounded bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-40" disabled={pending || (risingMode === 'local' && !region.trim()) || (risingMode === 'shopping' && !category.trim())} onClick={onCollect}>{pending ? '수집 중…' : '최신 수집 · 최대 10회'}</button>
            {rising && <span className="text-[10px] text-slate-400">{new Date(rising.collected_at).toLocaleString()} · {rising.actual_calls}/{rising.estimated_calls}회</span>}
          </div>
          <p className="mt-1 text-[10px] text-slate-400">주제 기반 후보이며 공식 실시간 인기순위가 아닙니다.</p>
          {error && <p className="mt-2 rounded bg-rose-50 p-2 text-[10px] text-rose-700">{error}</p>}
          {rising && rising.candidates.length > 0 && <div className="mt-2 space-y-1.5">
            {rising.candidates.slice(0, 8).map((candidate) => <button key={candidate.keyword} className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-slate-100 px-2 py-2 text-left hover:border-rose-300 hover:bg-rose-50" onClick={() => onSelect(candidate.keyword)}><span className="min-w-0 truncate text-xs font-semibold">{candidate.keyword}</span><span className={`text-[10px] ${candidate.direction === 'rising' || candidate.direction === 'new' ? 'text-rose-600' : candidate.direction === 'falling' ? 'text-sky-600' : 'text-slate-400'}`}>{RISING_DIRECTION_LABEL[candidate.direction]}{candidate.growth_rate == null ? '' : ` ${candidate.growth_rate > 0 ? '+' : ''}${candidate.growth_rate}%`}</span><span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] tabular-nums">최신성 {candidate.freshness_score ?? '—'}</span></button>)}
          </div>}
          {rising && rising.candidates.length === 0 && <p className="mt-2 rounded bg-slate-50 p-2 text-xs text-slate-400">수집된 후보가 없습니다. 공급자 설정과 데이터 상태를 확인하세요.</p>}
        </div>
      )}
    </section>
  );
}

function DataMeta({
  source,
  collectedAt,
  fromCache,
}: {
  source: string;
  collectedAt: string;
  fromCache?: boolean;
}) {
  const label = source === 'SEARCH_AD' ? 'SearchAd' : source === 'NAVER_API_HUB' ? 'API HUB' : source === 'BROWSER_DOM' ? 'Browser DOM' : source;
  return (
    <span className="text-[10px] text-slate-400">
      {label} · {new Date(collectedAt).toLocaleString()}{fromCache ? ' · cache' : ''}
    </span>
  );
}

export function RelatedKeywordsCard({
  result,
  onSelect,
}: {
  result: AnalyzeResponse;
  onSelect: (keyword: string) => void;
}) {
  if (result.related_keywords.length === 0) return null;
  const rows = [...result.related_keywords].sort((a, b) => {
    const volumeDiff = (monthlyTotal(b) ?? -1) - (monthlyTotal(a) ?? -1);
    return volumeDiff || a.keyword.localeCompare(b.keyword, 'ko');
  });
  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">연관 키워드</h2>
        <span className="text-[10px] text-slate-400">{rows.length}개 · SearchAd</span>
      </div>
      <div className="mt-2 max-h-72 overflow-auto">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-white text-slate-400">
            <tr><th className="py-1 text-left">키워드</th><th className="text-right">PC</th><th className="text-right">모바일</th><th className="text-right">합계</th><th className="text-right">모바일 비중</th><th className="text-right">경쟁</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((metric) => {
              const total = monthlyTotal(metric);
              const share = mobileShare(metric);
              return (
                <tr key={metric.keyword} className="border-t border-slate-100">
                  <td className="max-w-32 truncate py-1.5 font-medium" title={metric.keyword}>{metric.keyword}</td>
                  <td className="text-right tabular-nums">{metric.monthly_pc_searches?.toLocaleString() ?? (metric.volume_masked ? '<10' : '—')}</td>
                  <td className="text-right tabular-nums">{metric.monthly_mobile_searches?.toLocaleString() ?? (metric.volume_masked ? '<10' : '—')}</td>
                  <td className="text-right tabular-nums" title={total == null ? '정확한 합계 결측' : undefined}>{total?.toLocaleString() ?? '—'}</td>
                  <td className="text-right tabular-nums">{share == null ? '—' : `${Math.round(share * 100)}%`}</td>
                  <td className="text-right">{metric.ad_competition ?? '—'}</td>
                  <td className="pl-1 text-right"><button className="rounded border border-slate-200 px-1 py-0.5 hover:bg-slate-50" onClick={() => onSelect(metric.keyword)}>재분석</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2"><DataMeta source={rows[0].source} collectedAt={rows[0].collected_at} fromCache={rows[0].from_cache} /></div>
    </section>
  );
}

export function TrendCard({ result }: { result: AnalyzeResponse }) {
  const trend = result.trend;
  if (!trend || trend.points.length === 0) return null;
  const points = trend.points.slice(-12);
  const polyline = points.map((point, index) => {
    const x = points.length === 1 ? 150 : (index / (points.length - 1)) * 300;
    const y = 75 - Math.max(0, Math.min(100, point.ratio)) * 0.65;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <h2 className="font-semibold">검색 관심도 추이</h2>
      <p className="mt-0.5 text-[10px] text-slate-400">기간 내 최댓값을 100으로 둔 상대 지표이며 절대 검색량이 아닙니다.</p>
      <svg viewBox="0 0 300 80" className="mt-2 h-24 w-full" role="img" aria-label="상대 검색 관심도 추이">
        <line x1="0" y1="75" x2="300" y2="75" stroke="#e2e8f0" />
        <polyline points={polyline} fill="none" stroke="#059669" strokeWidth="3" strokeLinejoin="round" />
      </svg>
      <div className="flex justify-between text-[10px] text-slate-400"><span>{points[0].period}</span><span>최근 {points.at(-1)?.ratio.toFixed(1)}</span><span>{points.at(-1)?.period}</span></div>
      <div className="mt-2"><DataMeta source={trend.source} collectedAt={trend.collected_at} fromCache={trend.from_cache} /></div>
    </section>
  );
}

export function ClusterCard({
  result,
  onSelect,
}: {
  result: AnalyzeResponse;
  onSelect: (keyword: string) => void;
}) {
  if (result.clusters.length === 0) return null;
  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <h2 className="font-semibold">키워드 클러스터</h2>
      <div className="mt-2 space-y-2">
        {result.clusters.map((cluster) => (
          <div key={cluster.label} className="rounded border border-slate-100 p-2">
            <div className="flex justify-between text-xs"><b>{cluster.label}</b><span className="text-slate-400">검색량 합계 {cluster.total_volume.toLocaleString()}</span></div>
            <div className="mt-1 flex flex-wrap gap-1">
              {cluster.keywords.map((item) => <button key={item} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] hover:bg-slate-200" onClick={() => onSelect(item)}>{item}</button>)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function SearchEvidenceCard({ result }: { result: AnalyzeResponse }) {
  const apiItems = result.landscape?.top_results ?? [];
  const browserItems = result.serp?.results ?? [];
  if (apiItems.length === 0 && browserItems.length === 0) return null;
  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <h2 className="font-semibold">검색 결과 근거</h2>
      {browserItems.length > 0 && (
        <div className="mt-2">
          <h3 className="text-xs font-medium text-emerald-700">Browser SERP</h3>
          <ol className="mt-1 space-y-1 text-[11px]">
            {browserItems.slice(0, 10).map((item) => <li key={`${item.rank}-${item.url}`} className="flex gap-1.5"><span className="w-4 shrink-0 tabular-nums text-slate-400">{item.rank}</span><div className="min-w-0"><a href={safeExternalUrl(item.url)} target="_blank" rel="noreferrer" className="block truncate text-sky-700">{item.title || item.url}</a><span className="text-[10px] text-slate-400">{item.result_type}{item.is_ad ? ' · 광고' : ''}{item.posted_at ? ` · ${item.posted_at}` : ''}</span></div></li>)}
          </ol>
          {result.serp && <div className="mt-1"><DataMeta source={result.serp.source} collectedAt={result.serp.collected_at} /></div>}
        </div>
      )}
      {apiItems.length > 0 && (
        <div className="mt-3 border-t border-slate-100 pt-2">
          <h3 className="text-xs font-medium text-indigo-700">API HUB 블로그 결과</h3>
          <ol className="mt-1 space-y-1 text-[11px]">
            {apiItems.slice(0, 10).map((item, index) => <li key={`${index}-${item.link}`} className="flex gap-1.5"><span className="w-4 shrink-0 tabular-nums text-slate-400">{index + 1}</span><div className="min-w-0"><a href={safeExternalUrl(item.link)} target="_blank" rel="noreferrer" className="block truncate text-sky-700">{item.title || item.link}</a><span className="text-[10px] text-slate-400">{item.author || '작성자 미상'}{item.posted_at ? ` · ${item.posted_at}` : ''}</span></div></li>)}
          </ol>
          {result.landscape && <div className="mt-1"><DataMeta source={result.landscape.source} collectedAt={result.landscape.collected_at} fromCache={result.landscape.from_cache} /></div>}
        </div>
      )}
    </section>
  );
}

export function SpecializedCard({ result }: { result: SpecializedResponse }) {
  const rows = result.items ?? [];
  return (
    <section className="mt-3 rounded-lg border border-indigo-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">특화 분석 · {result.mode}</h2>
        <span className="text-[10px] text-slate-400">{STATUS_LABEL[result.status] ?? result.status}</span>
      </div>
      {result.rights_notice && <p className="mt-1 rounded bg-amber-50 p-2 text-[10px] text-amber-800">{result.rights_notice}</p>}
      {result.warning && <p className="mt-1 text-[10px] text-slate-500">{result.warning}</p>}
      {rows.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {rows.slice(0, 5).map((row, index) => (
            <li key={`${index}-${String(row.link ?? '')}`} className="rounded bg-slate-50 p-2">
              {Boolean(row.thumbnail) && <img src={safeExternalUrl(row.thumbnail)} alt="" className="mb-2 h-20 w-full rounded object-cover" />}
              <a href={safeExternalUrl(row.link)} target="_blank" rel="noreferrer" className="font-medium text-sky-700">
                {String(row.title ?? '결과')}
              </a>
              <p className="mt-0.5 text-[10px] text-slate-500">
                {String(row.category ?? row.road_address ?? '')}
                {row.width ? ` · ${String(row.width)}×${String(row.height ?? '—')}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
      {(result.series ?? []).length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {(result.series ?? []).map((row, index) => {
            const points = Array.isArray(row.points) ? row.points as Array<{ period?: string; ratio?: number }> : [];
            const latest = points.at(-1);
            return <li key={`${index}-${String(row.title ?? '')}`} className="flex justify-between rounded bg-slate-50 px-2 py-1"><span>{String(row.title ?? result.keyword)}</span><span>{latest?.ratio == null ? '결측' : `상대 ${latest.ratio.toFixed(1)}`}</span></li>;
          })}
        </ul>
      )}
      {result.plan_candidates && (
        <div className="mt-2 flex flex-wrap gap-1">
          {result.plan_candidates.map((item) => <span key={item} className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] text-indigo-700">{item}</span>)}
        </div>
      )}
    </section>
  );
}

export function PlanCard({
  plan,
  creating,
  onCreate,
  allowLlm = true,
}: {
  plan: PlanItem[];
  creating: boolean;
  onCreate: (item: PlanItem, mode: DraftGenerationMode) => void;
  allowLlm?: boolean;
}) {
  if (plan.length === 0) return null;
  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <h2 className="font-semibold">15편 콘텐츠 플랜</h2>
      {!allowLlm && <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-800">민감 키워드 판별이 완료되지 않았거나 민감 키워드로 확인되어 AI 초안이 비활성화되었습니다.</p>}
      <ol className="mt-2 space-y-1.5">
        {plan.map((p) => (
          <li key={p.order} className="rounded border border-slate-100 p-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs tabular-nums text-slate-400">{p.order}.</span>
              <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                {p.blog_type}
              </span>
              <span className="truncate text-xs font-medium">{p.title}</span>
            </div>
            <p className="mt-0.5 pl-5 text-[11px] text-slate-500">{p.reason}</p>
            <div className="mt-1 flex justify-end gap-1">
              <button
                className="rounded border border-slate-300 px-2 py-0.5 text-[10px] disabled:opacity-40"
                disabled={creating}
                onClick={() => onCreate(p, 'skeleton')}
              >
                구조 초안
              </button>
              <button
                className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] text-white disabled:opacity-40"
                disabled={creating || p.generation_status !== 'ready' || !allowLlm}
                title={!allowLlm ? '민감 키워드 판별로 AI 초안 비활성화' : p.generation_status === 'ready' ? '설정된 LLM으로 초안 생성' : '현재 LLM 생성 미지원 유형'}
                onClick={() => onCreate(p, 'llm')}
              >
                AI 초안
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function DraftCard({
  draft,
  savingVersion = false,
  versionError = '',
  onSaveVersion = () => undefined,
  startingPublish = false,
  publishError = '',
  publishJob = null,
  onPublish = () => undefined,
}: {
  draft: DraftDetail;
  savingVersion?: boolean;
  versionError?: string;
  onSaveVersion?: (title: string, body: string, note: string) => void;
  startingPublish?: boolean;
  publishError?: string;
  publishJob?: PublishJob | null;
  onPublish?: (blogId: string, tags: string[]) => void;
}) {
  const latest = draft.versions.at(-1)!;
  const [title, setTitle] = useState(latest.title);
  const [body, setBody] = useState(latest.body);
  const [note, setNote] = useState('');
  const [blogId, setBlogId] = useState('');
  const [tagsText, setTagsText] = useState('');
  useEffect(() => {
    const current = draft.versions.at(-1)!;
    setTitle(current.title);
    setBody(current.body);
    setNote('');
  }, [draft]);
  const dirty = title !== latest.title || body !== latest.body;
  const canPublish = !dirty && /^[A-Za-z0-9_-]+$/.test(blogId) && !startingPublish;

  function confirmPublish() {
    if (!canPublish) return;
    if (!window.confirm('전용 Chrome의 SmartEditor에 이 최신 버전을 입력하고 임시저장할까요? 공개 발행은 하지 않습니다.')) return;
    onPublish(blogId, tagsText.split(',').map((tag) => tag.trim()).filter(Boolean));
  }

  return (
    <section className="mt-3 rounded-lg border border-emerald-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">생성된 초안 v{latest.version}</h2>
        <span className="text-[10px] text-slate-400">
          {draft.provider}{draft.model ? ` · ${draft.model}` : ''}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-slate-400">본문 {body.length.toLocaleString()}자 · draft #{draft.draft_id} · 버전 {draft.versions.length}개</p>
      <label className="mt-2 block text-[11px] font-medium text-slate-500">제목</label>
      <input className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs" value={title} onChange={(event) => setTitle(event.target.value)} />
      <label className="mt-2 block text-[11px] font-medium text-slate-500">본문</label>
      <textarea className="mt-1 min-h-48 w-full rounded border border-slate-300 p-2 text-xs leading-5" value={body} onChange={(event) => setBody(event.target.value)} />
      <div className="mt-2 flex gap-1">
        <input className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs" value={note} onChange={(event) => setNote(event.target.value)} placeholder="수정 사유" />
        <button className="rounded bg-slate-800 px-2 py-1 text-xs text-white disabled:opacity-40" disabled={!dirty || !title.trim() || !body.trim() || savingVersion} onClick={() => onSaveVersion(title, body, note)}>{savingVersion ? '저장 중…' : '새 버전 저장'}</button>
      </div>
      {versionError && <p className="mt-1 text-xs text-rose-700">버전 저장 오류: {versionError}</p>}
      <div className="mt-2 flex flex-wrap gap-1">
        {draft.versions.map((version) => (
          <button key={version.version} className={`rounded px-1.5 py-0.5 text-[10px] ${version.version === latest.version ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`} onClick={() => { setTitle(version.title); setBody(version.body); setNote(`v${version.version} 기준 수정`); }}>v{version.version}{version.note ? ` · ${version.note}` : ''}</button>
        ))}
      </div>
      <div className="mt-3 border-t border-slate-100 pt-3">
        <h3 className="text-xs font-semibold">SmartEditor 임시저장</h3>
        <p className="mt-0.5 text-[10px] text-slate-400">전용 Chrome·로그인·CDP가 준비된 경우에만 실행됩니다. 공개 발행은 하지 않습니다.</p>
        <div className="mt-2 flex gap-1">
          <input className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs" value={blogId} onChange={(event) => setBlogId(event.target.value)} placeholder="네이버 blog ID" />
          <input className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs" value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="태그1, 태그2" />
        </div>
        {dirty && <p className="mt-1 text-[10px] text-amber-700">수정 내용을 새 버전으로 저장해야 임시저장을 시작할 수 있습니다.</p>}
        <button className="mt-2 w-full rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40" disabled={!canPublish} onClick={confirmPublish}>{startingPublish ? 'Job 시작 중…' : '최신 버전 임시저장 시작'}</button>
        {publishJob && <p className={`mt-2 rounded px-2 py-1 text-xs ${publishJob.status === 'failed' ? 'bg-rose-50 text-rose-700' : publishJob.status === 'draft_saved' ? 'bg-emerald-50 text-emerald-700' : 'bg-sky-50 text-sky-700'}`}>Job #{publishJob.job_id} · {publishJob.status} · {publishJob.stage || '대기'}</p>}
        {publishError && <p className="mt-1 text-xs text-rose-700">Publisher 오류: {publishError}</p>}
      </div>
    </section>
  );
}

export function BlogInspectionCard({ inspection }: { inspection: BlogParse }) {
  return (
    <section className="mt-3 rounded-lg border border-sky-200 bg-white p-3">
      <h2 className="font-semibold">현재 블로그 분석</h2>
      <p className="mt-1 truncate text-xs font-medium">{inspection.title || '제목 없음'}</p>
      <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-slate-600">
        <span>본문 {inspection.body_chars.toLocaleString()}자</span>
        <span>· 이미지 {inspection.image_count}</span>
        <span>· 영상 {inspection.video_count}</span>
        <span>· 링크 {inspection.link_count}</span>
        <span>· 공감 {inspection.likes ?? '결측'}</span>
        <span>· 댓글 {inspection.comments ?? '결측'}</span>
      </div>
    </section>
  );
}

function QuestionsCard({ result }: { result: AnalyzeResponse }) {
  if (result.questions.length === 0) return null;
  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <h2 className="font-semibold">실제 질문·후기 ({result.questions.length})</h2>
      <ul className="mt-2 space-y-1 text-xs">
        {result.questions.map((q) => (
          <li key={q.text} className="flex gap-1.5">
            <span className={`shrink-0 rounded px-1 text-[10px] ${q.kind === 'question' ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-700'}`}>
              {q.kind === 'question' ? '질문' : '후기'}
            </span>
            <span className="truncate">{q.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
