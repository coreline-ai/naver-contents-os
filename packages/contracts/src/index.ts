/** API contracts shared between the extension and the Local Core.
 * Mirrors the Pydantic response models in apps/local-core. */

export type DataSource = 'SEARCH_AD' | 'NAVER_API_HUB' | 'BROWSER_DOM' | 'DERIVED';

export interface HealthResponse {
  status: 'ok';
  version: string;
  config: Record<string, string>;
}
