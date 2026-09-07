import React from 'react';
import type { CapabilitiesResponse, TrendPoint } from '@ncos/contracts';
import { formatTime } from './common';
export const modeLabels = { general: '일반', local: '지역', shopping: '쇼핑', news: '뉴스' };
export const directionLabels = { new: '신규 상승', rising: '상승', steady: '보합', falling: '하락', insufficient: '자료 부족' };
export const statusLabel = (value: string) => ({ ok: '정상', ready: '준비됨', configured: '설정됨 · 실제 권한은 조회 시 확인', unconfigured: '설정 필요', partial: '일부 자료만 제공', empty: '결과 없음', quota: '사용 한도 도달', auth: '인증·권한 오류', not_collected: '미수집', insufficient: '자료 부족', unavailable: '제공 불가', upstream_unreachable: '서비스 연결 실패' }[value] ?? value);
export const numberText = (value: number | null | undefined, digits = 0) => value == null || !Number.isFinite(value) ? '자료 없음' : value.toLocaleString('ko-KR', { maximumFractionDigits: digits });
export const safeLink = (value: unknown) => { try { const url = new URL(String(value)); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } };
export function blocked(capabilities: CapabilitiesResponse | undefined, providers: string[]) { return providers.some(p => capabilities?.providers[p]?.quota?.blocked); }
export function DataStatus({ values }: { values?: Record<string, string> }) { return values ? <details className="data-status"><summary>자료별 연결 상태</summary><ul>{Object.entries(values).map(([name, value]) => <li key={name}>{name}: {statusLabel(value)}</li>)}</ul></details> : null; }
export function TrendLine({ points, label = '검색 추이', collectedAt }: { points: TrendPoint[]; label?: string; collectedAt?: string | null }) {
  const valid = points.filter(p => Number.isFinite(p.ratio));
  const max = Math.max(1, ...valid.map(p => p.ratio));
  return <div className="trend-block"><p><strong>{label}</strong> · 기간 내 상대지수, 검색 횟수 아님</p>{valid.length ? <><svg className="trend-line" viewBox="0 0 500 115" role="img" aria-label={`${label}: ${valid[0].period}부터 ${valid.at(-1)!.period}까지, 최근 상대지수 ${valid.at(-1)!.ratio}`}><polyline fill="none" stroke="var(--green, #08734f)" strokeWidth="3" points={valid.map((p, i) => `${5 + i / Math.max(1, valid.length - 1) * 490},${105 - p.ratio / max * 95}`).join(' ')}/></svg><p>{valid[0].period} ~ {valid.at(-1)!.period} · 최근 {numberText(valid.at(-1)!.ratio, 1)}</p><details><summary>기간별 원자료</summary><div className="table-scroll"><table><thead><tr><th>기간</th><th>상대지수</th></tr></thead><tbody>{valid.map((p, i) => <tr key={i}><td>{p.period}</td><td>{numberText(p.ratio, 2)}</td></tr>)}</tbody></table></div></details></> : <p>추이 자료가 없습니다.</p>}{collectedAt && <p>수집 {formatTime(collectedAt)}</p>}</div>;
}
