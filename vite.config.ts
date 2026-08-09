import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Whether this build contains the developer tools.
 *
 * The gate is the *build*, not a flag inside it, and that distinction is the
 * whole design. This game is a page: everything shipped to a browser can be
 * read by anybody who opens the console, so a password, a query string or a
 * runtime toggle is not a lock — it is a sign asking people not to try the
 * handle. The only way a feature is unavailable to somebody is if the code is
 * not there.
 *
 * So the panel is behind `if (__DEV_TOOLS__)` with a dynamic import inside it.
 * When this is `false` the bundler folds the condition away, the import is
 * never reachable, and `src/dev/` is not in the output at all — which
 * `npm run check:public` then verifies rather than assumes.
 *
 *   npm run dev          tools on   — working on it
 *   npm run build        tools OFF  — what anybody else gets
 *   npm run build:tools  tools on   — the private build, never deployed
 */
const devTools = process.env.MAKER_DEV_TOOLS === '1';

export default defineConfig({
  define: {
    __DEV_TOOLS__: JSON.stringify(devTools || process.env.NODE_ENV !== 'production'),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
