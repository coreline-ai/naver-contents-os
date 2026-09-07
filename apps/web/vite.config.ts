import { defineConfig } from 'vitest/config';
export default defineConfig({
  base: '/app/',
  test: { environment: 'happy-dom', include: ['tests/**/*.test.{ts,tsx}'] },
  build: { sourcemap: false },
});
