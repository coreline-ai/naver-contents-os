import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentPlanner } from '@ncos/workbench';
import type { CoreClient } from '@ncos/core-client';
import type { FactPack } from '@ncos/contracts';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const types = ['HOWTO', 'POLICY', 'REVIEW', 'COMPARISON', 'HOMEFEED', 'PRODUCT', 'NEWS', 'SERIES'];
const plans = Array.from({ length: 15 }, (_, index) => ({ order: index + 1, title: `테스트 플랜 ${index + 1}`, blog_type: types[index % 8], target_keyword: '여행', angle: '방향', reason: '근거', generation_status: index === 14 ? 'structure_only' : 'ready', series_prev: null, series_next: null }));
const pack: FactPack = { fact_pack_id: 3, snapshot_id: 11, draft_id: null, keyword: '여행', created_at: null, latest_version: 1, latest_status: 'draft', versions: [{ version: 1, status: 'draft', created_at: null, warnings: ['일부 수집 자료 없음'], evidence: [{ id: 'metric', kind: 'search_volume', label: '검색량', value: { pc: null, mobile: 0 }, source_type: 'SEARCH_AD', source_id: 'snapshot:11', source_url: null, collected_at: null, from_cache: true, freshness: 'unknown', selected: false }, { id: 'news', kind: 'search_result', label: '뉴스 제목', value: '사실 확정 아님', source_type: 'NAVER_API_HUB', source_id: 'snapshot:11:news', source_url: 'https://example.com', collected_at: null, from_cache: false, freshness: 'stale', selected: false }] }] };
let host: HTMLDivElement, root: Root, client: Record<string, ReturnType<typeof vi.fn>>, generate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); generate = vi.fn();
  client = { preflight: vi.fn().mockResolvedValue({ sensitive: false, correction: null }), analyze: vi.fn().mockResolvedValue({ keyword: '여행', snapshot_id: 11, collected_at: '2026-09-06T11:00:00Z', data_status: { hub: 'partial' }, questions: [{ text: '어떻게 가나요?' }], plan: plans }), createFactPack: vi.fn().mockResolvedValue(pack), getFactPack: vi.fn().mockResolvedValue(pack), appendFactPackVersion: vi.fn().mockImplementation(async (_id, selected: string[], status: 'draft' | 'approved') => ({ ...pack, latest_version: 2, latest_status: status, versions: [...pack.versions, { ...pack.versions[0], version: 2, status, evidence: pack.versions[0].evidence.map(e => ({ ...e, selected: selected.includes(e.id) })) }] })) };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
async function render(allowSensitiveUnknown = false) { await act(async () => root.render(<ContentPlanner client={client as unknown as CoreClient} disabled={false} aiReady allowSensitiveUnknown={allowSensitiveUnknown} onGenerate={generate} onDirtyChange={() => {}} onBusyChange={() => {}}/>)); }
function button(text: string) { return [...host.querySelectorAll('button')].find(b => b.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function input(value: string) { await act(async () => { const el = host.querySelector('#plan-keyword')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function analyze() { await render(); await input('여행'); await click('주제 분석'); }
async function selectEvidence() { await act(async () => (host.querySelector('input[type=checkbox]') as HTMLInputElement).click()); }
it('does not fetch on entry; retains all 15 plans and eight types; skeleton has no unapproved evidence', async () => {
  await render(); expect(client.analyze).not.toHaveBeenCalled(); expect(client.createFactPack).not.toHaveBeenCalled();
  await input('여행'); await click('주제 분석');
  expect(host.querySelectorAll('input[type=radio]')).toHaveLength(15);
  expect(host.textContent).toContain('홈피드'); expect(host.textContent).toContain('연재');
  await click('근거 자료 불러오기'); expect(button('승인 근거로 글 만들기').disabled).toBe(true);
  await click('글 뼈대만 만들기');
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({ generation_mode: 'skeleton', snapshot_id: 11 }));
  expect(generate.mock.calls[0][0]).not.toHaveProperty('fact_pack_id');
});
it('uses exact approved version and invalidates approval when selection changes', async () => {
  await analyze(); await click('근거 자료 불러오기'); await selectEvidence(); await click('선택한 근거 승인');
  expect(client.appendFactPackVersion).toHaveBeenCalledWith(3, ['metric'], 'approved', 1);
  await click('승인 근거로 글 만들기');
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({ generation_mode: 'llm', fact_pack_id: 3, fact_pack_version: 2 }));
  await selectEvidence(); expect(button('승인 근거로 글 만들기').disabled).toBe(true);
  expect(host.textContent).toContain('선택 변경 미저장');
});
it('keeps evidence selection after a failed approval and has no automatic write retry', async () => {
  await analyze(); await click('근거 자료 불러오기'); await selectEvidence();
  client.appendFactPackVersion.mockRejectedValue(new Error('409 최신 근거 충돌'));
  await click('선택한 근거 승인');
  expect((host.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(true);
  expect(client.appendFactPackVersion).toHaveBeenCalledTimes(1);
  expect(button('승인 근거로 글 만들기').disabled).toBe(true);
});
it('clears old snapshot and approval on topic change without auto fetching', async () => {
  await analyze(); await click('근거 자료 불러오기'); await selectEvidence(); await click('선택한 근거 승인');
  await input('다른 주제');
  expect(host.textContent).not.toContain('Snapshot #11'); expect(host.querySelectorAll('input[type=radio]')).toHaveLength(0);
  expect(client.analyze).toHaveBeenCalledTimes(1); expect(generate).not.toHaveBeenCalled();
});
it.each([true, null])('does not allow sensitive or unknown AI generation under strict policy (%s)', async sensitive => {
  client.preflight.mockResolvedValue({ sensitive, correction: null });
  await analyze(); await click('근거 자료 불러오기'); await selectEvidence(); await click('선택한 근거 승인');
  expect(button('승인 근거로 글 만들기').disabled).toBe(true); expect(button('글 뼈대만 만들기').disabled).toBe(false);
});
it('never offers a structure-only plan as a complete AI article', async () => {
  await analyze(); await click('근거 자료 불러오기'); await selectEvidence(); await click('선택한 근거 승인');
  await act(async () => (host.querySelectorAll('input[type=radio]')[14] as HTMLInputElement).click());
  expect(button('승인 근거로 글 만들기').disabled).toBe(true);
  await click('글 뼈대만 만들기'); expect(generate.mock.calls[0][0].plan_item.order).toBe(15);
});
it('blocks duplicate analysis requests', async () => {
  client.analyze.mockReturnValue(new Promise(() => {})); await render(); await input('여행');
  await act(async () => { button('주제 분석').click(); host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(client.analyze).toHaveBeenCalledTimes(1); expect(generate).not.toHaveBeenCalled();
});
