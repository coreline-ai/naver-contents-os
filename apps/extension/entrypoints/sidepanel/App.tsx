import type {
  AnalyzeResponse,
  ArticleQuality,
  BlogComposeRequest,
  BlogComposeResponse,
  BlogComposeStyle,
  DraftAsset,
  DraftDetail,
  DraftGenerationMode,
  DraftSummary,
  FactPack,
  KeywordSuggestion,
  PlanItem,
  PreflightResponse,
  PublishJob,
  RisingMode,
  RisingResponse,
  SerpObservation,
  SpecializedResponse,
  TodayWorkItem,
} from '@ncos/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { BROWSER_BRIDGE_PROTOCOL, MSG_BROWSER_CONNECTION, type BrowserConnection } from '@ncos/contracts';
import { PcMobileDonut } from '~/components/PcMobileDonut';
import { CoreClient, CoreError } from '~/lib/core';
import { MSG_GET_BLOG, MSG_GET_SERP, MSG_RUN_PUBLISH_JOB, requestActiveTab } from '~/lib/messages';
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

export function composeFailureHint(error: CoreError | null): string {
  if (!error) return '';
  const message = error.message.toLocaleLowerCase();
  if (message.includes('품질 검사')) {
    return '검사에 미달한 원고는 저장하지 않았으며 저품질 AI로 자동 전환하지 않았습니다.';
  }
  if (message.includes('사용량 한도') || message.includes('rate limit') || message.includes('429')) {
    return 'Codex 사용량이 갱신된 뒤 다시 시도해 주세요. 다른 AI로 자동 전환하지 않습니다.';
  }
  if (message.includes('초과') || message.includes('timeout')) {
    return '시간 초과 요청은 종료했습니다. 원고는 저장되지 않았으므로 다시 시도해 주세요.';
  }
  if (message.includes('codex login') || message.includes('로그인')) {
    return '터미널에서 codex login을 완료한 뒤 AI 상태를 다시 확인해 주세요.';
  }
  return '실패한 결과는 원고로 저장하지 않았습니다.';
}

