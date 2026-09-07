import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PerformanceChannel, PerformanceImportRequest } from '@ncos/contracts';
import { PerformanceImportPanel } from '../entrypoints/research/PerformanceWorkspace';
import type { CoreClient } from '../lib/core';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const channels = [{ id: 1, source: 'creator_advisor', display_name: '테스트 채널', enabled: true }] as PerformanceChannel[];
let container: HTMLDivElement;
let root: Root;
const previewResult = (request: PerformanceImportRequest) => ({
  valid: true, channel: channels[0], source: request.source, data_kind: request.data_kind,
  period: { start: request.period_start, end: request.period_end }, grain: request.grain,
  row_count: request.rows.length, warnings: [], input_hash: 'hash', rows: request.rows,
});
function button(label: string) {
  return [...container.querySelectorAll('button')].find((node) => node.textContent === label);
}
function input(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
}
async function mount(client: unknown) {
  await act(async () => root.render(<PerformanceImportPanel client={client as CoreClient} channels={channels}
    imports={[]} onNotice={vi.fn()} onChanged={vi.fn()} />));
  await act(async () => button('샘플 양식 넣기')!.click());
}
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('requires a new preview when the reviewed reporting date changes', async () => {
  const client = { previewPerformanceImport: vi.fn(async (request) => previewResult(request)), createPerformanceImport: vi.fn() };
  await mount(client);
  await act(async () => button('열 매핑·미리보기')!.click());
  expect(button('확인하고 로컬 저장')).toBeDefined();
  await act(async () => input(container.querySelector('input[type=date]')!, '2026-08-01'));
  expect(button('확인하고 로컬 저장')).toBeUndefined();
  expect(client.createPerformanceImport).not.toHaveBeenCalled();
});

it('discards a delayed preview after the user replaces the table', async () => {
  let resolve!: (value: unknown) => void;
  let request!: PerformanceImportRequest;
  const client = { previewPerformanceImport: vi.fn((value) => { request = value; return new Promise((r) => { resolve = r; }); }), createPerformanceImport: vi.fn() };
  await mount(client);
  await act(async () => button('열 매핑·미리보기')!.click());
  await act(async () => input(container.querySelector('textarea')!, '제목,노출\n새 원고,100'));
  await act(async () => resolve(previewResult(request)));
  expect(button('확인하고 로컬 저장')).toBeUndefined();
  expect(client.createPerformanceImport).not.toHaveBeenCalled();
});

it('saves exactly the reviewed request once', async () => {
  const client = { previewPerformanceImport: vi.fn(async (request) => previewResult(request)),
    createPerformanceImport: vi.fn(async () => ({ row_count: 1, duplicate: false })) };
  await mount(client);
  await act(async () => button('열 매핑·미리보기')!.click());
  await act(async () => { const save = button('확인하고 로컬 저장')!; save.click(); save.click(); });
  expect(client.createPerformanceImport).toHaveBeenCalledTimes(1);
  expect(client.createPerformanceImport).toHaveBeenCalledWith(client.previewPerformanceImport.mock.calls[0][0]);
});

it('does not apply an old file after changing the source', async () => {
  await mount({});
  let resolve!: (text: string) => void;
  const picker = container.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(picker, 'files', { value: [{ text: () => new Promise<string>((r) => { resolve = r; }) }] });
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => button('스마트스토어 성과')!.click());
  await act(async () => resolve('제목,조회수\n이전 블로그 표,10'));
  expect(container.querySelector('textarea')!.value).toBe('');
});

it('keeps a failed save retryable without reporting success', async () => {
  const client = { previewPerformanceImport: vi.fn(async (request) => previewResult(request)),
    createPerformanceImport: vi.fn().mockRejectedValueOnce(new Error('test failure')).mockResolvedValue({ row_count: 1 }) };
  await mount(client);
  await act(async () => button('열 매핑·미리보기')!.click());
  await act(async () => button('확인하고 로컬 저장')!.click());
  expect(container.querySelector('[role=alert]')?.textContent).toContain('완료하지 못했습니다');
  expect(button('확인하고 로컬 저장')?.disabled).toBe(false);
  await act(async () => button('확인하고 로컬 저장')!.click());
  expect(client.createPerformanceImport).toHaveBeenCalledTimes(2);
  expect(button('확인하고 로컬 저장')).toBeUndefined();
});
