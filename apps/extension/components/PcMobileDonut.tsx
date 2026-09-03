export interface PcMobileDonutProps {
  pc: number | null;
  mobile: number | null;
  masked?: boolean;
  compact?: boolean;
}

function validVolume(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

function percent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function raw(value: number | null, masked: boolean): string {
  if (masked) return '10 미만·마스킹';
  return validVolume(value) ? value.toLocaleString() : '결측';
}

export function PcMobileDonut({ pc, mobile, masked = false, compact = false }: PcMobileDonutProps) {
  const calculable = !masked && validVolume(pc) && validVolume(mobile) && pc + mobile > 0;
  if (!calculable) {
    return (
      <div className="max-w-full rounded-lg border border-dashed border-slate-200 bg-slate-50 p-2 text-xs" role="status" aria-label={`PC·모바일 비율 계산 불가. PC ${raw(pc, masked)}, 모바일 ${raw(mobile, masked)}`}>
        <b className="text-slate-600">PC·모바일 비율 계산 불가</b>
        <p className="mt-1 text-[10px] text-slate-500">PC {raw(pc, masked)} · 모바일 {raw(mobile, masked)}</p>
      </div>
    );
  }
  const total = pc + mobile;
  const pcShare = (pc / total) * 100;
  const mobileShare = 100 - pcShare;
  const label = `월간 SearchAd 검색량. PC ${pc.toLocaleString()}회 ${percent(pcShare)}%, 모바일 ${mobile.toLocaleString()}회 ${percent(mobileShare)}%, 합계 ${total.toLocaleString()}회`;
  return (
    <figure className={`max-w-full ${compact ? 'flex items-center gap-3' : 'grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3'}`} aria-label={label}>
      <div className={`${compact ? 'h-16 w-16' : 'h-24 w-24'} relative shrink-0 rounded-full`} style={{ background: `conic-gradient(#2563eb 0 ${pcShare}%, #10b981 ${pcShare}% 100%)` }} aria-hidden="true">
        <div className="absolute inset-[22%] grid place-items-center rounded-full bg-white text-[10px] font-bold text-slate-700">{total.toLocaleString()}</div>
      </div>
      <figcaption className="min-w-0 text-xs">
        <b className="block text-slate-700">월간 SearchAd 합계 {total.toLocaleString()}</b>
        <span className="mt-1 flex items-center gap-1 text-[11px]"><i className="h-2 w-2 rounded-full bg-blue-600" />PC {pc.toLocaleString()} · {percent(pcShare)}%</span>
        <span className="mt-0.5 flex items-center gap-1 text-[11px]"><i className="h-2 w-2 rounded-full bg-emerald-500" />모바일 {mobile.toLocaleString()} · {percent(mobileShare)}%</span>
      </figcaption>
    </figure>
  );
}
