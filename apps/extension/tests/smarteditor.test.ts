import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inputBody,
  inputTags,
  inputTitle,
  contentHash,
  readEditorVerification,
  saveDraft,
  uploadImages,
  validateCommand,
  waitForEditor,
} from '../lib/smarteditor';

function editorFixture(): Document {
  return new DOMParser().parseFromString(`
    <main class="se-container">
      <section class="se-documentTitle"><p class="se-text-paragraph" contenteditable="true"></p></section>
      <section class="se-main-container"><p class="se-text-paragraph" contenteditable="true"></p></section>
      <button data-click-area="tpb.publish">발행</button>
      <button data-click-area="tpb.save">임시저장</button>
    </main>
  `, 'text/html');
}

describe('SmartEditor current-Chrome adapter', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('finds editor controls inside a same-origin iframe realm', async () => {
    const outer = document.implementation.createHTMLDocument('outer');
    const frame = outer.createElement('iframe');
    outer.body.append(frame);
    const inner = frame.contentDocument!;
    inner.body.innerHTML = editorFixture().body.innerHTML;

    await expect(waitForEditor(outer)).resolves.toBeUndefined();
  });

  it('finds the editor and replaces title/body without touching publish confirmation', async () => {
    const doc = editorFixture();
    await expect(waitForEditor(doc)).resolves.toBeUndefined();
    inputTitle(doc, '완성 제목');
    inputBody(doc, '완성 본문\n둘째 문단');
    expect(doc.querySelector('.se-documentTitle p')?.textContent).toBe('완성 제목');
    expect(doc.querySelector('.se-main-container p')?.textContent).toBe('완성 본문\n둘째 문단');
  });

  it('opens only the tag layer and enters normalized tags', async () => {
    const doc = editorFixture();
    const publish = doc.querySelector<HTMLButtonElement>('[data-click-area="tpb.publish"]')!;
    publish.addEventListener('click', () => {
      const input = doc.createElement('input');
      input.id = 'tag-input';
      doc.body.append(input);
    });
    await inputTags(doc, ['후쿠오카 여행']);
    expect(doc.querySelector<HTMLInputElement>('#tag-input')?.value).toBe('후쿠오카여행');
  });

  it('clicks the draft-save control and never searches for a public-submit button', async () => {
    const doc = editorFixture();
    const save = doc.querySelector<HTMLButtonElement>('[data-click-area="tpb.save"]')!;
    let clicks = 0;
    save.addEventListener('click', () => {
      clicks += 1;
      save.textContent = '임시저장 1';
    });
    await saveDraft(doc);
    expect(clicks).toBe(1);
  });

  it('blocks commands shorter than the strict 3,000 character gate', () => {
    expect(() => validateCommand({
      job_id: 1,
      draft_id: 1,
      draft_version: 1,
      blog_id: 'sence4u',
      title: '제목',
      body: '짧은 본문',
      title_hash: '',
      body_hash: '',
      body_chars: 5,
      tags: [],
      assets: [],
    })).toThrow('3,000자');
  });

  it('verifies a reopened draft from independent title/body hashes and remote images', async () => {
    const doc = editorFixture();
    const title = '후쿠오카 여행 완전 가이드';
    const body = '후쿠오카 여행 준비 동선과 비용을 설명합니다. '.repeat(100);
    inputTitle(doc, title);
    inputBody(doc, body);
    const bodyRoot = doc.querySelector('.se-main-container')!;
    for (let index = 0; index < 3; index += 1) {
      const image = doc.createElement('img');
      image.src = `https://blogfiles.pstatic.net/example-${index}.jpg`;
      bodyRoot.append(image);
    }
    const verification = await readEditorVerification(doc, {
      job_id: 7,
      draft_id: 2,
      draft_version: 1,
      blog_id: 'sence4u',
      title,
      body,
      title_hash: await contentHash(title),
      body_hash: await contentHash(body),
      body_chars: body.length,
      tags: [],
      assets: [],
    });
    expect(verification).toMatchObject({
      title_hash_match: true,
      body_hash_match: true,
      image_count: 3,
      remote_image_count: 3,
    });
  });

  it('transfers an approved asset through the file input and waits for a pstatic URL', async () => {
    const doc = editorFixture();
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = 'image/png';
    doc.body.append(input);
    input.addEventListener('change', () => {
      const image = doc.createElement('img');
      image.src = 'https://blogfiles.pstatic.net/uploaded.png';
      doc.querySelector('.se-main-container')?.append(image);
    });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1]);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
    await uploadImages(doc, {
      job_id: 1, draft_id: 1, draft_version: 1, blog_id: 'sence4u',
      title: '제목', body: '본문'.repeat(2000), title_hash: '', body_hash: '', body_chars: 4000, tags: [],
      assets: [{
        asset_id: 1, draft_id: 1, draft_version: 1, filename: 'photo.png', mime_type: 'image/png',
        byte_size: bytes.byteLength, sha256: digest, position: 0, anchor_after: 1,
        rights_status: 'approved', created_at: null, download_url: '/v1/publish-jobs/1/assets/1',
        native_path: '/tmp/photo.png',
      }],
    }, async () => bytes.buffer);
    expect(input.files).toHaveLength(1);
    expect(input.files?.[0]?.name).toBe('photo.png');
  });
});
