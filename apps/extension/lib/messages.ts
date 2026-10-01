import { browser } from 'wxt/browser';
import type { PublishCommand } from '@ncos/contracts';
import type { BlogParse } from './parsers/blog';
import type { SerpParse } from './parsers/serp';

export const MSG_GET_SERP = 'NCOS_GET_SERP';
export const MSG_GET_BLOG = 'NCOS_GET_BLOG';
export const MSG_PING_EDITOR = 'NCOS_PING_EDITOR';
export const MSG_RUN_PUBLISH_JOB = 'NCOS_RUN_PUBLISH_JOB';
export const MSG_EXECUTE_PUBLISH_JOB = 'NCOS_EXECUTE_PUBLISH_JOB';
export const MSG_VERIFY_PUBLISH_JOB = 'NCOS_VERIFY_PUBLISH_JOB';
export const MSG_RECORD_PUBLISH_EVENT = 'NCOS_RECORD_PUBLISH_EVENT';
export const MSG_FETCH_PUBLISH_ASSET = 'NCOS_FETCH_PUBLISH_ASSET';

export interface GetSerpMessage {
  type: typeof MSG_GET_SERP;
}
export interface GetBlogMessage {
  type: typeof MSG_GET_BLOG;
}
export interface PingEditorMessage {
  type: typeof MSG_PING_EDITOR;
}
export interface RunPublishJobMessage {
  type: typeof MSG_RUN_PUBLISH_JOB;
  jobId: number;
}
export interface ExecutePublishJobMessage {
  type: typeof MSG_EXECUTE_PUBLISH_JOB;
  command: PublishCommand;
}
export interface VerifyPublishJobMessage {
  type: typeof MSG_VERIFY_PUBLISH_JOB;
  command: PublishCommand;
}
export interface RecordPublishEventMessage {
  type: typeof MSG_RECORD_PUBLISH_EVENT;
  jobId: number;
  event: {
    attempt_id: string;
    lease_owner: string;
    stage: string;
    status: 'running' | 'passed' | 'failed';
    error_code?: string | null;
    detail?: string;
    verification?: Record<string, unknown> | null;
  };
}
export interface FetchPublishAssetMessage {
  type: typeof MSG_FETCH_PUBLISH_ASSET;
  jobId: number;
  assetId: number;
}
export type ContentMessage = GetSerpMessage | GetBlogMessage;
export type PublisherRuntimeMessage = RunPublishJobMessage | PingEditorMessage | ExecutePublishJobMessage
  | VerifyPublishJobMessage | RecordPublishEventMessage | FetchPublishAssetMessage;
export type SerpReply = SerpParse;
export type BlogReply = BlogParse;

export interface PublisherReply {
  ok: boolean;
  jobId?: number;
  stage?: string;
  error_code?: string;
  detail?: string;
  verification?: Record<string, unknown>;
}

export interface PublisherAssetReply {
  ok: boolean;
  data_base64?: string;
  error_code?: string;
  detail?: string;
}

export async function requestActiveTab<T>(message: ContentMessage): Promise<T | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    return (await browser.tabs.sendMessage(tab.id, message)) as T;
  } catch {
    return null; // no content script on this page
  }
}
