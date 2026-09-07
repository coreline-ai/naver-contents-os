import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('declares a local scalable tab icon with the app N mark and no font or external dependency', () => {
  const html = readFileSync(resolve('index.html'), 'utf8');
  const head = new DOMParser().parseFromString(html, 'text/html').head;
  const icon = head.querySelector('link[rel="icon"]')!;
  expect(icon.getAttribute('href')).toBe('/ncos-icon-v1.svg');
  expect(icon.getAttribute('type')).toBe('image/svg+xml');
  expect(icon.getAttribute('sizes')).toBe('any');
  const svg = readFileSync(resolve('public/ncos-icon-v1.svg'), 'utf8');
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(document.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 64 64');
  expect(document.querySelector('path')?.getAttribute('fill')).toBe('#102419');
  expect(document.querySelector('rect')?.getAttribute('fill')).toBe('#4ade80');
  expect(svg).not.toMatch(/<script|<text|<image|<foreignObject|href=|url\(/i);
});
