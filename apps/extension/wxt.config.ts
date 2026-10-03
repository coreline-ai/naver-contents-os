import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const fingerprint = createHash('sha256');
for (const dir of ['apps/extension/entrypoints', 'apps/extension/lib', 'apps/extension/components', 'apps/extension/assets', 'packages/contracts/src', 'packages/core-client/src', 'packages/workbench/src']) {
  for (const file of readdirSync(resolve(root, dir), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => resolve(entry.parentPath, entry.name)).sort()) {
    fingerprint.update(relative(root, file)); fingerprint.update(readFileSync(file));
  }
}
fingerprint.update(readFileSync(resolve(root, 'apps/extension/wxt.config.ts')));
const buildId = `0.2.0+${fingerprint.digest('hex').slice(0, 12)}`;

export default defineConfig({
  // Keep the unpacked extension in a visible folder so Chrome's file picker
  // can select it without exposing hidden dot-directories.
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'Naver Content OS',
    version_name: buildId,
    description: '네이버 키워드 분석과 콘텐츠 기획 사이드패널',
    permissions: ['sidePanel', 'storage', 'activeTab', 'tabs', 'debugger'],
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*', '*://blog.naver.com/*'],
    action: { default_title: 'Naver Content OS' },
  },
});
