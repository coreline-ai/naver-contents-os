export function message(error: unknown) { return error instanceof Error ? error.message : '요청을 완료하지 못했습니다.'; }
export type WritingPreferences = { blogId: string; tags: string; allowSensitiveUnknown: boolean };

export function formatTime(value: string | null | undefined): string {
  if (!value) return '시각 미제공';
  const iso = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '시각 확인 필요';
  return `${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(date)} KST`;
}
