import type { BlogParse } from './parsers/blog';
import type { SerpParse } from './parsers/serp';

export const MSG_GET_SERP = 'NCOS_GET_SERP';
export const MSG_GET_BLOG = 'NCOS_GET_BLOG';

export interface GetSerpMessage {
  type: typeof MSG_GET_SERP;
}
export interface GetBlogMessage {
  type: typeof MSG_GET_BLOG;
}
export type ContentMessage = GetSerpMessage | GetBlogMessage;
export type SerpReply = SerpParse;
export type BlogReply = BlogParse;

export async function requestActiveTab<T>(message: ContentMessage): Promise<T | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    return (await chrome.tabs.sendMessage(tab.id, message)) as T;
  } catch {
    return null; // no content script on this page
  }
}
