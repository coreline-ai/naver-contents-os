import type { PublishCommand, PublishCommandAsset } from '@ncos/contracts';

export const EDITOR_SELECTORS = {
  root: ['.se-container', '.se-viewer', '#SE-canvas'],
  title: [
    '.se-documentTitle .se-text-paragraph',
    '.se-title-text .se-text-paragraph',
    '.se-title-text',
    '[contenteditable="true"][data-placeholder*="제목"]',
  ],
  body: [
    '.se-main-container .se-text-paragraph',
    '.se-main-container [contenteditable="true"]',
    '.se-section-text .se-text-paragraph',
    '.se-component.se-text .se-text-paragraph',
    '[contenteditable="true"][data-placeholder*="본문"]',
  ],
  imageButton: [
    'button.se-image-toolbar-button',
    'button[data-name="image"]',
    '.se-toolbar-item-image button',
  ],
  imageInput: [
    'input[type="file"][accept*="image"]',
    'input[type="file"][accept*=".jpg"]',
    'input[type="file"][multiple]',
  ],
  helpClose: [
    'button.se-help-panel-close-button',
    '.se-popup-button-cancel',
    'button[data-name="close"]',
  ],
  publishOpen: [
    'button.publish_btn__WEpYf',
    'button[class^="publish_btn__"]',
    'button[class*=" publish_btn__"]',
    'button[data-click-area="tpb.publish"]',
  ],
  tagInput: ['#tag-input', 'input.tag_input', '.tag_area input'],
  draftSave: [
    'button.save_btn__bzc5B',
    'button[class^="save_btn__"]',
    'button[class*=" save_btn__"]',
    '.save_area button.save_btn',
    'button[data-click-area="tpb.save"]',
  ],
  saveSuccess: [
    'span[class^="autosave_message__"][class*="is_show__"]',
    '[class*="save_complete"]',
  ],
} as const;

export class SmartEditorError extends Error {
  constructor(public stage: string, public code: string, message: string) {
    super(message);
  }
}

function visible(element: Element): element is HTMLElement {
  const view = element.ownerDocument.defaultView;
  if (!view || !(element instanceof view.HTMLElement)) return false;
  const style = view.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && !element.hasAttribute('disabled');
}

export function editorDocuments(root: Document): Document[] {
  const documents = [root];
  for (const frame of root.querySelectorAll('iframe')) {
    try {
      if (frame.contentDocument && frame.contentDocument !== root) {
        documents.push(...editorDocuments(frame.contentDocument));
      }
    } catch {
      // Cross-origin frames are intentionally ignored.
    }
  }
  return [...new Set(documents)];
}

export function findEditorElement(
  root: Document,
  selectors: readonly string[],
): HTMLElement | null {
  for (const doc of editorDocuments(root)) {
    for (const selector of selectors) {
      const found = [...doc.querySelectorAll(selector)].find(visible);
      if (found) return found as HTMLElement;
    }
  }
  return null;
}

function findButtonByText(root: Document, expected: RegExp): HTMLButtonElement | null {
  for (const doc of editorDocuments(root)) {
    const found = [...doc.querySelectorAll('button')].find((button) => {
      const text = button.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return visible(button) && expected.test(text);
    });
    if (found) return found as HTMLButtonElement;
  }
  return null;
}

export async function waitFor<T>(read: () => T | null, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value != null) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new SmartEditorError('health_check', 'editor_timeout', 'SmartEditor 입력 화면을 찾지 못했습니다.');
}

export async function waitForEditor(root: Document): Promise<void> {
  await waitFor(() => {
    const title = findEditorElement(root, EDITOR_SELECTORS.title);
    const body = findEditorElement(root, EDITOR_SELECTORS.body);
    const save = findEditorElement(root, EDITOR_SELECTORS.draftSave)
      ?? findButtonByText(root, /^임시\s*저장(?:\s*\d+)?$/);
    return title && body && save ? true : null;
  });
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);
}

export function replaceEditorText(element: HTMLElement, value: string): void {
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    setNativeValue(element, value);
  } else {
    const selection = element.ownerDocument.getSelection();
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const inserted = typeof element.ownerDocument.execCommand === 'function'
      && element.ownerDocument.execCommand('insertText', false, value);
    if (!inserted) element.textContent = value;
  }
  element.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    inputType: 'insertText',
    data: value,
  }));
  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: 'insertText',
    data: value,
  }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

export function dismissEditorPopups(root: Document): void {
  for (const selector of EDITOR_SELECTORS.helpClose) {
    findEditorElement(root, [selector])?.click();
  }
}

