import React, { useEffect, useState } from 'react';
import type { DraftAsset } from '@ncos/contracts';
import type { CoreClient } from '@ncos/core-client';
import { message } from './common';

export function DraftAssetPreview({ client, asset, paragraph }: { client: CoreClient; asset: DraftAsset; paragraph?: string }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl = '';
    setUrl(''); setError('');
    void (async () => {
      try {
        const blob = await client.draftAssetContent(asset.draft_id, asset.asset_id, abort.signal);
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (e) { if (!abort.signal.aborted) setError(message(e)); }
    })();
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, asset.draft_id, asset.asset_id, asset.sha256]);
  return <figure className="draft-asset-preview">
    {url && <img src={url} alt={`${asset.position + 1}번 본문 이미지: ${asset.filename}`} onError={() => setError('이미지 파일을 표시하지 못했습니다. 파일을 확인하고 교체하세요.')}/>}
    {!url && !error && <p role="status">미리보기 불러오는 중…</p>}
    {error && <p role="alert">미리보기 오류: {error}</p>}
    <figcaption>{asset.anchor_after === 0 ? '본문 시작 전' : `${asset.anchor_after}번째 문단 뒤`} · {asset.filename}
      {asset.anchor_after > 0 && <p className="muted">{paragraph ? `${paragraph.slice(0, 120)}${paragraph.length > 120 ? '…' : ''}` : '삽입 문단 확인 필요 — 원고의 문단 수와 맞지 않습니다.'}</p>}
    </figcaption>
  </figure>;
}
