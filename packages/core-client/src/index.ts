/** Shared Local Core transport. Extension tokens and same-origin web sessions
 * are explicit alternatives; provider secrets always remain in Local Core. */

import type {
  AnalyzeResponse,
  AdPerformanceResponse,
  AudienceResponse,
  BlogComposeRequest,
  BlogComposeResponse,
  CapabilitiesResponse,
  CommercialResponse,
  DraftCreateRequest,
  DraftCreateResponse,
  DraftAsset,
  DraftDetail,
  DraftListResponse,
  DraftUserStatus,
  FactPack,
  HealthResponse,
  IntentBoardResponse,
  KeywordSuggestionResponse,
  LatestRisingResponse,
  LLMStatusResponse,
  ContentPerformanceItem,
  PerformanceChannel,
  PerformanceChannelListResponse,
  PerformanceDataKind,
  PerformanceImportPreview,
  PerformanceImportRequest,
  PerformanceImportRun,
  PerformanceOverviewResponse,
  PerformanceRecommendation,
  PerformanceSource,
  QueryPerformanceItem,
  PublishedContent,
  PublishedContentListResponse,
  PublishJob,
  PublishCommand,
  PublisherReadiness,
  PreflightResponse,
  ResearchGraphResponse,
  RisingRequest,
  RisingResponse,
  SerpObservation,
  SpecializedResponse,
  TodayWorkResponse,
  WatchlistItem,
  WatchlistResponse,
  TrackingLinkResponse,
} from '@ncos/contracts';

export class CoreError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type CoreAuth = string | { kind: 'web-session' };

export class CoreClient {
  constructor(
    private baseUrl: string,
    private auth: CoreAuth,
  ) {}

