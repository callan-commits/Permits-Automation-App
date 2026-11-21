import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the built app works from any static host or sub-path (e.g. GitHub Pages).
  base: './',
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1000 },
  optimizeDeps: {
    // The LibreDWG package ships its own WASM loader; don't let Vite pre-bundle it.
    exclude: ['@mlightcad/libredwg-web'],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