export function inputTitle(root: Document, title: string): void {
  const element = findEditorElement(root, EDITOR_SELECTORS.title);
  if (!element) throw new SmartEditorError('input_title', 'title_not_found', 'SmartEditor 제목 입력란을 찾지 못했습니다.');
  replaceEditorText(element, title.trim());
}

export function inputBody(root: Document, body: string): void {
  const element = findEditorElement(root, EDITOR_SELECTORS.body);
  if (!element) throw new SmartEditorError('input_body', 'body_not_found', 'SmartEditor 본문 입력란을 찾지 못했습니다.');
  replaceEditorText(element, body.trim());
}

function pressEnter(element: HTMLElement): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
}

export async function inputTags(root: Document, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  const open = findEditorElement(root, EDITOR_SELECTORS.publishOpen)
    ?? findButtonByText(root, /^발행$/);
  if (!open) throw new SmartEditorError('input_tags', 'publish_layer_not_found', '태그 입력 화면을 여는 버튼을 찾지 못했습니다.');
  open.click();
  const input = await waitFor(
    () => findEditorElement(root, EDITOR_SELECTORS.tagInput),
    5_000,
  ).catch(() => null);
  if (!input) throw new SmartEditorError('input_tags', 'tag_input_not_found', '태그 입력란을 찾지 못했습니다.');
  for (const tag of tags.slice(0, 10)) {
    replaceEditorText(input, tag.replace(/\s+/g, ''));
    pressEnter(input);
  }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function fetchAsset(
  asset: PublishCommandAsset,
  loadAsset: (asset: PublishCommandAsset) => Promise<ArrayBuffer>,
): Promise<File> {
  let bytes: ArrayBuffer;
  try {
    bytes = await loadAsset(asset);
  } catch (error) {
    if (error instanceof SmartEditorError) throw error;
    throw new SmartEditorError(
      'upload_images',
      'asset_download_failed',
      `이미지 ${asset.position + 1} 다운로드에 실패했습니다: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
  if (bytes.byteLength !== asset.byte_size) {
    throw new SmartEditorError('upload_images', 'asset_size_mismatch', `이미지 ${asset.position + 1} 크기가 원본과 다릅니다.`);
  }
  const digest = toHex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== asset.sha256) {
    throw new SmartEditorError('upload_images', 'asset_hash_mismatch', `이미지 ${asset.position + 1} 무결성 검증에 실패했습니다.`);
  }
  return new File([bytes], asset.filename, { type: asset.mime_type });
}

export function remoteImageSources(root: Document): string[] {
  const sources: string[] = [];
  for (const doc of editorDocuments(root)) {
    for (const image of doc.querySelectorAll<HTMLImageElement>('img[src]')) {
      const source = image.currentSrc || image.src || image.getAttribute('src') || '';
      if (/^https:\/\/(?:blogfiles|postfiles)\.pstatic\.net\//i.test(source)) sources.push(source);
    }
  }
  return [...new Set(sources)];
}

function assignFiles(input: HTMLInputElement, files: File[]): void {
  const transfer = new DataTransfer();
  files.forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function placeImageCaret(root: Document, anchorAfter: number): void {
  const container = bodyContainer(root);
  if (!container) return;
  const paragraphs = [...container.querySelectorAll<HTMLElement>('.se-text-paragraph, p, [contenteditable="true"]')];
  const target = paragraphs[Math.min(Math.max(anchorAfter - 1, 0), Math.max(paragraphs.length - 1, 0))] ?? container;
  target.focus();
  const range = target.ownerDocument.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  const selection = target.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export async function uploadImages(
  root: Document,
  command: PublishCommand,
  loadAsset: (asset: PublishCommandAsset) => Promise<ArrayBuffer>,
): Promise<void> {
  if (command.assets.length === 0) return;
  const orderedAssets = [...command.assets].sort((left, right) => left.position - right.position);
  const files = await Promise.all(orderedAssets.map((asset) => fetchAsset(asset, loadAsset)));
  const before = remoteImageSources(root).length;
  for (const [index, file] of files.entries()) {
    placeImageCaret(root, orderedAssets[index].anchor_after);
    let input = findEditorElement(root, EDITOR_SELECTORS.imageInput) as HTMLInputElement | null;
    if (!input) {
      const button = findEditorElement(root, EDITOR_SELECTORS.imageButton);
      if (!button) throw new SmartEditorError('upload_images', 'image_button_not_found', 'SmartEditor 이미지 버튼을 찾지 못했습니다.');
      button.click();
      input = await waitFor(
        () => findEditorElement(root, EDITOR_SELECTORS.imageInput) as HTMLInputElement | null,
        5_000,
      ).catch(() => null);
    }
    if (!input) throw new SmartEditorError('upload_images', 'image_input_not_found', 'SmartEditor 이미지 파일 입력을 찾지 못했습니다.');
    try {
      assignFiles(input, [file]);
    } catch (error) {
      throw new SmartEditorError(
        'upload_images',
        'file_transfer_rejected',
        `브라우저가 이미지 파일 전달을 거부했습니다: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    await waitFor(
      () => remoteImageSources(root).length >= before + index + 1 ? true : null,
      45_000,
    ).catch(() => {
      throw new SmartEditorError('upload_images', 'remote_image_timeout', `이미지 ${index + 1}의 네이버 업로드 완료를 확인하지 못했습니다.`);
    });
  }
}

export async function saveDraft(root: Document): Promise<void> {
  const button = findEditorElement(root, EDITOR_SELECTORS.draftSave)
    ?? findButtonByText(root, /^임시\s*저장(?:\s*\d+)?$/);
  if (!button) throw new SmartEditorError('draft_save', 'draft_save_not_found', '임시저장 버튼을 찾지 못했습니다.');
  const before = button.textContent;
  button.click();
  await waitFor(() => {
    const success = findEditorElement(root, EDITOR_SELECTORS.saveSuccess);
    const changed = button.textContent !== before;
    return success || changed ? true : null;
  }, 8_000).catch(() => true);
}

export function validateCommand(command: PublishCommand): void {
  if (!command.title.trim()) throw new SmartEditorError('prepare_editor', 'empty_title', '제목이 비어 있습니다.');
  if (command.body_chars < 3000 || command.body.trim().length < 3000) {
    throw new SmartEditorError('prepare_editor', 'body_too_short', '본문은 3,000자 이상이어야 합니다.');
  }
}

export function normalizedContent(value: string): string {
  return value.replace(/[\s\u200b-\u200d\ufeff]+/g, '');
}

export async function contentHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizedContent(value));
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

function editorText(element: HTMLElement | null): string {
  return (element?.innerText || element?.textContent || '').replace(/\u200b/g, '').trim();
}

function bodyContainer(root: Document): HTMLElement | null {
  return findEditorElement(root, ['.se-main-container', '.se-section-text', '#SE-canvas'])
    ?? findEditorElement(root, EDITOR_SELECTORS.body)?.parentElement
    ?? null;
}

function tryResumeSavedDraft(root: Document, expectedTitle: string): void {
  const currentTitle = editorText(findEditorElement(root, EDITOR_SELECTORS.title));
  if (normalizedContent(currentTitle) === normalizedContent(expectedTitle)) return;
  const resume = findButtonByText(root, /^(?:이어쓰기|계속\s*쓰기|불러오기|확인)$/);
  if (resume) {
    resume.click();
    return;
  }
  for (const doc of editorDocuments(root)) {
    const titleNode = [...doc.querySelectorAll<HTMLElement>('button, a, li, [role="button"]')]
      .find((node) => normalizedContent(node.textContent ?? '').includes(normalizedContent(expectedTitle)));
    if (titleNode) {
      titleNode.click();
      return;
    }
  }
}

export async function readEditorVerification(
  root: Document,
  command: PublishCommand,
): Promise<Record<string, unknown>> {
  dismissEditorPopups(root);
  tryResumeSavedDraft(root, command.title);
  await waitFor(() => {
    const title = editorText(findEditorElement(root, EDITOR_SELECTORS.title));
    const body = editorText(bodyContainer(root));
    return normalizedContent(title) && normalizedContent(body).length >= 100 ? true : null;
  }, 20_000).catch(() => {
    throw new SmartEditorError('reopen_verify', 'saved_draft_not_loaded', '재열기 후 저장된 원고를 찾지 못했습니다.');
  });
  const title = editorText(findEditorElement(root, EDITOR_SELECTORS.title));
  const container = bodyContainer(root);
  const body = editorText(container);
  const allImages = container?.querySelectorAll('img[src]').length ?? 0;
  const remoteImages = remoteImageSources(root).filter((source) => {
    if (!container) return true;
    return [...container.querySelectorAll<HTMLImageElement>('img[src]')]
      .some((image) => (image.currentSrc || image.src || image.getAttribute('src') || '') === source);
  }).length;
  const [titleDigest, bodyDigest] = await Promise.all([contentHash(title), contentHash(body)]);
  return {
    title_hash_match: titleDigest === command.title_hash,
    body_hash_match: bodyDigest === command.body_hash,
    expected_title_hash: command.title_hash,
    actual_title_hash: titleDigest,
    expected_body_hash: command.body_hash,
    actual_body_hash: bodyDigest,
    body_chars: body.length,
    image_count: allImages,
    remote_image_count: remoteImages,
    post_url: window.location.href,
    verified_at: new Date().toISOString(),
  };
}
