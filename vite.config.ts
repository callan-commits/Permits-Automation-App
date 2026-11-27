import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Version shown in the status bar: package.json's version, plus the commit it was built from.
const version: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
})();

export default defineConfig({
  // Relative base so the built app works from any static host or sub-path (e.g. GitHub Pages).
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
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
