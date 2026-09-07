import { useEffect, useLayoutEffect, useState } from 'react';

export const THEME_KEY = 'ncos-web-theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;
export function parseTheme(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function readTheme(): ThemePreference {
  try { return parseTheme(localStorage.getItem(THEME_KEY)); } catch { return 'system'; }
}
export function systemTheme(): ResolvedTheme {
  try { return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'; } catch { return 'light'; }
}
export function resolveTheme(preference: ThemePreference, system: ResolvedTheme): ResolvedTheme {
  return preference === 'system' ? system : preference;
}

// Owned by App, not the settings route: navigating away must keep OS/tab sync.
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readTheme);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);
  const [saved, setSaved] = useState(true);
  const resolved = resolveTheme(preference, system);
  useLayoutEffect(() => { document.documentElement.dataset.theme = resolved; }, [resolved]);
  useEffect(() => {
    let media: MediaQueryList | undefined;
    const changed = (event: MediaQueryListEvent) => setSystem(event.matches ? 'dark' : 'light');
    try {
      media = window.matchMedia(DARK_QUERY);
      setSystem(media.matches ? 'dark' : 'light');
      media.addEventListener('change', changed);
    } catch { /* Unsupported media query API: light remains the safe default. */ }
    const sync = (event: StorageEvent) => {
      try { if (event.storageArea && event.storageArea !== localStorage) return; } catch { return; }
      if (event.key !== null && event.key !== THEME_KEY) return;
      setPreference(parseTheme(event.key === null ? null : event.newValue));
      setSaved(true);
    };
    window.addEventListener('storage', sync);
    return () => {
      media?.removeEventListener?.('change', changed);
      window.removeEventListener('storage', sync);
    };
  }, []);
  function select(value: ThemePreference) {
    const next = parseTheme(value);
    setPreference(next);
    try { localStorage.setItem(THEME_KEY, next); setSaved(true); }
    catch { setSaved(false); }
  }
  return { preference, resolved, saved, select };
}
export type ThemeState = ReturnType<typeof useTheme>;
