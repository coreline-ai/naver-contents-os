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
  fact_pack_id?: number | null;
  fact_pack_version?: number | null;
}

export interface DraftCreateResponse {
  draft_id: number;
  version: number;
  title: string;
  body: string;
  source_snapshot_id: number | null;
  fact_pack_id: number | null;
  fact_pack_version: number | null;
  provider: string;
  model: string;
  prompt_version: string;
}

export type BlogComposeStyle = 'auto' | 'informational' | 'review' | 'product';

export interface LLMStatusResponse {
  ready: boolean;
  provider: string;
  model: string;
  message: string;
  action: string;
  engine?: string;
  auth?: 'chatgpt' | 'api_key' | 'authenticated' | 'configured' | 'not_required' | 'missing' | 'unknown' | string;
  quality_tier?: 'high' | 'local' | 'external' | 'none' | 'unknown' | string;
}

export interface BlogComposeRequest {
  keyword: string;
  style: BlogComposeStyle;
  user_notes: string;
  target_chars: number;
  allow_sensitive_unknown: boolean;
  force_refresh?: boolean;
  source_draft_id?: number | null;
  source_draft_mode?: 'revision' | 'followup';
}

export interface ArticleQuality {
  passed: boolean;
  score: number;
  char_count: number;
  target_chars: number;
  paragraph_count: number;
  keyword_count: number;
  issues: string[];
  checks: Record<string, boolean>;
  repair_attempted: boolean;
}

export interface BlogComposeResponse {
  keyword: string;
  snapshot_id: number;
  draft: DraftCreateResponse;
  quality: ArticleQuality;
  suggested_tags: string[];
  analysis_summary: {
    monthly_searches: number | null;
    related_keyword_count: number;
    question_count: number;
    data_status: Record<string, string>;
  };
  fact_pack_id: number | null;
  fact_pack_version: number | null;
  preflight: PreflightResponse;
}

export interface DraftVersion {
  version: number;
  title: string;
  body: string;
  note: string;
  created_at: string | null;
}

export type DraftUserStatus = 'editing' | 'review_ready' | 'archived';
export type DraftDeliveryStatus = 'none' | 'pending' | 'draft_saved' | 'failed';

export interface DraftDetail {
  draft_id: number;
  keyword: string;
  blog_type: string;
  title: string;
  source_snapshot_id: number | null;
  user_status: DraftUserStatus;
  fact_pack_id: number | null;
  fact_pack_version: number | null;
  created_at: string | null;
  plan: PlanItem;
  provider: string;
  model: string;
  prompt_version: string;
  versions: DraftVersion[];
}

export interface DraftSummary {
  draft_id: number;
  keyword: string;
  title: string;
  blog_type: string;
  latest_version: number;
  latest_version_at: string;
  user_status: DraftUserStatus;
  latest_job_status: DraftDeliveryStatus;
  latest_job_id: number | null;
  latest_job_stage: string | null;
  latest_job_error: string | null;
  source_snapshot_id: number | null;
}

export interface DraftListResponse {
  items: DraftSummary[];
  next_cursor: string | null;
}

export type ContentState = 'missing' | 'draft_only' | 'published' | 'stale' | 'archived';

export interface PublishedContent {
  id: number;
  draft_id: number | null;
  keyword: string;
  title: string;
  canonical_url: string;
  published_at: string;
  verified_at: string;
  archived_at: string | null;
  state: 'published' | 'stale' | 'archived';
  draft_count: number;
}

export interface PublishedContentListResponse {
  items: PublishedContent[];
}

export type FactPackStatus = 'draft' | 'approved';
export type EvidenceFreshness = 'fresh' | 'stale' | 'unknown';

export interface FactPackEvidence {
  id: string;
  kind: string;
  label: string;
  value: unknown;
  source_type: string;
  source_url: string | null;
  source_id: string;
  collected_at: string | null;
  from_cache: boolean;
  freshness: EvidenceFreshness;
  selected: boolean;
}

export interface FactPackVersion {
  version: number;
  status: FactPackStatus;
  evidence: FactPackEvidence[];
  warnings: string[];
  created_at: string | null;
}