export default function App() {
  const settings = useSettings();
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const initialRecommendationId = Number(initialParams.get('recommendation_id')) || null;
  const initialSourceDraftId = Number(initialParams.get('source_draft_id')) || null;
  const remainingRecommendationId = useRef(initialRecommendationId);
  const [keyword, setKeyword] = useState('');
  const [serp, setSerp] = useState<SerpObservation | null>(null);
  const [serpNotice, setSerpNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [blogIdDraft, setBlogIdDraft] = useState('');
  const [defaultTagsDraft, setDefaultTagsDraft] = useState('');
  const [composeKeyword, setComposeKeyword] = useState(initialParams.get('compose_keyword') ?? '');
  const activeSourceDraftId = composeKeyword.trim() === (initialParams.get('compose_keyword') ?? '').trim() ? initialSourceDraftId : null;
  const [composeNotes, setComposeNotes] = useState(initialParams.get('compose_notes') ?? '');
  const [composeStyle, setComposeStyle] = useState<BlogComposeStyle>(
    ['auto', 'informational', 'review', 'product'].includes(initialParams.get('compose_style') ?? '')
      ? initialParams.get('compose_style') as BlogComposeStyle
      : 'auto',
  );
  const [composeLength, setComposeLength] = useState<2500 | 4000>(2500);
  const [composeResult, setComposeResult] = useState<BlogComposeResponse | null>(null);
  const [referenceImages, setReferenceImages] = useState<SpecializedResponse | null>(null);
  const [referencePending, setReferencePending] = useState(false);
  const [referenceError, setReferenceError] = useState('');
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [factPack, setFactPack] = useState<FactPack | null>(null);
  const [factPackSelection, setFactPackSelection] = useState<string[]>([]);
  const [factPackPending, setFactPackPending] = useState(false);
  const [factPackError, setFactPackError] = useState('');
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
  const [resumeError, setResumeError] = useState('');
  const [resumePending, setResumePending] = useState(false);
  const [publicationPending, setPublicationPending] = useState(false);
  const [publicationError, setPublicationError] = useState('');
  const suggestionAbort = useRef<AbortController | null>(null);
  const analysisEpoch = useRef(0);
  const draftEpoch = useRef(0);

  useEffect(() => {
    void settings.load();
    void loadRecentKeywords().then(setRecentKeywords);
  }, []);
  useEffect(() => {
    setTokenDraft(settings.token);
    setBlogIdDraft(settings.blogId);
    setDefaultTagsDraft(settings.defaultTags);
  }, [settings.token, settings.blogId, settings.defaultTags]);

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
  const recentDrafts = useQuery({
    queryKey: ['recent-drafts', settings.coreUrl, settings.token],
    queryFn: () => client.listDrafts({ limit: 3 }),
    enabled: settings.loaded && !!settings.token && handshake.isSuccess,
  });
  const todayTasks = useQuery({
    queryKey: ['sidepanel-today-work', settings.coreUrl, settings.token],
    queryFn: () => client.todayWork(3),
    enabled: settings.loaded && !!settings.token && handshake.isSuccess,
  });
  const sourceImprovementDraft = useQuery({
    queryKey: ['performance-source-draft', settings.coreUrl, settings.token, activeSourceDraftId],
    queryFn: () => client.getDraft(activeSourceDraftId!),
    enabled: settings.loaded && !!settings.token && handshake.isSuccess && !!activeSourceDraftId,
  });
  const llmStatus = useQuery({
    queryKey: ['llm-status', settings.coreUrl, settings.token],
    queryFn: () => client.llmStatus(),
    enabled: settings.loaded && !!settings.token && handshake.isSuccess,
    refetchInterval: 30_000,
  });
  const latestDraftVersion = draft?.versions.at(-1)?.version ?? null;
  const draftAssets = useQuery({
    queryKey: ['draft-assets', draft?.draft_id, latestDraftVersion, settings.coreUrl],
    queryFn: () => client.listDraftAssets(draft!.draft_id, latestDraftVersion!),
    enabled: settings.loaded && !!settings.token && handshake.isSuccess && !!draft && latestDraftVersion != null,
  });

  const uploadDraftAssets = useMutation<
    DraftAsset[],
    CoreError,
    { files: File[]; draftId: number; draftVersion: number }
  >({
    mutationFn: async ({ files, draftId, draftVersion }) => {
      const existing = await client.listDraftAssets(draftId, draftVersion);
      const uploaded: DraftAsset[] = [];
      for (const [index, file] of files.slice(0, Math.max(0, 10 - existing.length)).entries()) {
        const dataUrl = await fileToDataUrl(file);
        uploaded.push(await client.addDraftAsset(draftId, {
          draft_version: draftVersion,
          filename: file.name,
          mime_type: file.type as 'image/png' | 'image/jpeg' | 'image/webp',
          data_base64: dataUrl,
          position: existing.length + index,
          anchor_after: existing.length + index + 1,
          rights_status: 'approved',
        }));
      }
      return uploaded;
    },
    onSuccess: () => void draftAssets.refetch(),
  });

  const deleteDraftAsset = useMutation<void, CoreError, { draftId: number; assetId: number }>({
    mutationFn: ({ draftId, assetId }) => client.deleteDraftAsset(draftId, assetId),
    onSuccess: () => void draftAssets.refetch(),
  });

  useEffect(() => {
    if (!handshake.isSuccess) return;
    const params = new URLSearchParams(window.location.search);
    const draftId = Number(params.get('draft_id'));
    if (!Number.isInteger(draftId) || draftId < 1 || draft?.draft_id === draftId) return;
    const jobId = Number(params.get('job_id'));
    void resumeDraft(draftId, Number.isInteger(jobId) && jobId > 0 ? jobId : null);
  }, [handshake.isSuccess]);

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
      factPackId: number | null;
      factPackVersion: number | null;
    }
  >({
    mutationFn: async ({ planItem, mode, analysis, factPackId, factPackVersion }) => {
      const created = await client.createDraft({
        keyword: analysis.keyword,
        snapshot_id: analysis.snapshot_id,
        plan_item: planItem,
        questions: analysis.questions.filter((q) => q.kind === 'question').map((q) => q.text),
        generation_mode: mode,
        fact_pack_id: factPackId,
        fact_pack_version: factPackVersion,
      });
      return client.getDraft(created.draft_id);
    },
    onSuccess: (data, variables) => {
      if (variables.requestId === draftEpoch.current) {
        setDraft(data);
        setSectionTab('draft');
        void recentDrafts.refetch();
      }
    },
  });

  const composeBlog = useMutation<
    { composed: BlogComposeResponse; detail: DraftDetail },
    CoreError,
    BlogComposeRequest & { recommendationId: number | null }
  >({
    mutationFn: async ({ recommendationId: _recommendationId, ...input }) => {
      const composed = await client.composeBlog(input);
      const detail = await client.getDraft(composed.draft.draft_id);
      return { composed, detail };
    },
    onSuccess: ({ composed, detail }, input) => {
      setComposeResult(composed);
      setDraft(detail);
      setKeyword(composed.keyword);
      setReferenceImages(null);
      setReferenceError('');
      void rememberRecentKeyword(composed.keyword).then(setRecentKeywords);
      void recentDrafts.refetch();
      if (input.recommendationId) {
        remainingRecommendationId.current = null;
        void client.updatePerformanceRecommendation(input.recommendationId, 'done')
          .then(() => todayTasks.refetch())
          .catch(() => undefined);
      }
    },
  });

  const addDraftVersion = useMutation<
    DraftDetail,
    CoreError,
    { draftId: number; title: string; body: string; note: string; requestId: number }
  >({
    mutationFn: async ({ draftId, title, body, note }) => {
      if (!draft || draft.draft_id !== draftId) throw new CoreError(409, 'draft_version_conflict', '선택한 원고가 변경되었습니다. 원고를 다시 확인하세요.');
      await client.addDraftVersion(draftId, { title, body, note, expected_version: draft.versions.at(-1)?.version });
      return client.getDraft(draftId);
    },
    onSuccess: (data, variables) => {
      if (variables.requestId === draftEpoch.current) {
        setDraft(data);
        void recentDrafts.refetch();
      }
    },
  });

  const startPublishJob = useMutation<
    PublishJob,
    CoreError,
    { draftId: number; blogId: string; tags: string[]; requestId: number }
  >({
    mutationFn: async ({ draftId, blogId, tags }) => {
      const latestVersion = draft?.draft_id === draftId ? draft.versions.at(-1)?.version : undefined;
      const connection = await browser.runtime.sendMessage({ type: MSG_BROWSER_CONNECTION }) as BrowserConnection;
      if (!connection?.ok || connection.protocol_version !== BROWSER_BRIDGE_PROTOCOL || !connection.debugger_available || !connection.worker_id || !connection.build_id) throw new Error('이 브라우저의 최신 확장 연결을 확인하세요.');
      const job = await client.startPublishJob(draftId, {
        blog_id: blogId,
        tags,
        expected_version: latestVersion,
        transport: 'current_chrome_extension',
        target_worker_id: connection.worker_id,
      });
      void browser.runtime?.sendMessage?.({ type: MSG_RUN_PUBLISH_JOB, jobId: job.job_id })?.catch(() => undefined);
      return job;
    },
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
      return status === 'failed' || status === 'draft_saved' || status === 'verified_draft_saved' ? false : 1_000;
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
    setFactPack(null);
    setFactPackSelection([]);
    setFactPackError('');
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
    const factParam = factPack ? `&fact_pack_id=${factPack.fact_pack_id}` : '';
    const url = `${sidepanelUrl.slice(0, sidepanelUrl.lastIndexOf('/') + 1)}research.html?keyword=${encodeURIComponent(result.keyword)}&snapshot_id=${result.snapshot_id}${factParam}`;
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
    const approved = factPack?.latest_status === 'approved' ? factPack : null;
    createDraft.mutate({
      planItem,
      mode,
      analysis: result,
      requestId,
      factPackId: approved?.fact_pack_id ?? null,
      factPackVersion: approved?.latest_version ?? null,
    });
  }

  async function createFactPackFromAnalysis() {
    if (!result || factPackPending) return;
    setFactPackPending(true);
    setFactPackError('');
    try {
      const created = await client.createFactPack(result.snapshot_id);
      setFactPack(created);
      setFactPackSelection(created.versions.at(-1)?.evidence.filter((item) => item.selected).map((item) => item.id) ?? []);
    } catch (error) {
      setFactPackError(error instanceof CoreError ? `${error.code}: ${error.message}` : '근거 브리프를 만들지 못했습니다.');
    } finally {
      setFactPackPending(false);
    }
  }

  async function approveFactPack() {
    if (!factPack || factPackPending || !factPackSelection.length) return;
    if (!window.confirm('선택한 근거만 AI 초안의 사실 근거로 승인할까요?')) return;
    setFactPackPending(true);
    setFactPackError('');
    try {
      const updated = await client.appendFactPackVersion(factPack.fact_pack_id, factPackSelection, 'approved');
      setFactPack(updated);
    } catch (error) {
      setFactPackError(error instanceof CoreError ? `${error.code}: ${error.message}` : '근거 승인을 완료하지 못했습니다.');
    } finally {
      setFactPackPending(false);
    }
  }

  async function resumeDraft(draftId: number, latestJobId: number | null = null) {
    if (resumePending) return;
    setResumePending(true);
    setResumeError('');
    const requestId = ++draftEpoch.current;
    try {
      const detail = await client.getDraft(draftId);
      if (requestId !== draftEpoch.current) return;
      ++analysisEpoch.current;
      analyze.reset();
      createDraft.reset();
      setResult(null);
      setKeyword(detail.keyword);
      setDraft(detail);
      if (detail.fact_pack_id) {
        try {
          const loadedPack = await client.getFactPack(detail.fact_pack_id);
          if (requestId !== draftEpoch.current) return;
          setFactPack(loadedPack);
          const linked = loadedPack.versions.find((version) => version.version === detail.fact_pack_version);
          setFactPackSelection(linked?.evidence.filter((item) => item.selected).map((item) => item.id) ?? []);
        } catch {
          setFactPackError('연결된 FactPack을 불러오지 못했습니다.');
        }
      } else {
        setFactPack(null);
        setFactPackSelection([]);
      }
      setPublishJobId(latestJobId);
      setSectionTab('draft');
    } catch (error) {
      if (requestId === draftEpoch.current) {
        setResumeError(error instanceof CoreError ? `${error.code}: ${error.message}` : '초안을 불러오지 못했습니다.');
      }
    } finally {
      if (requestId === draftEpoch.current) setResumePending(false);
    }
  }

  async function registerPublished(input: { title: string; url: string; publishedAt: string }) {
    if (!draft || publicationPending) return;
    setPublicationPending(true);
    setPublicationError('');
    try {
      await client.createPublishedContent({
        draft_id: draft.draft_id,
        canonical_url: input.url,
        title: input.title,
        published_at: input.publishedAt,
        confirmed: true,
      });
      await recentDrafts.refetch();
      setPublicationError('공개 콘텐츠 등록을 완료했습니다.');
    } catch (error) {
      setPublicationError(error instanceof CoreError ? `${error.code}: ${error.message}` : '공개 콘텐츠를 등록하지 못했습니다.');
    } finally {
      setPublicationPending(false);
    }
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

  function openPerformanceDetails() {
    void browser.tabs.create({ url: browser.runtime.getURL('/research.html?view=my-performance') });
  }

  function handleTodayTask(item: TodayWorkItem) {
    if ((item.action === 'resume_draft' || item.action === 'inspect_error') && item.draft_id) {
      void resumeDraft(item.draft_id, item.publish_job_id);
      return;
    }
    if (item.action === 'open_performance') {
      openPerformanceDetails();
      return;
    }
    const query = new URLSearchParams({ keyword: item.keyword });
    void browser.tabs.create({ url: browser.runtime.getURL(`/research.html?${query.toString()}`) });
  }

  function runCompleteCompose() {
    const normalized = composeKeyword.trim();
    const matchesHandoff = normalized === (initialParams.get('compose_keyword') ?? '').trim();
    if (!normalized || composeBlog.isPending || !llmStatus.data?.ready) return;
    ++analysisEpoch.current;
    ++draftEpoch.current;
    analyze.reset();
    createDraft.reset();
    addDraftVersion.reset();
    startPublishJob.reset();
    setResult(null);
    setDraft(null);
    setFactPack(null);
    setPublishJobId(null);
    setComposeResult(null);
    setReferenceImages(null);
    setReferenceError('');
    composeBlog.mutate({
      keyword: normalized,
      style: composeStyle,
      user_notes: composeNotes,
      target_chars: composeLength,
      allow_sensitive_unknown: settings.allowLlmWhenSensitiveUnknown,
      force_refresh: false,
      source_draft_id: matchesHandoff ? activeSourceDraftId : null,
      source_draft_mode: matchesHandoff && initialParams.get('source_draft_mode') === 'followup' ? 'followup' : 'revision',
      recommendationId: matchesHandoff ? remainingRecommendationId.current : null,
    });
  }

  async function findReferenceImages() {
    const target = composeResult?.keyword ?? draft?.keyword ?? composeKeyword.trim();
    if (!target || referencePending) return;
    setReferencePending(true);
    setReferenceError('');
    try {
      setReferenceImages(await client.specialized(target, 'image'));
    } catch (error) {
      setReferenceImages(null);
      setReferenceError(
        error instanceof CoreError
          ? `${error.code}: ${error.message}`
          : '참고 사진을 불러오지 못했습니다.',
      );
    } finally {
      setReferencePending(false);
    }
  }

  const connected = handshake.isSuccess;
  const codexReady = llmStatus.data?.ready && llmStatus.data.engine === 'codex_cli';
  const currentAnalysisMutation = analyze.variables?.requestId === analysisEpoch.current;
  const currentDraftMutation = createDraft.variables?.requestId === draftEpoch.current;

  return (
    <div className="min-h-screen bg-[#f6f8f5] p-3 text-sm text-[#102a2e]">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Naver Content OS</p>
          <h1 className="text-base font-bold">블로그 글 자동 작성</h1>
        </div>
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
          <label className="mt-3 block text-xs font-medium text-slate-600">네이버 블로그 ID</label>
          <input
            value={blogIdDraft}
            onChange={(event) => setBlogIdDraft(event.target.value)}
            placeholder="예: sence4u"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
          <label className="mt-3 block text-xs font-medium text-slate-600">기본 태그</label>
          <input
            value={defaultTagsDraft}
            onChange={(event) => setDefaultTagsDraft(event.target.value)}
            placeholder="태그1, 태그2"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
          <button
            className="mt-2 rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white"
            onClick={() => void settings.save({
              token: tokenDraft,
              blogId: blogIdDraft.trim(),
              defaultTags: defaultTagsDraft.trim(),
            }).then(() => setShowSettings(false))}
          >
            설정 저장
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

      <section aria-labelledby="compose-title" className="mt-3 overflow-hidden rounded-2xl border border-[#dce5e0] bg-white shadow-[0_10px_30px_rgba(16,42,46,0.08)]">
        <div className="border-b border-[#dce5e0] bg-gradient-to-br from-[#102a2e] to-[#19483f] px-4 py-4 text-white">
          <p className="text-[10px] font-semibold tracking-[0.15em] text-emerald-200">STEP 1 · 주제만 입력하세요</p>
          <h2 id="compose-title" className="mt-1 text-xl font-bold tracking-tight">오늘 쓸 글은 무엇인가요?</h2>
          <p className="mt-1 text-xs leading-5 text-emerald-50/80">자료를 확인하고 완성된 원고까지 한 번에 만듭니다.</p>
        </div>
        <div className="p-4">
          <label className="block text-xs font-semibold text-[#102a2e]" htmlFor="compose-keyword">글 주제</label>
          <input
            id="compose-keyword"
            value={composeKeyword}
            onChange={(event) => setComposeKeyword(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') runCompleteCompose(); }}
            placeholder="예: 제주도 가족여행 준비물"
            maxLength={100}
            className="mt-1.5 w-full rounded-xl border border-[#bfd0c8] bg-[#fbfcfa] px-3 py-3 text-sm font-medium outline-none transition focus:border-[#00a86b] focus:ring-2 focus:ring-emerald-100"
          />

          <label className="mt-4 block text-xs font-semibold text-[#102a2e]" htmlFor="compose-notes">
            꼭 넣을 내용 <span className="font-normal text-slate-400">선택</span>
          </label>
          <textarea
            id="compose-notes"
            value={composeNotes}
            onChange={(event) => setComposeNotes(event.target.value)}
            placeholder="직접 경험한 내용, 장소, 제품명, 가격 등을 적어주세요. 없는 경험은 AI가 만들지 않습니다."
            maxLength={2000}
            className="mt-1.5 min-h-20 w-full resize-y rounded-xl border border-[#dce5e0] bg-[#fbfcfa] p-3 text-xs leading-5 outline-none focus:border-[#00a86b] focus:ring-2 focus:ring-emerald-100"
          />

          <div className="mt-4">
            <p className="text-xs font-semibold">글 스타일</p>
            <div className="mt-1.5 grid grid-cols-4 gap-1" aria-label="글 스타일">
              {([
                ['auto', '자동'],
                ['informational', '정보형'],
                ['review', '후기형'],
                ['product', '구매가이드'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={composeStyle === value}
                  className={`min-w-0 rounded-lg px-1 py-2 text-[11px] font-semibold transition ${composeStyle === value ? 'bg-[#102a2e] text-white' : 'bg-[#edf2ef] text-slate-600 hover:bg-[#dce5e0]'}`}
                  onClick={() => setComposeStyle(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between rounded-xl bg-[#edf2ef] px-3 py-2">
            <div>
              <p className="text-xs font-semibold">글 길이</p>
              <p className="text-[10px] text-slate-500">읽기 좋은 기본값은 2,500자입니다.</p>
            </div>
            <div className="flex rounded-lg bg-white p-0.5">
              {([2500, 4000] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={composeLength === value}
                  onClick={() => setComposeLength(value)}
                  className={`rounded-md px-2 py-1 text-[10px] font-semibold ${composeLength === value ? 'bg-[#00a86b] text-white' : 'text-slate-500'}`}
                >
                  {value.toLocaleString()}자
                </button>
              ))}
            </div>
          </div>

          {activeSourceDraftId && (
            <div className="mt-3 rounded-xl border border-indigo-100 bg-indigo-50 p-3 text-[11px] text-indigo-900">
              <p className="font-semibold">기존 Draft를 참고해 개선합니다.</p>
              {sourceImprovementDraft.isFetching && <p className="mt-1 text-indigo-700">최신 원고를 불러오는 중…</p>}
              {sourceImprovementDraft.data && <p className="mt-1 text-indigo-700">#{sourceImprovementDraft.data.draft_id} · {sourceImprovementDraft.data.title} · v{sourceImprovementDraft.data.versions.at(-1)?.version ?? 1}</p>}
              {sourceImprovementDraft.isError && <p className="mt-1 text-rose-700">기존 Draft를 확인하지 못해 생성을 시작할 수 없습니다.</p>}
              <p className="mt-1 text-[10px] text-indigo-600">결과는 기존 원고를 덮어쓰지 않고 새 Draft로 저장됩니다.</p>
            </div>
          )}

          <button
            type="button"
            className="mt-4 w-full rounded-xl bg-[#00a86b] px-4 py-3 text-sm font-bold text-white shadow-[0_8px_18px_rgba(0,168,107,0.24)] transition hover:bg-[#00945f] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
            disabled={!composeKeyword.trim() || !connected || !llmStatus.data?.ready || composeBlog.isPending || (!!activeSourceDraftId && !sourceImprovementDraft.data)}
            onClick={runCompleteCompose}
          >
            {composeBlog.isPending ? '완성 글을 만들고 있어요…' : '완성 글 만들기'}
          </button>

          {composeBlog.isPending && (
            <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 p-3" role="status">
              <div className="h-1.5 overflow-hidden rounded-full bg-emerald-100">
                <div className="h-full w-1/2 animate-pulse rounded-full bg-[#00a86b]" />
              </div>
              <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[9px] font-medium text-emerald-800">
                <span>자료 확인</span><span>글 작성</span><span>품질 검사</span><span>완료</span>
              </div>
              {codexReady && (
                <p className="mt-2 text-center text-[10px] leading-4 text-emerald-800">
                  Codex가 완성 원고를 작성 중입니다. 중복 실행은 자동으로 막습니다.
                </p>
              )}
            </div>
          )}

          {!composeBlog.isPending && connected && llmStatus.isFetching && (
            <p className="mt-2 text-[11px] text-slate-500">글쓰기 AI 준비 상태를 확인하고 있습니다…</p>
          )}
          {!composeBlog.isPending && connected && llmStatus.data?.ready && (
            <p className="mt-2 text-[11px] leading-4 text-slate-500">
              {codexReady
                ? `Codex 고품질 AI 연결됨 · ${llmStatus.data.auth === 'chatgpt' ? 'ChatGPT 로그인' : '인증 확인됨'}`
                : 'AI 모델 연결됨'}
              {' · '}생성 원고는 자동 검사 후 표시됩니다.
            </p>
          )}
          {!composeBlog.isPending && connected && llmStatus.data && !llmStatus.data.ready && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <p className="font-semibold">글쓰기 AI를 준비해야 합니다.</p>
              <p className="mt-1">{llmStatus.data.message}</p>
              <p className="mt-1 text-[11px] text-amber-700">{llmStatus.data.action}</p>
              <button className="mt-2 rounded-lg border border-amber-300 bg-white px-2 py-1 text-[11px] font-semibold" onClick={() => void llmStatus.refetch()}>다시 확인</button>
            </div>
          )}
          {composeBlog.isError && (
            <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800" role="alert">
              <p className="font-semibold">완성 글을 만들지 못했습니다.</p>
              <p className="mt-1">{composeBlog.error.message}</p>
              <p className="mt-1 text-[11px] leading-4 text-rose-700">{composeFailureHint(composeBlog.error)}</p>
            </div>
          )}
        </div>
      </section>

      {connected && (todayTasks.isFetching || (todayTasks.data?.items.length ?? 0) > 0) && (
        <SidepanelTodayWork
          items={todayTasks.data?.items ?? []}
          loading={todayTasks.isFetching}
          onAction={handleTodayTask}
          onDetails={openPerformanceDetails}
        />
      )}

      {draft && (
        <SimpleDraftCard
          draft={draft}
          quality={composeResult?.quality ?? null}
          suggestedTags={composeResult?.suggested_tags ?? []}
          savingVersion={addDraftVersion.isPending}
          versionError={addDraftVersion.error?.message ?? ''}
          onSaveVersion={(title, body, note) => addDraftVersion.mutate({
            draftId: draft.draft_id,
            title,
            body,
            note,
            requestId: draftEpoch.current,
          })}
          defaultBlogId={settings.blogId}
          defaultTags={settings.defaultTags}
          onSavePublishSettings={(blogId, tags) => settings.save({ blogId, defaultTags: tags })}
          startingPublish={startPublishJob.isPending}
          publishError={startPublishJob.error?.message ?? publishJob.error?.message ?? ''}
          publishJob={publishJob.data ?? startPublishJob.data ?? null}
          onPublish={(blogId, tags) => startPublishJob.mutate({
            draftId: draft.draft_id,
            blogId,
            tags,
            requestId: draftEpoch.current,
          })}
          referenceImages={referenceImages}
          referencePending={referencePending}
          referenceError={referenceError}
          onFindImages={() => void findReferenceImages()}
          onRegenerate={() => runCompleteCompose()}
          draftAssets={draftAssets.data ?? []}
          assetsPending={draftAssets.isFetching || uploadDraftAssets.isPending || deleteDraftAsset.isPending}
          assetsError={uploadDraftAssets.error?.message ?? deleteDraftAsset.error?.message ?? draftAssets.error?.message ?? ''}
          onAddAssets={(files) => latestDraftVersion && uploadDraftAssets.mutate({ files, draftId: draft.draft_id, draftVersion: latestDraftVersion })}
          onDeleteAsset={(assetId) => deleteDraftAsset.mutate({ draftId: draft.draft_id, assetId })}
        />
      )}

      {connected && (
        <RecentDraftsCard
          items={recentDrafts.data?.items ?? []}
          loading={recentDrafts.isFetching || resumePending}
          error={resumeError}
          onOpen={(item) => void resumeDraft(item.draft_id, item.latest_job_id)}
        />
      )}

      <details className="mt-4 rounded-xl border border-[#dce5e0] bg-white">
        <summary className="cursor-pointer list-none px-3 py-3 text-xs font-semibold text-slate-600 marker:hidden">
          상세 도구 <span className="font-normal text-slate-400">· 키워드 분석, 급상승, FactPack</span>
        </summary>
        <div className="border-t border-[#dce5e0] p-3 pt-0">
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
        <CompactFactPackCard
          pack={factPack}
          selection={factPackSelection}
          pending={factPackPending}
          error={factPackError}
          onCreate={() => void createFactPackFromAnalysis()}
          onSelection={setFactPackSelection}
          onApprove={() => void approveFactPack()}
          onOpen={openWorkspace}
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
      {!result && draft && (
        <DraftCard
          draft={draft}
          savingVersion={addDraftVersion.isPending}
          versionError={addDraftVersion.error?.message ?? ''}
          onSaveVersion={(title, body, note) =>
            addDraftVersion.mutate({ draftId: draft.draft_id, title, body, note, requestId: draftEpoch.current })
          }
          startingPublish={startPublishJob.isPending}
          publishError={startPublishJob.error?.message ?? publishJob.error?.message ?? ''}
          publishJob={publishJob.data ?? startPublishJob.data ?? null}
          onPublish={(blogId, tags) =>
            startPublishJob.mutate({ draftId: draft.draft_id, blogId, tags, requestId: draftEpoch.current })
          }
        />
      )}
      {blogInspection && <BlogInspectionCard inspection={blogInspection} />}
      {draft && blogInspection?.found && (
        <PublishedRegistrationCard
          inspection={blogInspection}
          pending={publicationPending}
          message={publicationError}
          onRegister={(input) => void registerPublished(input)}
        />
      )}
        </div>
      </details>
    </div>
  );
}

export function SidepanelTodayWork({
  items,
  loading,
  onAction,
  onDetails,
}: {
  items: TodayWorkItem[];
  loading: boolean;
  onAction: (item: TodayWorkItem) => void;
  onDetails: () => void;
}) {
  const labels: Record<TodayWorkItem['action'], string> = {
    inspect_error: '오류 확인',
    resume_draft: '이어쓰기',
    register_publication: '발행 확인',
    refresh_data: '자료 갱신',
    open_analysis: '분석 보기',
    open_performance: '성과 개선',
  };
  return (
    <section className="mt-3 rounded-xl border border-[#dce5e0] bg-white p-3" aria-label="오늘 우선 작업">
      <div className="flex items-center justify-between gap-2">
        <div><h2 className="text-xs font-bold">오늘 우선 작업</h2><p className="text-[10px] text-slate-400">중요한 작업을 최대 3개만 보여줍니다.</p></div>
        <button className="text-[10px] font-semibold text-emerald-700 underline" onClick={onDetails}>내 성과 자세히</button>
      </div>
      {loading && items.length === 0 && <p className="mt-2 text-[10px] text-slate-400">확인 중…</p>}
      <div className="mt-2 space-y-1.5">
        {items.slice(0, 3).map((item) => (
          <article key={item.id} className="flex items-center gap-2 rounded-lg bg-slate-50 p-2">
            <div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold">{item.title}</p><p className="truncate text-[9px] text-slate-400">{item.reason}</p></div>
            <button className="shrink-0 rounded bg-[#102a2e] px-2 py-1 text-[9px] font-semibold text-white" onClick={() => onAction(item)}>{labels[item.action]}</button>
          </article>
        ))}
      </div>
    </section>
  );
}

export function CompactFactPackCard({
  pack,
  selection,
  pending,
  error,
  onCreate,
  onSelection,
  onApprove,
  onOpen,
}: {
  pack: FactPack | null;
  selection: string[];
  pending: boolean;
  error: string;
  onCreate: () => void;
  onSelection: (ids: string[]) => void;
  onApprove: () => void;
  onOpen: () => void;
}) {
  const latest = pack?.versions.at(-1) ?? null;
  return (
    <section className="mt-3 rounded-lg border border-violet-200 bg-white p-3" aria-label="FactPack 근거 브리프">
      <div className="flex items-center justify-between gap-2"><div><h2 className="font-semibold">FactPack 근거 브리프</h2><p className="text-[10px] text-slate-500">승인한 정규화 근거만 AI 초안에 연결합니다.</p></div>{!pack && <button className="rounded bg-violet-600 px-2 py-1 text-xs text-white disabled:opacity-40" disabled={pending} onClick={onCreate}>{pending ? '생성 중…' : '근거 만들기'}</button>}</div>
      {latest && <><div className="mt-2 flex gap-2 text-[10px] text-slate-500"><span>#{pack?.fact_pack_id} · v{latest.version}</span><span className={latest.status === 'approved' ? 'font-semibold text-emerald-700' : 'text-amber-700'}>{latest.status === 'approved' ? '승인됨' : '검토 필요'}</span><span>{selection.length}/{latest.evidence.length} 선택</span></div>{latest.warnings.length > 0 && <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-800">{latest.warnings[0]}{latest.warnings.length > 1 ? ` 외 ${latest.warnings.length - 1}건` : ''}</p>}<div className="mt-2 max-h-36 space-y-1 overflow-auto">{latest.evidence.map((item) => <label key={item.id} className="flex gap-2 rounded bg-slate-50 px-2 py-1.5 text-xs"><input type="checkbox" checked={selection.includes(item.id)} onChange={(event) => onSelection(event.target.checked ? [...selection, item.id] : selection.filter((id) => id !== item.id))} /><span className="min-w-0 flex-1 truncate">{item.label} · {typeof item.value === 'string' ? item.value : JSON.stringify(item.value)}</span><span className="shrink-0 text-[10px] text-slate-400">{item.freshness}</span></label>)}</div><div className="mt-2 flex gap-1"><button className="flex-1 rounded border border-violet-300 px-2 py-1 text-xs text-violet-700" onClick={onOpen}>전체 검토</button><button className="flex-1 rounded bg-emerald-600 px-2 py-1 text-xs text-white disabled:opacity-40" disabled={pending || !selection.length} onClick={onApprove}>{pending ? '처리 중…' : latest.status === 'approved' ? '새 승인 버전' : '선택 근거 승인'}</button></div></>}
      {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
    </section>
  );
}

export function RecentDraftsCard({
  items,
  loading,
  error,
  onOpen,
}: {
  items: DraftSummary[];
  loading: boolean;
  error: string;
  onOpen: (item: DraftSummary) => void;
}) {
  if (!loading && items.length === 0 && !error) return null;
  return (
    <section className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50/60 p-3" aria-label="최근 작업 계속">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-indigo-900">최근 작업 계속</h2>
        {loading && <span className="text-[10px] text-indigo-500">불러오는 중…</span>}
      </div>
      {error && <p className="mt-2 rounded bg-rose-50 px-2 py-1 text-[10px] text-rose-700">{error}</p>}
      <div className="mt-2 space-y-1">
        {items.map((item) => (
          <button
            key={item.draft_id}
            className="flex w-full items-center gap-2 rounded bg-white px-2 py-2 text-left shadow-sm hover:bg-indigo-50"
            onClick={() => onOpen(item)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{item.title}</span>
              <span className="block truncate text-[10px] text-slate-500">{item.keyword} · v{item.latest_version} · {item.user_status}</span>
            </span>
            <span className={`shrink-0 text-[10px] ${item.latest_job_status === 'failed' ? 'text-rose-600' : 'text-indigo-600'}`}>
              {item.latest_job_status === 'failed' ? '오류 확인' : '이어쓰기'}
            </span>
          </button>
        ))}
      </div>
    </section>
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
      {m && <div className="mt-3"><PcMobileDonut pc={m.monthly_pc_searches} mobile={m.monthly_mobile_searches} masked={m.volume_masked} compact /></div>}
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

const PUBLISH_STAGE_LABEL: Record<string, string> = {
  '': '작업 대기',
  browser_attach: '브라우저 연결',
  health_check: '브라우저 확인',
  prepare_editor: '에디터 열기',
  input_title: '제목 입력',
  input_body: '본문 입력',
  upload_images: '이미지 입력',
  input_tags: '태그 입력',
  draft_save: '임시저장 확인',
  reopen_verify: '재열기 검증',
  publisher_runtime: '작업 확인',
};

function splitTags(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 10);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`${file.name} 파일을 읽지 못했습니다.`));
    reader.readAsDataURL(file);
  });
}

export function SimpleDraftCard({
  draft,
  quality,
  suggestedTags,
  savingVersion,
  versionError,
  onSaveVersion,
  defaultBlogId,
  defaultTags,
  onSavePublishSettings,
  startingPublish,
  publishError,
  publishJob,
  onPublish,
  referenceImages,
  referencePending,
  referenceError,
  onFindImages,
  onRegenerate,
  draftAssets,
  assetsPending = false,
  assetsError = '',
  onAddAssets = () => undefined,
  onDeleteAsset = () => undefined,
}: {
  draft: DraftDetail;
  quality: ArticleQuality | null;
  suggestedTags: string[];
  savingVersion: boolean;
  versionError: string;
  onSaveVersion: (title: string, body: string, note: string) => void;
  defaultBlogId: string;
  defaultTags: string;
  onSavePublishSettings: (blogId: string, tags: string) => Promise<void>;
  startingPublish: boolean;
  publishError: string;
  publishJob: PublishJob | null;
  onPublish: (blogId: string, tags: string[]) => void;
  referenceImages: SpecializedResponse | null;
  referencePending: boolean;
  referenceError: string;
  onFindImages: () => void;
  onRegenerate: () => void;
  draftAssets?: DraftAsset[];
  assetsPending?: boolean;
  assetsError?: string;
  onAddAssets?: (files: File[]) => void;
  onDeleteAsset?: (assetId: number) => void;
}) {
  const latest = draft.versions.at(-1)!;
  const [title, setTitle] = useState(latest.title);
  const [body, setBody] = useState(latest.body);
  const [note, setNote] = useState('');
  const [blogId, setBlogId] = useState(defaultBlogId);
  const [tagsText, setTagsText] = useState(defaultTags || suggestedTags.join(', '));
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [rightsApproved, setRightsApproved] = useState(false);

  useEffect(() => {
    const current = draft.versions.at(-1)!;
    setTitle(current.title);
    setBody(current.body);
    setNote('');
  }, [draft]);
  useEffect(() => {
    setBlogId(defaultBlogId);
    setTagsText(defaultTags || suggestedTags.join(', '));
    setSettingsSaved(false);
  }, [draft.draft_id, defaultBlogId, defaultTags, suggestedTags.join('|')]);

  const dirty = title !== latest.title || body !== latest.body;
  const validBlogId = /^[A-Za-z0-9_-]+$/.test(blogId);
  const requiredAssetsReady = draftAssets === undefined || draftAssets.length >= 3;
  const canPublish = validBlogId && !dirty && body.length >= 3000 && !startingPublish && requiredAssetsReady;
  const imageRows = referenceImages?.items?.slice(0, 5) ?? [];

  function confirmPublish() {
    if (!canPublish) return;
    if (!window.confirm('최신 원고를 네이버 SmartEditor에 입력하고 임시저장할까요? 공개 발행은 하지 않습니다.')) return;
    onPublish(blogId, splitTags(tagsText));
  }

  return (
    <section className="mt-4 rounded-2xl border border-emerald-200 bg-white p-4 shadow-[0_10px_30px_rgba(16,42,46,0.07)]" aria-labelledby="complete-draft-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold tracking-[0.14em] text-emerald-700">STEP 2 · 확인하고 다듬기</p>
          <h2 id="complete-draft-title" className="mt-1 text-lg font-bold">완성된 글</h2>
        </div>
        {quality && (
          <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-bold text-emerald-800">
            자동 검사 {quality.score}점
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        {body.length.toLocaleString()}자 · v{latest.version} · {draft.model || draft.provider}
        {quality?.repair_attempted ? ' · 자동 보정 완료' : ''}
      </p>
      {quality && (
        <div className="mt-2">
          <div className="flex flex-wrap gap-1 text-[10px]">
            <span className="rounded-full bg-[#edf2ef] px-2 py-1">길이 확인</span>
            <span className="rounded-full bg-[#edf2ef] px-2 py-1">키워드 {quality.keyword_count}회</span>
            <span className="rounded-full bg-[#edf2ef] px-2 py-1">문단 {quality.paragraph_count}개</span>
          </div>
          <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800">
            자동 검사는 분량·반복·민감정보 노출을 확인합니다. 사실 정확성과 표현은 임시저장 전에 직접 확인해 주세요.
          </p>
        </div>
      )}

      <label className="mt-4 block text-xs font-semibold" htmlFor="simple-draft-title">제목</label>
      <input
        id="simple-draft-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        className="mt-1.5 w-full rounded-xl border border-[#bfd0c8] px-3 py-2 text-sm font-semibold outline-none focus:border-[#00a86b] focus:ring-2 focus:ring-emerald-100"
      />
      <label className="mt-3 block text-xs font-semibold" htmlFor="simple-draft-body">본문</label>
      <textarea
        id="simple-draft-body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        className="mt-1.5 min-h-80 w-full resize-y rounded-xl border border-[#bfd0c8] bg-[#fffef9] p-3 text-[13px] leading-6 outline-none focus:border-[#00a86b] focus:ring-2 focus:ring-emerald-100"
      />
      <div className="mt-2 flex gap-2">
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="수정 메모"
          className="min-w-0 flex-1 rounded-lg border border-[#dce5e0] px-2 py-1.5 text-xs"
        />
        <button
          className="rounded-lg bg-[#102a2e] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          disabled={!dirty || !title.trim() || !body.trim() || savingVersion}
          onClick={() => onSaveVersion(title, body, note || '사용자 수정')}
        >
          {savingVersion ? '저장 중…' : '수정 저장'}
        </button>
      </div>
      {dirty && <p className="mt-1 text-[10px] text-amber-700">수정 내용을 저장해야 네이버 임시저장을 시작할 수 있습니다.</p>}
      {versionError && <p className="mt-1 text-xs text-rose-700">수정 저장 오류: {versionError}</p>}

      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[#dce5e0] pt-4">
        <button className="rounded-xl border border-[#bfd0c8] px-3 py-2 text-xs font-semibold text-[#102a2e]" onClick={onRegenerate}>다시 작성</button>
        <button className="rounded-xl border border-[#bfd0c8] px-3 py-2 text-xs font-semibold text-[#102a2e] disabled:opacity-40" disabled={referencePending} onClick={onFindImages}>
          {referencePending ? '사진 찾는 중…' : '참고 사진 찾기'}
        </button>
      </div>

      {(referenceImages || referenceError) && (
        <div className="mt-3 rounded-xl bg-[#f6f8f5] p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold">참고 사진</h3>
            {referenceImages && <span className="text-[10px] text-slate-400">최대 5개</span>}
          </div>
          <p className="mt-1 text-[10px] leading-4 text-amber-700">자동 삽입되지 않습니다. 사용 전 원 출처의 이용 권리를 확인하세요.</p>
          {referenceImages?.status === 'unconfigured' && <p className="mt-2 text-xs text-slate-600">NAVER 이미지 검색 API가 설정되지 않았습니다.</p>}
          {imageRows.length > 0 && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {imageRows.map((row, index) => (
                <a
                  key={`${index}-${String(row.link ?? '')}`}
                  href={safeExternalUrl(row.link)}
                  target="_blank"
                  rel="noreferrer"
                  className="overflow-hidden rounded-lg border border-[#dce5e0] bg-white"
                >
                  {Boolean(row.thumbnail) && <img src={safeExternalUrl(row.thumbnail)} alt="" className="h-24 w-full object-cover" />}
                  <span className="block truncate px-2 py-1.5 text-[10px] font-medium text-sky-700">{String(row.title || '원본 보기')}</span>
                </a>
              ))}
            </div>
          )}
          {referenceError && <p className="mt-2 text-xs text-rose-700">{referenceError}</p>}
        </div>
      )}

      {draftAssets !== undefined && (
        <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50/60 p-3" aria-label="네이버 본문 이미지">
          <div className="flex items-center justify-between gap-2">
            <div><h3 className="text-xs font-bold">본문 이미지</h3><p className="text-[10px] text-slate-500">최소 3장 · 최대 10장 · 현재 원고 v{latest.version} 전용</p></div>
            <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${draftAssets.length >= 3 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{draftAssets.length}/3</span>
          </div>
          <label className="mt-2 flex items-start gap-2 text-[10px] leading-4 text-slate-600">
            <input type="checkbox" checked={rightsApproved} onChange={(event) => setRightsApproved(event.target.checked)} />
            직접 촬영했거나 네이버 블로그 사용 권한이 있는 이미지만 선택합니다.
          </label>
          <label className={`mt-2 block rounded-lg border border-dashed px-3 py-2 text-center text-xs font-semibold ${rightsApproved && !assetsPending ? 'cursor-pointer border-sky-400 bg-white text-sky-700' : 'cursor-not-allowed border-slate-300 text-slate-400'}`}>
            {assetsPending ? '이미지 처리 중…' : '이미지 파일 선택'}
            <input
              className="hidden"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={!rightsApproved || assetsPending || draftAssets.length >= 10}
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = '';
                if (files.length) onAddAssets(files);
              }}
            />
          </label>
          <div className="mt-2 space-y-1">
            {draftAssets.map((asset) => (
              <div key={asset.asset_id} className="flex items-center gap-2 rounded bg-white px-2 py-1.5 text-[10px]">
                <span className="min-w-0 flex-1 truncate">{asset.position + 1}. {asset.filename} · {Math.ceil(asset.byte_size / 1024)}KB</span>
                <button className="text-rose-600 disabled:text-slate-300" disabled={assetsPending} onClick={() => onDeleteAsset(asset.asset_id)}>삭제</button>
              </div>
            ))}
          </div>
          {!requiredAssetsReady && <p className="mt-2 text-[10px] font-medium text-amber-700">임시저장을 시작하려면 승인된 이미지가 {3 - draftAssets.length}장 더 필요합니다.</p>}
          {assetsError && <p className="mt-2 text-[10px] text-rose-700">이미지 오류: {assetsError}</p>}
        </div>
      )}

      <div className="mt-4 rounded-xl border border-[#dce5e0] bg-[#f6f8f5] p-3">
        <p className="text-[10px] font-semibold tracking-[0.14em] text-emerald-700">STEP 3 · 네이버로 보내기</p>
        <h3 className="mt-1 text-sm font-bold">네이버 임시저장</h3>
        <p className="mt-1 text-[10px] leading-4 text-slate-500">블로그 ID는 한 번 저장하면 다음 글부터 자동으로 사용합니다. 공개 발행은 하지 않습니다.</p>
        {body.length < 3000 && <p className="mt-2 text-[10px] font-medium text-amber-700">임시저장은 본문 3,000자 이상부터 가능합니다. 현재 {body.length.toLocaleString()}자입니다.</p>}
        <label className="mt-3 block text-[11px] font-semibold" htmlFor="simple-blog-id">네이버 블로그 ID</label>
        <input
          id="simple-blog-id"
          value={blogId}
          onChange={(event) => { setBlogId(event.target.value); setSettingsSaved(false); }}
          placeholder="예: sence4u"
          className="mt-1 w-full rounded-lg border border-[#bfd0c8] bg-white px-2 py-2 text-xs"
        />
        <label className="mt-2 block text-[11px] font-semibold" htmlFor="simple-blog-tags">태그</label>
        <input
          id="simple-blog-tags"
          value={tagsText}
          onChange={(event) => { setTagsText(event.target.value); setSettingsSaved(false); }}
          placeholder="태그1, 태그2"
          className="mt-1 w-full rounded-lg border border-[#bfd0c8] bg-white px-2 py-2 text-xs"
        />
        {!validBlogId && blogId.length > 0 && <p className="mt-1 text-[10px] text-rose-700">영문, 숫자, 밑줄, 하이픈만 입력할 수 있습니다.</p>}
        <div className="mt-2 flex items-center justify-between">
          <button
            className="text-[10px] font-semibold text-emerald-700 disabled:text-slate-400"
            disabled={!validBlogId}
            onClick={() => void onSavePublishSettings(blogId.trim(), tagsText.trim()).then(() => setSettingsSaved(true))}
          >
            이 설정 기억하기
          </button>
          {settingsSaved && <span className="text-[10px] text-emerald-700">저장됨</span>}
        </div>
        <button
          className="mt-3 w-full rounded-xl bg-[#102a2e] px-3 py-2.5 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-35"
          disabled={!canPublish}
          onClick={confirmPublish}
        >
          {startingPublish ? '네이버로 보내는 중…' : '네이버에 임시저장'}
        </button>
        {publishJob && (
          <p className={`mt-2 rounded-lg px-2 py-2 text-xs ${publishJob.status === 'failed' ? 'bg-rose-50 text-rose-700' : publishJob.status === 'verified_draft_saved' || publishJob.status === 'draft_saved' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-50 text-sky-700'}`}>
            {publishJob.status === 'verified_draft_saved'
              ? '네이버 임시저장 후 재열기 검증까지 완료했습니다.'
              : publishJob.status === 'draft_saved'
                ? '네이버 임시저장을 확인했습니다. (전용 브라우저 방식)'
              : publishJob.status === 'failed'
                ? `중단됨 · ${PUBLISH_STAGE_LABEL[publishJob.stage] ?? publishJob.stage}`
                : `진행 중 · ${PUBLISH_STAGE_LABEL[publishJob.stage] ?? publishJob.stage}`}
          </p>
        )}
        {publishError && <p className="mt-2 text-xs text-rose-700">임시저장 오류: {publishError}</p>}
      </div>
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
    if (!window.confirm('현재 Chrome의 SmartEditor에 이 최신 버전을 입력하고 임시저장할까요? 공개 발행은 하지 않습니다.')) return;
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
      {draft.fact_pack_id && (
        <button
          className="mt-2 rounded border border-violet-300 px-2 py-1 text-[10px] text-violet-700"
          onClick={() => {
            const sidepanelUrl = browser.runtime.getURL('/sidepanel.html');
            const url = `${sidepanelUrl.slice(0, sidepanelUrl.lastIndexOf('/') + 1)}research.html?keyword=${encodeURIComponent(draft.keyword)}&snapshot_id=${draft.source_snapshot_id ?? ''}&fact_pack_id=${draft.fact_pack_id}`;
            void browser.tabs.create({ url });
          }}
        >
          연결 근거 FactPack #{draft.fact_pack_id} · v{draft.fact_pack_version} 보기
        </button>
      )}
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
        <p className="mt-0.5 text-[10px] text-slate-400">현재 Chrome의 네이버 로그인 상태를 사용합니다. 공개 발행은 하지 않습니다.</p>
        <div className="mt-2 flex gap-1">
          <input className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs" value={blogId} onChange={(event) => setBlogId(event.target.value)} placeholder="네이버 blog ID" />
          <input className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs" value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="태그1, 태그2" />
        </div>
        {dirty && <p className="mt-1 text-[10px] text-amber-700">수정 내용을 새 버전으로 저장해야 임시저장을 시작할 수 있습니다.</p>}
        <button className="mt-2 w-full rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40" disabled={!canPublish} onClick={confirmPublish}>{startingPublish ? 'Job 시작 중…' : '최신 버전 임시저장 시작'}</button>
        {publishJob && <p className={`mt-2 rounded px-2 py-1 text-xs ${publishJob.status === 'failed' ? 'bg-rose-50 text-rose-700' : publishJob.status === 'verified_draft_saved' || publishJob.status === 'draft_saved' ? 'bg-emerald-50 text-emerald-700' : 'bg-sky-50 text-sky-700'}`}>Job #{publishJob.job_id} · {publishJob.status} · {publishJob.stage || '대기'}</p>}
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

export function PublishedRegistrationCard({
  inspection,
  pending,
  message,
  onRegister,
}: {
  inspection: BlogParse;
  pending: boolean;
  message: string;
  onRegister: (input: { title: string; url: string; publishedAt: string }) => void;
}) {
  const [title, setTitle] = useState(inspection.title);
  const [url, setUrl] = useState(inspection.url ?? '');
  return (
    <section className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
      <h2 className="font-semibold">실제 공개 콘텐츠 등록</h2>
      <p className="mt-1 text-[10px] text-emerald-800">현재 블로그 분석 결과를 후보로 채웠습니다. 확인 전에는 저장되지 않습니다.</p>
      <input className="mt-2 w-full rounded border border-emerald-200 px-2 py-1 text-xs" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="공개된 글 제목" />
      <input className="mt-1 w-full rounded border border-emerald-200 px-2 py-1 text-xs" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://blog.naver.com/..." />
      <button
        className="mt-2 rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
        disabled={pending || !title.trim() || !url.trim()}
        onClick={() => {
          if (!window.confirm('현재 URL의 글이 실제로 공개된 것을 확인했나요? 임시저장만 된 글은 등록하지 마세요.')) return;
          onRegister({ title, url, publishedAt: new Date().toISOString() });
        }}
      >
        {pending ? '등록 중…' : '공개 사실 확인 후 등록'}
      </button>
      {message && <p className="mt-2 text-[10px] text-emerald-800">{message}</p>}
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