  private async request<T>(path: string, init?: RequestInit, binary = false): Promise<T> {
    const webSession = typeof this.auth !== 'string';
    // Web credentials must never be sent to a configured remote Core URL.
    if (webSession && this.baseUrl !== '') {
      throw new CoreError(0, 'unsafe_origin', '웹 세션은 현재 앱 서버에서만 사용할 수 있습니다.');
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        credentials: webSession ? 'same-origin' : 'omit',
        headers: {
          'Content-Type': 'application/json',
          ...(webSession ? { 'X-NCOS-Web': '1' } : { 'X-Local-Token': this.auth as string }),
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      throw new CoreError(0, 'unreachable', 'Local Core에 연결할 수 없습니다');
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const code = body?.error?.code ?? body?.detail?.code ?? String(response.status);
      const validationMessage = Array.isArray(body?.detail) ? body.detail[0]?.msg : undefined;
      throw new CoreError(
        response.status,
        code,
        body?.error?.message ?? body?.detail?.message ?? validationMessage ?? 'request failed',
      );
    }
    if (response.status === 204) return undefined as T;
    if (binary) return (await response.blob()) as T;
    return (await response.json()) as T;
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health');
  }

  handshake(): Promise<{ status: string }> {
    return this.request<{ status: string }>('/v1/handshake');
  }

  llmStatus(): Promise<LLMStatusResponse> {
    return this.request<LLMStatusResponse>('/v1/llm/status');
  }

  composeBlog(input: BlogComposeRequest): Promise<BlogComposeResponse> {
    return this.request<BlogComposeResponse>('/v1/blogs/compose', {
      method: 'POST',
      body: JSON.stringify({ ...input, force_refresh: input.force_refresh ?? false }),
    });
  }

  analyze(keyword: string, serp?: SerpObservation | null, forceRefresh = false): Promise<AnalyzeResponse> {
    return this.request<AnalyzeResponse>('/v1/keywords/analyze', {
      method: 'POST',
      body: JSON.stringify({ keyword, force_refresh: forceRefresh, serp: serp ?? null }),
    });
  }

  capabilities(): Promise<CapabilitiesResponse> {
    return this.request<CapabilitiesResponse>('/v1/capabilities');
  }

  preflight(keyword: string, forceRefresh = false): Promise<PreflightResponse> {
    return this.request<PreflightResponse>('/v1/keywords/preflight', {
      method: 'POST',
      body: JSON.stringify({ keyword, force_refresh: forceRefresh }),
    });
  }

  suggestKeywords(query: string, signal?: AbortSignal): Promise<KeywordSuggestionResponse> {
    return this.request<KeywordSuggestionResponse>('/v1/keywords/suggest', {
      method: 'POST',
      body: JSON.stringify({ query, limit: 8 }),
      signal,
    });
  }

  rising(input: RisingRequest): Promise<RisingResponse> {
    return this.request<RisingResponse>('/v1/research/rising', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  latestRising(input: Omit<RisingRequest, 'candidate_limit' | 'force_refresh'>): Promise<LatestRisingResponse> {
    const query = new URLSearchParams({ mode: input.mode });
    if (input.seed) query.set('seed', input.seed);
    if (input.region) query.set('region', input.region);
    if (input.category) query.set('category', input.category);
    return this.request<LatestRisingResponse>(`/v1/research/rising/latest?${query.toString()}`);
  }

  recentRising(): Promise<{ runs: RisingResponse[]; read_only: true }> {
    return this.request('/v1/research/rising/recent?limit=8');
  }

  graph(keyword: string, snapshotId?: number | null, forceRefresh = false): Promise<ResearchGraphResponse> {
    return this.request<ResearchGraphResponse>('/v1/research/graph', {
      method: 'POST',
      body: JSON.stringify({ keyword, snapshot_id: snapshotId ?? null, force_refresh: forceRefresh }),
    });
  }

  commercial(keywords: string[], device: 'PC' | 'MOBILE' = 'PC', forceRefresh = false): Promise<CommercialResponse> {
    return this.request<CommercialResponse>('/v1/research/commercial', {
      method: 'POST',
      body: JSON.stringify({ keywords, device, force_refresh: forceRefresh }),
    });
  }

  audience(keyword: string, forceRefresh = false): Promise<AudienceResponse> {
    return this.request<AudienceResponse>('/v1/research/audience', {
      method: 'POST',
      body: JSON.stringify({ keyword, force_refresh: forceRefresh }),
    });
  }

  specialized(
    keyword: string,
    mode: 'general' | 'local' | 'shopping' | 'image',
    category = '',
    forceRefresh = false,
  ): Promise<SpecializedResponse> {
    return this.request<SpecializedResponse>('/v1/research/specialized', {
      method: 'POST',
      body: JSON.stringify({ keyword, mode, category, force_refresh: forceRefresh }),
    });
  }

  listWatchlist(): Promise<WatchlistResponse> {
    return this.request<WatchlistResponse>('/v1/watchlist');
  }

  addWatchlist(keyword: string): Promise<WatchlistItem> {
    return this.request<WatchlistItem>('/v1/watchlist', {
      method: 'POST',
      body: JSON.stringify({ keyword }),
    });
  }

  deleteWatchlist(itemId: number): Promise<void> {
    return this.request<void>(`/v1/watchlist/${itemId}`, { method: 'DELETE' });
  }

  refreshWatchlist(itemIds: number[], forceRefresh = false): Promise<{ items: WatchlistItem[] }> {
    return this.request('/v1/watchlist/refresh', {
      method: 'POST',
      body: JSON.stringify({ item_ids: itemIds, force_refresh: forceRefresh }),
    });
  }

  adPerformance(since: string, until: string, forceRefresh = false): Promise<AdPerformanceResponse> {
    return this.request<AdPerformanceResponse>('/v1/research/ad-performance', {
      method: 'POST',
      body: JSON.stringify({ since, until, force_refresh: forceRefresh }),
    });
  }

  todayWork(limit = 5): Promise<TodayWorkResponse> {
    return this.request<TodayWorkResponse>(`/v1/work/today?limit=${limit}`);
  }

  performanceMetricDictionary(): Promise<Record<string, unknown>> {
    return this.request('/v1/performance/metric-dictionary');
  }

  createPerformanceChannel(input: {
    source: PerformanceSource;
    display_name: string;
    site_url?: string | null;
    ownership_confirmed?: boolean;
  }): Promise<PerformanceChannel> {
    return this.request<PerformanceChannel>('/v1/performance/channels', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  listPerformanceChannels(includeDisabled = true): Promise<PerformanceChannelListResponse> {
    return this.request<PerformanceChannelListResponse>(
      `/v1/performance/channels?include_disabled=${includeDisabled ? 'true' : 'false'}`,
    );
  }

  updatePerformanceChannel(channelId: number, enabled: boolean): Promise<PerformanceChannel> {
    return this.request<PerformanceChannel>(`/v1/performance/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
  }

  previewPerformanceImport(input: PerformanceImportRequest): Promise<PerformanceImportPreview> {
    return this.request<PerformanceImportPreview>('/v1/performance/imports/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  createPerformanceImport(input: PerformanceImportRequest): Promise<PerformanceImportRun> {
    return this.request<PerformanceImportRun>('/v1/performance/imports', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  listPerformanceImports(limit = 30, channelId?: number): Promise<{ items: PerformanceImportRun[] }> {
    return this.request(`/v1/performance/imports?limit=${limit}${channelId ? `&channel_id=${channelId}` : ''}`);
  }

  deletePerformanceImport(importId: number): Promise<void> {
    return this.request<void>(`/v1/performance/imports/${importId}`, { method: 'DELETE' });
  }

  performanceOverview(channelId?: number, importId?: number): Promise<PerformanceOverviewResponse> {
    return this.request<PerformanceOverviewResponse>(`/v1/performance/overview${performanceScope(importId, channelId)}`);
  }

  contentPerformance(importId?: number, channelId?: number): Promise<{ items: ContentPerformanceItem[] }> {
    const suffix = performanceScope(importId, channelId);
    return this.request(`/v1/performance/contents${suffix}`);
  }

  queryPerformance(importId?: number, channelId?: number): Promise<{ items: QueryPerformanceItem[] }> {
    const suffix = performanceScope(importId, channelId);
    return this.request(`/v1/performance/queries${suffix}`);
  }

  mapContentPerformance(snapshotId: number, publishedContentId: number): Promise<ContentPerformanceItem> {
    return this.request<ContentPerformanceItem>(`/v1/performance/content-snapshots/${snapshotId}/mapping`, {
      method: 'PATCH',
      body: JSON.stringify({ published_content_id: publishedContentId }),
    });
  }

  performanceRecommendations(status: 'open' | 'dismissed' | 'done' = 'open', channelId?: number): Promise<{ items: PerformanceRecommendation[] }> {
    const query = new URLSearchParams({ status });
    if (channelId) query.set('channel_id', String(channelId));
    return this.request(`/v1/performance/recommendations?${query.toString()}`);
  }

  updatePerformanceRecommendation(
    recommendationId: number,
    status: 'open' | 'dismissed' | 'done',
  ): Promise<PerformanceRecommendation> {
    return this.request<PerformanceRecommendation>(`/v1/performance/recommendations/${recommendationId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }

  buildTrackingLink(input: {
    destination_url: string;
    nt_source: string;
    nt_medium: string;
    nt_detail?: string;
    nt_keyword?: string;
    published_content_id?: number | null;
  }): Promise<TrackingLinkResponse> {
    return this.request<TrackingLinkResponse>('/v1/performance/tracking-links', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  createDraft(input: DraftCreateRequest): Promise<DraftCreateResponse> {
    return this.request<DraftCreateResponse>('/v1/drafts', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  createFactPack(snapshotId: number, draftId?: number | null): Promise<FactPack> {
    return this.request<FactPack>('/v1/factpacks', {
      method: 'POST',
      body: JSON.stringify({ snapshot_id: snapshotId, draft_id: draftId ?? null }),
    });
  }

  getFactPack(factPackId: number): Promise<FactPack> {
    return this.request<FactPack>(`/v1/factpacks/${factPackId}`);
  }

  getIntentBoard(snapshotId: number): Promise<IntentBoardResponse> {
    return this.request<IntentBoardResponse>(`/v1/snapshots/${snapshotId}/intent-board`);
  }

  appendFactPackVersion(
    factPackId: number,
    selectedEvidenceIds: string[],
    status: 'draft' | 'approved',
    expectedVersion?: number,
  ): Promise<FactPack> {
    return this.request<FactPack>(`/v1/factpacks/${factPackId}/versions`, {
      method: 'POST',
      body: JSON.stringify({ selected_evidence_ids: selectedEvidenceIds, status, expected_version: expectedVersion }),
    });
  }

  getDraft(draftId: number): Promise<DraftDetail> {
    return this.request<DraftDetail>(`/v1/drafts/${draftId}`);
  }

  listDrafts(input: {
    query?: string;
    status?: DraftUserStatus;
    cursor?: string;
    limit?: number;
  } = {}): Promise<DraftListResponse> {
    const query = new URLSearchParams();
    if (input.query) query.set('query', input.query);
    if (input.status) query.set('status', input.status);
    if (input.cursor) query.set('cursor', input.cursor);
    if (input.limit) query.set('limit', String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : '';
    return this.request<DraftListResponse>(`/v1/drafts${suffix}`);
  }

  updateDraftStatus(
    draftId: number,
    status: DraftUserStatus,
  ): Promise<{ draft_id: number; user_status: DraftUserStatus }> {
    return this.request(`/v1/drafts/${draftId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }

  createPublishedContent(input: {
    draft_id?: number | null;
    keyword?: string;
    canonical_url: string;
    title: string;
    published_at: string;
    confirmed: boolean;
  }): Promise<PublishedContent> {
    return this.request<PublishedContent>('/v1/published-contents', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  listPublishedContents(query = '', includeArchived = false): Promise<PublishedContentListResponse> {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    if (includeArchived) params.set('include_archived', 'true');
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.request<PublishedContentListResponse>(`/v1/published-contents${suffix}`);
  }

  updatePublishedContent(
    contentId: number,
    input: { title?: string; published_at?: string; archived?: boolean },
  ): Promise<PublishedContent> {
    return this.request<PublishedContent>(`/v1/published-contents/${contentId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  addDraftVersion(
    draftId: number,
    input: { title: string; body: string; note?: string; expected_version?: number },
  ): Promise<{ draft_id: number; version: number }> {
    return this.request(`/v1/drafts/${draftId}/versions`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  startPublishJob(
    draftId: number,
    input: {
      blog_id: string;
      tags: string[];
      expected_version?: number;
      transport?: 'dedicated_chrome_cdp' | 'current_chrome_extension';
      target_worker_id?: string;
    },
  ): Promise<PublishJob> {
    return this.request<PublishJob>(`/v1/drafts/${draftId}/publish-jobs`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getPublishJob(jobId: number): Promise<PublishJob> {
    return this.request<PublishJob>(`/v1/publish-jobs/${jobId}`);
  }

  latestPublishJob(draftId: number): Promise<PublishJob | null> {
    return this.request<PublishJob | null>(`/v1/drafts/${draftId}/publish-jobs/latest`);
  }

  addDraftAsset(
    draftId: number,
    input: {
      draft_version: number;
      filename: string;
      mime_type: 'image/png' | 'image/jpeg' | 'image/webp';
      data_base64: string;
      position: number;
      anchor_after: number;
      rights_status: 'approved';
    },
  ): Promise<DraftAsset> {
    return this.request<DraftAsset>(`/v1/drafts/${draftId}/assets`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  listDraftAssets(draftId: number, draftVersion: number): Promise<DraftAsset[]> {
    return this.request<DraftAsset[]>(`/v1/drafts/${draftId}/assets?draft_version=${draftVersion}`);
  }

  generateDraftGuideAssets(draftId: number, draftVersion: number): Promise<DraftAsset[]> {
    return this.request<DraftAsset[]>(`/v1/drafts/${draftId}/assets/generate-guide`, {
      method: 'POST',
      body: JSON.stringify({ draft_version: draftVersion, count: 3 }),
    });
  }

  deleteDraftAsset(draftId: number, assetId: number): Promise<void> {
    return this.request<void>(`/v1/drafts/${draftId}/assets/${assetId}`, { method: 'DELETE' });
  }

  draftAssetContent(draftId: number, assetId: number, signal?: AbortSignal): Promise<Blob> {
    return this.request<Blob>(`/v1/drafts/${draftId}/assets/${assetId}/content`, { signal }, true);
  }

  getPublishCommand(jobId: number, leaseOwner?: string): Promise<PublishCommand> {
    const query = leaseOwner ? `?lease_owner=${encodeURIComponent(leaseOwner)}` : '';
    return this.request<PublishCommand>(`/v1/publish-jobs/${jobId}/command${query}`);
  }

  nextPublishCommand(leaseOwner: string, blogIds: string[] = []): Promise<PublishCommand | null> {
    const query = new URLSearchParams({ lease_owner: leaseOwner });
    for (const blogId of blogIds) query.append('blog_id', blogId);
    return this.request<PublishCommand | null>(`/v1/publisher/next-command?${query.toString()}`);
  }

  recordPublishEvent(jobId: number, input: {
    attempt_id: string;
    lease_owner: string;
    stage: string;
    status: 'running' | 'passed' | 'failed';
    error_code?: string | null;
    detail?: string;
    verification?: Record<string, unknown> | null;
  }): Promise<PublishJob> {
    return this.request<PublishJob>(`/v1/publish-jobs/${jobId}/events`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  retryPublishJob(jobId: number): Promise<PublishJob> {
    return this.request<PublishJob>(`/v1/publish-jobs/${jobId}/retry`, { method: 'POST' });
  }

  publisherReadiness(workerId?: string): Promise<PublisherReadiness> {
    const query = workerId ? `?target_worker_id=${encodeURIComponent(workerId)}` : '';
    return this.request<PublisherReadiness>(`/v1/publisher/readiness${query}`);
  }

  publisherHeartbeat(input: { extension_id: string; version: string; active_url?: string; protocol_version?: number; build_id?: string }): Promise<PublisherReadiness> {
    return this.request<PublisherReadiness>('/v1/publisher/extension-heartbeat', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
}

function performanceScope(importId?: number, channelId?: number): string {
  const query = new URLSearchParams();
  if (importId) query.set('import_id', String(importId));
  if (channelId) query.set('channel_id', String(channelId));
  return query.size ? `?${query}` : '';
}
