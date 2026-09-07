import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  // Keep the unpacked extension in a visible folder so Chrome's file picker
  // can select it without exposing hidden dot-directories.
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'Naver Content OS',
    description: '네이버 키워드 분석과 콘텐츠 기획 사이드패널',
    permissions: ['sidePanel', 'storage', 'activeTab', 'tabs'],
    host_permissions: ['http://127.0.0.1/*'],
    action: { default_title: 'Naver Content OS' },
  },
});
