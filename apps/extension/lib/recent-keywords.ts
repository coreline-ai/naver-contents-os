import type { KeywordSuggestion } from '@ncos/contracts';
import { browser } from 'wxt/browser';

export const RECENT_KEYWORDS_KEY = 'ncos-recent-keywords';
const RECENT_CAP = 30;

function key(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko');
}

export async function loadRecentKeywords(): Promise<string[]> {
  const stored = await browser.storage.local.get(RECENT_KEYWORDS_KEY);
  const values = stored[RECENT_KEYWORDS_KEY];
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === 'string' && !!value.trim()).slice(0, RECENT_CAP);
}

export async function rememberRecentKeyword(keyword: string): Promise<string[]> {
  const normalized = keyword.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!normalized) return loadRecentKeywords();
  const current = await loadRecentKeywords();
  const normalizedKey = key(normalized);
  const next = [normalized, ...current.filter((value) => key(value) !== normalizedKey)].slice(0, RECENT_CAP);
  await browser.storage.local.set({ [RECENT_KEYWORDS_KEY]: next });
  return next;
}

export function recentSuggestions(query: string, values: string[], limit = 8): KeywordSuggestion[] {
  const normalized = key(query);
  if (!normalized) return [];
  return values
    .map((value, index) => ({ value, index, normalized: key(value) }))
    .filter((row) => row.normalized.includes(normalized) && row.normalized !== normalized)
    .sort((a, b) => {
      const aPrefix = a.normalized.startsWith(normalized) ? 0 : 1;
      const bPrefix = b.normalized.startsWith(normalized) ? 0 : 1;
      return aPrefix - bPrefix || a.index - b.index;
    })
    .slice(0, limit)
    .map((row) => ({
      keyword: row.value,
      source: 'recent',
      monthly_searches: null,
      volume_masked: false,
      competition: null,
      from_cache: true,
      collected_at: new Date().toISOString(),
    }));
}

export function mergeSuggestions(
  local: KeywordSuggestion[],
  provider: KeywordSuggestion[],
  limit = 8,
): KeywordSuggestion[] {
  const seen = new Set<string>();
  return [...local, ...provider].filter((item) => {
    const normalized = key(item.keyword);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).slice(0, limit);
}

export function isSuggestionQuery(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  const hasCjk = [...compact].some((char) => char >= '\u2e80' && char <= '\ud7af');
  return compact.length >= (hasCjk ? 2 : 3);
}