export interface FactPack {
  fact_pack_id: number;
  snapshot_id: number;
  draft_id: number | null;
  keyword: string;
  created_at: string | null;
  latest_version: number;
  latest_status: FactPackStatus;
  versions: FactPackVersion[];
}

export type SearchIntent = 'informational' | 'howto' | 'eligibility' | 'troubleshooting' | 'comparison_review' | 'commercial' | 'local_visit' | 'other';

export interface IntentBoardItem {
  keyword: string;
  intent: SearchIntent;
  intent_version: 'intent-v1';
  matched_markers: string[];
  confidence: 'low' | 'medium' | 'high';
  metric: {
    pc: number | null;
    mobile: number | null;
    total: number | null;
    masked: boolean;
    source: string;
    collected_at: string | null;
    from_cache: boolean;
  } | null;
  trend: {
    latest_period: string | null;
    latest_ratio: number;
    relative_change: number | null;
    source: string;
    collected_at: string | null;
    from_cache: boolean;
    note: string;
  } | null;
  organic: {
    blog_total: number | null;
    cafe_total: number | null;
    kin_total: number | null;
    news_total: number | null;
    source: string;
    collected_at: string | null;
    note: string;
  } | null;
  commercial: {
    ad_competition: string | null;
    source: string;
    note: string;
  };
  content: {
    state: ContentState;
    draft_count: number;
    last_draft_at: string | null;
    published_content_id: number | null;
    published_url: string | null;
    published_at: string | null;
  };
}

export interface IntentBoardResponse {
  snapshot_id: number;
  keyword: string;
  intent_version: 'intent-v1';
  collected_at: string | null;
  items: IntentBoardItem[];
}

export type TodayWorkAction = 'inspect_error' | 'resume_draft' | 'register_publication' | 'refresh_data' | 'open_analysis' | 'open_performance';

export interface TodayWorkItem {
  id: string;
  priority: number;
  source_type: string;
  source_id: number;
  keyword: string;
  title: string;
  reason: string;
  action: TodayWorkAction;
  stale: boolean;
  draft_id: number | null;
  publish_job_id: number | null;
  published_content_id: number | null;
  published_url: string | null;
  calculated_at: string;
}

export interface TodayWorkResponse {
  items: TodayWorkItem[];
  calculated_at: string;
  limit: number;
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
  transport: 'dedicated_chrome_cdp' | 'current_chrome_extension';
  draft_version: number;
  asset_manifest_version: number;
  verification: Record<string, unknown>;
}

export interface DraftAsset {
  asset_id: number;
  draft_id: number;
  draft_version: number;
  filename: string;
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp';
  byte_size: number;
  sha256: string;
  position: number;
  anchor_after: number;
  rights_status: 'approved';
  created_at: string | null;
}

export interface PublishCommandAsset extends DraftAsset {
  download_url: string;
  native_path: string;
}

export interface PublishCommand {
  job_id: number;
  draft_id: number;
  draft_version: number;
  blog_id: string;
  title: string;
  body: string;
  title_hash: string;
  body_hash: string;
  body_chars: number;
  tags: string[];
  assets: PublishCommandAsset[];
}

