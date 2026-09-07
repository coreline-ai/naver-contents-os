import bootstrap from '../public/theme-init.js?raw';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const css = readFileSync(resolve('src/theme.css'), 'utf8');
import html from '../index.html?raw';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DARK_QUERY, THEME_KEY, parseTheme, resolveTheme, useTheme, type ThemeState } from '../src/theme';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, state: ThemeState;
let media: EventTarget & { matches: boolean; media: string };
function Probe() {
  state = useTheme();
  const [text, setText] = useState('未保存・미저장 원고');
  return <textarea value={text} onChange={e => setText(e.target.value)}/>;
}
async function render() { await act(async () => root.render(<Probe/>)); }
async function system(dark: boolean) {
  media.matches = dark;
  await act(async () => media.dispatchEvent(Object.assign(new Event('change'), { matches: dark })));
}
async function storage(key: string | null, newValue: string | null, storageArea?: Storage) {
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea })));
}
beforeEach(() => {
  localStorage.clear(); delete document.documentElement.dataset.theme;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  media = Object.assign(new EventTarget(), { matches: false, media: DARK_QUERY });
  vi.stubGlobal('matchMedia', vi.fn(() => media));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); delete document.documentElement.dataset.theme; });
it.each([null, '', 'broken', 'DARK', '{"dark":true}', 'system'])('invalid or default value %s uses system', value => {
  expect(parseTheme(value)).toBe('system'); expect(resolveTheme(parseTheme(value), 'dark')).toBe('dark');
});
it.each(['light', 'dark'] as const)('explicit %s persists and survives remount without touching other preferences', async value => {
  localStorage.setItem('ncos-web-preferences', '{"blogId":"fixture"}');
  await render(); await act(async () => state.select(value));
  expect(document.documentElement.dataset.theme).toBe(value); expect(localStorage.getItem(THEME_KEY)).toBe(value);
  expect(host.querySelector('textarea')!.value).toBe('未保存・미저장 원고');
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect(state.preference).toBe(value); expect(localStorage.getItem('ncos-web-preferences')).toBe('{"blogId":"fixture"}');
});
it('follows live OS changes only in system mode and resumes with latest OS value', async () => {
  await render(); expect(state.preference).toBe('system');
  await system(true); expect(state.resolved).toBe('dark');
  await act(async () => state.select('light')); await system(false); await system(true); expect(state.resolved).toBe('light');
  await act(async () => state.select('system')); expect(state.resolved).toBe('dark');
  await system(false); expect(state.resolved).toBe('light');
});
it('syncs same-origin tabs, deletion and clear but ignores unrelated keys and session storage', async () => {
  await render(); await storage(THEME_KEY, 'dark', localStorage); expect(state.preference).toBe('dark');
  await storage('other', 'light', localStorage); await storage(THEME_KEY, 'light', sessionStorage); expect(state.preference).toBe('dark');
  await storage(THEME_KEY, null, localStorage); expect(state.preference).toBe('system');
  await storage(THEME_KEY, 'dark', localStorage); await storage(null, null, localStorage); expect(state.preference).toBe('system');
});
it('blocked storage still applies locally and reports persistence failure, with retry recovery', async () => {
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  await render(); await act(async () => state.select('dark')); expect(state.resolved).toBe('dark'); expect(state.saved).toBe(false);
  set.mockRestore(); await act(async () => state.select('dark')); expect(state.saved).toBe(true);
});
it('works without matchMedia and cleans up change/storage listeners on unmount', async () => {
  const removeMedia = vi.spyOn(media, 'removeEventListener'), removeWindow = vi.spyOn(window, 'removeEventListener');
  await render(); await act(async () => root.unmount()); root = createRoot(host);
  expect(removeMedia).toHaveBeenCalledWith('change', expect.any(Function)); expect(removeWindow).toHaveBeenCalledWith('storage', expect.any(Function));
  vi.stubGlobal('matchMedia', undefined); await render(); expect(state.resolved).toBe('light');
  await act(async () => state.select('dark')); expect(state.resolved).toBe('dark');
});
it.each(['light', 'dark', 'system', 'invalid', null])('blocking bootstrap and React agree for saved %s with dark OS', async saved => {
  if (saved) localStorage.setItem(THEME_KEY, saved); media.matches = true;
  // Execute the exact shipped classic script, without changing production CSP.
  new Function(bootstrap)(); const initial = document.documentElement.dataset.theme;
  await render(); expect(initial).toBe(state.resolved); expect(initial).toBe(saved === 'light' ? 'light' : 'dark');
});
it('bootstrap works when storage and matchMedia throw, and is external before React', () => {
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); }); vi.stubGlobal('matchMedia', undefined);
  new Function(bootstrap)(); expect(document.documentElement.dataset.theme).toBe('light');
  expect(html.indexOf('src="/theme-init.js"')).toBeLessThan(html.indexOf('<body>'));
  expect(html).toContain('content="light dark"'); expect(html).not.toMatch(/<script[^>]*(?:defer|async)[^>]*theme-init/);
  expect(bootstrap).not.toMatch(/fetch\(|\.style\.|innerHTML|document\.write/);
});
function tokens(selector: string) {
  const start = css.indexOf(selector+' {'); const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+): (#[0-9a-f]{6});/g)].map(m => [m[1], m[2]]));
}
function luminance(hex: string) {
  const rgb = [1,3,5].map(i => parseInt(hex.slice(i, i+2),16)/255).map(v => v<=.04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
  return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
}
function contrast(a: string,b: string) { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
it.each([':root', ':root[data-theme="dark"]'])('%s semantic text, statuses and controls meet contrast targets', selector => {
  const t = tokens(selector); expect(Object.keys(t).length).toBeGreaterThan(25);
  const textPairs = ['canvas','surface','surface-subtle','editor','empty-editor','table-header','surface-hover','selected'].flatMap(bg => [['text',bg],['muted',bg]]);
  textPairs.push(['green','surface'],['on-accent','green'],['on-accent','accent-hover'],['selected-text','selected'],['error-text','error-bg'],['warning-text','surface'],['info-text','info-bg'],['selection-text','selection-bg']);
  for (const [fg,bg] of textPairs) expect(contrast(t[fg],t[bg]),`${selector} ${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
  for (const [fg,bg] of [['control-border','surface'],['control-border','editor'],['focus','surface'],['chart-pc','surface'],['chart-mobile','surface'],['graph-edge','graph-bg'],['graph-ok','graph-bg'],['graph-pending','graph-bg'],['graph-selected','graph-bg']]) expect(contrast(t[fg],t[bg]),`${selector} ${fg}/${bg}`).toBeGreaterThanOrEqual(3);
  expect(contrast(t.text,t['graph-bg'])).toBeGreaterThanOrEqual(4.5);
});
it('system fallback uses exactly the same dark tokens', () => {
  expect(tokens(':root:not([data-theme])')).toEqual(tokens(':root[data-theme="dark"]'));
});
it('web component styles use semantic tokens, native color scheme and never invert photos', () => {
  const styles = readFileSync(resolve('src/style.css'), 'utf8');
  expect(styles).toContain('@import "./theme.css"');
  expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|(?:color|background):\s*(?:white|black)\b/i);
  expect(styles).not.toMatch(/filter\s*:|mix-blend-mode\s*:/);
  expect(styles).toContain('input::placeholder'); expect(styles).toContain(':focus-visible');
});
