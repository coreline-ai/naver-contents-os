/** Local Core HTTP client. The token comes from extension storage — API secrets
 * never live in the extension (docs/11 Secret boundary). */

import type { AnalyzeResponse, HealthResponse, SerpObservation } from '@ncos/contracts';

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
      throw new CoreError(response.status, code, body?.error?.message ?? 'request failed');
    }
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
}
