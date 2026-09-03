import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PcMobileDonut } from '../components/PcMobileDonut';

function render(pc: number | null, mobile: number | null, masked = false): string {
  return renderToStaticMarkup(<PcMobileDonut pc={pc} mobile={mobile} masked={masked} />);
}

describe('PC·mobile SearchAd donut', () => {
  it.each([
    [50, 50, 'PC 50 · 50%', '모바일 50 · 50%'],
    [100, 0, 'PC 100 · 100%', '모바일 0 · 0%'],
    [0, 100, 'PC 0 · 0%', '모바일 100 · 100%'],
    [1, 2, 'PC 1 · 33.3%', '모바일 2 · 66.7%'],
    [9_000_000_000, 1_000_000_000, 'PC 9,000,000,000 · 90%', '모바일 1,000,000,000 · 10%'],
  ])('renders trusted values without a chart dependency', (pc, mobile, pcText, mobileText) => {
    const html = render(pc as number, mobile as number);
    expect(html).toContain('conic-gradient');
    expect(html).toContain(pcText);
    expect(html).toContain(mobileText);
    expect(html).toContain('aria-label="월간 SearchAd 검색량');
    expect(html).toContain('max-w-full');
  });

  it.each([
    [null, 10, false, 'PC 결측 · 모바일 10'],
    [10, null, false, 'PC 10 · 모바일 결측'],
    [0, 0, false, 'PC 0 · 모바일 0'],
    [5, 5, true, 'PC 10 미만·마스킹 · 모바일 10 미만·마스킹'],
  ])('does not draw a misleading ratio for missing or masked values', (pc, mobile, masked, fallback) => {
    const html = render(pc as number | null, mobile as number | null, masked as boolean);
    expect(html).toContain('비율 계산 불가');
    expect(html).toContain(fallback);
    expect(html).not.toContain('conic-gradient');
  });
});
