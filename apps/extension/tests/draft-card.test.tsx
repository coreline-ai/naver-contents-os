import type { DraftDetail, PublishJob } from '@ncos/contracts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftCard } from '../entrypoints/sidepanel/App';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const draft: DraftDetail = {
  draft_id: 11,
  blog_type: 'HOWTO',
  title: '최신 제목',
  source_snapshot_id: 7,
  plan: {
    order: 1,
    title: '계획 제목',
    blog_type: 'HOWTO',
    target_keyword: '키워드',
    angle: '',
    reason: '',
    generation_status: 'ready',
    series_prev: null,
    series_next: null,
  },
  provider: 'skeleton',
  model: '',
  prompt_version: 'v1',
  versions: [
    { version: 1, title: '원본 제목', body: '원본 본문', note: 'V1 원본' },
    { version: 2, title: '최신 제목', body: '최신 본문', note: '사실확인' },
  ],
};

const savedJob: PublishJob = {
  job_id: 5,
  draft_id: 11,
  status: 'draft_saved',
  stage: 'draft_save',
  error_code: null,
  detail: '',
  history: [],
};

function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

describe('DraftCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('keeps old versions selectable and appends edits through the save callback', async () => {
    const onSaveVersion = vi.fn();
    await act(async () => root.render(<DraftCard draft={draft} onSaveVersion={onSaveVersion} />));

    await act(async () => button(container, 'v1 · V1 원본').click());
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('원본 제목');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('원본 본문');
    expect(button(container, '새 버전 저장').disabled).toBe(false);

    await act(async () => button(container, '새 버전 저장').click());
    expect(onSaveVersion).toHaveBeenCalledWith('원본 제목', '원본 본문', 'v1 기준 수정');
  });

  it('does not start publishing before explicit confirmation and shows terminal status', async () => {
    const onPublish = vi.fn();
    await act(async () => root.render(
      <DraftCard draft={draft} onPublish={onPublish} publishJob={savedJob} />,
    ));
    const blogId = container.querySelector<HTMLInputElement>('input[placeholder="네이버 blog ID"]')!;
    const tags = container.querySelector<HTMLInputElement>('input[placeholder="태그1, 태그2"]')!;
    await act(async () => {
      setInput(blogId, 'target_blog');
      setInput(tags, '태그1, 태그2');
    });

    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await act(async () => button(container, '최신 버전 임시저장 시작').click());
    expect(onPublish).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValueOnce(true);
    await act(async () => button(container, '최신 버전 임시저장 시작').click());
    expect(onPublish).toHaveBeenCalledWith('target_blog', ['태그1', '태그2']);
    expect(container.textContent).toContain('Job #5 · draft_saved · draft_save');
  });

  it('blocks publishing while an unsaved edit exists', async () => {
    await act(async () => root.render(<DraftCard draft={draft} />));
    const title = container.querySelector<HTMLInputElement>('input')!;
    await act(async () => setInput(title, '저장 전 제목'));
    expect(button(container, '최신 버전 임시저장 시작').disabled).toBe(true);
    expect(container.textContent).toContain('새 버전으로 저장해야');
  });
});
