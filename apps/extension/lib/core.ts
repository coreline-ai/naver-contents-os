/** Local Core HTTP client. The token comes from extension storage — API secrets
 * never live in the extension (docs/11 Secret boundary). */

import type {
  AnalyzeResponse,
  AdPerformanceResponse,
  AudienceResponse,
  CapabilitiesResponse,
  CommercialResponse,
  DraftCreateRequest,
  DraftCreateResponse,
  DraftDetail,
  HealthResponse,
  PublishJob,
  PreflightResponse,
  ResearchGraphResponse,
  SerpObservation,
  SpecializedResponse,
  WatchlistItem,
  WatchlistResponse,
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

export class CoreClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'X-Local-Token': this.token,
          ...(init?.headers ?? {}),
        },
      });
    } catch {
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
    return (await response.json()) as T;
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health');
  }

  handshake(): Promise<{ status: string }> {
    return this.request<{ status: string }>('/v1/handshake');
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

  createDraft(input: DraftCreateRequest): Promise<DraftCreateResponse> {
    return this.request<DraftCreateResponse>('/v1/drafts', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getDraft(draftId: number): Promise<DraftDetail> {
    return this.request<DraftDetail>(`/v1/drafts/${draftId}`);
  }

  addDraftVersion(
    draftId: number,
    input: { title: string; body: string; note?: string },
  ): Promise<{ draft_id: number; version: number }> {
    return this.request(`/v1/drafts/${draftId}/versions`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  startPublishJob(
    draftId: number,
    input: { blog_id: string; tags: string[] },
  ): Promise<PublishJob> {
    return this.request<PublishJob>(`/v1/drafts/${draftId}/publish-jobs`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getPublishJob(jobId: number): Promise<PublishJob> {
    return this.request<PublishJob>(`/v1/publish-jobs/${jobId}`);
  }
}