export interface PublisherReadiness {
  current_chrome_extension: {
    ready: boolean;
    last_seen: string | null;
    extension_id?: string;
    version?: string;
    active_url?: string;
  };
  dedicated_chrome_cdp: { ready: boolean; url: string };
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

export type ProviderState = 'configured' | 'unsupported' | 'empty' | 'partial' | 'ok' | 'unconfigured';

export interface QuotaWindow {
  period: string;
  used: number;
  limit: number;
}

export interface QuotaStatus {
  provider: string;
  monthly: QuotaWindow;
  daily: QuotaWindow | null;
  ratio: number;
  warning: boolean;
  blocked: boolean;
}

export interface CapabilityProvider {
  status: ProviderState;
  features: string[];
  quota: QuotaStatus | null;
}

export interface CapabilitiesResponse {
  collected_at: string;
  providers: Record<string, CapabilityProvider>;
  searchad_access: 'read_only';
}

export interface PreflightResponse {
  keyword: string;
  correction: string | null;
  sensitive: boolean | null;
  data_status: Record<string, string>;
  from_cache?: boolean;
  collected_at: string;
}

export type SuggestionSource = 'recent' | 'searchad';

export interface KeywordSuggestion {
  keyword: string;
  source: SuggestionSource;
  monthly_searches: number | null;
  volume_masked: boolean;
  competition: string | null;
  from_cache: boolean;
  collected_at: string;
}

export interface KeywordSuggestionResponse {
  query: string;
  status: string;
  data_status: Record<string, string>;
  suggestions: KeywordSuggestion[];
  collected_at: string;
}

export type RisingMode = 'general' | 'local' | 'shopping' | 'news';
export type RisingDirection = 'new' | 'rising' | 'steady' | 'falling' | 'insufficient';

export interface FreshnessComponents {
  trend_score: number | null;
  news_volume_score: number | null;
  news_recency_score: number | null;
  news_score: number | null;
  trend_weight: number;
  news_weight: number;
  reason: string | null;
}

export interface RisingCandidate {
  keyword: string;
  direction: RisingDirection;
  recent7_avg: number | null;
  previous7_avg: number | null;
  growth_rate: number | null;
  trend_score: number | null;
  news_7d_sample_count: number | null;
  sample_capped: boolean;
  latest_news_at: string | null;
  news_score: number | null;
  freshness_score: number | null;
  confidence: 'unavailable' | 'low' | 'medium' | 'high';
  coverage: { observed_days: number; recent_days: number; previous_days: number };
  monthly_searches: number | null;
  volume_masked: boolean;
  components: FreshnessComponents;
  data_status: Record<string, string>;
  source_meta: Record<string, unknown>;
}

export interface RisingRequest {
  seed?: string;
  mode: RisingMode;
  region?: string;
  category?: string;
  candidate_limit?: number;
  force_refresh?: boolean;
}

export interface RisingResponse {
  run_id: number | null;
  seed: string;
  effective_seed: string;
  mode: RisingMode;
  region: string;
  category: string;
  status: string;
  comparison_window: { start_date: string; end_date: string; recent_start: string };
  estimated_calls: number;
  actual_calls: number;
  score_version: 'freshness-v1';
  collected_at: string;
  data_status: Record<string, string>;
  candidates: RisingCandidate[];
  disclaimer: string;
}

export interface LatestRisingResponse {
  run: RisingResponse | null;
}

export interface ResearchGraphNode {
  id: string;
  keyword: string;
  depth: number;
  volume: number | null;
  pc_volume: number | null;
  mobile_volume: number | null;
  volume_masked: boolean;
  competition: string | null;
  cluster: string;
  blog_total: number | null;
  trend_delta: number | null;
  enrichment_status: string;
}

export interface ResearchGraphEdge {
  source: string;
  target: string;
}

export interface ResearchGraphResponse {
  keyword: string;
  snapshot_id?: number | null;
  status: string;
  nodes: ResearchGraphNode[];
  edges: ResearchGraphEdge[];
  clusters?: KeywordCluster[];
  call_budget: { actual: number; maximum: number };
  caps?: Record<string, number>;
  collected_at: string;
}

export interface CommercialRow {
  keyword: string;
  device: string;
  average_position_bid: number | null;
  minimum_exposure_bid: number | null;
  median_bid: number | null;
  estimated_impressions: number | null;
  estimated_clicks: number | null;
  commercial_score: number | null;
}

export interface CommercialResponse {
  status: string;
  data_status?: Record<string, string>;
  score_version: string;
  score_note?: string;
  rows: CommercialRow[];
  collected_at?: string;
}

export interface SegmentSeries {
  label: string;
  points: TrendPoint[];
  collected_at: string;
  from_cache: boolean;
}

export interface AudienceResponse {
  keyword: string;
  status: string;
  data_status?: Record<string, string>;
  segments: Record<string, SegmentSeries[]>;
  normalization?: 'independent';
  warning?: string;
  collected_at?: string;
}

export interface SpecializedResponse {
  mode: 'general' | 'local' | 'shopping' | 'image';
  keyword: string;
  status: string;
  items?: Array<Record<string, unknown>>;
  series?: Array<Record<string, unknown>>;
  total?: number | null;
  category?: string;
  plan_candidates?: string[];
  rights_notice?: string;
  warning?: string;
  collected_at?: string;
}

export interface WatchSnapshot {
  comparison_key: string;
  collected_at: string;
  monthly_searches: number | null;
  volume_masked: boolean;
  latest_ratio: number | null;
  latest_period: string | null;
  data_status: Record<string, string>;
}

export interface WatchlistItem {
  id: number;
  keyword: string;
  status: string;
  comparison_key: string;
  last_snapshot: WatchSnapshot | null;
  previous_snapshot: WatchSnapshot | null;
  delta: number | null;
  direction: '상승' | '보합' | '하락' | '비교 불가';
  stale: boolean;
  created_at: string;
  updated_at: string;
}

export interface WatchlistResponse {
  items: WatchlistItem[];
  cap: number;
}

export interface AdPerformanceRow {
  id: string;
  keyword: string;
  campaign_id: string | null;
  adgroup_id: string | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  cpc: number | null;
  cost: number | null;
  conversions: number | null;
  conversion_value: number | null;
  roas: number | null;
  content: {
    state: ContentState;
    draft_count: number;
    last_draft_at: string | null;
    published_content_id: number | null;
    published_url: string | null;
    published_at: string | null;
  };
}

export interface AdPerformanceResponse {
  status: string;
  read_only: true;
  period?: { since: string; until: string };
  data_status?: Record<string, string>;
  campaign_count?: number;
  adgroup_count?: number;
  rows: AdPerformanceRow[];
  recommendations: Array<{
    keyword: string;
    reason: string;
    content_state: string;
    clicks: number | null;
    conversions: number | null;
  }>;
  collected_at?: string;
}

export type PerformanceSource = 'creator_advisor' | 'biz_advisor' | 'search_advisor';
export type PerformanceDataKind = 'content_performance' | 'query_performance' | 'commerce_attribution' | 'site_performance';
export type PerformanceDataState = 'pending' | 'partial' | 'observed_zero' | 'unavailable' | 'ready';
export type PerformanceGrain = 'daily' | 'weekly' | 'monthly';

export interface PerformanceChannel {
  id: number;
  source: PerformanceSource;
  channel_kind: 'blog' | 'smartstore' | 'website';
  display_name: string;
  site_url: string | null;
  ownership_confirmed: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface PerformanceChannelListResponse {
  items: PerformanceChannel[];
  features: { creator: boolean; commerce: boolean; website: boolean };
}

export interface ContentPerformanceImportRow {
  canonical_url?: string | null;
  published_content_id?: number | null;
  title?: string;
  views?: number | null;
  impressions?: number | null;
  inflows?: number | null;
  ctr?: number | null;
  average_rank?: number | null;
  likes?: number | null;
  comments?: number | null;
  data_state?: PerformanceDataState;
}

export interface QueryPerformanceImportRow {
  query: string;
  canonical_url?: string | null;
  published_content_id?: number | null;
  impressions?: number | null;
  inflows?: number | null;
  ctr?: number | null;
  average_rank?: number | null;
  data_state?: PerformanceDataState;
}

export interface CommerceAttributionImportRow {
  tracking_id: string;
  destination_url?: string | null;
  published_content_id?: number | null;
  inflows?: number | null;
  product_views?: number | null;
  orders?: number | null;
  conversion_rate?: number | null;
  attributed_revenue?: number | null;
  data_state?: PerformanceDataState;
}

export interface SitePerformanceImportRow {
  page_url: string;
  collected_pages?: number | null;
  indexed_pages?: number | null;
  impressions?: number | null;
  clicks?: number | null;
  ctr?: number | null;
  data_state?: PerformanceDataState;
}

export type PerformanceImportRow =
  | ContentPerformanceImportRow
  | QueryPerformanceImportRow
  | CommerceAttributionImportRow
  | SitePerformanceImportRow;

export interface PerformanceImportRequest {
  channel_id: number;
  source: PerformanceSource;
  data_kind: PerformanceDataKind;
  period_start: string;
  period_end: string;
  grain: PerformanceGrain;
  rows: PerformanceImportRow[];
}

export interface PerformanceImportPreview {
  valid: true;
  channel: PerformanceChannel;
  source: PerformanceSource;
  data_kind: PerformanceDataKind;
  period: { start: string; end: string };
  grain: PerformanceGrain;
  row_count: number;
  warnings: string[];
  input_hash: string;
  rows: Array<Record<string, unknown>>;
}

export interface PerformanceImportRun {
  id: number;
  channel_id: number;
  source: PerformanceSource;
  data_kind: PerformanceDataKind;
  period: { start: string; end: string };
  grain: PerformanceGrain;
  status: 'ready' | 'partial';
  row_count: number;
  warning_count: number;
  warnings: string[];
  input_hash: string;
  collected_at: string;
  duplicate: boolean;
}

export interface PerformanceMetricSummary {
  channel_name?: string;
  aggregation_note?: string;
  source: PerformanceSource;
  channel_id: number;
  data_kind: PerformanceDataKind;
  period: { start: string; end: string };
  grain: PerformanceGrain;
  status: string;
  collected_at: string;
  metrics: Record<string, number | null>;
  previous_metrics: Record<string, number | null> | null;
  changes: Record<string, number | null>;
  row_count: number;
}

export interface PerformanceOverviewResponse {
  creator: PerformanceMetricSummary | null;
  commerce: PerformanceMetricSummary | null;
  website: PerformanceMetricSummary | null;
  sources_combined: false;
  note: string;
}

export interface ContentPerformanceItem {
  id: number;
  channel_id: number;
  published_content_id: number | null;
  canonical_url: string | null;
  title: string;
  keyword: string;
  period: { start: string; end: string };
  grain: PerformanceGrain;
  data_state: PerformanceDataState;
  metrics: {
    views: number | null;
    impressions: number | null;
    inflows: number | null;
    ctr: number | null;
    average_rank: number | null;
    likes: number | null;
    comments: number | null;
  };
  previous_metrics: ContentPerformanceItem['metrics'] | null;
  market: {
    keyword: string;
    searchad: { monthly_searches: number | null; source: 'SEARCH_AD'; collected_at: string | null } | null;
    trend: { latest_ratio: number | null; source: 'NAVER_API_HUB'; collected_at: string | null; note: string } | null;
    serp: {
      sample_count: number;
      blog_count: number;
      ad_count: number;
      median_observed_rank: number | null;
      source: 'BROWSER_DOM';
      collected_at: string;
      note: string;
    } | null;
  };
  mapped: boolean;
}

export interface QueryPerformanceItem {
  id: number;
  channel_id: number;
  published_content_id: number | null;
  query: string;
  canonical_url: string | null;
  period: { start: string; end: string };
  grain: PerformanceGrain;
  data_state: PerformanceDataState;
  metrics: { impressions: number | null; inflows: number | null; ctr: number | null; average_rank: number | null };
}

export type PerformanceAction = 'improve_title' | 'refresh_body' | 'create_followup';

export interface PerformanceRecommendation {
  published_keyword?: string | null;
  id: number;
  channel_id: number;
  published_content_id: number | null;
  draft_id: number | null;
  published_title: string | null;
  published_url: string | null;
  keyword: string;
  rule_code: string;
  action: PerformanceAction;
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  calculation_version: string;
  period: { start: string; end: string };
  evidence: Record<string, unknown>;
  status: 'open' | 'dismissed' | 'done';
  created_at: string;
}

export interface TrackingLinkResponse {
  id: number;
  url: string;
  tracking_id: string;
  published_content_id: number | null;
  parameters: Record<string, string | null>;
  attribution_note: string;
}
