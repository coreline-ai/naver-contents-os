/** API contracts shared between the extension and the Local Core.
 * Mirrors the Pydantic response models in apps/local-core. */

export type DataSource = 'SEARCH_AD' | 'NAVER_API_HUB' | 'BROWSER_DOM' | 'DERIVED';

export interface HealthResponse {
  status: 'ok';
  version: string;
  config: Record<string, string>;
}

export interface KeywordMetric {
  source: DataSource;
  collected_at: string;
  from_cache?: boolean;
  raw_schema_version?: string;
  keyword: string;
  monthly_pc_searches: number | null;
  monthly_mobile_searches: number | null;
  volume_masked: boolean;
  ad_competition: string | null;
  ad_click_metrics: Record<string, unknown>;
}

export interface SearchItem {
  title: string;
  link: string;
  description: string;
  author: string;
  posted_at: string;
}

export interface SearchLandscape {
  source: DataSource;
  collected_at: string;
  from_cache?: boolean;
  raw_schema_version?: string;
  keyword: string;
  blog_total: number | null;
  cafe_total: number | null;
  kin_total: number | null;
  web_total: number | null;
  news_total: number | null;
  top_results: SearchItem[];
  kin_items: SearchItem[];
  cafe_items: SearchItem[];
  news_items: SearchItem[];
}

export interface TrendPoint {
  period: string;
  ratio: number;
}

export interface TrendSeries {
  source: DataSource;
  collected_at: string;
  from_cache?: boolean;
  raw_schema_version?: string;
  keyword_group: string;
  keywords: string[];
  time_unit: string;
  points: TrendPoint[];
}

export interface ScoreContribution {
  component: string;
  weight: number;
  normalized: number | null;
  points: number | null;
  status: 'ok' | 'missing';
  raw: string;
}

export interface OpportunityScore {
  value: number | null;
  score_version: string;
  coverage_weight: number;
  available_component_count: number;
  total_component_count: number;
  confidence: 'unavailable' | 'low' | 'medium' | 'high';
  contributions: ScoreContribution[];
  missing: string[];
}

export interface QuestionCandidate {
  text: string;
  kind: 'question' | 'review';
  channel: 'kin' | 'cafe';
}

export interface KeywordCluster {
  label: string;
  keywords: string[];
  total_volume: number;
}

export interface PlanItem {
  order: number;
  title: string;
  blog_type: string;
  target_keyword: string;
  angle: string;
  reason: string;
  generation_status: 'ready' | 'structure_only';
  series_prev: number | null;
  series_next: number | null;
}

export interface SerpResult {
  rank: number;
  result_type: string;
  title: string;
  url: string;
  blog_id: string;
  description: string;
  posted_at: string;
  is_ad: boolean;
}

export interface SerpObservation {
  source: DataSource;
  collected_at: string;
  query: string;
  results: SerpResult[];
}

export type DraftGenerationMode = 'skeleton' | 'llm';

export interface DraftCreateRequest {
  keyword: string;
  snapshot_id: number | null;
  plan_item: PlanItem;
  questions: string[];
  generation_mode: DraftGenerationMode;
}

export interface DraftCreateResponse {
  draft_id: number;
  version: number;
  title: string;
  body: string;
  source_snapshot_id: number | null;
  provider: string;
  model: string;
  prompt_version: string;
}

export interface DraftVersion {
  version: number;
  title: string;
  body: string;
  note: string;
}

export interface DraftDetail {
  draft_id: number;
  blog_type: string;
  title: string;
  source_snapshot_id: number | null;
  plan: PlanItem;
  provider: string;
  model: string;
  prompt_version: string;
  versions: DraftVersion[];
}

export interface PublishJobHistoryEntry {
  stage: string;
  status: string;
  at: string;
  error_code?: string | null;
  detail?: string;
  evidence?: Record<string, unknown>;
}

export interface PublishJob {
  job_id: number;
  draft_id: number;
  status: string;
  stage: string;
  error_code: string | null;
  detail: string;
  history: PublishJobHistoryEntry[];
}

export interface AnalyzeResponse {
  keyword: string;
  snapshot_id: number;
  collected_at: string;
  data_status: Record<string, string>;
  metric: KeywordMetric | null;
  related_keywords: KeywordMetric[];
  landscape: SearchLandscape | null;
  trend: TrendSeries | null;
  serp: SerpObservation | null;
  score: OpportunityScore;
  questions: QuestionCandidate[];
  clusters: KeywordCluster[];
  plan: PlanItem[];
}

export interface BlogInspection {
  title: string;
  posted_at: string;
  body_chars: number;
  image_count: number;
  video_count: number;
  link_count: number;
  likes: number | null;
  comments: number | null;
}
